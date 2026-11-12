// Live WebSocket connection to the relay: NIP-42 authentication, subscriptions, reconnect on drop.
// The key is kept in memory only and used to sign the AUTH event and our own ephemeral events (typing).
import WebSocket from 'ws';
import { isCertificateError, NostrEvent } from './core';
import { authEvent, isNostrEvent } from './nostr';

export type LiveStateName = 'off' | 'connecting' | 'live' | 'offline' | 'error';
export interface LiveState {
  state: LiveStateName;
  detail?: string;
  reason?: 'certificate'; // the relay's TLS certificate is not trusted on this computer
}

/** The answer to a one-shot read: `complete` only when the relay said it sent everything (EOSE). */
export interface QueryResult {
  events: NostrEvent[];
  complete: boolean;
  reason: 'eose' | 'closed' | 'timeout' | 'disconnected';
}

export interface LiveOptions {
  authWaitMs?: number; // if the relay sends no challenge, subscribe after this long
  backoffMs?: number[]; // reconnect delays
  pingMs?: number; // heartbeat: a connection that does not answer a ping within this time is dropped
  stableMs?: number; // the backoff starts over only after the connection stayed up this long
  log?: (line: string) => void;
}

type Filter = Record<string, unknown>;

export class LiveRelay {
  private ws?: WebSocket;
  private readonly subs = new Map<string, Filter[]>();
  private readonly queries = new Map<string, { got: NostrEvent[]; done: (reason: QueryResult['reason']) => void }>(); // one-shot reads in flight
  private authed = false;
  private openWithoutAuth = false;
  private pendingAuth?: string;
  private stopped = true;
  private attempt = 0;
  private retryTimer?: NodeJS.Timeout;
  private authTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private readonly eventCbs = new Set<(subId: string, ev: NostrEvent) => void>();
  private readonly stateCbs = new Set<(s: LiveState) => void>();
  state: LiveState = { state: 'off' };

  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly opts: LiveOptions = {},
  ) {}

  onEvent(cb: (subId: string, ev: NostrEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  onState(cb: (s: LiveState) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.authTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.stableTimer);
    const ws = this.ws;
    this.ws = undefined;
    for (const q of [...this.queries.values()]) q.done('disconnected');
    ws?.removeAllListeners();
    ws?.on('error', () => undefined);
    ws?.terminate();
    this.setState({ state: 'off' });
  }

  subscribe(id: string, filters: Filter[]): void {
    this.subs.set(id, filters);
    if (this.ready) this.send(['REQ', id, ...filters]);
  }

  unsubscribe(id: string): void {
    if (this.subs.delete(id) && this.ready) this.send(['CLOSE', id]);
  }

  /**
   * One-shot read: the events matching `filters`, until the relay says it has sent everything (EOSE) or the time
   * is up. Undefined when not connected; what arrived so far when the connection drops meanwhile.
   */
  query(filters: Filter[], timeoutMs = 4000): Promise<QueryResult | undefined> {
    if (!this.ready) return Promise.resolve(undefined);
    const id = 'q-' + Math.random().toString(36).slice(2, 10);
    return new Promise((resolve) => {
      const got: NostrEvent[] = [];
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      const done = (reason: QueryResult['reason']) => {
        clearTimeout(timer);
        if (!this.queries.delete(id)) return;
        this.send(['CLOSE', id]);
        resolve({ events: got, complete: reason === 'eose', reason });
      };
      this.queries.set(id, { got, done });
      this.send(['REQ', id, ...filters]);
    });
  }

  /** Send a signed event over the open connection. Returns false when not connected (nothing is queued). */
  publish(ev: NostrEvent): boolean {
    if (!this.ready) return false;
    this.send(['EVENT', ev]);
    return true;
  }

  private get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && (this.authed || this.openWithoutAuth);
  }

  private log(s: string): void {
    this.opts.log?.(s);
  }

  private setState(s: LiveState): void {
    if (s.state === this.state.state && s.detail === this.state.detail) return;
    this.state = s;
    this.log(`state: ${s.state}${s.detail ? ` (${s.detail})` : ''}`);
    for (const cb of this.stateCbs) cb(s);
  }

  private send(msg: unknown[]): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      /* the connection is closing; subscriptions are re-sent after reconnecting */
    }
  }

  private flushSubs(): void {
    for (const [id, f] of this.subs) this.send(['REQ', id, ...f]);
  }

  /** Live from now on. The backoff starts over only once the connection proved stable (no tight loop on a flapping relay). */
  private goLive(ws: WebSocket, detail?: string): void {
    this.setState(detail ? { state: 'live', detail } : { state: 'live' });
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      if (this.ws === ws) this.attempt = 0;
    }, this.opts.stableMs ?? 30000);
    this.flushSubs();
  }

  /**
   * After sleep or a VPN switch a socket can die without a close ever arriving. A ping that gets no pong
   * before the next one ends the connection, and the normal reconnect takes over.
   */
  private heartbeat(ws: WebSocket): void {
    clearInterval(this.pingTimer);
    let waiting = false;
    ws.on('pong', () => (waiting = false));
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return clearInterval(this.pingTimer);
      if (waiting) {
        this.log('no answer to ping: reconnecting');
        ws.terminate();
        return;
      }
      waiting = true;
      try {
        ws.ping();
      } catch {
        /* closing */
      }
    }, this.opts.pingMs ?? 30000);
  }

  private connect(): void {
    if (this.stopped) return;
    this.authed = false;
    this.openWithoutAuth = false;
    this.pendingAuth = undefined;
    this.setState({ state: 'connecting' });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 10000 });
    } catch (e) {
      this.setState({ state: 'error', detail: (e as Error).message });
      return this.retry();
    }
    this.ws = ws;
    ws.on('open', () => {
      this.log('connected');
      this.heartbeat(ws);
      // Buzz sends a challenge first; no challenge means the relay doesn't require auth
      this.authTimer = setTimeout(() => {
        if (!this.authed && this.ws === ws) {
          this.openWithoutAuth = true;
          this.goLive(ws, 'no auth required');
        }
      }, this.opts.authWaitMs ?? 2500);
    });
    ws.on('message', (data) => this.onMessage(ws, data.toString()));
    let certificate: string | undefined; // why TLS refused the relay, if it did
    ws.on('error', (e) => {
      this.log(`error: ${e.message}`);
      if (isCertificateError(e)) certificate = e.message;
    });
    ws.on('close', (code) => {
      clearTimeout(this.authTimer);
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      clearTimeout(this.stableTimer);
      this.ws = undefined;
      this.authed = false;
      for (const q of [...this.queries.values()]) q.done('disconnected'); // whatever a read got so far, marked incomplete
      if (this.stopped) return;
      // a certificate this computer does not trust is said as such (it will not go away by retrying, though it is retried)
      if (this.state.state !== 'error') {
        this.setState(
          certificate ? { state: 'error', detail: certificate, reason: 'certificate' } : { state: 'offline', detail: `connection closed (${code})` },
        );
      }
      this.retry();
    });
  }

  private retry(): void {
    if (this.stopped) return;
    const steps = this.opts.backoffMs ?? [1000, 2000, 5000, 10000, 30000];
    const ms = steps[Math.min(this.attempt, steps.length - 1)];
    this.attempt++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), ms);
  }

  private onMessage(ws: WebSocket, raw: string): void {
    if (this.ws !== ws) return;
    let msg: unknown[];
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    switch (msg[0]) {
      case 'AUTH': {
        const challenge = String(msg[1] ?? '');
        const ev = authEvent(this.url, challenge, this.key);
        this.pendingAuth = ev.id;
        this.send(['AUTH', ev]);
        break;
      }
      case 'OK':
        if (msg[1] === this.pendingAuth) {
          this.pendingAuth = undefined;
          clearTimeout(this.authTimer);
          if (msg[2] === true) {
            this.authed = true;
            this.openWithoutAuth = false;
            this.goLive(ws);
          } else {
            this.setState({ state: 'error', detail: `authentication failed: ${String(msg[3] ?? '')}` });
            ws.close();
          }
        }
        break;
      case 'EVENT': {
        const ev = msg[2];
        if (typeof msg[1] === 'string' && isNostrEvent(ev)) {
          const q = this.queries.get(msg[1]);
          if (q) q.got.push(ev);
          else for (const cb of this.eventCbs) cb(msg[1], ev);
        }
        break;
      }
      case 'EOSE':
        this.queries.get(String(msg[1] ?? ''))?.done('eose');
        break;
      case 'CLOSED': {
        const id = String(msg[1] ?? '');
        const why = String(msg[2] ?? '');
        const q = this.queries.get(id);
        if (q) q.done('closed');
        if (q || why) this.log(`subscription closed ${id}: ${why}`); // a CLOSED answering our own CLOSE says nothing
        // a request sent before authentication finished: flushSubs re-sends it once authenticated
        break;
      }
      case 'NOTICE':
        this.log(`relay: ${String(msg[1] ?? '')}`);
        break;
    }
  }
}
