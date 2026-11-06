/** Contact + connection helpers shared by the owner API and the peer API. */
import { ctx } from './ctx.js';
import { fingerprint, newId } from './crypto.js';
import { issueKey } from './auth.js';
import { linesFor } from './profile.js';
import type { SharedDomain } from './domains/sharing.js';
import { displayAddr } from './node.js';
import type { ContactMethod } from './methods.js';
import {
  grantsFor, now, peerGet, sendSigned, type PartyDoc, type LinkDoc, type RequestDoc,
} from './federation.js';

export const firstName = (name: string) => name.replace(/^(Dr|Mr|Mrs|Ms|Mx)\.?\s+/i, '').split(' ')[0];

export async function linkFor(c: PartyDoc) {
  return c.node?.linkId ? ctx.store.get<LinkDoc>('nodeLinks', c.node.linkId) : null;
}

export type ContactStatus = 'plain' | 'pending_in' | 'pending_out' | 'active';

/** The latest thing that happened with a party, worked out from the connection, messages and copies (never stored). */
export async function lastActivityOf(c: PartyDoc, link: LinkDoc | null) {
  const items: { text: string; at: string }[] = [{ text: 'Added', at: c.createdAt }];
  const step = link?.timeline.at(-1);
  if (step) items.push({ text: step.label, at: step.at });
  const [m] = await ctx.store.find<{ _id: string; direction: string; createdAt: string }>('messages', { contactId: c._id }, { sort: { createdAt: -1 }, limit: 1 });
  if (m) items.push({ text: m.direction === 'in' ? 'Sent you a message' : 'You sent a message', at: m.createdAt });
  const [cp] = await ctx.store.find<{ _id: string; title: string; createdAt: string }>('copies', { contactId: c._id }, { sort: { createdAt: -1 }, limit: 1 });
  if (cp) items.push({ text: `You sent a copy of ${cp.title}`, at: cp.createdAt });
  return items.sort((a, b) => b.at.localeCompare(a.at))[0];
}

export async function partyOut(c: PartyDoc, opts: { detail?: boolean } = {}) {
  const link = await linkFor(c);
  const status: ContactStatus = c.node && link && link.status !== 'revoked' ? link.status : 'plain';
  const g = await grantsFor(c._id);
  const base = {
    id: c._id, type: c.type, name: c.name, status,
    node: c.node && link ? { url: displayAddr(link.peerUrl), nodeId: link.peerNodeId, linkId: link._id } : null,
    grants: { profile: g.profile, fields: g.fields, domains: g.domains },
    lastActivity: await lastActivityOf(c, link), createdAt: c.createdAt,
    methods: c.methods, affiliations: c.affiliations ?? [],
  };
  if (!opts.detail) return base;
  const req = link ? await ctx.store.findOne<RequestDoc>('connectionRequests', { linkId: link._id, status: 'pending' }) : null;
  const issued = link?.tokenIssuedToPeer ? await ctx.store.get('apiKeys', link.tokenIssuedToPeer.keyId) : null;
  return {
    ...base,
    notes: c.notes,
    // What they shared with us is kept when the connection ends: the last known values, with when we last fetched them.
    sharedIn: c.sharedIn,
    sharedDomains: c.sharedDomains || [],
    sharedInFetchedAt: c.sharedInFetchedAt,
    request: req ? {
      id: req._id, direction: req.direction, note: req.note, quiet: req.quiet, viaInvite: !!req.inviteId, expiresAt: req.expiresAt,
      requestedFields: req.requestedFields, offeredLabels: req.offeredLabels,
    } : null,
    timeline: link?.timeline || [],
    keys: link ? {
      peerSigningKey: fingerprint(link.peerSigningKey),
      peerVersion: link.peerVersion,
      tokenIssued: issued && !issued.revokedAt ? { prefix: issued.prefix, scopes: issued.scopes, lastUsedAt: issued.lastUsedAt } : null,
      tokenFromPeer: link.tokenFromPeerEnc ? { stored: true, lastUsedAt: link.tokenFromPeerLastUsedAt } : null,
      lastSyncAt: link.lastSyncAt, rotatedAt: link.rotatedAt,
    } : null,
  };
}

export async function pushTimeline(link: LinkDoc, label: string) {
  const fresh = (await ctx.store.get<LinkDoc>('nodeLinks', link._id))!;
  await ctx.store.update('nodeLinks', link._id, { timeline: [...fresh.timeline, { label, at: now() }] });
}

/** Token we hand a peer so it can read what we share. */
export async function issuePeerToken(contact: PartyDoc) {
  return issueKey({ kind: 'peer', name: contact.name, scopes: ['peer:profile', 'peer:fields'], contactId: contact._id });
}

export async function revokeIssuedToken(link: LinkDoc) {
  if (link.tokenIssuedToPeer) await ctx.store.update('apiKeys', link.tokenIssuedToPeer.keyId, { revokedAt: now() });
}

/** Link ends (either side): revoke tokens, keep the person as "Contact only". */
export async function endLink(link: LinkDoc, reason: string) {
  await revokeIssuedToken(link);
  await ctx.store.update('nodeLinks', link._id, { status: 'revoked', tokenFromPeerEnc: null, tokenIssuedToPeer: null });
  await ctx.store.removeMany('connectionRequests', { linkId: link._id, status: 'pending' });
  const c = await ctx.store.get<PartyDoc>('parties', link.contactId);
  if (c) {
    // They stay a party, with their Little Dipper address as a website, and what they last shared is kept.
    const methods: ContactMethod[] = [...c.methods];
    if (!methods.some((m) => m.kind === 'website' && m.value === link.peerUrl)) methods.push({ kind: 'website', label: 'Little Dipper', value: link.peerUrl });
    await ctx.store.update('parties', c._id, { node: null, methods });
  }
  await pushTimeline(link, reason);
}

/** Profile lines this party's token may read right now: the basic profile (standard lines), or the extra lines granted one by one. */
export async function sharedOut(contactId: string, which: 'profile' | 'fields'): Promise<{ key: string; label: string; value: string }[]> {
  const g = await grantsFor(contactId);
  const lines = which === 'profile'
    ? (g.profile ? await linesFor({ basic: true, extra: [] }) : [])
    : (await linesFor({ basic: false, extra: g.fields })).filter((l) => l.sensitivity !== 'standard' || !g.profile);
  return lines.map((l) => ({ key: l.key, label: l.label, value: l.value }));
}

/** Pull what a connected contact shares with us and cache it locally. */
// ── change nudges ─────────────────────────────────────────────────────
// When what a connection can read changes, tell their node to sync now instead of on its next stale check.
const pending = new Map<string, NodeJS.Timeout>();

/** Debounced per link: a burst of edits sends one nudge. contactIds = null means every active connection. */
export function nudgePeers(contactIds: string[] | null) {
  (async () => {
    const links = await ctx.store.find<LinkDoc>('nodeLinks', { status: 'active' });
    for (const l of links) {
      if (contactIds && !contactIds.includes(l.contactId)) continue;
      clearTimeout(pending.get(l._id));
      pending.set(l._id, setTimeout(() => {
        pending.delete(l._id);
        sendSigned(l.peerUrl, '/peer/links/changed', { type: 'link.changed' }).catch(() => { /* they'll catch up on their next sync */ });
      }, 1500));
    }
  })().catch(() => {});
}

/** Contacts with an active link that can read this domain. */
export async function contactsSharing(domain: string) {
  const grants = await ctx.store.find<{ _id: string; contactId: string; domain?: string }>('grants', { domain });
  return grants.map((g) => g.contactId);
}

export async function syncContact(c: PartyDoc) {
  const link = await linkFor(c);
  if (!link || link.status !== 'active') return c;
  const profile = (await peerGet(link, '/peer/profile')) as { fields?: PartyDoc['sharedIn'] };
  const extra = (await peerGet(link, '/peer/fields')) as { fields?: PartyDoc['sharedIn'] };
  const seen = new Set<string>();
  const sharedIn = [...(profile.fields || []), ...(extra.fields || [])]
    .filter((f) => f && typeof f.key === 'string' && !seen.has(f.key) && seen.add(f.key))
    .map((f) => ({ key: String(f.key), label: String(f.label).slice(0, 80), value: String(f.value).slice(0, 2000) }));
  // Domains they've granted us. Older nodes don't have this endpoint: treat as none.
  const sharedDomains: SharedDomain[] = [];
  const list = (await peerGet(link, '/peer/domains').catch(() => ({ domains: [] }))) as { domains?: { id: string }[] };
  for (const { id } of (list.domains || []).slice(0, 50)) {
    if (!/^[a-z0-9_]{1,40}$/.test(String(id))) continue;
    const d = (await peerGet(link, `/peer/domains/${id}`).catch(() => null)) as SharedDomain | null;
    if (!d || !Array.isArray(d.records)) continue;
    sharedDomains.push({
      domain: id, label: String(d.label).slice(0, 80), scope: d.scope === 'current' ? 'current' : 'all',
      records: d.records.slice(0, 500).map((r) => ({
        id: String(r.id), title: String(r.title).slice(0, 200),
        fields: (r.fields || []).slice(0, 60).map((f) => ({ key: String(f.key), label: String(f.label).slice(0, 80), value: String(f.value).slice(0, 2000) })),
        data: typeof r.data === 'object' && r.data ? r.data : {}, validFrom: r.validFrom ?? null, validTo: r.validTo ?? null, current: !!r.current, updatedAt: String(r.updatedAt || ''),
      })),
    });
  }
  const t = now();
  await ctx.store.update('parties', c._id, { sharedIn, sharedDomains, sharedInFetchedAt: t });
  await ctx.store.update('nodeLinks', link._id, { lastSyncAt: t, tokenFromPeerLastUsedAt: t });
  return (await ctx.store.get<PartyDoc>('parties', c._id))!;
}

export async function newNodeParty(opts: { name: string; address: string; nodeId: string; signingKey: string; version: string | null; status: LinkDoc['status']; requestId: string }) {
  const contactId = newId('pty');
  const linkId = newId('lnk');
  const t = now();
  const contact: PartyDoc = {
    _id: contactId, type: 'person', name: opts.name, methods: [], notes: '', affiliations: [],
    node: { url: opts.address, nodeId: opts.nodeId, linkId }, sharedIn: [], sharedInFetchedAt: null, createdAt: t,
  };
  const link: LinkDoc = {
    _id: linkId, contactId, peerNodeId: opts.nodeId, peerUrl: opts.address, status: opts.status, peerSigningKey: opts.signingKey,
    peerVersion: opts.version, requestId: opts.requestId, tokenIssuedToPeer: null, tokenFromPeerEnc: null, tokenFromPeerLastUsedAt: null,
    timeline: [{ label: opts.status === 'pending_out' ? 'Request sent by you' : `Request received from ${firstName(opts.name)}`, at: t }],
    establishedAt: null, lastSyncAt: null, rotatedAt: null,
  };
  await ctx.store.insert('parties', contact);
  await ctx.store.insert('nodeLinks', link);
  return { contact, link };
}

/** An existing contact (any status) for this peer, so repeat requests reuse it. */
export async function existingForNode(nodeId: string) {
  const link = (await ctx.store.find<LinkDoc>('nodeLinks', { peerNodeId: nodeId })).find((l) => l.status !== 'revoked');
  if (!link) return null;
  const contact = await ctx.store.get<PartyDoc>('parties', link.contactId);
  return contact ? { contact, link } : null;
}

