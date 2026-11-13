/** Records engine: validation, part-level encryption, output shapes and derived profile fields. */
import { ctx } from '../ctx.js';
import { decrypt, encrypt, isEncrypted, newId } from '../crypto.js';
import { bad } from '../auth.js';
import { mask, type Sensitivity } from '../fields.js';
import type { Store } from '../store/index.js';
import { BUILT_IN_DOMAINS, RESERVED } from './catalog.js';
import { dateTimeSortKey, displayDateTime, isDateTime, isTimeZone, normalizeDateTime, type DateTimeValue } from './datetime.js';
import { checkMethod, displayPhone } from '../methods.js';
import type { Actor, DomainDef, PartDef, PartType, RecordDoc, VersionDoc } from './types.js';

export type { DomainDef, PartDef, RecordDoc };

const RANK: Record<Sensitivity, number> = { standard: 0, sensitive: 1, secret: 2 };
export const maxSens = (a: Sensitivity, b: Sensitivity) => (RANK[a] >= RANK[b] ? a : b);
export const SENS: Sensitivity[] = ['standard', 'sensitive', 'secret'];

/** The category's default for an entry with these values: per kind where it says so (names: preferred is standard). */
export function defaultSens(d: DomainDef, plain: Record<string, unknown> = {}): Sensitivity {
  const by = d.sensitivityBy ? [d.sensitivityBy].flat() : [];
  return by.map((b) => b.values[String(plain[b.part])]).find(Boolean) || d.sensitivity;
}

/** How sensitive an entry is: the owner's choice for it, or the default for its kind. */
export const entrySens = (d: DomainDef, r?: Pick<RecordDoc, 'sensitivity'> | null, plain: Record<string, unknown> = {}): Sensitivity =>
  r?.sensitivity ?? defaultSens(d, plain);

/**
 * A part's declared sensitivity is a floor: a passport number is always at least secret. Otherwise a part follows its
 * entry, so marking an entry more sensitive protects every part of it.
 */
export const partSens = (d: DomainDef, p: PartDef, entry: Sensitivity = d.sensitivity): Sensitivity => (p.sensitivity ? maxSens(p.sensitivity, entry) : entry);

// ── registry ───────────────────────────────────────────────────────────

export async function listDomains(): Promise<DomainDef[]> {
  const custom = await ctx.store.find<DomainDef & { _id: string }>('domainDefs', {}, { sort: { label: 1 } });
  return [...BUILT_IN_DOMAINS, ...custom.map(({ _id, ...d }) => d as DomainDef)];
}

export async function getDomain(id: string): Promise<DomainDef | null> {
  return BUILT_IN_DOMAINS.find((d) => d.id === id) ?? (await ctx.store.findOne<DomainDef & { _id: string }>('domainDefs', { id })) ?? null;
}

const PART_TYPES: PartType[] = ['text', 'longtext', 'date', 'datetime', 'time', 'email', 'phone', 'url', 'country', 'region', 'address', 'currency', 'money', 'number', 'boolean', 'enum', 'last4', 'party', 'contact'];

/** Validate an owner-defined domain. Ids are x_ + slug so they never collide with built-ins or routes. */
export function checkCustomDomain(input: Partial<DomainDef>): DomainDef {
  const label = String(input.label || '').trim();
  if (!label) throw bad('label_required', 'Give the category a name');
  const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  const id = `x_${slug || 'custom'}`;
  if (RESERVED.has(id)) throw bad('reserved');
  const parts = (input.parts || []).map((p, i) => {
    const key = String(p.key || p.label || `part${i}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 30) || `part${i}`;
    if (!PART_TYPES.includes(p.type)) throw bad('bad_part_type', `Unknown type for ${p.label}`);
    if (p.type === 'enum' && !p.options?.length) throw bad('options_required', `${p.label} needs options`);
    return { key, label: String(p.label || key), type: p.type, required: !!p.required, sensitivity: p.sensitivity, options: p.options, hint: p.hint } as PartDef;
  });
  if (!parts.length) throw bad('parts_required', 'Add at least one detail to the category');
  if (new Set(parts.map((p) => p.key)).size !== parts.length) throw bad('duplicate_parts', 'Two details have the same name');
  const sensitivity = (['standard', 'sensitive', 'secret'] as Sensitivity[]).includes(input.sensitivity as Sensitivity) ? (input.sensitivity as Sensitivity) : 'sensitive';
  return {
    id, label, noun: String(input.noun || label.toLowerCase()), group: 'custom', description: String(input.description || ''),
    sensitivity, parts, dated: !!input.dated, title: input.title || `{${parts[0].key}}`,
    publicable: !!input.publicable && sensitivity !== 'secret',
    builtIn: false, schemaVersion: 1,
  };
}

// ── validation ─────────────────────────────────────────────────────────

export const PERIODS = ['hour', 'week', 'month', 'year', 'once'] as const;
const ADDRESS_KEYS = ['street1', 'street2', 'city', 'region', 'postalCode', 'country'] as const;
const RRULE_KEYS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'BYYEARDAY', 'BYWEEKNO', 'WKST']);

/** A party exists. */
export const partyExists = async (id: string) => !!(await ctx.store.get('parties', id));

// ── party names ────────────────────────────────────────────────────────
// Entries point to parties by id; titles and displays show their names ("Engineer at Acme Corp"). Names are kept in
// memory and refreshed whenever the parties collection is written, so they're never stale.
const partyNames = new Map<string, string>();
export const partyName = (id: string) => partyNames.get(id) ?? 'Someone removed';

export async function loadPartyNames() {
  partyNames.clear();
  for (const p of await ctx.store.find<{ _id: string; name: string }>('parties', {})) partyNames.set(p._id, p.name);
}

/** Wrap a store so every write to parties (or a restore) refreshes the names. Call once at boot. */
export function trackPartyNames<T extends Store>(store: T): T {
  const refresh = () => loadPartyNames().catch(() => {});
  for (const m of ['insert', 'update', 'remove', 'removeMany'] as const) {
    const orig = (store[m] as (...a: unknown[]) => Promise<unknown>).bind(store);
    (store as Record<string, unknown>)[m] = async (coll: string, ...rest: unknown[]) => { const r = await orig(coll, ...rest); if (coll === 'parties') await refresh(); return r; };
  }
  const restore = store.restore.bind(store);
  store.restore = async (data) => { await restore(data); await refresh(); };
  return store;
}

/** An iCalendar RRULE: KEY=VALUE pairs, FREQ required, COUNT and UNTIL not both. Normalised to upper case without the RRULE: prefix. */
export function checkRepeat(v: unknown): string | null {
  const s = String(v ?? '').trim().replace(/^RRULE:/i, '').toUpperCase();
  const pairs = s.split(';').filter(Boolean).map((x) => x.split('='));
  if (!pairs.length || pairs.some((x) => x.length !== 2 || !RRULE_KEYS.has(x[0]) || !x[1])) return null;
  const m = Object.fromEntries(pairs);
  if (!/^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(m.FREQ ?? '')) return null;
  if (m.COUNT && m.UNTIL) return null;
  if (m.INTERVAL && !/^[1-9]\d{0,2}$/.test(m.INTERVAL)) return null;
  if (m.COUNT && !/^[1-9]\d{0,3}$/.test(m.COUNT)) return null;
  if (m.UNTIL && !/^\d{8}(T\d{6}Z?)?$/.test(m.UNTIL)) return null;
  if (m.BYDAY && !/^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)(,([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU))*$/.test(m.BYDAY)) return null;
  return pairs.map((x) => x.join('=')).join(';');
}

const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const isPartialDate = (v: unknown) => typeof v === 'string' && DATE.test(v);

/** newParties: "new:<ref>" values that stand for people or organisations a suggestion will create when approved. */
type PartCtx = { domain: string; recordId: string | null; newParties?: Set<string> };
const MAX_ROWS = 200;

async function checkPart(p: PartDef, v: unknown, cx: PartCtx): Promise<unknown> {
  const fail = (why: string) => { throw bad('invalid_value', `${p.label}: ${why}`); };
  switch (p.type) {
    case 'text': case 'longtext': {
      const s = String(v).trim();
      if (s.length > (p.type === 'text' ? 500 : 10000)) fail('too long');
      return s;
    }
    case 'date': return isPartialDate(v) ? v : fail('use YYYY, YYYY-MM or YYYY-MM-DD');
    case 'datetime': return normalizeDateTime(v) ?? fail('use { at: "YYYY-MM-DDTHH:MM", tz: "America/New_York" }; at may include a UTC offset');
    case 'email': return EMAIL.test(String(v).trim()) ? String(v).trim() : fail('not an email address');
    case 'phone': return /^[+\d][\d\s().\-x]{3,30}$/.test(String(v).trim()) ? String(v).trim() : fail('not a phone number');
    case 'url': {
      const s = String(v).trim();
      try { const u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`); return u.toString(); } catch { return fail('not a web address'); }
    }
    case 'country': { const s = String(v).toUpperCase(); return /^[A-Z]{2}$/.test(s) ? s : fail('use a two-letter country code, e.g. US'); }
    case 'region': { const s = String(v).trim().toUpperCase(); return /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(s) ? s : fail('use a country code, or country and region, e.g. US or US-OR'); }
    case 'address': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('expected an address');
      const a = v as Record<string, unknown>;
      const extra = Object.keys(a).filter((k) => !(ADDRESS_KEYS as readonly string[]).includes(k));
      if (extra.length) fail(`addresses have no ${extra.join(', ')}: use street1, street2, city, region (a state or province, e.g. UT), postalCode and country (a two-letter code, e.g. US)`);
      const out: Record<string, string> = {};
      for (const k of ADDRESS_KEYS) {
        const x = String(a[k] ?? '').trim();
        if (x.length > 200) fail('too long');
        if (x) out[k] = k === 'country' ? x.toUpperCase() : x;
      }
      if (!/^[A-Z]{2}$/.test(out.country ?? '')) fail('needs a two-letter country code, e.g. US');
      return out;
    }
    case 'repeat': return checkRepeat(v) ?? fail('use an iCalendar repeat rule, e.g. FREQ=WEEKLY;BYDAY=TU');
    case 'time': { const s = String(v).trim(); return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s) ? s : fail('use HH:MM or HH:MM:SS, e.g. 06:42:17'); }
    case 'timezone': return isTimeZone(v) ? v : fail('use a time zone name, e.g. America/Chicago');
    case 'geo': {
      const g = v as { lat?: unknown; lon?: unknown };
      const lat = Number(g?.lat), lon = Number(g?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) fail('use { lat, lon } in decimal degrees');
      return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
    }
    case 'party': case 'contact': {
      const ids = p.many ? (Array.isArray(v) ? v.map(String) : fail('expected a list of people or organisations')) : [String(v)];
      if (new Set(ids).size !== ids.length) fail('the same person twice');
      for (const id of ids) if (!cx.newParties?.has(id) && !(await partyExists(id))) fail(id.startsWith('new:') ? `${id} isn’t in newParties` : 'no such person or organisation (use their id from find_parties; someone new goes in newParties as "new:<ref>")');
      return p.many ? ids : ids[0];
    }
    case 'record': {
      const ids = p.many ? (Array.isArray(v) ? v.map(String) : fail('expected a list of entries')) : [String(v)];
      if (new Set(ids).size !== ids.length) fail('the same entry twice');
      for (const id of ids) {
        if (id === cx.recordId) fail('an entry can’t point to itself');
        const target = await ctx.store.get<RecordDoc>('records', id);
        if (!target) fail('no such entry');
        if (p.to?.length && !p.to.includes(target!.domain)) fail(`must be an entry in ${p.to.join(' or ')}`);
      }
      return p.many ? ids : ids[0];
    }
    case 'currency': { const s = String(v).toUpperCase(); return /^[A-Z]{3}$/.test(s) ? s : fail('use a three-letter currency code, e.g. USD'); }
    case 'money': {
      const m = v as { amount?: unknown; currency?: unknown };
      if (m?.amount === '' || m?.amount === null || m?.amount === undefined) fail('amount must be a number');
      const amount = Number(m?.amount);
      const currency = String(m?.currency || 'USD').toUpperCase();
      if (!Number.isFinite(amount)) fail('amount must be a number');
      if (!/^[A-Z]{3}$/.test(currency)) fail('bad currency');
      if (!p.periodic) return { amount, currency };
      const period = (m as { period?: unknown }).period;
      if (!PERIODS.includes(period as never)) fail(`say per what: ${PERIODS.join(', ')}`);
      return { amount, currency, period };
    }
    case 'number': { const n = Number(v); return Number.isFinite(n) ? n : fail('must be a number'); }
    case 'boolean': return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : fail('must be true or false');
    case 'enum': return p.options!.some(([k]) => k === v) ? v : fail(`must be one of ${p.options!.map(([k]) => k).join(', ')}`);
    case 'last4': return /^\d{4}$/.test(String(v)) ? String(v) : fail('only the last four digits, never the full number');
    case 'list': {
      if (!Array.isArray(v)) fail('expected a list');
      if ((v as unknown[]).length > MAX_ROWS) fail(`up to ${MAX_ROWS} rows`);
      const rows: Record<string, unknown>[] = [];
      for (const raw of v as unknown[]) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('each row must be an object');
        const r = raw as Record<string, unknown>;
        const extra = Object.keys(r).filter((k) => !p.of!.some((s) => s.key === k));
        if (extra.length) fail(`rows have no ${extra.join(', ')}`);
        const row: Record<string, unknown> = {};
        for (const s of p.of!) if (!empty(r[s.key]) && !(s.type === 'money' && empty((r[s.key] as { amount?: unknown })?.amount))) row[s.key] = await checkPart(s, r[s.key], cx);
        if (!Object.keys(row).length) continue; // a blank row from the table editor
        const missing = p.of!.filter((s) => s.required && empty(row[s.key]));
        if (missing.length) fail(`each row needs ${missing.map((s) => s.label.toLowerCase()).join(', ')}`);
        rows.push(row);
      }
      return rows;
    }
  }
}

const empty = (v: unknown) => v === undefined || v === null || v === '';

/** Rules across the parts of one built-in domain, checked once each part has passed on its own. */
const CHECKS: Record<string, (data: Record<string, unknown>) => void> = {
  // A car's VIN since 1981 is 17 characters, never I, O or Q. Older cars, boats and bikes: anything goes.
  vehicles: (x) => {
    if (x.vin === undefined || !['car', 'truck', 'motorcycle', 'rv'].includes(String(x.kind)) || Number(x.year) < 1981) return;
    const vin = String(x.vin).toUpperCase().replace(/\s/g, '');
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw bad('invalid_value', 'VIN: 17 letters and numbers (never I, O or Q)');
    x.vin = vin;
  },
  // The one contact-method shape: the value is checked and normalised by kind (phones in E.164).
  contact_methods: (x) => {
    if (x.kind === 'postal' || x.value === undefined) return;
    const m = checkMethod({ kind: x.kind, value: x.value, service: x.service });
    x.value = m.value;
  },
  events: (x) => {
    const start = x.start as DateTimeValue | undefined, end = x.end as DateTimeValue | undefined;
    if (start && end) {
      // All day: compare days (the end is the last day). Timed: the end must come after the start.
      const ok = x.allDay ? end.at.slice(0, 10) >= start.at.slice(0, 10) : Date.parse(end.at) > Date.parse(start.at);
      if (!ok) throw bad('end_before_start', x.allDay ? 'The last day is before the first' : 'It ends before it starts');
    }
  },
};

export type RecordInput = { data?: Record<string, unknown>; validFrom?: string | null; validTo?: string | null; notes?: string; sensitivity?: Sensitivity | null;
  /** People and organisations a suggestion brings with it, referred to in data as "new:<ref>". Created only when the owner approves. */
  newParties?: import('../newParties.js').NewParty[] };

const conds = (p: PartDef) => (p.when ? (Array.isArray(p.when) ? p.when : [p.when]) : []);
const applies = (p: PartDef, data: Record<string, unknown>) => !p.when || conds(p).some((w) => (w.in.includes('*') ? !empty(data[w.part]) : w.in.includes(String(data[w.part]))));

/**
 * Build the stored form of a record from input (create) or input merged onto an existing record (patch).
 * In a patch, a part set to null is removed; parts not mentioned are kept. `sensitivity: null` goes back to the default.
 * Values are worked on in the clear, then each part is encrypted if it's secret for this entry, so changing how
 * sensitive an entry is re-protects every part.
 */
/** `by` is whoever is making this change: the creator on a new record, the latest editor on an existing one. */
export async function buildRecord(d: DomainDef, input: RecordInput, existing: RecordDoc | null, by: Actor, opts: { newParties?: Set<string> } = {}): Promise<RecordDoc> {
  const inData = (input.data ?? {}) as Record<string, unknown>;
  const unknownKeys = Object.keys(inData).filter((k) => !d.parts.some((p) => p.key === k));
  if (unknownKeys.length) throw bad('unknown_parts', `${d.label} has no ${unknownKeys.join(', ')}`);
  if (!existing && d.single && (await ctx.store.count('records', { domain: d.id }))) throw bad('single_entry', `${d.label} has one entry. Change that one.`);
  const plain: Record<string, unknown> = existing ? plainData(existing) : {};
  for (const p of d.parts) {
    if (!(p.key in inData)) continue;
    const v = inData[p.key];
    if (empty(v)) { delete plain[p.key]; continue; }
    const clean = await checkPart(p, v, { domain: d.id, recordId: existing?._id ?? null, newParties: opts.newParties });
    if (Array.isArray(clean) && !clean.length) { delete plain[p.key]; continue; }
    plain[p.key] = clean;
  }
  // A part that only applies in some states can't be set outside them. Values already stored stay: they were true.
  const misplaced = d.parts.filter((p) => p.key in inData && !empty(inData[p.key]) && !applies(p, plain));
  if (misplaced.length) {
    const when = conds(misplaced[0]).map((w) => {
      const on = d.parts.find((x) => x.key === w.part);
      if (w.in.includes('*')) return `${on?.label.toLowerCase() ?? w.part} is given`;
      return `${on?.label.toLowerCase() ?? w.part} is ${w.in.map((v) => on?.options?.find(([k]) => k === v)?.[1] ?? v).join(' or ')}`;
    }).join(', or ');
    throw bad('not_applicable', `${misplaced.map((p) => p.label).join(', ')} only applies when ${when}`);
  }
  const missing = d.parts.filter((p) => p.required && applies(p, plain) && empty(plain[p.key]));
  if (missing.length) throw bad('required', `${d.label} needs ${missing.map((p) => p.label.toLowerCase()).join(', ')}`);
  CHECKS[d.id]?.(plain);

  let sensitivity = existing?.sensitivity;
  if (input.sensitivity !== undefined) {
    if (input.sensitivity !== null && !SENS.includes(input.sensitivity)) throw bad('invalid_value', 'Sensitivity: standard, sensitive or secret');
    sensitivity = input.sensitivity ?? undefined;
  }
  const entry = entrySens(d, { sensitivity }, plain);
  const data = Object.fromEntries(Object.entries(plain).map(([k, v]) => {
    const p = d.parts.find((x) => x.key === k);
    return [k, p && partSens(d, p, entry) === 'secret' ? encrypt(ctx.keys.masterKey, JSON.stringify(v)) : v];
  }));

  let validFrom = existing?.validFrom ?? null, validTo = existing?.validTo ?? null;
  if (d.dated) {
    if (input.validFrom !== undefined) validFrom = empty(input.validFrom) ? null : isPartialDate(input.validFrom) ? input.validFrom! : (() => { throw bad('invalid_value', 'From: use YYYY, YYYY-MM or YYYY-MM-DD'); })();
    if (input.validTo !== undefined) validTo = empty(input.validTo) ? null : isPartialDate(input.validTo) ? input.validTo! : (() => { throw bad('invalid_value', 'To: use YYYY, YYYY-MM or YYYY-MM-DD'); })();
    if (validFrom && validTo && validTo < validFrom) throw bad('invalid_value', '“To” is before “From”');
  }
  const t = new Date().toISOString();
  return {
    _id: existing?._id ?? newId('rec'), domain: d.id, data, validFrom, validTo,
    sensitivity, // undefined = the default for its kind; an update removes a stored choice
    notes: input.notes !== undefined ? String(input.notes).slice(0, 10000) : existing?.notes ?? '',
    source: existing?.source ?? by, updatedBy: by, schemaVersion: d.schemaVersion, createdAt: existing?.createdAt ?? t, updatedAt: t,
  };
}

// ── reading ────────────────────────────────────────────────────────────

/** Readable names for whoever changed records, for owner-facing screens: "You", an app key's name… */
export async function actorLabels(): Promise<(a: Actor) => string> {
  const keys = new Map((await ctx.store.find<{ _id: string; name?: string }>('apiKeys', { kind: 'app' })).map((k) => [k._id, k.name]));
  return (a) => (a.type === 'owner' ? 'You' : a.type === 'app' ? keys.get(a.id) || 'An app' : a.type === 'import' ? 'Import' : 'Little Dipper');
}

/** Part values with secrets decrypted. */
export function plainData(rec: RecordDoc): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rec.data).map(([k, v]) => [k, isEncrypted(v) ? JSON.parse(decrypt(ctx.keys.masterKey, v)) : v]));
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const countryName = (code: string) => { try { return regionNames.of(code) || code; } catch { return code; } };

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function displayValue(p: PartDef, v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  switch (p.type) {
    case 'enum': return p.options?.find(([k]) => k === v)?.[1] ?? String(v);
    case 'country': return countryName(String(v));
    case 'money': {
      const m = v as { amount: number; currency: string; period?: string };
      let s: string;
      try { s = new Intl.NumberFormat('en', { style: 'currency', currency: m.currency, maximumFractionDigits: Number.isInteger(m.amount) ? 0 : 2 }).format(m.amount); } catch { s = `${m.amount} ${m.currency}`; }
      return m.period && m.period !== 'once' ? `${s} ${m.period === 'hour' ? 'an' : 'a'} ${m.period}` : s;
    }
    case 'boolean': return v ? 'Yes' : 'No';
    case 'list': { const n = (v as unknown[]).length; return n ? `${n} ${n === 1 ? 'row' : 'rows'}` : ''; }
    case 'datetime': return isDateTime(v) ? displayDateTime(v) : String(v);
    case 'region': { const [c, r] = String(v).split('-'); return r ? `${r}, ${countryName(c)}` : countryName(c); }
    case 'address': { const a = v as Record<string, string>; return [a.street1, a.street2, a.city, [a.region, a.postalCode].filter(Boolean).join(' '), a.country ? countryName(a.country) : ''].filter(Boolean).join(', '); }
    case 'repeat': return describeRepeat(String(v));
    case 'geo': { const g = v as { lat: number; lon: number }; return `${Math.abs(g.lat)}° ${g.lat >= 0 ? 'N' : 'S'}, ${Math.abs(g.lon)}° ${g.lon >= 0 ? 'E' : 'W'}`; }
    case 'record': { const n = Array.isArray(v) ? v.length : 1; return `${n} linked ${n === 1 ? 'entry' : 'entries'}`; }
    case 'party': case 'contact': return (Array.isArray(v) ? v : [v]).map((x) => partyName(String(x))).join(', ');
    case 'date': { const [y, m, d] = String(v).split('-'); return [d && String(+d), m && MONTH_NAMES[+m - 1], y].filter(Boolean).join(' '); }
    // Phone numbers are stored as +15035550148 and read as (503) 555-0148, wherever they turn up.
    default: return E164.test(String(v)) ? displayPhone(String(v)) : String(v);
  }
}

const E164 = /^\+[1-9]\d{6,14}(;ext=\d+)?$/;

const DAYS: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
const NTH: Record<string, string> = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '-1': 'last' };

/** A repeat rule in words, for the common cases: "Every 2 weeks on Tuesday", "Monthly on the second Monday". */
export function describeRepeat(rule: string): string {
  const m = Object.fromEntries(rule.split(';').map((x) => x.split('=')));
  const n = Number(m.INTERVAL || 1);
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[m.FREQ as string] ?? '';
  let out = n === 1 ? { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' }[m.FREQ as string] ?? rule : `Every ${n} ${unit}s`;
  if (m.BYDAY) {
    out += ' on ' + String(m.BYDAY).split(',').map((d) => {
      const x = d.match(/^([+-]?\d{1,2})?([A-Z]{2})$/);
      if (!x) return d;
      return x[1] ? `the ${NTH[x[1].replace('+', '')] ?? x[1]} ${DAYS[x[2]]}` : DAYS[x[2]];
    }).join(', ');
  } else if (m.BYMONTHDAY) out += ` on day ${m.BYMONTHDAY}`;
  if (m.COUNT) out += `, ${m.COUNT} times`;
  if (m.UNTIL) out += `, until ${m.UNTIL.slice(0, 4)}-${m.UNTIL.slice(4, 6)}-${m.UNTIL.slice(6, 8)}`;
  return out;
}

export function renderTitle(d: DomainDef, raw: Record<string, unknown>, hidden: Set<string> = new Set()): string {
  // A phone reads as people write it, not as stored (+12065550199 → (206) 555-0199).
  const values = d.id === 'contact_methods' && raw.kind === 'phone' && typeof raw.value === 'string' ? { ...raw, value: displayPhone(raw.value) } : raw;
  // {a|b}: the first of them that has a value (a name's "Nickname" rather than "Another name").
  const out = d.title.replace(/\{([\w|]+)\}/g, (_, ks: string) => {
    const k = ks.split('|').find((x) => values[x] !== undefined && values[x] !== '') ?? ks.split('|')[0];
    if (hidden.has(k)) return '••••';
    const p = d.parts.find((x) => x.key === k);
    return p ? displayValue(p, values[k]) : '';
  });
  // A title is one line: a note's is its opening words.
  const [first, ...rest] = out.trim().split('\n');
  const line = first.replace(/\(\s*\)/g, '').replace(/\s+(at|·|:)\s*$/g, '').replace(/^\s*(·|:|at)\s+/g, '').replace(/\s{2,}/g, ' ').replace(/\s+·\s+·\s+/g, ' · ').trim() || d.noun;
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : rest.some((x) => x.trim()) ? `${line}…` : line;
}

export const isCurrent = (d: DomainDef, r: RecordDoc) => !d.dated || !r.validTo || r.validTo >= new Date().toISOString().slice(0, r.validTo.length);

/** API shape. Secret parts are masked unless revealed; `masked` lists which. */
/** reveal: true shows every secret part; a set shows just those part keys (an assistant's allowed secrets). */
export function recordOut(d: DomainDef, r: RecordDoc, opts: { reveal?: boolean | Set<string> } = {}) {
  const plain = plainData(r);
  const entry = entrySens(d, r, plain);
  const data: Record<string, unknown> = {};
  const masked: string[] = [];
  for (const p of d.parts) {
    if (!(p.key in plain)) continue;
    if (partSens(d, p, entry) === 'secret' && !(opts.reveal === true || (opts.reveal instanceof Set && opts.reveal.has(p.key)))) {
      masked.push(p.key);
      data[p.key] = typeof plain[p.key] === 'object' ? null : mask(String(plain[p.key]));
    } else data[p.key] = plain[p.key];
  }
  return {
    id: r._id, domain: d.id, title: renderTitle(d, plain, masked.length ? new Set(masked) : undefined),
    data, masked, sensitivity: entry, sensitivityDefault: !r.sensitivity, validFrom: r.validFrom, validTo: r.validTo, current: isCurrent(d, r),
    // Records from before per-edit provenance (or restored from an older backup) were last changed by their creator.
    notes: r.notes, source: r.source, updatedBy: r.updatedBy ?? r.source, schemaVersion: r.schemaVersion, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

/** A part value as sortable text: dates as written, a datetime by its instant. */
const sortKey = (v: unknown) => (isDateTime(v) ? dateTimeSortKey(v) : String(v ?? ''));

/** Newest first; current records ahead of ended ones. */
export function sortRecords(d: DomainDef, recs: RecordDoc[]) {
  const by = d.sortBy;
  return recs.sort((a, b) => {
    if (by) {
      // Undated entries last; plain values only (a sortBy part is never secret).
      const x = sortKey(a.data[by]), y = sortKey(b.data[by]);
      if (x !== y) return !x ? 1 : !y ? -1 : y.localeCompare(x);
      return b.createdAt.localeCompare(a.createdAt);
    }
    if (d.dated) {
      const ca = isCurrent(d, a) ? 1 : 0, cb = isCurrent(d, b) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return String(b.validFrom ?? '').localeCompare(String(a.validFrom ?? '')) || b.createdAt.localeCompare(a.createdAt);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

// ── history ────────────────────────────────────────────────────────────

/** Deleted records can be brought back for this long; then their history goes too. */
export const KEEP_DELETED_DAYS = 30;

/** Keep a copy of a record as it stands after a change (as it was, for a delete). */
export async function recordVersion(rec: RecordDoc, action: VersionDoc['action'], by: Actor) {
  const { _id, ...rest } = rec;
  const v: VersionDoc = { ...rest, _id: newId('ver'), recordId: _id, action, at: new Date().toISOString(), by };
  await ctx.store.insert('recordVersions', v);
}

/** Every version of one record, newest first. */
export async function versionsOf(recordId: string) {
  return (await ctx.store.find<VersionDoc>('recordVersions', { recordId }, { sort: { at: 1 } })).reverse();
}

/** The version as a record, for recordOut and restores. */
export const versionRecord = (v: VersionDoc): RecordDoc => {
  const { _id, recordId, action, at, by, ...rest } = v;
  return { ...rest, _id: recordId };
};

/** Records deleted from a domain in the last KEEP_DELETED_DAYS, newest first: their last version before deletion. */
export async function deletedRecords(domainId: string) {
  await pruneDeleted();
  const latest = new Map<string, VersionDoc>();
  for (const v of await ctx.store.find<VersionDoc>('recordVersions', { domain: domainId, action: 'delete' }, { sort: { at: 1 } })) latest.set(v.recordId, v);
  const out: VersionDoc[] = [];
  for (const v of latest.values()) if (!(await ctx.store.get('records', v.recordId))) out.push(v);
  return out.reverse();
}

/** Forget the history of records deleted more than KEEP_DELETED_DAYS ago (and not brought back). */
export async function pruneDeleted() {
  const cutoff = new Date(Date.now() - KEEP_DELETED_DAYS * 86400_000).toISOString();
  const gone = new Set<string>();
  for (const v of await ctx.store.find<VersionDoc>('recordVersions', { action: 'delete' })) {
    if (v.at < cutoff && !(await ctx.store.get('records', v.recordId))) gone.add(v.recordId);
  }
  for (const id of gone) {
    const last = (await versionsOf(id))[0];
    if (last?.action === 'delete' && last.at < cutoff) await ctx.store.removeMany('recordVersions', { recordId: id });
  }
}

export async function recordsOf(domainId: string) {
  return ctx.store.find<RecordDoc & { [k: string]: unknown }>('records', { domain: domainId }) as Promise<RecordDoc[]>;
}

// ── references ─────────────────────────────────────────────────────────
// Entries point to parties and to other entries. Deleting the target shows what points to it, then removes those
// pointers, so a link never dangles. The reverse ("this passport proves a citizenship") is worked out, never stored.

export type Reference = { domain: string; domainLabel: string; recordId: string; title: string; part: string; partLabel: string };

async function referencesWhere(match: (p: PartDef, v: unknown) => boolean): Promise<Reference[]> {
  const out: Reference[] = [];
  for (const d of await listDomains()) {
    const parts = d.parts.filter((p) => ['party', 'contact', 'record'].includes(p.type));
    if (!parts.length) continue;
    for (const r of await recordsOf(d.id)) {
      const plain = plainData(r);
      // Titles as recordOut gives them: secret parts masked.
      for (const p of parts) if (plain[p.key] !== undefined && match(p, plain[p.key])) out.push({ domain: d.id, domainLabel: d.label, recordId: r._id, title: recordOut(d, r).title, part: p.key, partLabel: p.label });
    }
  }
  return out;
}

const pointsTo = (v: unknown, id: string) => (Array.isArray(v) ? v.includes(id) : v === id);

/** Entries that name this party (employer, landlord, supervisor…). */
export const partyReferences = (partyId: string) => referencesWhere((p, v) => p.type !== 'record' && pointsTo(v, partyId));

/** Entries that link to this entry (a citizenship proven by a passport…). */
export const recordReferences = (recordId: string) => referencesWhere((p, v) => p.type === 'record' && pointsTo(v, recordId));

/** Remove every pointer to a party or entry that's being deleted. Each changed entry gets a version, like any edit. */
async function unlink(refs: Reference[], id: string, by: Actor) {
  for (const ref of refs) {
    const r = await ctx.store.get<RecordDoc>('records', ref.recordId);
    if (!r) continue;
    const plain = plainData(r);
    const v = plain[ref.part];
    const next = Array.isArray(v) ? v.filter((x) => x !== id) : null;
    const data = { ...r.data };
    if (next && next.length) data[ref.part] = isEncrypted(r.data[ref.part]) ? encrypt(ctx.keys.masterKey, JSON.stringify(next)) : next;
    else delete data[ref.part];
    const updated = { ...r, data, updatedBy: by, updatedAt: new Date().toISOString() };
    await ctx.store.update('records', r._id, { data, updatedBy: by, updatedAt: updated.updatedAt });
    await recordVersion(updated, 'update', by);
  }
}

export async function unlinkParty(partyId: string, byId: string) { await unlink(await partyReferences(partyId), partyId, { type: 'owner', id: byId }); }
export async function unlinkRecord(recordId: string, by: Actor) { await unlink(await recordReferences(recordId), recordId, by); }

/** Only one main contact method per kind, and one primary home. */
export async function demoteOtherPrimaries(rec: RecordDoc) {
  if (!['contact_methods', 'residences'].includes(rec.domain) || rec.data.primary !== true) return;
  for (const r of await recordsOf(rec.domain)) {
    const same = rec.domain === 'residences' || r.data.kind === rec.data.kind;
    if (r._id !== rec._id && same && r.data.primary === true) await ctx.store.update('records', r._id, { data: { ...r.data, primary: false } });
  }
}
