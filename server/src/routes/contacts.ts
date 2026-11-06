import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { fingerprint, newId, randomToken } from '../crypto.js';
import { audit, ownerActor } from '../audit.js';
import { bad, HttpError, notFound, requireOwner } from '../auth.js';
import { allFields, type FieldDoc } from '../fields.js';
import { getDomain, partyReferences, unlinkParty } from '../domains/records.js';
import { checkMethods } from '../methods.js';
import { canonicalUrl, displayAddr, getNode } from '../node.js';
import { getOwner } from '../owner.js';
import {
  grantsFor, lookupDescriptor, mutualHints, now, parsePeerInput, REQUEST_TTL_DAYS, sealToken, sendSigned, setDomainGrant, setFieldGrant, setProfileGrant, tokenHash,
  type PartyDoc, type InviteDoc, type LinkDoc, type PublicProfileDoc, type RequestDoc,
} from '../federation.js';
import {
  nudgePeers, partyOut, endLink, existingForNode, firstName, issuePeerToken, linkFor, newNodeParty, pushTimeline, revokeIssuedToken, syncContact,
} from '../contacts.js';

const STALE_MS = 10 * 60_000;

async function getContact(id: string) {
  const c = await ctx.store.get<PartyDoc>('parties', id);
  if (!c) throw notFound('party_not_found');
  return c;
}

const TYPES = ['person', 'organisation'] as const;
type PartyInput = { type?: string; name?: string; notes?: string; methods?: unknown; affiliations?: { party?: string; role?: string }[] };

/** Validated affiliations: each points to an organisation that exists, never to the party itself. */
async function checkAffiliations(list: PartyInput['affiliations'], self: string | null) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > 20) throw bad('invalid_value', 'Affiliations must be a list (up to 20)');
  const out: PartyDoc['affiliations'] = [];
  for (const a of list) {
    const org = await ctx.store.get<PartyDoc>('parties', String(a?.party));
    if (!org || org._id === self) throw bad('invalid_value', 'An affiliation points to an organisation in your parties');
    if (org.type !== 'organisation') throw bad('invalid_value', `${org.name} is a person, not an organisation`);
    out.push({ party: org._id, role: String(a.role || '').trim().slice(0, 80) });
  }
  return out;
}

/** What we tell a peer about ourselves in a request. */
async function selfIntro() {
  const n = await getNode();
  const o = await getOwner();
  const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
  return { nodeId: n._id, address: canonicalUrl(n), signingKey: n.signingKey.publicKey, displayName: pp?.displayName || o?.displayName || 'Little Dipper owner', version: n.version };
}

async function labelsFor(keys: string[]) {
  const fields = await allFields();
  return keys.map((k) => fields.find((f) => f.key === k)?.label).filter(Boolean) as string[];
}

async function sendRequest(link: LinkDoc, offeredFields: string[], note: string, invite: string | null) {
  const offeredLabels = [...(await allFields()).filter((f) => f.sensitivity === 'standard' && f.value).map((f) => f.label), ...(await labelsFor(offeredFields))];
  await sendSigned(link.peerUrl, '/peer/requests', {
    type: 'connect.request', requestId: link.requestId, to: link.peerNodeId, fromNode: await selfIntro(),
    offeredFields, offeredLabels, requestedFields: [], note, invite, mutualHints: await mutualHints(link.peerNodeId),
  });
}

/** Look up a node and send it a signed connection request. shareProfile: grant the basic profile once they approve. */
export async function requestConnection(keyId: string, address: string, offeredFields: string[], note: string, shareProfile: boolean) {
  const { origin, invite } = parsePeerInput(address);
  const d = await lookupDescriptor(origin);
  const n = await getNode();
  if (d.nodeId === n._id) throw bad('self', "That's your own Little Dipper");
  const existing = await existingForNode(d.nodeId);
  if (existing && existing.link.status === 'active') throw new HttpError(409, 'already_connected', `You're already connected with ${existing.contact.name}`);
  if (existing && existing.link.status === 'pending_in') throw new HttpError(409, 'request_waiting', `${existing.contact.name} already asked to connect. Review their request instead.`);
  if (existing) throw new HttpError(409, 'request_pending', `You already asked ${existing.contact.name}. Use Resend on their contact page.`);
  const fields = await allFields();
  const offered = offeredFields.filter((k) => fields.some((f) => f.key === k && f.sensitivity === 'sensitive'));
  const requestId = newId('req');
  const name = d.displayName || displayAddr(d.address);
  const { contact, link } = await newNodeParty({ name, address: d.address, nodeId: d.nodeId, signingKey: d.signingKey, version: d.version, status: 'pending_out', requestId });
  try {
    await sendRequest(link, offered, note.slice(0, 500), invite);
  } catch (e) {
    await ctx.store.remove('parties', contact._id);
    await ctx.store.remove('nodeLinks', link._id);
    throw e;
  }
  // What we'll share once they approve: basic profile (unless told not to; no grant at all means shared) + the extras we offered.
  await setProfileGrant(contact._id, shareProfile);
  for (const k of offered) await setFieldGrant(contact._id, k, true);
  const t = now();
  await ctx.store.insert<RequestDoc>('connectionRequests', {
    _id: newId('req'), direction: 'out', requestId, fromNodeId: n._id, peerName: name, fromNode: displayAddr(canonicalUrl(n)), toNode: displayAddr(d.address),
    offeredFields: offered, offeredLabels: [], requestedFields: [], note, nonce: randomToken(8), signature: '', inviteId: null,
    quiet: false, status: 'pending', contactId: contact._id, linkId: link._id, createdAt: t, expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86400_000).toISOString(),
  });
  await audit({ actor: ownerActor(keyId), action: 'link.request.out', resource: `parties/${contact._id}`, text: `You sent ${name} a connection request`, tone: 'request' });
  return { delivered: true, contactId: contact._id, requestId };
}

export default async function contactRoutes(app: FastifyInstance) {
  // ── parties ──────────────────────────────────────────────────────────
  app.get('/api/parties', async (req) => {
    await requireOwner(req, 'parties:read');
    const q = req.query as { type?: string; status?: string; q?: string };
    const all = await ctx.store.find<PartyDoc>('parties', {}, { sort: { createdAt: -1 } });
    const items = await Promise.all(all.map((c) => partyOut(c)));
    const term = (q.q || '').toLowerCase();
    return { items: items.filter((c) => (!q.type || c.type === q.type) && (!q.status || c.status === q.status) && (!term || c.name.toLowerCase().includes(term))) };
  });

  app.post('/api/parties', async (req, reply) => {
    const p = await requireOwner(req, 'parties:write');
    const b = (req.body || {}) as PartyInput;
    const name = String(b.name || '').trim().slice(0, 200);
    if (!name) throw bad('name_required', 'Add a name first');
    if (!TYPES.includes(b.type as never)) throw bad('invalid_value', 'Type: person or organisation');
    const t = now();
    const c: PartyDoc = {
      _id: newId('pty'), type: b.type as PartyDoc['type'], name, methods: checkMethods(b.methods), notes: String(b.notes || '').slice(0, 10000),
      affiliations: (await checkAffiliations(b.affiliations, null)) ?? [], node: null, sharedIn: [], sharedInFetchedAt: null, createdAt: t,
    };
    await ctx.store.insert('parties', c);
    await audit({ actor: ownerActor(p.key._id), action: 'party.create', resource: `parties/${c._id}`, text: `You added ${name}`, tone: 'owner' });
    reply.code(201);
    return partyOut(c, { detail: true });
  });

  app.get('/api/parties/:id', async (req) => {
    await requireOwner(req, 'parties:read');
    let c = await getContact((req.params as { id: string }).id);
    const link = await linkFor(c);
    let syncError: string | null = null;
    const stale = !c.sharedInFetchedAt || Date.now() - new Date(c.sharedInFetchedAt).getTime() > STALE_MS;
    if (link?.status === 'active' && (stale || (req.query as { sync?: string }).sync)) {
      try { c = await syncContact(c); } catch (e) { syncError = (e as Error).message; }
    }
    return { ...(await partyOut(c, { detail: true })), usedBy: await partyReferences(c._id), syncError };
  });

  app.patch('/api/parties/:id', async (req) => {
    const p = await requireOwner(req, 'parties:write');
    const c = await getContact((req.params as { id: string }).id);
    const b = (req.body || {}) as PartyInput;
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) {
      if (!String(b.name).trim()) throw bad('name_required', 'A party needs a name');
      patch.name = String(b.name).trim().slice(0, 200);
    }
    if (b.type !== undefined) {
      if (!TYPES.includes(b.type as never)) throw bad('invalid_value', 'Type: person or organisation');
      patch.type = b.type;
    }
    if (b.notes !== undefined) patch.notes = String(b.notes).slice(0, 10000);
    if (b.methods !== undefined) patch.methods = checkMethods(b.methods);
    const aff = await checkAffiliations(b.affiliations, c._id);
    if (aff) patch.affiliations = aff;
    await ctx.store.update('parties', c._id, patch);
    await audit({ actor: ownerActor(p.key._id), action: 'party.update', resource: `parties/${c._id}`, text: `You edited ${c.name}`, tone: 'owner' });
    return partyOut((await ctx.store.get<PartyDoc>('parties', c._id))!, { detail: true });
  });

  /** Entries that point to a party stop pointing to it, so nothing dangles. Without confirm:true, says what would change. */
  app.delete('/api/parties/:id', async (req) => {
    const p = await requireOwner(req, 'parties:write');
    const c = await getContact((req.params as { id: string }).id);
    const usedBy = await partyReferences(c._id);
    if (usedBy.length && (req.query as { confirm?: string }).confirm !== 'true') {
      throw new HttpError(409, 'in_use', `${usedBy.length} ${usedBy.length === 1 ? 'entry points' : 'entries point'} to ${c.name}. Deleting removes ${c.name} from ${usedBy.length === 1 ? 'it' : 'them'}.`, { usedBy });
    }
    const link = await linkFor(c);
    if (link && link.status === 'active') {
      try { await sendSigned(link.peerUrl, '/peer/links/revoke', { type: 'link.revoke' }); } catch { /* peer offline: our side still revokes */ }
    }
    if (link) { await revokeIssuedToken(link); await ctx.store.remove('nodeLinks', link._id); }
    await ctx.store.removeMany('grants', { contactId: c._id });
    await ctx.store.removeMany('connectionRequests', { contactId: c._id });
    await ctx.store.removeMany('messages', { contactId: c._id });
    // Links sent to them stop working; the copies stay in your history.
    for (const cp of await ctx.store.find<{ _id: string; revokedAt: string | null }>('copies', { contactId: c._id })) {
      if (!cp.revokedAt) await ctx.store.update('copies', cp._id, { revokedAt: now() });
    }
    await unlinkParty(c._id, ownerActor(p.key._id).id);
    for (const o of await ctx.store.find<PartyDoc>('parties', {})) {
      if (o.affiliations?.some((a) => a.party === c._id)) await ctx.store.update('parties', o._id, { affiliations: o.affiliations.filter((a) => a.party !== c._id) });
    }
    await ctx.store.remove('parties', c._id);
    await audit({ actor: ownerActor(p.key._id), action: 'party.delete', resource: `parties/${c._id}`, text: `You deleted ${c.name}`, tone: 'owner' });
    return { deleted: true, unlinked: usedBy.length };
  });

  app.get('/api/parties/:id/grants', async (req) => {
    await requireOwner(req, 'parties:read');
    const c = await getContact((req.params as { id: string }).id);
    const g = await grantsFor(c._id);
    return { profile: g.profile, fields: g.fields };
  });

  /**
   * Body: { profile?: boolean, fields?: { [key]: boolean }, domains?: { [domain]: false | true | { scope?: 'all'|'current', includeSecret?: boolean } }, confirm?: boolean }
   * Secret fields, secret domains and includeSecret need confirm:true.
   */
  app.put('/api/parties/:id/grants', async (req) => {
    const p = await requireOwner(req, 'parties:write');
    const c = await getContact((req.params as { id: string }).id);
    if (!c.node) throw bad('not_connected', 'Only people and organisations on Little Dipper can be granted access');
    const b = (req.body || {}) as { profile?: boolean; fields?: Record<string, boolean>; domains?: Record<string, boolean | { scope?: 'all' | 'current'; includeSecret?: boolean }>; confirm?: boolean };
    const fields = await allFields();
    const changes: string[] = [];
    if (typeof b.profile === 'boolean') {
      await setProfileGrant(c._id, b.profile);
      changes.push(`basic profile ${b.profile ? 'on' : 'off'}`);
    }
    for (const [key, on] of Object.entries(b.fields || {})) {
      const f = fields.find((x) => x.key === key) as FieldDoc | undefined;
      if (!f) throw bad('unknown_field', key);
      if (on && f.sensitivity === 'secret' && b.confirm !== true) throw new HttpError(409, 'confirm_required', `Sharing ${f.label} needs confirmation`);
      await setFieldGrant(c._id, key, !!on, f.sensitivity === 'secret');
      changes.push(`${f.label} ${on ? 'shared' : 'unshared'}`);
    }
    for (const [id, v] of Object.entries(b.domains || {})) {
      const d = await getDomain(id);
      if (!d) throw bad('unknown_domain', id);
      if (!v) {
        await setDomainGrant(c._id, id, null);
        changes.push(`${d.label} unshared`);
        continue;
      }
      const g = v === true ? {} : v;
      const scope = g.scope === 'current' ? 'current' : 'all';
      const includeSecret = !!g.includeSecret;
      if ((d.sensitivity === 'secret' || includeSecret) && b.confirm !== true) throw new HttpError(409, 'confirm_required', `Sharing ${d.label} needs confirmation`);
      await setDomainGrant(c._id, id, { scope, includeSecret });
      changes.push(`${d.label} shared (${scope === 'current' ? 'current only' : 'all'}${includeSecret ? ', with secret details' : ''})`);
    }
    if (changes.length) {
      await audit({ actor: ownerActor(p.key._id), action: 'grant.update', resource: `parties/${c._id}/grants`, text: `Sharing with ${c.name}: ${changes.join(', ')}`, tone: 'owner' });
    }
    if (changes.length) nudgePeers([c._id]);
    const g = await grantsFor(c._id);
    return { profile: g.profile, fields: g.fields, domains: g.domains };
  });

  app.post('/api/parties/:id/invite', async (req) => {
    await requireOwner(req, 'parties:write');
    const c = await getContact((req.params as { id: string }).id);
    const inv = await createInvite('7d', []);
    const n = await getNode();
    const email = String(c.methods.find((m) => m.kind === 'email' && m.primary)?.value ?? c.methods.find((m) => m.kind === 'email')?.value ?? '');
    const o = await getOwner();
    const body = `Hi ${firstName(c.name)},\n\nI keep my contact details on Little Dipper, a personal data store I run myself. If you set one up too, open this link in it and we'll be connected:\n\n${inv.url}\n\nDon't have one yet? It's free and open source.\n\n${o?.displayName || ''}`;
    return { ...inv, to: email, subject: 'Connect with me on Little Dipper', body, address: displayAddr(canonicalUrl(n)) };
  });

  // ── federation (owner side) ──────────────────────────────────────────
  app.post('/api/federation/lookup', async (req) => {
    await requireOwner(req, 'parties:write');
    const { address } = (req.body || {}) as { address?: string };
    const { origin, invite } = parsePeerInput(String(address || ''));
    const d = await lookupDescriptor(origin);
    const n = await getNode();
    if (d.nodeId === n._id) throw bad('self', "That's your own Little Dipper");
    const existing = await existingForNode(d.nodeId);
    return {
      nodeId: d.nodeId, displayName: d.displayName, address: displayAddr(d.address), version: d.version,
      signingKey: fingerprint(d.signingKey),
      viaInvite: !!invite, acceptsRequests: !!invite || d.connectRequests !== 'off',
      existing: existing ? { contactId: existing.contact._id, status: existing.link.status } : null,
    };
  });

  app.post('/api/federation/requests', async (req, reply) => {
    const p = await requireOwner(req, 'parties:write');
    const b = (req.body || {}) as { address?: string; offeredFields?: string[]; note?: string };
    const out = await requestConnection(p.key._id, String(b.address || ''), b.offeredFields || [], String(b.note || ''), true);
    reply.code(202);
    return out;
  });

  app.get('/api/federation/requests', async (req) => {
    await requireOwner(req, 'parties:read');
    const q = req.query as { status?: string; direction?: string };
    for (const r of await ctx.store.find<RequestDoc>('connectionRequests', { status: 'pending' })) {
      if (new Date(r.expiresAt).getTime() < Date.now()) await ctx.store.update('connectionRequests', r._id, { status: 'expired' });
    }
    const items = await ctx.store.find<RequestDoc>('connectionRequests', { ...(q.status ? { status: q.status } : {}), ...(q.direction ? { direction: q.direction } : {}) }, { sort: { createdAt: -1 } });
    return { items: items.map(({ signature, nonce, ...r }) => r) };
  });

  app.post('/api/federation/requests/:id/resend', async (req) => {
    await requireOwner(req, 'parties:write');
    const r = await ctx.store.get<RequestDoc>('connectionRequests', (req.params as { id: string }).id);
    if (!r || r.direction !== 'out' || r.status !== 'pending') throw notFound('request_not_found');
    const link = (await ctx.store.get<LinkDoc>('nodeLinks', r.linkId))!;
    await sendRequest(link, r.offeredFields, r.note, null);
    await ctx.store.update('connectionRequests', r._id, { expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86400_000).toISOString() });
    return { delivered: true };
  });

  app.post('/api/federation/requests/:id/accept', async (req) => {
    const p = await requireOwner(req, 'parties:write');
    const r = await ctx.store.get<RequestDoc>('connectionRequests', (req.params as { id: string }).id);
    if (!r || r.direction !== 'in' || r.status !== 'pending') throw notFound('request_not_found');
    const link = (await ctx.store.get<LinkDoc>('nodeLinks', r.linkId))!;
    const contact = (await ctx.store.get<PartyDoc>('parties', r.contactId))!;
    const { secret, doc } = await issuePeerToken(contact);
    let theirs: { token?: string };
    try {
      theirs = await sendSigned(link.peerUrl, `/peer/requests/${encodeURIComponent(r.requestId)}/accept`, { type: 'connect.accept', requestId: r.requestId, token: secret, version: (await getNode()).version }, link.peerSigningKey);
    } catch (e) {
      await ctx.store.update('apiKeys', doc._id, { revokedAt: now() });
      throw e;
    }
    if (!theirs.token) throw new HttpError(502, 'peer_error', "Their Little Dipper didn't send a token back");
    const t = now();
    await ctx.store.update('nodeLinks', link._id, { status: 'active', tokenIssuedToPeer: { keyId: doc._id, scope: 'peer:profile peer:fields' }, tokenFromPeerEnc: sealToken(theirs.token), establishedAt: t });
    await pushTimeline(link, 'Approved by you');
    await pushTimeline(link, 'Secure connection set up');
    await ctx.store.update('connectionRequests', r._id, { status: 'accepted' });
    const g = await grantsFor(contact._id);
    await audit({ actor: ownerActor(p.key._id), action: 'link.accept', resource: `parties/${contact._id}`, text: `You connected with ${contact.name}`, tone: 'peer', meta: { grants: g } });
    try { await syncContact((await ctx.store.get<PartyDoc>('parties', contact._id))!); } catch { /* fetched later */ }
    return { status: 'active', grants: { profile: g.profile, fields: g.fields, domains: g.domains }, issuedToken: doc.prefix };
  });

  app.post('/api/federation/requests/:id/decline', async (req) => {
    const p = await requireOwner(req, 'parties:write');
    const r = await ctx.store.get<RequestDoc>('connectionRequests', (req.params as { id: string }).id);
    if (!r || r.direction !== 'in' || r.status !== 'pending') throw notFound('request_not_found');
    const link = await ctx.store.get<LinkDoc>('nodeLinks', r.linkId);
    const contact = await ctx.store.get<PartyDoc>('parties', r.contactId);
    if (link) {
      try { await sendSigned(link.peerUrl, `/peer/requests/${encodeURIComponent(r.requestId)}/decline`, { type: 'connect.decline', requestId: r.requestId }); } catch { /* best effort */ }
    }
    const { block } = (req.body || {}) as { block?: boolean };
    if (block) {
      const n = await getNode();
      await ctx.store.update('nodes', n._id, { blockedNodeIds: [...new Set([...(n.blockedNodeIds || []), r.fromNodeId])] });
    }
    // Declined strangers don't linger in the address book.
    if (contact) await ctx.store.remove('parties', contact._id);
    if (link) await ctx.store.remove('nodeLinks', link._id);
    await ctx.store.removeMany('grants', { contactId: r.contactId });
    await ctx.store.update('connectionRequests', r._id, { status: 'declined' });
    await audit({ actor: ownerActor(p.key._id), action: 'link.decline', resource: `connectionRequests/${r._id}`, text: `You declined ${contact?.name || r.fromNode}'s request${block ? ' and blocked them' : ''}`, tone: 'owner' });
    return { status: 'declined' };
  });

  // ── invites ──────────────────────────────────────────────────────────
  async function createInvite(expiresIn: string, offeredFields: string[]) {
    const ttl = { '24h': 1, '7d': 7, '30d': 30 }[expiresIn] ?? 7;
    const id = 'inv_' + randomToken(6).replace(/[-_]/g, 'x');
    const secret = randomToken(12);
    const doc: InviteDoc = { _id: id, tokenHash: tokenHash(secret), offeredFields, singleUse: true, expiresAt: new Date(Date.now() + ttl * 86400_000).toISOString(), usedByNodeId: null, createdAt: now() };
    await ctx.store.insert('invites', doc);
    const n = await getNode();
    return { id, url: `${canonicalUrl(n)}/connect?invite=${id}.${secret}`, expiresAt: doc.expiresAt, singleUse: true, offeredFields };
  }

  app.post('/api/federation/invites', async (req, reply) => {
    const p = await requireOwner(req, 'parties:write');
    const b = (req.body || {}) as { expiresIn?: string; offeredFields?: string[] };
    const fields = await allFields();
    const offered = (b.offeredFields || []).filter((k) => fields.some((f) => f.key === k && f.sensitivity === 'sensitive'));
    const inv = await createInvite(String(b.expiresIn || '7d'), offered);
    await audit({ actor: ownerActor(p.key._id), action: 'invite.create', resource: `invites/${inv.id}`, text: 'You created an invite link', tone: 'owner' });
    reply.code(201);
    return inv;
  });

  // ── links ────────────────────────────────────────────────────────────
  app.post('/api/federation/links/:id/rotate', async (req) => {
    const p = await requireOwner(req, 'parties:write');
    const link = await ctx.store.get<LinkDoc>('nodeLinks', (req.params as { id: string }).id);
    if (!link || link.status !== 'active') throw notFound('link_not_found');
    const contact = (await ctx.store.get<PartyDoc>('parties', link.contactId))!;
    const { secret, doc } = await issuePeerToken(contact);
    let theirs: { token?: string };
    try {
      theirs = await sendSigned(link.peerUrl, '/peer/links/rotate', { type: 'link.rotate', token: secret }, link.peerSigningKey);
    } catch (e) {
      await ctx.store.update('apiKeys', doc._id, { revokedAt: now() });
      throw e;
    }
    if (!theirs.token) throw new HttpError(502, 'peer_error', "Their Little Dipper didn't send a new token");
    await revokeIssuedToken(link);
    await ctx.store.update('nodeLinks', link._id, { tokenIssuedToPeer: { keyId: doc._id, scope: 'peer:profile peer:fields' }, tokenFromPeerEnc: sealToken(theirs.token), rotatedAt: now() });
    await pushTimeline(link, 'Connection refreshed');
    await audit({ actor: ownerActor(p.key._id), action: 'link.rotate', resource: `nodeLinks/${link._id}`, text: `You refreshed the connection with ${contact.name}`, tone: 'owner' });
    return { rotated: true, newTokenPrefix: doc.prefix };
  });

  app.delete('/api/federation/links/:id', async (req) => {
    const p = await requireOwner(req, 'parties:write');
    const link = await ctx.store.get<LinkDoc>('nodeLinks', (req.params as { id: string }).id);
    if (!link || link.status === 'revoked') throw notFound('link_not_found');
    const contact = await ctx.store.get<PartyDoc>('parties', link.contactId);
    let notified = true;
    try { await sendSigned(link.peerUrl, '/peer/links/revoke', { type: 'link.revoke' }); } catch { notified = false; }
    await endLink(link, 'Disconnected');
    await audit({ actor: ownerActor(p.key._id), action: 'link.revoke', resource: `nodeLinks/${link._id}`, text: `You disconnected from ${contact?.name || displayAddr(link.peerUrl)}`, tone: 'owner' });
    return { status: 'revoked', peerNotified: notified };
  });
}
