// Nostr signatures (BIP-340 Schnorr) and event creation. Plain BigInt curve math, so it also runs in VS Code/Electron (sha256 is built in).
import { createHash, randomBytes } from 'crypto';
import { isHex64, liftX, mulG, mulPoint, NostrEvent, pointAdd, privateKeyHex, SECP_N, SECP_P } from './core';

const sha256 = (...parts: Buffer[]): Buffer => createHash('sha256').update(Buffer.concat(parts)).digest();
const tagHashes = new Map<string, Buffer>();
function tagged(tag: string, ...parts: Buffer[]): Buffer {
  let t = tagHashes.get(tag);
  if (!t) tagHashes.set(tag, (t = sha256(Buffer.from(tag, 'utf8'))));
  return sha256(t, t, ...parts);
}
const b32 = (n: bigint): Buffer => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
const int = (b: Buffer): bigint => BigInt('0x' + b.toString('hex'));

/** BIP-340 signature (64 bytes). aux is only passed in tests; normally random. */
export function schnorrSign(msg32: Buffer, secHex: string, aux: Buffer = randomBytes(32)): Buffer {
  const d0 = BigInt('0x' + secHex);
  if (d0 <= 0n || d0 >= SECP_N) throw new Error('Invalid private key');
  const P = mulG(d0)!;
  const d = P[1] % 2n === 0n ? d0 : SECP_N - d0;
  const t = b32(d);
  const a = tagged('BIP0340/aux', aux);
  for (let i = 0; i < 32; i++) t[i] ^= a[i];
  const k0 = int(tagged('BIP0340/nonce', t, b32(P[0]), msg32)) % SECP_N;
  if (k0 === 0n) throw new Error('Could not produce a signature');
  const R = mulG(k0)!;
  const k = R[1] % 2n === 0n ? k0 : SECP_N - k0;
  const e = int(tagged('BIP0340/challenge', b32(R[0]), b32(P[0]), msg32)) % SECP_N;
  return Buffer.concat([b32(R[0]), b32((k + e * d) % SECP_N)]);
}

/** BIP-340 verification. */
export function schnorrVerify(msg32: Buffer, pubHex: string, sig: Buffer): boolean {
  if (sig.length !== 64 || !isHex64(pubHex)) return false;
  const P = liftX(BigInt('0x' + pubHex));
  const r = int(sig.subarray(0, 32));
  const s = int(sig.subarray(32, 64));
  if (!P || r >= SECP_P || s >= SECP_N) return false;
  const e = int(tagged('BIP0340/challenge', sig.subarray(0, 32), b32(P[0]), msg32)) % SECP_N;
  const R = pointAdd(mulG(s), mulPoint(P, (SECP_N - e) % SECP_N));
  return !!R && R[1] % 2n === 0n && R[0] === r;
}

export type Draft = Pick<NostrEvent, 'kind' | 'tags' | 'content'> & { created_at?: number };

/** NIP-01 event id: sha256 of [0, pubkey, created_at, kind, tags, content]. */
export function eventId(e: Omit<NostrEvent, 'id' | 'sig'>): string {
  return sha256(Buffer.from(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]), 'utf8')).toString('hex');
}

export function signEvent(draft: Draft, key: string): NostrEvent {
  const sec = privateKeyHex(key);
  if (!sec) throw new Error('Invalid Nostr key');
  const pubkey = mulG(BigInt('0x' + sec))![0]
    .toString(16)
    .padStart(64, '0');
  const base = { pubkey, created_at: draft.created_at ?? Math.floor(Date.now() / 1000), kind: draft.kind, tags: draft.tags, content: draft.content };
  const id = eventId(base);
  return { ...base, id, sig: schnorrSign(Buffer.from(id, 'hex'), sec).toString('hex') };
}

export function verifyEvent(ev: NostrEvent): boolean {
  if (!ev.sig || eventId(ev) !== ev.id) return false;
  return schnorrVerify(Buffer.from(ev.id, 'hex'), ev.pubkey, Buffer.from(ev.sig, 'hex'));
}

const AUTH_KIND = 22242; // NIP-42

/** NIP-42 authentication event. */
export function authEvent(relayUrl: string, challenge: string, key: string): NostrEvent {
  return signEvent(
    {
      kind: AUTH_KIND,
      tags: [
        ['relay', relayUrl],
        ['challenge', challenge],
      ],
      content: '',
    },
    key,
  );
}

/** WebSocket address for an http(s) relay address. */
export function wsUrl(relay: string): string {
  return relay
    .trim()
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:')
    .replace(/\/+$/, '');
}

/** A relay payload shaped like an event; anything else is ignored rather than trusted. */
export function isNostrEvent(x: unknown): x is NostrEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    isHex64(String(e.id ?? '')) &&
    isHex64(String(e.pubkey ?? '')) &&
    typeof e.kind === 'number' &&
    typeof e.created_at === 'number' &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags) &&
    e.tags.every((tag) => Array.isArray(tag) && tag.every((v) => typeof v === 'string'))
  );
}
