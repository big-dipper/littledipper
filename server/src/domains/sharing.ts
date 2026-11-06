/** What a connected contact may read from a domain (or a copy holds), shaped for display on their side. */
import { ctx } from '../ctx.js';
import { whatTheyGet } from '../shares.js';
import { displayValue, entrySens, getDomain, isCurrent, partSens, plainData, recordsOf, renderTitle, sortRecords, type DomainDef, type PartDef, type RecordDoc } from './records.js';

export type SharedRecord = {
  id: string;
  title: string;
  /** rows: one line per row of a list part (a receipt's items). */
  fields: { key: string; label: string; value: string; rows?: string[] }[];
  /** Raw values for machine use (no contact ids, no notes). */
  data: Record<string, unknown>;
  validFrom: string | null;
  validTo: string | null;
  current: boolean;
  updatedAt: string;
};
export type SharedDomain = { domain: string; label: string; scope: 'all' | 'current'; records: SharedRecord[] };

/** Categories a party can read: whole ones shared with them, and ones holding entries shared one by one. */
export async function sharedDomainIds(partyId: string) {
  const w = await whatTheyGet(partyId);
  const ids = new Set(Object.keys(w.categories));
  for (const e of w.entries) { const r = await ctx.store.get<RecordDoc>('records', e.id); if (r) ids.add(r.domain); }
  return [...ids];
}

/** What a party may read of one category: the whole category (all or current), plus entries shared one by one. */
export async function sharedDomainOut(contactId: string, domainId: string): Promise<SharedDomain | null> {
  const w = await whatTheyGet(contactId);
  const d = await getDomain(domainId);
  if (!d) return null;
  const g = w.categories[domainId];
  const all = sortRecords(d, await recordsOf(d.id));
  const picked = new Map(w.entries.map((e) => [e.id, e]));
  const recs = all.filter((r) => (g && (g.scope === 'all' || isCurrent(d, r))) || picked.has(r._id));
  if (!recs.length && !g) return null;
  // Secret details per category, or per entry shared on its own.
  const out: SharedRecord[] = [];
  for (const r of recs) out.push(...(await shapeRecords(d, [r], (g?.includeSecret ?? false) || (picked.get(r._id)?.includeSecret ?? false))));
  return { domain: d.id, label: d.label, scope: g?.scope ?? 'all', records: out };
}

/** Records as someone else sees them: no notes, secret parts only with includeSecret, contacts as names. */
export async function shapeRecords(d: DomainDef, recs: RecordDoc[], includeSecret: boolean): Promise<SharedRecord[]> {
  const names = new Map<string, string>();
  const nameOf = async (id: string) => {
    if (!names.has(id)) names.set(id, (await ctx.store.get('parties', id))?.name ?? '');
    return names.get(id)!;
  };
  // Sharing doesn't follow links: a linked entry shows only that it exists ("Proven by: Government IDs"), never its contents.
  const linkLabel = async (p: PartDef, v: unknown) => {
    const n = Array.isArray(v) ? v.length : 1;
    const labels = await Promise.all((p.to ?? []).map(async (id) => (await getDomain(id))?.label ?? id));
    return `${n} ${n === 1 ? 'entry' : 'entries'}${labels.length ? ` in ${labels.join(' or ')}` : ''}`;
  };
  const out: SharedRecord[] = [];
  for (const r of recs) {
    const plain = plainData(r);
    const entry = entrySens(d, r, plain);
    const hidden = new Set(d.parts.filter((p) => partSens(d, p, entry) === 'secret' && !includeSecret).map((p) => p.key));
    const fields: SharedRecord['fields'] = [];
    const data: Record<string, unknown> = {};
    for (const p of d.parts) {
      if (hidden.has(p.key) || plain[p.key] === undefined) continue;
      // A party becomes their name: ids mean nothing elsewhere.
      const isParty = p.type === 'party' || p.type === 'contact';
      const value = isParty ? await nameOf(String(plain[p.key])) : p.type === 'record' ? await linkLabel(p, plain[p.key]) : displayValue(p, plain[p.key]);
      if (!value) continue;
      const rows = p.type === 'list' ? (plain[p.key] as Record<string, unknown>[]).map((row) => p.of!.map((s) => displayValue(s, row[s.key])).filter(Boolean).join(' · ')) : undefined;
      fields.push({ key: p.key, label: p.label, value, ...(rows ? { rows } : {}) });
      data[p.key] = isParty || p.type === 'record' ? value : plain[p.key];
    }
    out.push({ id: r._id, title: renderTitle(d, plain, hidden), fields, data, validFrom: r.validFrom, validTo: r.validTo, current: isCurrent(d, r), updatedAt: r.updatedAt });
  }
  return out;
}
