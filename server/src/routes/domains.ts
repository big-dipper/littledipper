/**
 * Domain endpoints: one per category of personal data (/api/data/employment, /api/data/residences…),
 * plus the catalog that describes them and a cross-domain timeline.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ctx } from '../ctx.js';
import { PROFILE_DOMAINS } from '../profile.js';
import type { ShareDoc } from '../shares.js';
import { audit, ownerActor, systemActor } from '../audit.js';
import { bad, HttpError, notFound, requireOwner, requireSession, type ApiKeyDoc } from '../auth.js';
import { canAddTo, canSeeRecord } from '../access.js';
import { checkNewParties, createParties, existingParty, NEW, refsIn, substitute, type NewParty } from '../newParties.js';
import { isIdentityChange, pendingReply, propose, reviewInput, type ReviewDoc } from '../reviews.js';
import { mask } from '../fields.js';
import { undoOnRecord } from '../undo.js';
import { contactsSharing, nudgePeers } from '../contacts.js';
import { documentsByRecord, recordRemoved } from '../documents.js';
import { isDateTime } from '../domains/datetime.js';
import {
  actorLabels, buildRecord, displayValue, checkCustomDomain, deletedRecords, KEEP_DELETED_DAYS, recordVersion, versionRecord, versionsOf, demoteOtherPrimaries, getDomain, isCurrent, listDomains, partSens, entrySens, plainData, recordReferences, unlinkRecord,
  recordOut, recordsOf, sortRecords, type DomainDef, type RecordDoc, type RecordInput,
} from '../domains/records.js';
import type { Actor, VersionDoc } from '../domains/types.js';

/** Domains the profile reads: a change there can change what every connection sees. */
const DERIVED_DOMAINS = PROFILE_DOMAINS;
const readScopes = (d: string) => [`${d}:read`, 'records:read'];
const writeScopes = (d: string) => [`${d}:write`, 'records:write'];

/**
 * The titles of the entries this category's records link to ("Covers: 2019 Subaru Outback", not "1 linked entry").
 * Only for the owner's own screens: an app sees the ids, and reads the other category if its key allows.
 */
async function linkedTitles(d: DomainDef, recs: RecordDoc[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const parts = d.parts.filter((p) => p.type === 'record');
  const wanted = new Set(recs.flatMap((r) => parts.flatMap((p) => [r.data[p.key]].flat())).filter((x): x is string => typeof x === 'string'));
  if (!wanted.size) return out;
  for (const t of new Set(parts.flatMap((p) => p.to ?? []))) {
    const td = await getDomain(t);
    if (!td) continue;
    for (const r of await recordsOf(td.id)) if (wanted.has(r._id)) out[r._id] = recordOut(td, r).title;
  }
  return out;
}

async function domainOr404(id: string) {
  const d = await getDomain(id);
  if (!d) throw notFound('not_found');
  return d;
}

/** A record the caller may see: anything for the owner, only what its share covers for a party. Hidden looks like missing. */
async function visibleOr404(p: { key: ApiKeyDoc }, d: DomainDef, id: string) {
  const r = await recordOr404(d, id);
  if (!canSeeRecord(p.key, d, r, isCurrent(d, r))) throw notFound('record_not_found');
  return r;
}

async function recordOr404(d: DomainDef, id: string) {
  const r = await ctx.store.get<RecordDoc & { [k: string]: unknown }>('records', id);
  if (!r || r.domain !== d.id) throw notFound('record_not_found');
  return r as RecordDoc;
}

/**
 * ?from=&to= for a category. Kinds dated by one of their own fields (a receipt's purchase date, a transaction's date,
 * an event's start) are filtered by that day; dated kinds by overlap with when the entry applied.
 */
function inRangeOf(d: DomainDef, r: RecordDoc, from?: string, to?: string) {
  if (!d.sortBy) return inRange(r, from, to);
  const raw = plainData(r)[d.sortBy];
  const v = raw && typeof raw === 'object' && 'at' in (raw as object) ? String((raw as { at: unknown }).at) : raw ? String(raw) : '';
  if (!v) return false;
  const day = v.slice(0, 10);
  // A partial date (2026-11) counts as its whole period: it can still fall in the range.
  return (!from || day >= from.slice(0, day.length)) && (!to || day <= to.slice(0, day.length));
}

/** Overlap filter for ?from=&to= on dated domains. */
function inRange(r: RecordDoc, from?: string, to?: string) {
  if (from && r.validTo && r.validTo < from) return false;
  if (to && r.validFrom && r.validFrom > to) return false;
  return true;
}

type Summary = { count: number; currentCount: number; sharedWith: number };

/** Count, current count and how many connections can read it: what the hub shows per category. No contents: the overview is for finding your way, not for showing your details. */
async function summarize(domains: DomainDef[]): Promise<Record<string, Summary>> {
  const shares = await ctx.store.find<ShareDoc>('shares', { mode: 'live' });
  const activeContacts = new Set((await ctx.store.find<{ _id: string; contactId: string; status: string }>('nodeLinks', { status: 'active' })).map((l) => l.contactId));
  const out: Record<string, Summary> = {};
  for (const d of domains) {
    const recs = sortRecords(d, await recordsOf(d.id));
    out[d.id] = {
      count: recs.length,
      currentCount: recs.filter((r) => isCurrent(d, r)).length,
      sharedWith: shares.filter((s) => s.party && activeContacts.has(s.party) && s.categories.some((c) => c.domain === d.id)).length,
    };
  }
  return out;
}

function catalogEntry(d: DomainDef, sum: Summary) {
  return {
    ...d,
    parts: d.parts.map((p) => ({ ...p, sensitivity: partSens(d, p) })),
    ...sum,
    scopes: { read: `${d.id}:read`, write: `${d.id}:write` },
    endpoint: `/api/data/${d.id}`,
    feedsProfile: PROFILE_DOMAINS.has(d.id),
  };
}

/**
 * A suggestion's new people and organisations (BRY-114): checked, matched to anyone already on the node (those are
 * used as they are), the rest kept as "new:<ref>" until the owner approves. Only keys send them; the owner adds people directly.
 */
async function prepareNew(input: RecordInput, isSession: boolean) {
  const used = refsIn(input.data);
  if (input.newParties === undefined && !used.size) return { input, pending: new Set<string>() };
  if (isSession) throw bad('invalid_value', 'Add people and organisations in Relationships, then choose them here.');
  const list = checkNewParties(input.newParties);
  for (const r of used) if (!list.some((x) => x.ref === r)) throw bad('invalid_value', `${NEW}${r} isn't in newParties`);
  const known = new Map<string, string>();
  const pending: NewParty[] = [];
  for (const x of list.filter((x) => used.has(x.ref))) {
    const e = await existingParty(x);
    if (e) known.set(x.ref, e._id); else pending.push(x);
  }
  const { newParties: _drop, ...rest } = input;
  const out: RecordInput = { ...rest, data: substitute(input.data, known), ...(pending.length ? { newParties: pending } : {}) };
  return { input: out, pending: new Set(pending.map((x) => `${NEW}${x.ref}`)) };
}

/** Create a suggestion's new parties now (an approval, or a key allowed to make changes) and point the entry at them. */
async function settleNew(input: RecordInput): Promise<RecordInput> {
  if (!input.newParties?.length) return input;
  const ids = await createParties(input.newParties);
  const { newParties: _drop, ...rest } = input;
  return { ...rest, data: substitute(input.data, ids) };
}

/** Who made a change, for the activity feed: "You", or the app or assistant's name. */
const actorName = (p: { isSession: boolean; key: { name: string } }) => (p.isSession ? 'You' : p.key.name);

/** Secret parts an input sets (a value, not a removal), judged by how sensitive the entry will be. */
function secretKeys(d: DomainDef, input: RecordInput, existing: RecordDoc | null = null) {
  const plain = { ...(existing ? plainData(existing) : {}), ...(input.data ?? {}) };
  const entry = entrySens(d, { sensitivity: input.sensitivity === undefined ? existing?.sensitivity : input.sensitivity ?? undefined }, plain);
  return Object.entries(input.data ?? {}).filter(([k, v]) => v !== null && v !== undefined && v !== '' && d.parts.some((x) => x.key === k && partSens(d, x, entry) === 'secret')).map(([k]) => k);
}

async function proposeChange(p: { key: ApiKeyDoc }, d: DomainDef, recordId: string | null, input: RecordInput, reason: ReviewDoc['reason']) {
  const r = await propose(p.key, d.id, recordId, input, reason);
  await audit({ actor: ownerActor(p.key._id), action: 'review.propose', resource: `reviews/${r._id}`, text: `${p.key.name} suggested ${recordId ? 'a change to' : 'a new entry in'} ${d.label}. It's waiting for you in Review.`, tone: 'request' });
  return r;
}

export async function createRecord(d: DomainDef, input: RecordInput, by: Actor, who: string) {
  const rec = await buildRecord(d, input, null, by);
  await ctx.store.insert('records', rec);
  await recordVersion(rec, 'create', by);
  await demoteOtherPrimaries(rec);
  const out = { ...recordOut(d, rec), updatedByLabel: (await actorLabels())(by) };
  nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id, [rec._id]));
  await audit({ actor: ownerActor(by.id), action: 'record.create', resource: `${d.id}/${rec._id}`, text: `${who} added ${out.title} to ${d.label}`, tone: 'owner' });
  return out;
}

export async function updateRecord(d: DomainDef, existing: RecordDoc, input: RecordInput, by: Actor, who: string) {
  const rec = await buildRecord(d, input, existing, by);
  const { _id, ...rest } = rec;
  // Replace data wholesale so removed parts really go.
  await ctx.store.update('records', _id, { ...rest });
  await recordVersion(rec, 'update', by);
  await demoteOtherPrimaries(rec);
  const out = { ...recordOut(d, rec), updatedByLabel: (await actorLabels())(by) };
  nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id, [_id]));
  // Little Dipper itself (a task's answer arriving) is logged as the system, never as the owner.
  const sys = by.type === 'system';
  await audit({ actor: sys ? systemActor : ownerActor(by.id), action: 'record.update', resource: `${d.id}/${_id}`, text: `${who} updated ${out.title} in ${d.label}`, tone: sys ? 'system' : 'owner' });
  return out;
}

export default async function domainRoutes(app: FastifyInstance) {
  // ── catalog ──────────────────────────────────────────────────────────
  app.get('/api/catalog', async (req) => {
    // Any key that can read a kind sees that kind's entry (an assistant learns its fields here).
    const domains = await listDomains();
    const p = await requireOwner(req, ['records:read', 'owner:read', ...domains.map((d) => `${d.id}:read`)]);
    const visible = p.key.scopes.includes('admin:*') || p.key.scopes.includes('records:read')
      ? domains : domains.filter((d) => p.key.scopes.includes(`${d.id}:read`));
    const sums = await summarize(visible);
    return { domains: visible.map((d) => catalogEntry(d, sums[d.id])) };
  });

  app.post('/api/catalog', async (req, reply) => {
    const p = await requireSession(req);
    const def = checkCustomDomain((req.body || {}) as Partial<DomainDef>);
    if (await getDomain(def.id)) throw new HttpError(409, 'exists', `You already have a category called ${def.label}`);
    await ctx.store.insert('domainDefs', { _id: def.id, ...def });
    await audit({ actor: ownerActor(p.key._id), action: 'domain.create', resource: `catalog/${def.id}`, text: `You created the category ${def.label}`, tone: 'owner' });
    reply.code(201);
    return catalogEntry(def, (await summarize([def]))[def.id]);
  });

  app.delete('/api/catalog/:id', async (req) => {
    const p = await requireSession(req);
    const d = await domainOr404((req.params as { id: string }).id);
    if (d.builtIn) throw bad('built_in', 'Built-in categories can’t be removed');
    const n = await ctx.store.count('records', { domain: d.id });
    if (n && (req.query as { force?: string }).force !== '1') throw new HttpError(409, 'not_empty', `${d.label} still has ${n} entr${n === 1 ? 'y' : 'ies'}`);
    for (const r of await recordsOf(d.id)) { await unlinkRecord(r._id, { type: 'owner', id: p.key._id }); await recordRemoved(r._id); }
    await ctx.store.removeMany('records', { domain: d.id });
    for (const s of await ctx.store.find<ShareDoc>('shares', { mode: 'live' })) {
      if (s.categories.some((c) => c.domain === d.id)) await ctx.store.update('shares', s._id, { categories: s.categories.filter((c) => c.domain !== d.id) });
    }
    await ctx.store.remove('domainDefs', d.id);
    await audit({ actor: ownerActor(p.key._id), action: 'domain.delete', resource: `catalog/${d.id}`, text: `You removed the category ${d.label}`, tone: 'owner' });
    return { deleted: true };
  });

  // ── attention: documents and registrations expiring soon (or already) ─
  app.get('/api/attention', async (req) => {
    await requireOwner(req, ['records:read']);
    const days = Math.min(730, Math.max(1, Number((req.query as { days?: string }).days) || 180));
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
    const items = [];
    for (const d of await listDomains()) {
      const dateParts = d.parts.filter((x) => (x.type === 'date' || x.type === 'datetime') && (x.remind || /expires/i.test(x.key)));
      if (!dateParts.length) continue;
      for (const r of await recordsOf(d.id)) {
        if (!isCurrent(d, r)) continue;
        const plain = plainData(r);
        for (const x of dateParts) {
          const raw = plain[x.key];
          if (!raw) continue;
          // A datetime counts by its local date; clients that know the type also get the moment itself.
          const v = isDateTime(raw) ? raw.at.slice(0, 10) : String(raw);
          // A partial date expires at the end of its period: 2027 → 2027-12-31, 2027-04 → 2027-04-30.
          const end = v.length === 4 ? `${v}-12-31` : v.length === 7 ? new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7), 0)).toISOString().slice(0, 10) : v;
          if (end > horizon) continue;
          // Deadlines (return by, warranty until) stop mattering soon after they pass; expired IDs keep nagging.
          if (x.remind && end < new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)) continue;
          items.push({ domain: d.id, domainLabel: d.label, id: r._id, title: recordOut(d, r).title, part: x.label, kind: x.remind ? 'deadline' : 'expiry', date: v, ...(isDateTime(raw) ? { datetime: raw } : {}), expired: end < today });
        }
      }
    }
    items.push(...(await passportForTrips(today)));
    items.sort((a, b) => a.date.localeCompare(b.date));
    return { items, days };
  });

  // ── timeline: every dated record, across domains ─────────────────────
  app.get('/api/timeline', async (req) => {
    await requireOwner(req, ['records:read']);
    const q = req.query as { from?: string; to?: string; domains?: string };
    const wanted = q.domains ? new Set(q.domains.split(',')) : null;
    const domains = (await listDomains()).filter((d) => d.dated && (!wanted || wanted.has(d.id)));
    const items = [];
    for (const d of domains) {
      for (const r of await recordsOf(d.id)) {
        if (!r.validFrom || !inRange(r, q.from, q.to)) continue;
        const out = recordOut(d, r);
        items.push({ domain: d.id, domainLabel: d.label, id: r._id, title: out.title, validFrom: r.validFrom, validTo: r.validTo, current: out.current });
      }
    }
    items.sort((a, b) => b.validFrom!.localeCompare(a.validFrom!));
    return { items };
  });

  // ── per-domain CRUD: /api/data/{domain} ────────────────────────────
  // Records have their own prefix, so no fixed route can ever block a domain name.
  const ctxFor = async (req: FastifyRequest, write: boolean) => {
    const { domain, id } = req.params as { domain: string; id?: string };
    const d = await domainOr404(domain);
    // Record writes are reviewable: an assistant's change goes to Review when its mode or the change calls for it.
    const p = await requireOwner(req, write ? writeScopes(d.id) : readScopes(d.id), { reviewable: write });
    const by: Actor = { type: p.isSession ? 'owner' : 'app', id: p.key._id };
    return { d, p, id, by };
  };

  const base = '/api/data/:domain';
  app.get(base, async (req) => {
    const { d, p } = await ctxFor(req, false);
    const q = req.query as { current?: string; from?: string; to?: string };
    // A party sees what its share covers: all of a category, only what's current, or single entries.
    let recs = sortRecords(d, await recordsOf(d.id)).filter((r) => canSeeRecord(p.key, d, r, isCurrent(d, r)));
    if (q.current === 'true') recs = recs.filter((r) => isCurrent(d, r));
    if (q.from || q.to) recs = recs.filter((r) => inRangeOf(d, r, q.from, q.to));
    const docs = await documentsByRecord(d.id);
    const label = await actorLabels();
    return { domain: d.id, items: recs.map((r) => { const out = recordOut(d, r); return { ...out, updatedByLabel: label(out.updatedBy), sourceLabel: label(out.source), documents: docs.get(r._id) ?? [] }; }), ...(p.isSession ? { linked: await linkedTitles(d, recs) } : {}) };
  });

  app.post(base, async (req, reply) => {
    const { d, p, by } = await ctxFor(req, true);
    if (!canAddTo(p.key, d)) throw new HttpError(403, 'not_shared', `You can change the ${d.label.toLowerCase()} entries shared with you, but not add new ones.`);
    const prep = await prepareNew((req.body || {}) as RecordInput, p.isSession);
    let input = prep.input;
    const a = p.key.assistant;
    if (a) {
      // Check it now, so the assistant hears about a mistake straight away rather than at approval.
      await buildRecord(d, input, null, by, { newParties: prep.pending });
      const reason = a.mode === 'suggest' ? 'suggest' : isIdentityChange(d, input, null) ? 'identity' : input.sensitivity !== undefined ? 'protection' : secretKeys(d, input).length ? 'secret' : null;
      if (reason) { reply.code(202); return pendingReply(await proposeChange(p, d, null, input, reason)); }
    }
    input = await settleNew(input);
    reply.code(201);
    return createRecord(d, input, by, actorName(p));
  });

  app.get(`${base}/:id`, async (req) => {
    const { d, p, id } = await ctxFor(req, false);
    const r = await visibleOr404(p, d, id!);
    const out = recordOut(d, r);
    const label = await actorLabels();
    return { ...out, updatedByLabel: label(out.updatedBy), sourceLabel: label(out.source), documents: (await documentsByRecord(d.id)).get(r._id) ?? [], ...(p.isSession ? { linked: await linkedTitles(d, [r]) } : {}) };
  });

  app.patch(`${base}/:id`, async (req, reply) => {
    const { d, p, id, by } = await ctxFor(req, true);
    const existing = await visibleOr404(p, d, id!);
    const prep = await prepareNew((req.body || {}) as RecordInput, p.isSession);
    let input = prep.input;
    const a = p.key.assistant;
    if (a) {
      await buildRecord(d, input, existing, by, { newParties: prep.pending });
      if (a.mode === 'suggest') { reply.code(202); return pendingReply(await proposeChange(p, d, existing._id, input, 'suggest')); }
      if (isIdentityChange(d, input, existing)) { reply.code(202); return pendingReply(await proposeChange(p, d, existing._id, input, 'identity')); }
      // How an entry is protected is the owner's call.
      if (input.sensitivity !== undefined) { reply.code(202); return pendingReply(await proposeChange(p, d, existing._id, input, 'protection')); }
      // Make changes: its new people and organisations are added now, like the rest of the change.
      input = await settleNew(input);
      // Make changes: everything else goes in except secret values, which wait in Review.
      const secrets = secretKeys(d, input, existing);
      if (secrets.length) {
        const review = await proposeChange(p, d, existing._id, { data: Object.fromEntries(secrets.map((k) => [k, input.data![k]])) }, 'secret');
        const rest: RecordInput = { ...input, data: Object.fromEntries(Object.entries(input.data!).filter(([k]) => !secrets.includes(k))) };
        const saved = await updateRecord(d, existing, rest, by, actorName(p));
        return { ...saved, pendingReview: pendingReply(review) };
      }
    }
    input = await settleNew(input);
    return updateRecord(d, existing, input, by, actorName(p));
  });

  app.delete(`${base}/:id`, async (req) => {
    const { d, p, id, by } = await ctxFor(req, true);
    if (p.key.assistant) throw new HttpError(403, 'owner_only', 'Only the owner deletes. Tell them what to remove.');
    const r = await recordOr404(d, id!);
    const title = recordOut(d, r).title;
    // Entries that link here (a citizenship proven by this passport) lose the link. Say so first.
    const usedBy = await recordReferences(r._id);
    if (usedBy.length && (req.query as { confirm?: string }).confirm !== 'true') {
      throw new HttpError(409, 'in_use', `${usedBy.length} ${usedBy.length === 1 ? 'entry links' : 'entries link'} to ${title}. Deleting removes the link.`, { usedBy });
    }
    await unlinkRecord(r._id, by);
    await recordVersion(r, 'delete', by);
    await ctx.store.remove('records', r._id);
    const docsDeleted = await recordRemoved(r._id);
    nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id, [r._id]));
    await audit({ actor: ownerActor(p.key._id), action: 'record.delete', resource: `${d.id}/${r._id}`, text: `${actorName(p)} removed ${title} from ${d.label}`, tone: 'owner' });
    return { deleted: true, documentsDeleted: docsDeleted, restorableForDays: KEEP_DELETED_DAYS };
  });

  app.post(`${base}/:id/reveal`, async (req) => {
    const { d, p, id } = await ctxFor(req, false);
    const r = await visibleOr404(p, d, id!);
    const a = p.key.assistant;
    const out = recordOut(d, r, { reveal: a ? new Set(a.secretFields.filter((f) => f.startsWith(`${d.id}.`)).map((f) => f.slice(d.id.length + 1))) : true });
    await audit({ actor: ownerActor(p.key._id), action: 'record.reveal', resource: `${d.id}/${r._id}`, text: `${actorName(p)} revealed ${recordOut(d, r).title} (${d.label})`, tone: 'owner', ip: req.ip });
    return out;
  });

  // ── history: /api/data/{domain}/{id}/history ───────────────────────
  // Owner-facing only (same scopes as the record); contacts and peers see current values, never history.
  const versionOut = (d: DomainDef, v: VersionDoc, label: (a: Actor) => string) => ({
    version: v._id, action: v.action, at: v.at, by: v.by, byLabel: label(v.by), record: recordOut(d, versionRecord(v)),
  });

  // A party sees what's shared now, never what was deleted or what it used to say.
  const ownHistoryOnly = (p: { key: ApiKeyDoc }) => { if (p.key.access) throw new HttpError(403, 'owner_only', 'Earlier versions and deleted entries are only for the owner.'); };

  app.get('/api/data/:domain/deleted', async (req) => {
    const { d, p } = await ctxFor(req, false);
    ownHistoryOnly(p);
    const label = await actorLabels();
    return { domain: d.id, keepDays: KEEP_DELETED_DAYS, items: (await deletedRecords(d.id)).map((v) => versionOut(d, v, label)) };
  });

  app.get('/api/data/:domain/:id/history', async (req) => {
    const { d, p, id } = await ctxFor(req, false);
    ownHistoryOnly(p);
    const versions = (await versionsOf(id!)).filter((v) => v.domain === d.id);
    if (!versions.length && !(await ctx.store.get('records', id!))) throw notFound('record_not_found');
    const label = await actorLabels();
    return { recordId: id, deleted: !(await ctx.store.get('records', id!)), items: versions.map((v) => versionOut(d, v, label)) };
  });

  /** Make an earlier version current again, as a new change (or bring a deleted record back). Nothing is rewritten. */
  app.post('/api/data/:domain/:id/history/:version/restore', async (req) => {
    const { d, p, id, by } = await ctxFor(req, true);
    if (p.key.assistant) throw new HttpError(403, 'owner_only', 'Only the owner restores earlier versions.');
    const { version } = req.params as { version: string };
    const v = await ctx.store.get<VersionDoc>('recordVersions', version);
    if (!v || v.recordId !== id || v.domain !== d.id) throw notFound('version_not_found');
    const existing = await ctx.store.get<RecordDoc>('records', id!);
    const rec: RecordDoc = { ...versionRecord(v), updatedBy: by, updatedAt: new Date().toISOString() };
    if (existing) { const { _id, ...rest } = rec; await ctx.store.update('records', _id, { ...rest }); }
    else await ctx.store.insert('records', rec);
    await recordVersion(rec, 'restore', by);
    await demoteOtherPrimaries(rec);
    nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id, [rec._id]));
    const out = { ...recordOut(d, rec), updatedByLabel: (await actorLabels())(by) };
    await audit({ actor: ownerActor(p.key._id), action: 'record.restore', resource: `${d.id}/${id}`, text: `${actorName(p)} ${existing ? 'restored an earlier version of' : 'brought back'} ${out.title} in ${d.label}`, tone: 'owner' });
    return out;
  });

  /** Undo one change an app or assistant made, field by field (never over a later edit). */
  app.post('/api/data/:domain/:id/history/:version/undo', async (req) => {
    const p = await requireSession(req);
    const { domain, id, version } = req.params as { domain: string; id: string; version: string };
    const v = await ctx.store.get<VersionDoc>('recordVersions', version);
    if (!v || v.recordId !== id || v.domain !== domain) throw notFound('version_not_found');
    if (v.by.type !== 'app') throw bad('not_an_app_change', 'Only changes made by apps and assistants can be undone this way. Restore an earlier version instead.');
    const result = await undoOnRecord(id, [v], v.by.id, { type: 'owner', id: p.key._id });
    if (result.outcome === 'reverted' || result.outcome === 'removed') {
      nudgePeers(DERIVED_DOMAINS.has(domain) ? null : await contactsSharing(domain, [id]));
      await audit({ actor: ownerActor(p.key._id), action: 'undo.change', resource: `${domain}/${id}`, text: `You undid a change to ${result.title}`, tone: 'owner' });
    }
    return result;
  });

  // ── review: changes assistants proposed, waiting for the owner ─────────
  // The owner sees every item; an assistant's key sees its own. Secret values it can't read stay masked even in its own
  // suggestions (the same key serves every conversation, so one chat mustn't read back what another sent); a value
  // too short to show its last four says it's hidden, so it never reads as blank.
  const reviewOut = async (r: ReviewDoc, owner: boolean, secretFields: string[] = []) => {
    const d = await getDomain(r.domain);
    const input = reviewInput(r);
    const current = r.recordId ? await ctx.store.get<RecordDoc>('records', r.recordId) : null;
    const plainNow = current ? plainData(current) : {};
    const hidden = (v: unknown) => { const m = mask(String(v)); return m.trim() === '••••' ? '•••• (hidden)' : m; };
    const show = (k: string, v: unknown) => (!owner && !secretFields.includes(`${r.domain}.${k}`) && d?.parts.some((x) => x.key === k && partSens(d, x) === 'secret') ? hidden(v) : v);
    return {
      id: r._id, by: r.by, keyId: r.keyId, domain: r.domain, domainLabel: d?.label ?? r.domain, recordId: r.recordId,
      recordTitle: d && current ? recordOut(d, current).title : null, recordGone: !!r.recordId && !current,
      action: r.action, reason: r.reason, status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt, resultId: r.resultId ?? null,
      changes: [
        // New people and organisations it brings: created only if the owner approves.
        ...(input.newParties ?? []).map((n) => ({ key: `${NEW}${n.ref}`, label: n.type === 'organisation' ? 'New organisation' : 'New person', secret: false, to: [n.name, ...[n.website, n.api && `API ${n.api}`, n.mcp && `MCP ${n.mcp}`].filter(Boolean)].join(' · ') })),
        ...Object.entries(input.data ?? {}).map(([k, v]) => {
          const part = d?.parts.find((x) => x.key === k);
          const secret = !!(d && part && partSens(d, part) === 'secret');
          // People and organisations by name, not id; choices by their label ("In collections", not in_collections).
          // One that comes with the suggestion reads "Bonneville Collections (new)".
          const fresh = (x: unknown): unknown => (typeof x === 'string' && x.startsWith(NEW) ? `${input.newParties?.find((n) => `${NEW}${n.ref}` === x)?.name ?? x} (new)` : Array.isArray(x) ? x.map(fresh) : x);
          const named = (x: unknown) => {
            if (x === null || x === undefined || !part) return x;
            if (['party', 'contact'].includes(part.type) && JSON.stringify(x).includes(NEW)) { const f = fresh(x); return Array.isArray(f) ? f.join(', ') : f; }
            return ['party', 'contact', 'enum'].includes(part.type) ? displayValue(part, x) : x;
          };
          return { key: k, label: part?.label ?? k, secret, to: named(show(k, v)), from: r.recordId && owner ? named(plainNow[k] ?? null) : undefined };
        }),
        ...(input.sensitivity !== undefined ? [{ key: 'sensitivity', label: 'Who can see this', secret: false, to: input.sensitivity ?? 'default', from: current && owner ? current.sensitivity ?? 'default' : undefined }] : []),
        ...(['validFrom', 'validTo', 'notes'] as const).filter((k) => input[k] !== undefined).map((k) => ({
          key: k, label: { validFrom: 'From', validTo: 'To', notes: 'Notes' }[k], secret: false, to: input[k], from: current && owner ? current[k] ?? null : undefined,
        })),
      ],
    };
  };

  app.get('/api/reviews', async (req) => {
    const p = await requireOwner(req, ['records:read', 'records:write', ...(await listDomains()).flatMap((d) => [`${d.id}:read`, `${d.id}:write`])]);
    const q = req.query as { status?: string };
    const status = q.status === 'all' ? null : q.status || 'pending';
    let items = await ctx.store.find<ReviewDoc>('reviews', status ? { status } : {}, { sort: { createdAt: -1 } });
    if (!p.isSession) items = items.filter((r) => r.keyId === p.key._id);
    return { items: await Promise.all(items.slice(0, 200).map((r) => reviewOut(r, p.isSession, p.key.assistant?.secretFields ?? []))) };
  });

  const reviewOr404 = async (id: string) => {
    const r = await ctx.store.get<ReviewDoc>('reviews', id);
    if (!r) throw notFound('review_not_found');
    if (r.status !== 'pending') throw new HttpError(409, 'already_decided', `This was already ${r.status}.`);
    return r;
  };

  /** Approve: the change is saved now, credited to the assistant that proposed it. */
  app.post('/api/reviews/:id/approve', async (req) => {
    const p = await requireSession(req);
    const r = await reviewOr404((req.params as { id: string }).id);
    const d = await domainOr404(r.domain);
    const by: Actor = { type: 'app', id: r.keyId };
    let saved;
    if (r.recordId) {
      const existing = await ctx.store.get<RecordDoc>('records', r.recordId);
      if (!existing) throw new HttpError(409, 'record_gone', 'That entry was deleted since. Reject this suggestion instead.');
      saved = await updateRecord(d, existing, await settleNew(reviewInput(r)), by, `${r.by} (approved by you)`);
    } else saved = await createRecord(d, await settleNew(reviewInput(r)), by, `${r.by} (approved by you)`); // its new people and organisations, created now
    await ctx.store.update('reviews', r._id, { status: 'approved', decidedAt: new Date().toISOString(), resultId: saved.id });
    await audit({ actor: ownerActor(p.key._id), action: 'review.approve', resource: `reviews/${r._id}`, text: `You approved ${r.by}'s suggestion for ${d.label}`, tone: 'owner' });
    return { ...(await reviewOut({ ...r, status: 'approved', decidedAt: new Date().toISOString(), resultId: saved.id }, true)), record: saved };
  });

  app.post('/api/reviews/:id/reject', async (req) => {
    const p = await requireSession(req);
    const r = await reviewOr404((req.params as { id: string }).id);
    await ctx.store.update('reviews', r._id, { status: 'rejected', decidedAt: new Date().toISOString() });
    await audit({ actor: ownerActor(p.key._id), action: 'review.reject', resource: `reviews/${r._id}`, text: `You turned down ${r.by}'s suggestion`, tone: 'owner' });
    return reviewOut({ ...r, status: 'rejected', decidedAt: new Date().toISOString() }, true);
  });
}

/** The last day of a full or partial date: 2031 → 2031-12-31, 2031-04 → 2031-04-30. */
const lastDay = (v: string) => (v.length === 4 ? `${v}-12-31` : v.length === 7 ? new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7), 0)).toISOString().slice(0, 10) : v);
const addMonths = (v: string, n: number) => { const d = new Date(`${v}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

/**
 * Trips abroad in the next year that your passport won't cover: many countries turn you away when it has less than
 * six months left after you arrive. "Abroad" is a country other than the one you live in (your primary home).
 */
async function passportForTrips(today: string) {
  const travel = await getDomain('travel'), ids = await getDomain('ids'), homes = await getDomain('residences');
  if (!travel || !ids || !homes) return [];
  const yearOut = addMonths(today, 12);
  const home = (await recordsOf('residences')).filter((r) => isCurrent(homes, r)).map((r) => plainData(r)).find((v) => v.primary)?.country;
  const passports = (await recordsOf('ids')).filter((r) => isCurrent(ids, r) && plainData(r).kind === 'passport');
  const out = [];
  for (const t of await recordsOf('travel')) {
    const v = plainData(t);
    const start = t.validFrom ?? '';
    if (start.length !== 10 || start < today || start > yearOut || !v.country || v.country === home) continue;
    const back = t.validTo && t.validTo.length === 10 ? t.validTo : start;
    const trip = recordOut(travel, t).title.split(' · ').slice(0, -1).join(', ') || recordOut(travel, t).title;
    const ok = passports.some((p) => { const e = plainData(p).expires; return typeof e === 'string' && lastDay(e) >= addMonths(back, 6); });
    if (ok) continue;
    const p = passports[0];
    out.push({
      domain: 'ids', domainLabel: ids.label, id: p?._id ?? t._id, title: p ? `Your passport expires within 6 months of your trip to ${trip}` : `No passport on file for your trip to ${trip}`,
      part: 'Trip starts', kind: 'trip', date: start, expired: false,
    });
  }
  return out;
}
