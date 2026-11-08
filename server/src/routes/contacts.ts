import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { fingerprint, newId, randomToken } from '../crypto.js';
import { audit, ownerActor } from '../audit.js';
import { bad, HttpError, notFound, requireOwner } from '../auth.js';
import { ownerName, profileLines, PROFILE_LINES, publicName } from '../profile.js';
import { ALWAYS_SHARED, basicLines } from '../shares.js';
import { entrySens, getDomain, isPartialDate, partyReferences, plainData, recordOut, unlinkParty, type RecordDoc } from '../domains/records.js';
import { describeEntries, endLiveShare, setLiveShare, whatTheyGet, type WhatTheyGet } from '../shares.js';
import { checkMethods } from '../methods.js';
import { canonicalUrl, displayAddr, getNode } from '../node.js';
import { getOwner } from '../owner.js';
import {
  lookupDescriptor, mutualHints, now, parsePeerInput, REQUEST_TTL_DAYS, sealToken, sendSigned, tokenHash,
  type PartyDoc, type InviteDoc, type LinkDoc, type PublicProfileDoc, type RequestDoc,
} from '../federation.js';
import {
  nudgePeers, partyOut, endLink, existingForNode, firstName, issuePeerToken, linkFor, newNodeParty, pushTimeline, revokeIssuedToken, syncContact,
} from '../contacts.js';

const STALE_MS = 10 * 60_000;

type ShareInput = {
  basic?: boolean; lines?: Record<string, boolean>; confirm?: boolean;
  categories?: Record<string, boolean | { scope?: 'all' | 'current'; includeSecret?: boolean }>;
  entries?: Record<string, boolean | { includeSecret?: boolean }>;
};

const shareOut = async (w: WhatTheyGet) => ({ basic: w.basic, lines: w.lines, categories: w.categories, entries: await describeEntries(w.entries) });

/** Apply changes to a party's live share; returns what changed, in words, for the activity log. */
async function applyShare(partyId: string, b: ShareInput): Promise<string[]> {
  const cur = await whatTheyGet(partyId);
  const lines = new Set(cur.lines), categories = { ...cur.categories }, entries = new Map(cur.entries.map((e) => [e.id, e]));
  const profile = await profileLines();
  const changes: string[] = [];
  if (typeof b.basic === 'boolean' && b.basic !== cur.basic) changes.push(`basic profile ${b.basic ? 'on' : 'off'}`);
  for (const [key, on] of Object.entries(b.lines || {})) {
    const label = PROFILE_LINES.find(([k]) => k === key)?.[1];
    if (!label) throw bad('unknown_field', `Your profile has no ${key}`);
    if (on && profile.find((l) => l.key === key)?.sensitivity === 'secret') throw bad('secret_line', `${label} is secret, so it never leaves your profile. Share its category instead.`);
    if (on) lines.add(key); else lines.delete(key);
    changes.push(`${label} ${on ? 'shared' : 'unshared'}`);
  }
  for (const [id, v] of Object.entries(b.categories || {})) {
    const d = await getDomain(id);
    if (!d) throw bad('unknown_domain', id);
    if (!v) { delete categories[id]; changes.push(`${d.label} unshared`); continue; }
    if (d.oneAtATime) throw bad('one_at_a_time', `${d.label} can only be shared one entry at a time`);
    const g = v === true ? {} : v;
    const scope = g.scope === 'current' ? 'current' : 'all';
    const includeSecret = !!g.includeSecret;
    if ((d.confirmShare || includeSecret) && b.confirm !== true) throw new HttpError(409, 'confirm_required', `Sharing ${d.label} needs confirmation`);
    categories[id] = { domain: id, scope, includeSecret };
    changes.push(`${d.label} shared (${scope === 'current' ? 'current only' : 'all'}${includeSecret ? ', with secret details' : ''})`);
  }
  for (const [rid, v] of Object.entries(b.entries || {})) {
    const r = await ctx.store.get<RecordDoc>('records', rid);
    const d = r && (await getDomain(r.domain));
    if (!r || !d) throw bad('invalid_value', 'No such entry');
    const title = recordOut(d, r).title;
    if (!v) { entries.delete(rid); changes.push(`${title} unshared`); continue; }
    const includeSecret = v !== true && !!v.includeSecret;
    const secret = entrySens(d, r, plainData(r)) === 'secret';
    if ((d.confirmShare || secret || includeSecret) && b.confirm !== true) throw new HttpError(409, 'confirm_required', `Sharing ${title} needs confirmation`);
    entries.set(rid, { id: rid, includeSecret });
    changes.push(`${title} shared`);
  }
  await setLiveShare(partyId, { basic: b.basic ?? cur.basic, lines: [...lines], categories: Object.values(categories), entries: [...entries.values()] });
  return changes;
}

async function getContact(id: string) {
  const c = await ctx.store.get<PartyDoc>('parties', id);
  if (!c) throw notFound('party_not_found');
  return c;
}

const TYPES = ['person', 'organisation'] as const;
type PartyInput = { type?: string; name?: string; notes?: string; methods?: unknown; affiliations?: { party?: string; role?: string }[]; birthDate?: string | null };

/** A person's date of birth, as a partial date; organisations don't have one. */
function checkBirthDate(v: PartyInput['birthDate'], type: string) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (type !== 'person') throw bad('invalid_value', 'Only a person has a date of birth');
  if (!isPartialDate(v)) throw bad('invalid_value', 'Date of birth: use YYYY, YYYY-MM or YYYY-MM-DD');
  return v;
}

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
  const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
  return { nodeId: n._id, address: canonicalUrl(n), signingKey: n.signingKey.publicKey, displayName: (await publicName(pp ?? null)) || 'Little Dipper owner', version: n.version };
}

/** Extra profile lines that can be offered one by one: the sensitive ones you have (standard ones come with the basic profile). */
async function offerable(keys: string[]) {
  const lines = await profileLines();
  return keys.filter((k) => lines.some((l) => l.key === k && l.sensitivity === 'sensitive'));
}

/** What a request tells them we'll share: the basic profile's lines (if shared) and the extras, by label. */
/** What a request offers, with the values: the other side decides on the real details, not labels. Never secret lines. */
async function offerDetails(basic: boolean, extra: string[]) {
  const lines = new Map((await profileLines()).filter((l) => l.sensitivity !== 'secret').map((l) => [l.key, l]));
  const keys = [...(basic ? await basicLines() : []), ...extra].filter((k, i, all) => lines.has(k) && all.indexOf(k) === i);
  // Your Little Dipper as its address; the Node ID is already in the signed envelope.
  return keys.map((k) => ({ label: lines.get(k)!.label, value: k === 'little_dipper' ? lines.get(k)!.value.split(' · ')[0] : lines.get(k)!.value }));
}

async function sendRequest(link: LinkDoc, offeredFields: string[], offered: { label: string; value: string }[], requestedFields: string[], note: string, invite: string | null) {
  await sendSigned(link.peerUrl, '/peer/requests', {
    type: 'connect.request', requestId: link.requestId, to: link.peerNodeId, fromNode: await selfIntro(),
    offeredFields, offeredLabels: offered.map((o) => o.label), offeredDetails: offered, requestedFields, note, invite, mutualHints: await mutualHints(link.peerNodeId),
  });
}

/** What you choose to share when you connect: the basic profile, extra lines, whole categories. */
export type ConnectChoice = { basic?: boolean; lines?: string[]; categories?: Record<string, { scope?: 'all' | 'current' }>; confirm?: boolean };

/**
 * Look up a node and send it a signed connection request. `choice`: what we'll share once they approve (basic profile
 * unless told otherwise, plus extras). `asks`: things on their card we'd like (profile lines only; no reasons between people).
 */
export async function requestConnection(keyId: string, address: string, choice: ConnectChoice, note: string, asks: string[] = []) {
  const { origin, invite } = parsePeerInput(address);
  const d = await lookupDescriptor(origin);
  const n = await getNode();
  if (d.nodeId === n._id) throw bad('self', "That's your own Little Dipper");
  const existing = await existingForNode(d.nodeId);
  if (existing && existing.link.status === 'active') throw new HttpError(409, 'already_connected', `You're already connected with ${existing.contact.name}`);
  if (existing && existing.link.status === 'pending_in') throw new HttpError(409, 'request_waiting', `${existing.contact.name} already asked to connect. Review their request instead.`);
  if (existing) throw new HttpError(409, 'request_pending', `You already asked ${existing.contact.name}. Use Resend on their contact page.`);
  const offered = (choice.lines ?? []).filter((k) => PROFILE_LINES.some(([x]) => x === k));
  const requested = asks.filter((k) => PROFILE_LINES.some(([x]) => x === k) && k !== ALWAYS_SHARED).slice(0, 20);
  const shareProfile = choice.basic !== false;
  const requestId = newId('req');
  const name = d.displayName || displayAddr(d.address);
  const { contact, link } = await newNodeParty({ name, address: d.address, nodeId: d.nodeId, signingKey: d.signingKey, version: d.version, status: 'pending_out', requestId });
  try {
    await sendRequest(link, offered, await offerDetails(shareProfile, offered), requested, note.slice(0, 500), invite);
  } catch (e) {
    await ctx.store.remove('parties', contact._id);
    await ctx.store.remove('nodeLinks', link._id);
    throw e;
  }
  // What we'll share once they approve: basic profile (unless told not to; no grant at all means shared) + the extras we offered.
  await applyShare(contact._id, { basic: shareProfile, lines: Object.fromEntries(offered.map((k) => [k, true])), categories: Object.fromEntries(Object.entries(choice.categories ?? {}).map(([d, c]) => [d, { scope: c.scope ?? 'all' }])), confirm: choice.confirm });
  const t = now();
  await ctx.store.insert<RequestDoc>('connectionRequests', {
    _id: newId('req'), direction: 'out', requestId, fromNodeId: n._id, peerName: name, fromNode: displayAddr(canonicalUrl(n)), toNode: displayAddr(d.address),
    offeredFields: offered, offeredLabels: [], requestedFields: requested, note, nonce: randomToken(8), signature: '', inviteId: null,
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
      ...(checkBirthDate(b.birthDate, String(b.type)) ? { birthDate: b.birthDate! } : {}),
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
    const born = checkBirthDate(b.birthDate, String(patch.type ?? c.type));
    if (born !== undefined) patch.birthDate = born ?? undefined;
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
    await endLiveShare(c._id);
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

  /** What this party gets: the basic profile, extra lines, whole categories and specific entries. */
  app.get('/api/parties/:id/share', async (req) => {
    await requireOwner(req, 'parties:read');
    const c = await getContact((req.params as { id: string }).id);
    return await shareOut(await whatTheyGet(c._id));
  });

  /**
   * Exactly what this person's Little Dipper receives from you right now: the same code their node calls, so what
   * you see here is what they see. Nothing is sent and nothing is logged as a read.
   */
  app.get('/api/parties/:id/preview', async (req) => {
    await requireOwner(req, 'parties:read');
    const c = await getContact((req.params as { id: string }).id);
    const { sharedOut } = await import('../contacts.js');
    const { sharedDomainIds, sharedDomainOut } = await import('../domains/sharing.js');
    const lines = [...(await sharedOut(c._id, 'profile')), ...(await sharedOut(c._id, 'fields'))];
    const domains = [];
    for (const id of await sharedDomainIds(c._id)) { const sd = await sharedDomainOut(c._id, id); if (sd) domains.push(sd); }
    return { lines, domains };
  });

  /**
   * Change what a party gets. Body: { basic?: boolean, lines?: { [key]: boolean },
   * categories?: { [domain]: false | true | { scope?: 'all'|'current', includeSecret?: boolean } },
   * entries?: { [recordId]: false | true | { includeSecret?: boolean } }, confirm?: boolean }.
   * Categories that hold IDs, health or money, secret entries and secret details need confirm:true.
   */
  app.put('/api/parties/:id/share', async (req) => {
    const p = await requireOwner(req, 'parties:write');
    const c = await getContact((req.params as { id: string }).id);
    if (!c.node) throw bad('not_connected', 'Only people and organisations on Little Dipper get a live share. Send them a copy instead.');
    const changes = await applyShare(c._id, (req.body || {}) as ShareInput);
    if (changes.length) {
      await audit({ actor: ownerActor(p.key._id), action: 'share.update', resource: `parties/${c._id}/share`, text: `Sharing with ${c.name}: ${changes.join(', ')}`, tone: 'owner' });
      nudgePeers([c._id]);
    }
    return await shareOut(await whatTheyGet(c._id));
  });

  app.post('/api/parties/:id/invite', async (req) => {
    await requireOwner(req, 'parties:write');
    const c = await getContact((req.params as { id: string }).id);
    const inv = await createInvite('7d', []);
    const n = await getNode();
    const email = String(c.methods.find((m) => m.kind === 'email' && m.primary)?.value ?? c.methods.find((m) => m.kind === 'email')?.value ?? '');
    const body = `Hi ${firstName(c.name)},\n\nI keep my contact details on Little Dipper, a personal data store I run myself. If you set one up too, open this link in it and we'll be connected:\n\n${inv.url}\n\nDon't have one yet? It's free and open source.\n\n${await ownerName()}`;
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
    const b = (req.body || {}) as { address?: string; share?: ConnectChoice; asks?: string[]; note?: string; offeredFields?: string[] };
    const choice: ConnectChoice = b.share ?? { basic: true, lines: b.offeredFields ?? [] };
    const out = await requestConnection(p.key._id, String(b.address || ''), choice, String(b.note || ''), (b.asks ?? []).map(String));
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
    const share = await whatTheyGet(r.contactId);
    await sendRequest(link, r.offeredFields, await offerDetails(share.basic, r.offeredFields), r.requestedFields, r.note, null);
    await ctx.store.update('connectionRequests', r._id, { expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86400_000).toISOString() });
    return { delivered: true };
  });

  app.post('/api/federation/requests/:id/accept', async (req) => {
    const p = await requireOwner(req, 'parties:write');
    const r = await ctx.store.get<RequestDoc>('connectionRequests', (req.params as { id: string }).id);
    if (!r || r.direction !== 'in' || r.status !== 'pending') throw notFound('request_not_found');
    const link = (await ctx.store.get<LinkDoc>('nodeLinks', r.linkId))!;
    const contact = (await ctx.store.get<PartyDoc>('parties', r.contactId))!;
    // What you chose on the connect screen: the basic profile and any extras (suggested ones you kept, requests you ticked).
    const choice = ((req.body || {}) as { share?: ConnectChoice }).share;
    if (choice) {
      await applyShare(contact._id, {
        basic: choice.basic !== false,
        lines: Object.fromEntries((choice.lines ?? []).map((k) => [k, true])),
        categories: Object.fromEntries(Object.entries(choice.categories ?? {}).map(([d, c]) => [d, { scope: c.scope ?? 'all' }])),
        confirm: choice.confirm,
      });
    }
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
    const g = await shareOut(await whatTheyGet(contact._id));
    await audit({ actor: ownerActor(p.key._id), action: 'link.accept', resource: `parties/${contact._id}`, text: `You connected with ${contact.name}`, tone: 'peer', meta: { share: g } });
    try { await syncContact((await ctx.store.get<PartyDoc>('parties', contact._id))!); } catch { /* fetched later */ }
    return { status: 'active', share: g, issuedToken: doc.prefix };
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
    await endLiveShare(r.contactId);
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
    const offered = await offerable(b.offeredFields || []);
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
