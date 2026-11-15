// SPDX-License-Identifier: Apache-2.0 (the service kit only; the rest of Little Dipper is AGPL-3.0)
/**
 * Little Dipper's wire protocol, standalone: identity, signing and signed envelopes. No framework, no storage, only
 * node:crypto, so anything that wants to talk to Little Dippers can use it (the service kit, Big Dipper, a business).
 *
 * This must stay byte-for-byte compatible with server/src/crypto.ts and server/src/federation.ts in this repo:
 * same canonical JSON, Ed25519 over it, the same "ldn_" IDs and the same envelope checks. kit/selftest.ts checks
 * the kit against a real node.
 */
import crypto from 'node:crypto';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36).padStart(9, '0')}${crypto.randomBytes(6).toString('hex')}`;

/** Deterministic JSON: object keys sorted recursively, undefined dropped. This is what gets signed. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

/** An identity: the public key (DER SPKI, base64), the private key (DER PKCS8, base64) and the ID derived from it. */
export type Identity = { id: string; publicKey: string; privateKey: string };

/** ID = "ldn_" + base32(sha256(publicKey)), first 26 characters. Self-certifying: anyone can check it against the key. */
export function idFromPublicKey(publicKeyB64: string): string {
  return 'ldn_' + base32(crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest()).slice(0, 26);
}

/**
 * A stable identity from a secret, so a service keeps the same ID across restarts and redeploys without storing a
 * key file: the secret is hashed to the 32-byte Ed25519 seed. Anyone with the secret can act as the service.
 */
export function identityFromSecret(secret: string): Identity {
  if (!secret || secret.length < 16) throw new Error('The identity secret must be at least 16 characters');
  const seed = crypto.createHash('sha256').update(`little-dipper-service-identity:${secret}`).digest();
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const priv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).toString('base64');
  return { id: idFromPublicKey(publicKey), publicKey, privateKey: pkcs8.toString('base64') };
}

export function sign(privateKeyB64: string, payload: unknown): string {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64');
}

export function verify(publicKeyB64: string, payload: unknown, signatureB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** A signed message: the payload (with from, ts and nonce added) and a signature over its canonical JSON. */
export type Envelope<T = Record<string, unknown>> = { payload: T & { from: string; ts: number; nonce: string }; signature: string };

export function envelope<T extends object>(me: Identity, payload: T): Envelope<T> {
  const p = { ...payload, from: me.id, ts: Date.now(), nonce: randomToken(12) };
  return { payload: p, signature: sign(me.privateKey, p) };
}

export class ProtocolError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message || code); }
}

const SKEW_MS = 10 * 60_000;
const seen = new Map<string, number>();

/** Check signature, freshness (10 minutes either way) and replay. Returns the payload. */
export function openEnvelope<T>(body: unknown, publicKeyB64: string): Envelope<T>['payload'] {
  const env = body as Envelope<T>;
  if (!env || typeof env !== 'object' || !env.payload || typeof env.signature !== 'string') throw new ProtocolError(400, 'bad_envelope');
  if (!verify(publicKeyB64, env.payload, env.signature)) throw new ProtocolError(401, 'bad_signature');
  if (Math.abs(Date.now() - Number(env.payload.ts)) > SKEW_MS) throw new ProtocolError(401, 'stale_message');
  const k = `${env.payload.from}:${env.payload.nonce}`;
  if (seen.has(k)) throw new ProtocolError(409, 'replayed');
  seen.set(k, Date.now());
  if (seen.size > 5000) for (const [key, t] of seen) if (Date.now() - t > SKEW_MS) seen.delete(key);
  return env.payload;
}

/** What /.well-known/little-dipper answers. `kind: 'service'` marks something that interacts but holds no one's life. */
export type Descriptor = {
  nodeId: string; version: string; signingKey: string; displayName: string | null; address: string;
  connectRequests: string; claimed: boolean; kind?: 'node' | 'service'; capabilities?: string[];
};

export const origin = (address: string) => new URL(/^https?:\/\//.test(address) ? address : `https://${address}`).origin;

async function call(url: string, init: RequestInit & { json?: unknown } = {}, timeoutMs = 15_000) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  }).catch(() => { throw new ProtocolError(502, 'peer_unreachable', `Couldn't reach ${new URL(url).host}`); });
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, data };
}

/** Fetch another party's descriptor and check its ID really comes from its key. */
export async function lookupDescriptor(address: string): Promise<Descriptor> {
  const r = await call(`${origin(address)}/.well-known/little-dipper`);
  const d = r.data as Descriptor | null;
  if (!r.ok || !d?.nodeId || !d.signingKey) throw new ProtocolError(502, 'not_little_dipper', 'No Little Dipper answered at that address');
  if (idFromPublicKey(d.signingKey) !== d.nodeId) throw new ProtocolError(502, 'identity_mismatch');
  return d;
}

/** POST a signed envelope. If `peerKey` is given, the answer must be signed by it too. */
export async function sendSigned<R = Record<string, unknown>>(me: Identity, address: string, path: string, payload: object, peerKey?: string): Promise<R> {
  const r = await call(`${origin(address)}${path}`, { method: 'POST', json: envelope(me, payload) });
  if (!r.ok) throw new ProtocolError(r.status, String(r.data?.code || 'peer_error'), String(r.data?.message || `They answered ${r.status}`));
  return (peerKey ? openEnvelope<R>(r.data, peerKey) : r.data || {}) as R;
}
