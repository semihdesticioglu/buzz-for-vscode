// Live connection manager: connects once the key and relay are known, reconnects when they change.
import * as vscode from 'vscode';
import { NostrEvent, privateKeyHex } from './core';
import * as cfg from './config';
import { LiveRelay, LiveState, QueryResult } from './liveRelay';
import { Draft, signEvent, wsUrl } from './nostr';
import { log } from './log';
import type { Secrets } from './setup';

type Filter = Record<string, unknown>;

export class LiveManager implements vscode.Disposable {
  private relay?: LiveRelay;
  private sec?: string;
  private readonly subs = new Map<string, Filter[]>();
  private readonly eventCbs = new Set<(subId: string, ev: NostrEvent) => void>();
  private readonly stateCbs = new Set<(s: LiveState) => void>();
  private gen = 0; // each restart; one that finishes after a newer one (or after dispose) does nothing
  private disposed = false;
  state: LiveState = { state: 'off' };

  constructor(private readonly secrets: Secrets) {}

  get isLive(): boolean {
    return this.state.state === 'live';
  }

  /** Does not connect when the setting is off or the key/relay is missing (polling keeps working). */
  async restart(): Promise<void> {
    const g = ++this.gen;
    this.relay?.stop();
    this.relay = undefined;
    this.sec = undefined;
    this.setState({ state: 'off' });
    if (this.disposed || !cfg.liveEnabled()) return;
    const key = await this.secrets.key();
    if (g !== this.gen || this.disposed) return; // a newer restart (or deactivation) took over while waiting
    const relay = cfg.relayUrl();
    const sec = key ? privateKeyHex(key) : undefined;
    if (!sec || !relay) return;
    const url = wsUrl(relay);
    log.info(`[live] connecting to ${url}`);
    const r = new LiveRelay(url, sec, { log: (l) => log.info(`[live] ${l}`) });
    r.onEvent((id, ev) => this.eventCbs.forEach((cb) => cb(id, ev)));
    r.onState((s) => this.setState(s));
    for (const [id, f] of this.subs) r.subscribe(id, f);
    this.relay = r;
    this.sec = sec;
    r.start();
  }

  subscribe(id: string, filters: Filter[]): void {
    this.subs.set(id, filters);
    this.relay?.subscribe(id, filters);
  }

  /** One-shot read over the live connection (e.g. messages by id). Undefined when there is no live connection. */
  /** A one-shot read over the live connection; undefined when there is none, `complete: false` when it was cut short. */
  fetch(filters: Filter[], timeoutMs = 4000): Promise<QueryResult | undefined> {
    return this.relay && this.isLive ? this.relay.query(filters, timeoutMs) : Promise.resolve(undefined);
  }

  unsubscribe(id: string): void {
    this.subs.delete(id);
    this.relay?.unsubscribe(id);
  }

  /** Sign and send an event (used for ephemeral signals such as typing). False when not live. */
  publish(draft: Draft): boolean {
    if (!this.relay || !this.sec || !this.isLive) return false;
    try {
      return this.relay.publish(signEvent(draft, this.sec));
    } catch {
      return false;
    }
  }

  onEvent(cb: (subId: string, ev: NostrEvent) => void): vscode.Disposable {
    this.eventCbs.add(cb);
    return new vscode.Disposable(() => this.eventCbs.delete(cb));
  }

  onState(cb: (s: LiveState) => void): vscode.Disposable {
    this.stateCbs.add(cb);
    return new vscode.Disposable(() => this.stateCbs.delete(cb));
  }

  private setState(s: LiveState): void {
    this.state = s;
    this.stateCbs.forEach((cb) => cb(s));
  }

  dispose(): void {
    this.disposed = true;
    this.gen++;
    this.relay?.stop();
    this.relay = undefined;
  }
}
