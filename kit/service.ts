// SPDX-License-Identifier: Apache-2.0 (the service kit only; the rest of Little Dipper is AGPL-3.0)
/**
 * The service kit: lets an organisation take part in the Little Dipper network without running a node. A service
 * has an identity and offers capabilities (feedback, verification, ...); people's nodes connect to it the way they
 * connect to anyone, and call its capabilities with signed requests. It holds no one's life and asks for no profile.
 *
 * Stateless by design: a caller is checked by its signature and by the key its own public address publishes, so a
 * service needs no database to start with. Storage, if a service wants it, is the service's business (onConnected,
 * onDisconnected).
 *
 * Framework-free: `handle()` takes a method, path, headers and body and returns a status and body. fastifyAdapter()
 * mounts it on Fastify; any other server can call handle() the same way.
 *
 * What a node expects from anyone it connects to (see server/src/routes/peer.ts):
 *   GET  /.well-known/little-dipper          the descriptor (kind: 'service', capabilities)
 *   POST /peer/requests                      a connection request; a service answers by accepting (or declining)
 *   POST /peer/links/revoke | /changed       the node disconnected / changed what it shares
 *   POST /peer/messages                      a message from the node
 *   GET  /peer/profile | /domains | /fields  what the service shares with the node: nothing
 * And the capabilities themselves:
 *   POST /peer/services/:capability          a signed call; answered with a signed result
 */
import {
  lookupDescriptor, newId, openEnvelope, origin, ProtocolError, sendSigned, envelope,
  type Descriptor, type Identity,
} from './protocol.js';

/** A node that called us, verified: its ID, its public address and the key that address publishes. */
export type Caller = { id: string; address: string; signingKey: string; displayName: string | null; version: string | null };

export type CapabilityHandler = (call: { caller: Caller; data: Record<string, unknown> }) => Promise<Record<string, unknown>>;

export type ServiceOptions = {
  identity: Identity;
  /** The public address nodes reach this service at, e.g. https://service.example.com */
  address: string;
  displayName: string;
  version: string;
  /** Capability name → handler. Names are advertised in the descriptor (e.g. "feedback"). */
  capabilities: Record<string, CapabilityHandler>;
  /** Decide whether to accept a connection request. Default: accept every verified node. */
  acceptRequest?: (caller: Caller, note: string) => Promise<boolean> | boolean;
  onConnected?: (caller: Caller) => void | Promise<void>;
  onDisconnected?: (callerId: string) => void | Promise<void>;
  onMessage?: (callerId: string, message: Record<string, unknown>) => void | Promise<void>;
  log?: (msg: string, extra?: unknown) => void;
  /** How long to wait before answering a request, so the node has finished saving it. */
  acceptDelayMs?: number;
};

export type Reply = { status: number; body: unknown };

const DESCRIPTOR_TTL_MS = 10 * 60_000;

export function createService(o: ServiceOptions) {
  const address = origin(o.address);
  const me = o.identity;
  const log = o.log ?? (() => {});
  const cache = new Map<string, { d: Descriptor; at: number }>();

  const descriptor = (): Descriptor => ({
    nodeId: me.id, version: o.version, signingKey: me.publicKey, displayName: o.displayName, address,
    connectRequests: 'anyone', claimed: true, kind: 'service', capabilities: Object.keys(o.capabilities),
  });

  /** The caller's descriptor, from its own address, cached briefly. Its ID must be the one that signed. */
  async function callerAt(addr: string, id: string): Promise<Caller> {
    const key = origin(addr);
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > DESCRIPTOR_TTL_MS) { hit = { d: await lookupDescriptor(key), at: Date.now() }; cache.set(key, hit); }
    if (hit.d.nodeId !== id) { cache.delete(key); throw new ProtocolError(401, 'address_mismatch', 'That address belongs to someone else'); }
    return { id, address: key, signingKey: hit.d.signingKey, displayName: hit.d.displayName, version: hit.d.version ?? null };
  }

  /** Callers verified since this process started, by ID: for the node messages that don't repeat their address. */
  const known = new Map<string, Caller>();

  /**
   * Verify a signed body. Requests and capability calls name the sender's address (fromNode.address, address), which
   * is checked against what that address publishes. Other messages (disconnect, a chat message) only carry the ID,
   * so they verify against a caller seen before; null if we've never seen it (nothing to do statelessly).
   */
  async function verified<T>(body: unknown): Promise<{ caller: Caller; payload: T }>;
  async function verified<T>(body: unknown, optional: true): Promise<{ caller: Caller; payload: T } | null>;
  async function verified<T>(body: unknown, optional = false) {
    const p = (body as { payload?: { from?: string; address?: string; fromNode?: { address?: string } } })?.payload;
    if (!p?.from) throw new ProtocolError(400, 'bad_envelope');
    const addr = p.fromNode?.address || p.address;
    const caller = addr ? await callerAt(addr, p.from) : known.get(p.from);
    if (!caller) { if (optional) return null; throw new ProtocolError(404, 'unknown_peer', 'Signed requests must say where the sender lives'); }
    const payload = openEnvelope<T>(body, caller.signingKey) as T;
    known.set(caller.id, caller);
    return { caller, payload };
  }

  const signed = (payload: object) => envelope(me, payload);

  async function onRequest(body: unknown): Promise<Reply> {
    const { caller, payload } = await verified<{ type: string; requestId: string; to: string; note?: string }>(body);
    if (payload.type !== 'connect.request' || payload.to !== me.id) throw new ProtocolError(400, 'wrong_recipient');
    const yes = await (o.acceptRequest ?? (() => true))(caller, String(payload.note || ''));
    // Answer after replying, the way a person would: the node saves its side of the request first.
    setTimeout(async () => {
      const path = `/peer/requests/${encodeURIComponent(payload.requestId)}/${yes ? 'accept' : 'decline'}`;
      try {
        await sendSigned(me, caller.address, path, { type: yes ? 'connect.accept' : 'connect.decline', requestId: payload.requestId, version: o.version }, yes ? caller.signingKey : undefined);
        if (yes) await o.onConnected?.(caller);
        log(`[service] ${yes ? 'connected' : 'declined'} ${caller.id} (${caller.address})`);
      } catch (e) {
        log(`[service] couldn't answer ${caller.id}'s request`, e);
      }
    }, o.acceptDelayMs ?? 1500);
    return { status: 202, body: { received: true } };
  }

  async function onCapability(name: string, body: unknown): Promise<Reply> {
    const handler = o.capabilities[name];
    if (!handler) throw new ProtocolError(404, 'not_supported', `This service doesn't offer ${name}`);
    const { caller, payload } = await verified<{ type: string; to: string; capability: string; data?: Record<string, unknown> }>(body);
    if (payload.type !== 'service.call' || payload.to !== me.id || payload.capability !== name) throw new ProtocolError(400, 'wrong_recipient');
    const result = await handler({ caller, data: payload.data ?? {} });
    return { status: 200, body: signed({ type: 'service.result', capability: name, result }) };
  }

  /** Route one request. Errors come back as { code, message } with a status, the way nodes report them. */
  async function handle(method: string, path: string, body: unknown): Promise<Reply> {
    const p = path.split('?')[0];
    try {
      if (method === 'GET' && p === '/.well-known/little-dipper') return { status: 200, body: descriptor() };
      // A service shares nothing about anyone: the node's sync finds empty lists, not errors.
      if (method === 'GET' && p === '/peer/profile') return { status: 200, body: { fields: [] } };
      if (method === 'GET' && p === '/peer/fields') return { status: 200, body: { fields: [] } };
      if (method === 'GET' && p === '/peer/domains') return { status: 200, body: { domains: [] } };
      if (method !== 'POST') return { status: 404, body: { code: 'not_found', message: `No route for ${method} ${p}` } };
      if (p === '/peer/requests') return await onRequest(body);
      const cap = p.match(/^\/peer\/services\/([a-z][a-z0-9.-]{0,40})$/);
      if (cap) return await onCapability(cap[1], body);
      if (p === '/peer/links/revoke') {
        const v = await verified(body, true);
        if (v) { known.delete(v.caller.id); await o.onDisconnected?.(v.caller.id); }
        return { status: 200, body: { ok: true } };
      }
      // Nothing to sync and nothing stored about where they live: acknowledged.
      if (p === '/peer/links/changed') return { status: 202, body: { ok: true } };
      if (p === '/peer/address-change') { cache.clear(); return { status: 202, body: { updated: true } }; }
      if (p === '/peer/messages') {
        const { caller, payload } = await verified<Record<string, unknown>>(body);
        await o.onMessage?.(caller.id, payload);
        return { status: 201, body: { received: true, id: payload.id, duplicate: false } };
      }
      return { status: 404, body: { code: 'not_found', message: `No route for ${method} ${p}` } };
    } catch (e) {
      if (e instanceof ProtocolError) return { status: e.status, body: { code: e.code, message: e.message } };
      log('[service] error', e);
      return { status: 500, body: { code: 'internal', message: 'Something went wrong at this service.' } };
    }
  }

  /** Send a text message into a connected node's Messages. */
  async function sendMessage(to: Caller, text: string) {
    await sendSigned(me, to.address, '/peer/messages', {
      type: 'message', id: newId('msg'), to: to.id, conversation: null, kind: 'text', body: text, inReplyTo: null, attachments: [], createdAt: new Date().toISOString(),
    });
  }

  return { descriptor, handle, sendMessage, identity: me, address };
}

export type Service = ReturnType<typeof createService>;

type Req = { method: string; url: string; body?: unknown };
type Res = { code: (n: number) => { send: (b: unknown) => unknown } };

/** Mount a service on Fastify: the descriptor and everything under /peer/, nothing else. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Fastify instance; the kit doesn't depend on Fastify's types
export function fastifyAdapter(app: { route: (opts: any) => unknown }, svc: Service) {
  const handler = async (req: Req, reply: Res) => {
    const r = await svc.handle(req.method, req.url, req.body);
    return reply.code(r.status).send(r.body);
  };
  app.route({ method: 'GET', url: '/.well-known/little-dipper', handler });
  app.route({ method: ['GET', 'POST'], url: '/peer/*', handler });
}
