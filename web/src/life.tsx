/** Shared pieces for the "My data" area: catalog types, group styling, dates, and the schema-driven record editor. */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { del, FILE_ACCEPT, get, longDate, patch, post, uploadDocument, type DocRef, type Sensitivity } from './api';
import { DocTiles } from './docs';
import { Confirm, Pills, Toggle, useAction, useToast, type ConfirmCfg } from './ui';
import { zoneFor, zoneLabel } from './zones';

// ── types ──────────────────────────────────────────────────────────────
export type Part = {
  key: string; label: string; type: string; required?: boolean; sensitivity: Sensitivity; options?: [string, string][]; hint?: string; of?: Part[]; remind?: boolean; deprecated?: boolean; system?: boolean;
  /** money: per what (hour, week, month, year, once). */ periodic?: boolean;
  /** record: the categories it may point to, and whether it holds several. */ to?: string[]; many?: boolean;
  /** Only applies when another part holds one of these values (a list: any of them). */ when?: { part: string; in: string[] } | { part: string; in: string[] }[];
  /** A label that follows another part (a contact method's value: Email address, Phone number…). */ labelBy?: { part: string; labels: Record<string, string> };
  /** text: common answers offered as you type. */ suggestions?: string[];
  /** The question the form asks; label is what cards show. */ ask?: string;
  /** true: always under More details; false: always up front. */ more?: boolean;
  /** country: a new entry starts with the country you live in. */ prefill?: 'home_country';
  /** timezone: filled in from the place until the owner picks one. */ zoneFrom?: { country: string; region?: string };
  /** party: what's usually there, so a new one starts as the right type. */ expects?: 'person' | 'organisation';
};
/** Whether a part applies, given the values so far (collection details only once an account is in collections). */
export const applies = (p: Part, vals: Record<string, unknown>) => !p.when || (Array.isArray(p.when) ? p.when : [p.when]).some((w) => (w.in.includes('*') ? String(vals[w.part] ?? '') !== '' : w.in.includes(String(vals[w.part] ?? ''))));
export type Address = { street1?: string; street2?: string; city?: string; region?: string; postalCode?: string; country?: string };
const PERIODS: [string, string][] = [['hour', 'an hour'], ['week', 'a week'], ['month', 'a month'], ['year', 'a year'], ['once', 'once']];
/** One entry in a record's history: the record as it stood after a change (before it, for a delete). */
export type Version = { version: string; action: 'create' | 'update' | 'delete' | 'restore'; at: string; by: { type: string; id: string }; byLabel: string; record: Rec };
/** "You" reads as "you" mid-sentence; an app's name stays as it is. */
export const byWhom = (label: string) => (label === 'You' ? 'you' : label);

export type Domain = {
  id: string; label: string; noun: string; group: string; description: string; sensitivity: Sensitivity; dated: boolean; builtIn: boolean;
  parts: Part[]; title: string; count: number; currentCount: number; sharedWith: number;
  /** The profile reads this category (names, birth, where you live…). */
  feedsProfile?: boolean;
  livesOn?: 'party' | 'actions' | 'profile';
  oneAtATime?: boolean;
  /** Newest first by this date part (receipts: purchase date, income: received on). */
  sortBy?: string;
  /** What this category invites once an entry is saved (a car: its title, insurance, loan). Never required. */
  companions?: { domain?: string; document?: string; label: string; when?: { part: string; in: string[] } }[];
  single?: boolean;
  /** Sharing the whole category needs a confirm (IDs, health, money). */
  confirmShare?: boolean;
  /** Entries take linked documents; new ones get this kind. */
  documents?: string;
};
export type Rec = {
  id: string; domain: string; title: string; data: Record<string, unknown>; masked: string[]; validFrom: string | null; validTo: string | null;
  current: boolean; notes: string; createdAt: string; updatedAt: string;
  /** How sensitive this entry is, and whether that's the category's default for its kind or the owner's choice. */
  sensitivity?: Sensitivity; sensitivityDefault?: boolean;
  /** Who made the latest change, as the server names them: "You", an app's name, "Import"… */
  updatedByLabel?: string;
  /** Who added it, named the same way. */
  sourceLabel?: string;
  documents?: DocRef[];
};
export type ContactLite = { id: string; name: string; type: 'person' | 'organisation' };

export const fetchCatalog = () => get<{ domains: Domain[] }>('/api/catalog').then((r) => r.domains);

// ── groups ─────────────────────────────────────────────────────────────
export type Group = { id: string; label: string; blurb: string; ink: string; wash: string };
export const GROUPS: Group[] = [
  { id: 'identity', label: 'Identity', blurb: 'Who you are, on paper', ink: 'var(--color-accent-700)', wash: 'var(--color-accent-100)' },
  { id: 'life', label: 'Life', blurb: 'Where you live, who you live with, where you’ve been', ink: 'var(--color-accent-2-600)', wash: 'var(--color-accent-2-100)' },
  { id: 'work', label: 'Work', blurb: 'What you do and what you’ve learned', ink: 'var(--color-accent-500)', wash: 'var(--color-accent-200)' },
  { id: 'health', label: 'Health', blurb: 'Your body, your care, your cover', ink: 'var(--color-accent-2-800)', wash: 'var(--color-accent-2-200)' },
  { id: 'money', label: 'Money', blurb: 'Accounts, income, what you own, taxes and your estate', ink: 'var(--color-neutral-800)', wash: 'var(--color-neutral-200)' },
  { id: 'personal', label: 'Personal', blurb: 'Your memberships, online accounts and the details that make you you', ink: 'var(--color-accent-2-500)', wash: 'var(--color-accent-2-100)' },
  { id: 'custom', label: 'Your categories', blurb: 'Anything else you want to keep track of', ink: 'var(--color-neutral-600)', wash: 'var(--color-neutral-200)' },
];
export const groupOf = (id: string) => GROUPS.find((g) => g.id === id) ?? GROUPS[GROUPS.length - 1];

/** Two-letter monogram in the category's group colours. */
export function Mono({ d, size = 40 }: { d: Pick<Domain, 'label' | 'group'>; size?: number }) {
  const g = groupOf(d.group);
  const letters = d.label.replace(/&/g, '').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: size > 48 ? 22 : 14, background: g.wash, color: g.ink, display: 'grid', placeItems: 'center', fontFamily: 'var(--font-heading)', fontSize: size * 0.38, flex: 'none' }}>{letters}</span>
  );
}

export const Lock = ({ style }: { style?: CSSProperties }) => (
  <svg aria-label="Secret" role="img" width="11" height="12" viewBox="0 0 11 12" style={{ flex: 'none', ...style }}>
    <rect x="1" y="5" width="9" height="6.5" rx="2" fill="currentColor" />
    <path d="M3 5V3.6a2.5 2.5 0 0 1 5 0V5" stroke="currentColor" strokeWidth="1.4" fill="none" />
  </svg>
);

// ── dates ──────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(v: string | null | undefined) {
  if (!v) return '';
  const [y, m, d] = v.split('-');
  if (!m) return y;
  if (!d) return `${MONTHS[+m - 1]} ${y}`;
  return `${+d} ${MONTHS[+m - 1]} ${y}`;
}

/** A datetime part: { at: ISO 8601 with offset, tz: IANA zone }. */
export type DateTime = { at: string; tz: string };
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
let zones: [string, string][] | null = null;
const timeZones = () => {
  if (!zones) {
    const all = Intl.supportedValuesOf('timeZone');
    zones = (all.includes(localZone()) ? all : [localZone(), ...all]).map((z) => [z, zoneLabel(z)]);
  }
  return zones;
};

/** In the viewer's own time, plus the local time there when the event's zone is different. */
export function fmtDateTime(v: DateTime) {
  const when = new Date(v.at);
  // Seconds only when they were given (a birth time, say).
  const sec = when.getSeconds() ? { second: '2-digit' as const } : {};
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...sec, timeZoneName: 'short' };
  try {
    const mine = new Intl.DateTimeFormat(undefined, opts).format(when);
    if (v.tz === localZone()) return mine;
    return `${mine} (${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', ...sec, timeZoneName: 'short', timeZone: v.tz }).format(when)} there)`;
  } catch { return v.at; }
}
export function fmtRange(from: string | null, to: string | null) {
  if (!from && !to) return '';
  if (!from) return `Until ${fmtDate(to)}`;
  return `${fmtDate(from)} – ${to ? fmtDate(to) : 'present'}`;
}
/** "3 yrs 4 mos" between two partial dates (to = now when open). */
export function duration(from: string | null, to: string | null) {
  if (!from) return '';
  const a = new Date(from.length === 4 ? `${from}-01-01` : from.length === 7 ? `${from}-01` : from);
  const b = to ? new Date(to.length === 4 ? `${to}-12-31` : to.length === 7 ? `${to}-28` : to) : new Date();
  // Full dates under two months long read in days, both ends counted (a trip from the 1st to the 3rd is 3 days).
  if (from.length === 10 && to?.length === 10) {
    const days = Math.round((b.getTime() - a.getTime()) / 86400_000) + 1;
    if (days > 0 && days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  }
  // UTC throughout: a date-only value is midnight UTC, which local time would push into the previous month.
  const months = Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth());
  const y = Math.floor(months / 12), m = months % 12;
  return [y ? `${y} yr${y === 1 ? '' : 's'}` : '', m ? `${m} mo${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || 'under a month';
}

// ── countries ──────────────────────────────────────────────────────────
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'CQ']);
let countryCache: [string, string][] | null = null;
export function countries(): [string, string][] {
  if (countryCache) return countryCache;
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const out: [string, string][] = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    if (NOT_COUNTRIES.has(code)) continue;
    try { const n = names.of(code); if (n && n !== code && !/unknown/i.test(n)) out.push([code, n]); } catch { /* not a region */ }
  }
  return (countryCache = out.sort((x, y) => x[1].localeCompare(y[1])));
}
export const countryName = (code: string) => countries().find(([c]) => c === code)?.[1] ?? code;

/** Whole amounts without cents; receipts keep theirs. */
export function money(m: { amount: number; currency: string }) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currency, maximumFractionDigits: Number.isInteger(m.amount) ? 0 : 2 }).format(m.amount); } catch { return `${m.amount} ${m.currency}`; }
}

/** Human value for display. */
export function show(p: Part, v: unknown, contacts: ContactLite[]): string {
  if (v === undefined || v === null || v === '') return '';
  switch (p.type) {
    case 'enum': return p.options?.find(([k]) => k === v)?.[1] ?? String(v);
    case 'country': return countryName(String(v));
    case 'money': { const m = v as { amount: number; currency: string; period?: string }; return m.period && m.period !== 'once' ? `${money(m)} ${PERIODS.find(([k]) => k === m.period)?.[1] ?? ''}` : money(m); }
    case 'address': { const a = v as Address; return [a.street1, a.street2, a.city, [a.region, a.postalCode].filter(Boolean).join(' '), a.country ? countryName(a.country) : ''].filter(Boolean).join(', '); }
    case 'region': { const [c, r] = String(v).split('-'); return r ? `${r}, ${countryName(c)}` : countryName(c); }
    case 'geo': { const g = v as { lat: number; lon: number }; return `${Math.abs(g.lat)}° ${g.lat >= 0 ? 'N' : 'S'}, ${Math.abs(g.lon)}° ${g.lon >= 0 ? 'E' : 'W'}`; }
    case 'timezone': return zoneLabel(String(v));
    case 'repeat': return describeRepeat(String(v));
    case 'record': { const n = Array.isArray(v) ? v.length : 1; return `${n} linked ${n === 1 ? 'entry' : 'entries'}`; }
    case 'list': { const n = (v as unknown[]).length; return n ? `${n} ${n === 1 ? 'row' : 'rows'}` : ''; }
    case 'boolean': return v ? 'Yes' : 'No';
    case 'date': return fmtDate(String(v));
    case 'datetime': return fmtDateTime(v as DateTime);
    case 'party': case 'contact': return (Array.isArray(v) ? v : [v]).map((x) => contacts.find((c) => c.id === x)?.name ?? 'Removed contact').join(', ');
    case 'last4': return `•••• ${v}`;
    case 'url': return String(v).replace(/^https?:\/\//, '').replace(/\/$/, '');
    default: return String(v);
  }
}

// ── inputs ─────────────────────────────────────────────────────────────
const selectStyle: CSSProperties = { appearance: 'none', backgroundImage: 'linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%)', backgroundPosition: 'calc(100% - 18px) 55%, calc(100% - 13px) 55%', backgroundSize: '5px 5px', backgroundRepeat: 'no-repeat', paddingRight: 32 };
export function Select({ value, onChange, options, placeholder, id, style }: { value: string; onChange: (v: string) => void; options: [string, string][]; placeholder?: string; id?: string; style?: CSSProperties }) {
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} style={{ ...selectStyle, ...style }}>
      <option value="">{placeholder ?? '—'}</option>
      {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  );
}

/** Year, then optionally month and day: histories rarely know the exact day. */
export function PartialDate({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const [y = '', m = '', d = ''] = value ? value.split('-') : [];
  const set = (ny: string, nm: string, nd: string) => onChange(!ny ? '' : [ny, nm, nm ? nd : ''].filter(Boolean).join('-'));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 80px', gap: 6 }}>
      <input id={id} className="input mono" inputMode="numeric" placeholder="Year" maxLength={4} value={y} onChange={(e) => set(e.target.value.replace(/\D/g, ''), m, d)} />
      <Select value={m} onChange={(v) => set(y, v, d)} placeholder="Month" options={MONTHS.map((n, i) => [String(i + 1).padStart(2, '0'), n])} />
      <Select value={d} onChange={(v) => set(y, m, v)} placeholder="Day" options={Array.from({ length: 31 }, (_, i) => [String(i + 1).padStart(2, '0'), String(i + 1)])} />
    </div>
  );
}

function PartInput({ p, value, onChange, contacts, hiddenSaved, currency, dateOnly }: { p: Part; value: unknown; onChange: (v: unknown) => void; contacts: ContactLite[]; hiddenSaved: boolean; currency: string; dateOnly?: boolean }) {
  const id = `part-${p.key}`;
  const ph = hiddenSaved ? 'Saved and hidden · type to replace' : p.hint || '';
  switch (p.type) {
    case 'longtext':
      return <textarea id={id} className="input" style={{ borderRadius: 20, minHeight: 80 }} placeholder={ph} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <PartialDate id={id} value={String(value ?? '')} onChange={onChange} />;
    case 'datetime': {
      // The wall-clock time in the chosen zone; the server works out the offset.
      const dt = (value as Partial<DateTime> | null) || {};
      const tz = dt.tz || localZone(), at = (dt.at ?? '').slice(0, 19);
      // All-day events: just the day (midnight in the zone); the zone stays as it was.
      if (dateOnly) return <input id={id} className="input" type="date" value={at.slice(0, 10)} onChange={(e) => onChange(e.target.value ? { at: `${e.target.value}T00:00`, tz } : '')} style={{ maxWidth: 220 }} />;
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <input id={id} className="input" type="datetime-local" step={1} value={at} onChange={(e) => onChange(e.target.value ? { at: e.target.value, tz } : '')} />
          <Select value={tz} onChange={(z) => onChange({ at, tz: z || localZone() })} options={timeZones()} placeholder="Time zone" />
        </div>
      );
    }
    case 'country':
      return <Select id={id} value={String(value ?? '')} onChange={onChange} options={countries()} placeholder="Choose a country" />;
    case 'enum':
      return (p.options!.length <= 4
        ? <Pills value={String(value ?? '')} options={p.options as [string, string][]} onChange={(v) => onChange(v === value ? '' : v)} size={12} />
        : <Select id={id} value={String(value ?? '')} onChange={onChange} options={p.options!} placeholder="Choose…" />);
    case 'boolean':
      return <Toggle on={!!value} label={p.label} onChange={() => onChange(!value)} />;
    case 'party':
    case 'contact': {
      if (!p.many) return <PartyPicker id={id} value={String(value ?? '')} onChange={onChange} contacts={contacts} expects={p.expects} />;
      // Several: each one chosen shows with a remove button; the picker adds the next.
      const chosen = (value as string[] | undefined) ?? [];
      return (
        <div style={{ display: 'grid', gap: 6 }}>
          {chosen.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {chosen.map((c) => <span key={c} className="tag tag-neutral">{contacts.find((x) => x.id === c)?.name ?? 'Added'}<button type="button" className="bare" aria-label="Remove" onClick={() => onChange(chosen.filter((x) => x !== c))} style={{ marginLeft: 6 }}>×</button></span>)}
          </div>}
          <PartyPicker id={id} value="" onChange={(v) => v && !chosen.includes(v) && onChange([...chosen, v])} contacts={contacts.filter((c) => !chosen.includes(c.id))} expects={p.expects} />
        </div>
      );
    }
    case 'record':
      return <RecordPicker id={id} p={p} value={value} onChange={onChange} />;
    case 'money': {
      const m = (value as { amount?: number | string; currency?: string; period?: string } | null) ?? {};
      const next = (x: Partial<typeof m>) => ({ amount: m.amount ?? '', currency: m.currency || 'USD', ...(p.periodic ? { period: m.period || 'year' } : {}), ...x });
      return (
        <div style={{ display: 'grid', gridTemplateColumns: p.periodic ? '1fr 80px 120px' : '1fr 90px', gap: 6 }}>
          <input id={id} className="input" inputMode="decimal" placeholder={hiddenSaved ? 'Saved and hidden · type to replace' : 'Amount'} value={m.amount ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : next({ amount: e.target.value }))} />
          <input className="input mono" aria-label="Currency" maxLength={3} value={m.currency ?? 'USD'} onChange={(e) => onChange(next({ currency: e.target.value.toUpperCase() }))} />
          {p.periodic && <Select value={m.period || 'year'} onChange={(v) => onChange(next({ period: v || 'year' }))} options={PERIODS} />}
        </div>
      );
    }
    case 'address': {
      const a = (value as Address | null) ?? {};
      const put = (k: keyof Address, v: string) => onChange({ ...a, [k]: v });
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <input id={id} className="input" style={{ gridColumn: '1 / -1' }} placeholder="Street" value={a.street1 ?? ''} onChange={(e) => put('street1', e.target.value)} />
          <input className="input" style={{ gridColumn: '1 / -1' }} aria-label="Apartment, suite, unit" placeholder="Apartment, suite, unit" value={a.street2 ?? ''} onChange={(e) => put('street2', e.target.value)} />
          <input className="input" aria-label="City" placeholder="City" value={a.city ?? ''} onChange={(e) => put('city', e.target.value)} />
          <input className="input" aria-label="State or region" placeholder="State / region" value={a.region ?? ''} onChange={(e) => put('region', e.target.value)} />
          <input className="input" aria-label="Postal code" placeholder="Postal code" value={a.postalCode ?? ''} onChange={(e) => put('postalCode', e.target.value)} />
          <Select value={a.country ?? ''} onChange={(v) => put('country', v)} options={countries()} placeholder="Country" />
        </div>
      );
    }
    case 'region': {
      const [c = '', r = ''] = String(value ?? '').split('-');
      const join = (nc: string, nr: string) => onChange(nc ? (nr.trim() ? `${nc}-${nr.trim().toUpperCase()}` : nc) : '');
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 6 }}>
          <Select id={id} value={c} onChange={(v) => join(v, r)} options={countries()} placeholder="Country" />
          <input className="input mono" aria-label="State or region code" placeholder="e.g. OR" maxLength={3} value={r} onChange={(e) => join(c, e.target.value)} />
        </div>
      );
    }
    case 'time':
      return <input id={id} className="input" type="time" step={1} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 200 }} />;
    case 'timezone':
      return <Select id={id} value={String(value ?? '')} onChange={onChange} options={timeZones()} placeholder="Time zone" />;
    case 'geo': {
      const g = (value as { lat?: string | number; lon?: string | number } | null) ?? {};
      const put = (x: object) => { const n = { ...g, ...x }; onChange(n.lat === '' && n.lon === '' ? '' : n); };
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <input id={id} className="input mono" inputMode="decimal" placeholder="Latitude, e.g. 40.6936" value={g.lat ?? ''} onChange={(e) => put({ lat: e.target.value })} />
          <input className="input mono" inputMode="decimal" aria-label="Longitude" placeholder="Longitude, e.g. -89.589" value={g.lon ?? ''} onChange={(e) => put({ lon: e.target.value })} />
        </div>
      );
    }
    case 'repeat':
      return <RepeatInput id={id} value={String(value ?? '')} onChange={onChange} />;
    case 'list':
      return <ListInput p={p} value={(value as Row[] | undefined) ?? []} onChange={onChange} currency={currency} />;
    case 'last4':
      return <input id={id} className="input mono" inputMode="numeric" maxLength={4} placeholder={hiddenSaved ? '••••' : 'Last 4 digits only'} value={String(value ?? '')} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 160, letterSpacing: '.2em' }} />;
    case 'number':
      return <input id={id} className="input" inputMode="numeric" placeholder={ph} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 200 }} />;
    default:
      return (
        <>
          <input id={id} className="input" list={p.suggestions ? `${id}-list` : undefined} type={p.type === 'email' ? 'email' : p.type === 'phone' ? 'tel' : p.type === 'url' ? 'url' : 'text'} placeholder={ph} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
          {p.suggestions && <datalist id={`${id}-list`}>{p.suggestions.map((x) => <option key={x} value={x} />)}</datalist>}
        </>
      );
  }
}

/** A part's label, following another part when it says so (by kind: "Email address", "Phone number"). */
export const labelOf = (p: Part, vals: Record<string, unknown>) => (p.labelBy && p.labelBy.labels[String(vals[p.labelBy.part] ?? '')]) || p.label;

const DAYS: Record<string, string> = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
const NTH: Record<string, string> = { '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '-1': 'last' };
/** A repeat rule (iCalendar RRULE) in words: "Every 2 weeks on Tuesday", "Monthly on the second Monday". */
export function describeRepeat(rule: string): string {
  const m = Object.fromEntries(rule.split(';').map((x) => x.split('=')));
  const n = Number(m.INTERVAL || 1);
  const unit = ({ DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' } as Record<string, string>)[m.FREQ] ?? '';
  let out = n === 1 ? ({ DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Yearly' } as Record<string, string>)[m.FREQ] ?? rule : `Every ${n} ${unit}s`;
  if (m.BYDAY) out += ' on ' + String(m.BYDAY).split(',').map((d) => { const x = d.match(/^([+-]?\d{1,2})?([A-Z]{2})$/); return !x ? d : x[1] ? `the ${NTH[x[1].replace('+', '')] ?? x[1]} ${DAYS[x[2]]}` : DAYS[x[2]]; }).join(', ');
  else if (m.BYMONTHDAY) out += ` on day ${m.BYMONTHDAY}`;
  if (m.COUNT) out += `, ${m.COUNT} times`;
  if (m.UNTIL) out += `, until ${m.UNTIL.slice(0, 4)}-${m.UNTIL.slice(4, 6)}-${m.UNTIL.slice(6, 8)}`;
  return out;
}

const REPEATS: [string, string][] = [['FREQ=DAILY', 'Every day'], ['FREQ=WEEKLY', 'Every week'], ['FREQ=WEEKLY;INTERVAL=2', 'Every 2 weeks'], ['FREQ=MONTHLY', 'Every month'], ['FREQ=YEARLY', 'Every year'], ['custom', 'Custom…']];
/** Common choices, or any iCalendar rule ("the second Monday of each month") typed as a rule and read back in words. */
function RepeatInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const preset = REPEATS.some(([k]) => k === value);
  const [custom, setCustom] = useState(!!value && !preset);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <Select id={id} value={custom ? 'custom' : value} placeholder="Doesn’t repeat" options={REPEATS} onChange={(v) => { if (v === 'custom') { setCustom(true); return; } setCustom(false); onChange(v); }} />
      {custom && <>
        <input className="input mono" aria-label="Repeat rule" placeholder="FREQ=MONTHLY;BYDAY=2MO" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
        {value && <div className="text-muted" style={{ fontSize: 12 }}>{describeRepeat(value)}</div>}
      </>}
    </div>
  );
}

/** Pick a person or organisation, or add a new one right here: a name is never just typed into an entry. */
function PartyPicker({ id, value, onChange, contacts, expects = 'person' }: { id: string; value: string; onChange: (v: string) => void; contacts: ContactLite[]; expects?: 'person' | 'organisation' }) {
  const [added, setAdded] = useState<ContactLite[]>([]);
  const [adding, setAdding] = useState<{ name: string; type: 'person' | 'organisation' } | null>(null);
  const [error, setError] = useState('');
  const all = [...contacts, ...added.filter((a) => !contacts.some((c) => c.id === a.id))];
  const create = async () => {
    if (!adding?.name.trim()) return;
    try {
      const p = await post<ContactLite>('/api/parties', { type: adding.type, name: adding.name.trim() });
      setAdded((x) => [...x, { id: p.id, name: p.name, type: p.type }]);
      onChange(p.id);
      setAdding(null);
      setError('');
    } catch (e) { setError((e as Error).message); }
  };
  if (adding) return (
    <div style={{ display: 'grid', gap: 6 }}>
      <Pills value={adding.type} options={[['person', 'A person'], ['organisation', 'An organisation']]} onChange={(v) => setAdding({ ...adding, type: v as 'person' | 'organisation' })} size={12} />
      <div style={{ display: 'flex', gap: 6 }}>
        <input id={id} className="input" autoFocus placeholder="Their name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } }} />
        <button type="button" className="btn btn-primary" onClick={create} disabled={!adding.name.trim()}>Add</button>
        <button type="button" className="btn btn-ghost" onClick={() => setAdding(null)}>Cancel</button>
      </div>
      {error && <div style={{ color: 'var(--color-accent-700)', fontSize: 12 }}>{error}</div>}
    </div>
  );
  return (
    <Select id={id} value={value} placeholder={all.length ? 'Choose from your contacts' : 'No contacts yet'}
      options={[...all.map((c) => [c.id, c.name] as [string, string]), ['__new', '＋ Someone new…']]}
      onChange={(v) => (v === '__new' ? setAdding({ name: '', type: expects }) : onChange(v))} />
  );
}

/** Point to other entries (the passport that proves a citizenship), or add the entry right here if it isn't in yet. */
function RecordPicker({ id, p, value, onChange }: { id: string; p: Part; value: unknown; onChange: (v: unknown) => void }) {
  const [options, setOptions] = useState<{ id: string; title: string; domain: string }[]>([]);
  const [targets, setTargets] = useState<Domain[]>([]);
  const [creating, setCreating] = useState<Domain | null>(null);
  const contacts = useContactsLite();
  const load = async () => {
    const cat = await fetchCatalog();
    const ds = cat.filter((d) => !p.to?.length || p.to.includes(d.id));
    setTargets(ds);
    const lists = await Promise.all(ds.map((d) => get<{ items: Rec[] }>(`/api/data/${d.id}`).then((r) => r.items.map((x) => ({ id: x.id, title: ds.length > 1 ? `${x.title} (${d.label})` : x.title, domain: d.id })))));
    setOptions(lists.flat());
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load().catch(() => {}); }, []);
  const chosen = p.many ? ((value as string[] | undefined) ?? []) : value ? [String(value)] : [];
  const toggle = (rid: string) => onChange(p.many ? (chosen.includes(rid) ? chosen.filter((x) => x !== rid) : [...chosen, rid]) : rid);
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {p.many ? (
        <div id={id} style={{ display: 'grid', gap: 4 }}>
          {options.map((o) => (
            <label key={o.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
              <input type="checkbox" checked={chosen.includes(o.id)} onChange={() => toggle(o.id)} />{o.title}
            </label>
          ))}
          {!options.length && <div className="text-muted" style={{ fontSize: 13 }}>Nothing in {targets.map((d) => d.label).join(' or ') || 'there'} yet.</div>}
        </div>
      ) : (
        <Select id={id} value={chosen[0] ?? ''} onChange={(v) => onChange(v)} options={options.map((o) => [o.id, o.title])} placeholder="Choose…" />
      )}
      {targets.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {targets.map((d) => <button key={d.id} type="button" className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setCreating(d)}>＋ Add {targets.length > 1 ? `to ${d.label}` : `a new ${d.noun}`}</button>)}
        </div>
      )}
      {creating && <RecordEditor d={creating} rec={null} contacts={contacts} onClose={() => setCreating(null)}
        onSaved={(saved) => { setCreating(null); if (saved) { load().catch(() => {}); onChange(p.many ? [...chosen, saved.id] : saved.id); } }} />}
    </div>
  );
}

/**
 * After a new entry is saved: what goes with it, each a nudge you can skip. Adding a related entry links the two,
 * whichever side holds the link (insurance "covers" the car; a property points to its deed).
 */
function Companions({ d, saved, vals, onDone }: { d: Domain; saved: Rec; vals: Record<string, unknown>; onDone: () => void }) {
  const [catalog, setCatalog] = useState<Domain[]>([]);
  const [open, setOpen] = useState<Domain | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const contacts = useContactsLite();
  useEffect(() => { fetchCatalog().then(setCatalog).catch(() => {}); }, []);
  const invites = (d.companions ?? []).filter((c) => !c.when || c.when.in.includes(String(vals[c.when.part] ?? '')));
  // The other side's link to this entry, if it has one (insurance → the car it covers).
  const backLink = (t: Domain) => t.parts.find((p) => p.type === 'record' && p.to?.includes(d.id));
  const defaultsFor = (t: Domain) => { const p = backLink(t); return p ? { [p.key]: p.many ? [saved.id] : saved.id } : {}; };
  // This entry's link to the other side, if it holds it (a property → its deed): set once the other is added.
  const ourLink = (t: Domain) => d.parts.find((p) => p.type === 'record' && p.to?.includes(t.id) && !backLink(t));
  const added = async (t: Domain, other?: Rec) => {
    setOpen(null);
    if (!other) return;
    setDone((x) => new Set(x).add(t.id));
    const p = ourLink(t);
    if (p) await patch(`/api/data/${d.id}/${saved.id}`, { data: { [p.key]: p.many ? [other.id] : other.id } }).catch(() => {});
  };
  const upload = async (kind: string, files: FileList | null) => {
    for (const f of Array.from(files ?? [])) await uploadDocument(f, { link: { domain: d.id, recordId: saved.id }, kind }).catch(() => {});
    setDone((x) => new Set(x).add(`doc:${kind}`));
  };
  return (
    <div className="dialog-backdrop" style={{ zIndex: 50, placeItems: 'stretch end', padding: 0 }} onClick={onDone}>
      <aside role="dialog" aria-modal="true" aria-label="What goes with it" onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(540px, 100%)', height: '100dvh', maxHeight: '100dvh', background: 'var(--color-bg)', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', borderRadius: '32px 0 0 32px', padding: '28px', gap: 16 }}>
        <div className="card-kicker" style={{ color: groupOf(d.group).ink }}>{d.label} · saved</div>
        <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22 }}>{saved.title}</div>
        <p className="text-muted" style={{ margin: 0 }}>Want to add what goes with it? Each is linked to it, and you can skip any of them.</p>
        <div style={{ display: 'grid', gap: 8 }}>
          {invites.map((c, i) => {
            const t = c.domain ? catalog.find((x) => x.id === c.domain) : undefined;
            const isDone = c.domain ? done.has(c.domain) : done.has(`doc:${c.document}`);
            return (
              <div key={i} className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexDirection: 'row' }}>
                <span style={{ flex: 1 }}>{c.label}</span>
                {isDone ? <span className="tag tag-neutral">Added</span>
                  : c.document ? <label className="btn btn-secondary" style={{ fontSize: 13, cursor: 'pointer' }}>Add a file<input type="file" hidden accept={FILE_ACCEPT} onChange={(e) => upload(c.document!, e.target.files)} /></label>
                    : t ? <button type="button" className="btn btn-secondary" style={{ fontSize: 13 }} onClick={() => setOpen(t)}>Add</button> : null}
              </div>
            );
          })}
        </div>
        <button type="button" className="btn btn-primary" style={{ justifySelf: 'start' }} onClick={onDone}>Done</button>
      </aside>
      {open && <RecordEditor d={open} rec={null} contacts={contacts} defaults={defaultsFor(open)} onClose={() => setOpen(null)} onSaved={(other) => added(open, other)} />}
    </div>
  );
}

// ── changes: who changed what, and going back ─────────────────────────
const ACTION: Record<Version['action'], string> = { create: 'Added', update: 'Changed', delete: 'Deleted', restore: 'Restored' };

/** What differs between a version and the one before it, by label. */
function changedParts(d: Domain, now: Rec, before: Rec | undefined) {
  if (!before) return [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out = d.parts.filter((p) => !same(now.data[p.key], before.data[p.key])).map((p) => p.label);
  if (!same(now.validFrom, before.validFrom) || !same(now.validTo, before.validTo)) out.push('Dates');
  if (!same(now.notes, before.notes)) out.push('Notes');
  return out;
}

function RecordChanges({ d, rec, onRestored }: { d: Domain; rec: Rec; onRestored: (saved?: Rec) => void }) {
  const { run } = useAction();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Version[] | null>(null);
  const toggle = async () => {
    setOpen(!open);
    if (!items) { const x = await run(() => get<{ items: Version[] }>(`/api/data/${d.id}/${rec.id}/history`)); if (x) setItems(x.items); }
  };
  const restore = async (v: Version) => {
    const saved = await run(() => post<Rec>(`/api/data/${d.id}/${rec.id}/history/${v.version}/restore`));
    if (saved) onRestored(saved);
  };
  /** An app's change: put back just the fields it changed, never over a later edit. */
  const undo = async (v: Version) => {
    const r = await run(() => post<{ outcome: string; reverted: string[]; skipped: string[]; reason?: string }>(`/api/data/${d.id}/${rec.id}/history/${v.version}/undo`));
    if (!r) return;
    toast(r.outcome === 'removed' ? 'Removed' : r.outcome === 'reverted' ? `Undone${r.skipped.length ? `. Kept your later change to ${r.skipped.join(', ')}` : ''}` : r.reason ?? 'Nothing to undo');
    if (r.outcome === 'reverted' || r.outcome === 'removed') onRestored();
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <button type="button" className="btn btn-ghost" style={{ justifySelf: 'start', fontSize: 13 }} onClick={toggle}>{open ? 'Hide changes' : 'See changes'}</button>
      {open && items && items.map((v, i) => {
        const what = changedParts(d, v.record, items[i + 1]?.record);
        return (
          <div key={v.version} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, padding: '8px 12px', borderRadius: 12, background: 'var(--color-neutral-100)' }}>
            <div style={{ flex: 1 }}>
              <div>{ACTION[v.action]}{what.length ? `: ${what.join(', ')}` : ''}</div>
              <div className="text-muted" style={{ fontSize: 12 }}>By {byWhom(v.byLabel)} · {new Date(v.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</div>
            </div>
            {v.by.type === 'app' && (v.action === 'update' || v.action === 'create') && <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => undo(v)}>Undo this change</button>}
            {i > 0 && <button type="button" className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => restore(v)}>Restore this version</button>}
          </div>
        );
      })}
    </div>
  );
}

// ── list parts: a small table, one row per item ───────────────────────
type Row = Record<string, unknown>;

function ListInput({ p, value, onChange, currency }: { p: Part; value: Row[]; onChange: (v: Row[]) => void; currency: string }) {
  const cols = p.of ?? [];
  // Always one blank row at the end to type into.
  const rows = [...value, {}];
  const setCell = (i: number, k: string, v: unknown) => {
    const next = rows.map((r, j) => (j === i ? { ...r, [k]: v } : r));
    onChange(next.filter((r) => !rowEmpty(r)));
  };
  const width = (c: Part) => (c.type === 'number' ? '64px' : c.type === 'money' ? '96px' : c.required ? 'minmax(120px,2fr)' : 'minmax(80px,1fr)');
  const grid = `${cols.map(width).join(' ')} 28px`;
  return (
    <div style={{ display: 'grid', gap: 6, overflowX: 'auto' }}>
      <div className="text-muted" style={{ display: 'grid', gridTemplateColumns: grid, gap: 6, fontSize: 11 }}>{cols.map((c) => <span key={c.key}>{c.label}</span>)}<span /></div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: grid, gap: 6, alignItems: 'center' }}>
          {cols.map((c) => {
            const v = r[c.key];
            const shown = c.type === 'money' ? String((v as { amount?: unknown } | undefined)?.amount ?? '') : String(v ?? '');
            return (
              <input key={c.key} className="input" aria-label={`${c.label}, row ${i + 1}`} inputMode={c.type === 'number' || c.type === 'money' ? 'decimal' : undefined}
                value={shown} placeholder={i === value.length && c.required ? 'Add an item' : ''} style={{ padding: '8px 12px', fontSize: 13, minWidth: 0 }}
                onChange={(e) => setCell(i, c.key, c.type === 'money' ? (e.target.value === '' ? '' : { amount: e.target.value, currency }) : e.target.value)} />
            );
          })}
          {i < value.length ? <button type="button" className="btn btn-ghost" aria-label={`Remove row ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))} style={{ padding: 0, width: 28, height: 28 }}>×</button> : <span />}
        </div>
      ))}
    </div>
  );
}

const rowEmpty = (r: Row) => Object.values(r).every((v) => v === '' || v === undefined || v === null);

/** Typed rows for the API: numbers as numbers, blank cells and rows dropped. */
function cleanRows(p: Part, rows: Row[]): Row[] {
  return rows.map((r) => {
    const out: Row = {};
    for (const c of p.of ?? []) {
      const v = r[c.key];
      if (v === '' || v === undefined || v === null) continue;
      if (c.type === 'money') { const m = v as { amount: string | number; currency: string }; if (m.amount !== '') out[c.key] = { amount: Number(m.amount), currency: m.currency || 'USD' }; }
      else if (c.type === 'number') out[c.key] = Number(v);
      else out[c.key] = typeof v === 'string' ? v.trim() : v;
    }
    return out;
  }).filter((r) => Object.keys(r).length);
}

const titleKeys = (d: Domain) => [...d.title.matchAll(/\{([\w|]+)\}/g)].flatMap((m) => m[1].split('|'));

// ── the editor: a side panel generated from the domain's schema ───────
export function RecordEditor({ d, rec, contacts, onClose, onSaved, defaults }: { d: Domain; rec: Rec | null; contacts: ContactLite[]; onClose: () => void; onSaved: (saved?: Rec) => void; defaults?: Record<string, unknown> }) {
  const { run, busy } = useAction();
  const [vals, setVals] = useState<Record<string, unknown>>(() => {
    if (!rec) return { ...defaults };
    // Secret parts arrive masked: start them blank, keep them unless replaced.
    return Object.fromEntries(Object.entries(rec.data).filter(([k]) => !rec.masked.includes(k)));
  });
  const [touched, setTouched] = useState<Set<string>>(new Set());
  // A new passport or license starts in the country you live in (your current main home, else this browser's region).
  useEffect(() => {
    const keys = rec ? [] : d.parts.filter((p) => p.prefill === 'home_country' && !defaults?.[p.key]).map((p) => p.key);
    if (!keys.length) return;
    get<{ items: Rec[] }>('/api/data/residences').then((r) => {
      const now = r.items.filter((x) => !x.validTo);
      const home = String((now.find((x) => x.data.primary) ?? now[0])?.data.country ?? new Intl.Locale(navigator.language).maximize().region ?? '').toUpperCase();
      if (home) setVals((v) => ({ ...Object.fromEntries(keys.filter((k) => !v[k]).map((k) => [k, home])), ...v }));
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [from, setFrom] = useState(rec?.validFrom ?? '');
  const [to, setTo] = useState(rec?.validTo ?? '');
  const [current, setCurrent] = useState(rec ? !rec.validTo : true);
  const [notes, setNotes] = useState(rec?.notes ?? '');
  // 'default' = follow the category's default for this kind of entry.
  const startSens = rec && !rec.sensitivityDefault && rec.sensitivity ? rec.sensitivity : 'default';
  const [sensChoice, setSensChoice] = useState<Sensitivity | 'default'>(startSens);
  const sensChanged = sensChoice !== startSens;
  const sens = sensChoice === 'default' ? null : sensChoice;
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [docs, setDocs] = useState<DocRef[]>(rec?.documents ?? []);
  const [pending, setPending] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [after, setAfter] = useState<Rec | null>(null);

  /** Existing entries upload at once; new ones wait until saved. */
  const addDocs = async (files: File[]) => {
    if (!rec) return setPending((p) => [...p, ...files]);
    setUploading(true);
    for (const f of files) {
      try { const doc = await uploadDocument(f, { link: { domain: d.id, recordId: rec.id } }); setDocs((x) => [...x, { ...doc, links: doc.links.map(({ domain, recordId }) => ({ domain, recordId })) }]); }
      catch (e) { setError(`${f.name}: ${(e as Error).message}`); }
    }
    setUploading(false);
  };
  /** A document filed only here is deleted; one linked elsewhere just loses this link. */
  const removeDoc = (doc: DocRef) => setConfirm({
    title: doc.links.length > 1 ? 'Unlink this document?' : 'Delete this document?',
    body: doc.links.length > 1 ? `${doc.title} stays in Documents and on its other entries.` : `${doc.title} is deleted from your Little Dipper.`,
    cta: doc.links.length > 1 ? 'Unlink' : 'Delete',
    onConfirm: async () => {
      const ok = doc.links.length > 1
        ? await run(() => patch(`/api/documents/${doc.id}`, { links: doc.links.filter((l) => l.recordId !== rec!.id) }))
        : await run(() => del(`/api/documents/${doc.id}`));
      if (ok) setDocs((x) => x.filter((y) => y.id !== doc.id));
      setConfirm(null);
    },
  });

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !confirm && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, confirm]);

  const tKeys = titleKeys(d);
  // Deprecated parts stay editable on records that already use them, but aren't offered otherwise.
  const offered = d.parts.filter((p) => !p.system && applies(p, vals) && (!p.deprecated || (vals[p.key] !== undefined && vals[p.key] !== '') || rec?.masked.includes(p.key)));
  const essential = offered.filter((p, i) => p.more === false || (!p.more && (p.required || tKeys.includes(p.key) || i < 4)));
  const extra = offered.filter((p) => !essential.includes(p));
  const extraFilled = extra.some((p) => vals[p.key] !== undefined && vals[p.key] !== '' || rec?.masked.includes(p.key));

  // Line-item prices follow the currency of the first amount entered (a receipt's total).
  const currency = d.parts.filter((p) => p.type === 'money').map((p) => (vals[p.key] as { currency?: string } | undefined)?.currency).find(Boolean) || 'USD';

  // Moving an event's start moves its end too, so it keeps how long it lasts (as calendars do).
  // Zones still following the place: not picked by hand (a saved zone that isn't the place's own counts as picked).
  const [picked, setPicked] = useState<Set<string>>(() => new Set(d.parts.filter((p) => p.zoneFrom && rec?.data[p.key] && rec.data[p.key] !== zoneFor(rec.data[p.zoneFrom.country], p.zoneFrom.region ? rec.data[p.zoneFrom.region] : '')).map((p) => p.key)));
  const guessed = d.parts.filter((p) => p.zoneFrom && !picked.has(p.key));
  const shiftsEnd = (k: string) => k === 'start' && d.parts.some((p) => p.key === 'end' && p.type === 'datetime');
  const set = (k: string, v: unknown) => {
    setVals((s) => {
      const next = { ...s, [k]: v };
      const was = s[k] as Partial<DateTime> | undefined, now = v as Partial<DateTime> | undefined, end = s.end as Partial<DateTime> | undefined;
      if (shiftsEnd(k) && was?.at && now?.at && end?.at) {
        const wall = (x: string) => Date.parse(`${x.slice(0, 16)}Z`); // wall-clock minutes; zones don't matter for a shift
        next.end = { at: new Date(wall(end.at) + wall(now.at) - wall(was.at)).toISOString().slice(0, 16), tz: end.tz ?? now.tz };
      }
      // A time zone follows the place until the owner picks one themselves.
      for (const z of guessed) {
        const zone = zoneFor(next[z.zoneFrom!.country], z.zoneFrom!.region ? next[z.zoneFrom!.region] : '');
        if (zone) next[z.key] = zone;
      }
      return next;
    });
    setTouched((t) => { const n = new Set(t).add(k); if (shiftsEnd(k) && vals.end) n.add('end'); guessed.forEach((z) => n.add(z.key)); return n; });
    if (d.parts.some((p) => p.key === k && p.zoneFrom)) setPicked((x) => new Set(x).add(k));
  };

  const save = async () => {
    setError('');
    const data: Record<string, unknown> = {};
    for (const p of d.parts) {
      if (rec && !touched.has(p.key)) continue;
      let v = vals[p.key];
      // A part that doesn't apply right now isn't sent (its stored value, if any, stays: it was true).
      if (!applies(p, vals)) continue;
      if (p.type === 'money' && v && typeof v === 'object') {
        const m = v as { amount: string | number; currency: string; period?: string };
        v = m.amount === '' || m.amount === undefined ? null : { amount: Number(m.amount), currency: m.currency || 'USD', ...(p.periodic ? { period: m.period || 'year' } : {}) };
      }
      if (p.type === 'geo' && v && typeof v === 'object') {
        const g = v as { lat: string | number; lon: string | number };
        v = g.lat === '' || g.lon === '' ? null : { lat: Number(g.lat), lon: Number(g.lon) };
      }
      if (p.type === 'address' && v && typeof v === 'object') {
        const a = Object.fromEntries(Object.entries(v as Address).filter(([, x]) => String(x ?? '').trim()));
        v = Object.keys(a).length ? a : null;
      }
      if (p.type === 'number' && v !== '' && v !== undefined) v = Number(v);
      if (p.type === 'datetime' && v && typeof v === 'object' && !(v as Partial<DateTime>).at) v = undefined;
      if (p.type === 'list' && Array.isArray(v)) v = cleanRows(p, v as Row[]);
      if (Array.isArray(v) && !v.length) v = rec ? null : undefined;
      data[p.key] = v === '' || v === undefined ? (rec ? null : undefined) : v;
      if (data[p.key] === undefined) delete data[p.key];
    }
    const body = { data, notes, ...(d.dated ? { validFrom: from || null, validTo: current ? null : to || null } : {}), ...(sensChanged ? { sensitivity: sens } : {}) };
    try {
      const saved = rec ? await patch<Rec>(`/api/data/${d.id}/${rec.id}`, body) : await post<Rec>(`/api/data/${d.id}`, body);
      // Documents picked before the entry existed go up now, filed on it.
      for (const f of pending) await uploadDocument(f, { link: { domain: d.id, recordId: saved.id } }).catch((e) => setError(`${f.name}: ${(e as Error).message}`));
      // A new entry invites what goes with it (a car: its title, insurance, loan) before the panel closes.
      const invites = rec ? [] : (d.companions ?? []).filter((c) => !c.when || c.when.in.includes(String(vals[c.when.part] ?? '')));
      if (invites.length) setAfter(saved); else onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = () => setConfirm({
    title: `Delete this ${d.noun}?`, body: `${rec!.title} is removed from your Little Dipper and from anyone you share ${d.label} with. You can bring it back from Recently deleted for 30 days.${docs.some((x) => x.links.length === 1) ? ' Documents filed only on it are deleted for good.' : ''}`, cta: 'Delete',
    onConfirm: async () => { if (await run(() => del(`/api/data/${d.id}/${rec!.id}`))) onSaved(); },
  });

  const field = (p: Part) => (
    <div key={p.key} className="field">
      <label htmlFor={`part-${p.key}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {(p.labelBy && p.labelBy.labels[String(vals[p.labelBy.part] ?? '')]) || p.ask || p.label}{p.required && <span aria-hidden style={{ color: 'var(--color-accent-500)' }}>*</span>}
        {p.sensitivity === 'secret' && <span className="tag tag-accent" style={{ padding: '1px 8px', fontSize: 10, gap: 4 }}><Lock style={{ width: 8, height: 9 }} />Secret</span>}
      </label>
      <PartInput p={p} value={vals[p.key]} onChange={(v) => set(p.key, v)} contacts={contacts} hiddenSaved={!!rec?.masked.includes(p.key) && !touched.has(p.key)} currency={currency} dateOnly={p.type === 'datetime' && vals.allDay === true} />
    </div>
  );

  if (after) return <Companions d={d} saved={after} vals={vals} onDone={() => onSaved(after)} />;

  return (
    <div className="dialog-backdrop" style={{ zIndex: 50, placeItems: 'stretch end', padding: 0 }} onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label={rec ? `Edit ${d.noun}` : `Add ${d.noun}`} onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(540px, 100%)', height: '100dvh', maxHeight: '100dvh', background: 'var(--color-bg)', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', borderRadius: '32px 0 0 32px' }}>
        <div style={{ padding: '26px 28px 16px', display: 'flex', gap: 14, alignItems: 'center' }}>
          <Mono d={d} size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="card-kicker" style={{ color: groupOf(d.group).ink }}>{d.label}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, lineHeight: 1.15 }}>{rec ? rec.title : `New ${d.noun}`}</div>
          </div>
          <button className="btn btn-secondary" onClick={onClose} aria-label="Close" style={{ width: 36, height: 36, padding: 0 }}>×</button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save(); }} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 28px 24px', display: 'grid', gap: 14, alignContent: 'start' }}>
          {essential.map(field)}
          {d.documents && (
            <div className="field">
              <label>Documents</label>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <DocTiles docs={docs} size={84} onRemove={removeDoc} />
                {pending.map((f, i) => (
                  <span key={i} className="tag tag-neutral" style={{ gap: 6 }}>{f.name}<button type="button" className="bare" aria-label={`Remove ${f.name}`} onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>×</button></span>
                ))}
                <label style={{ width: 84, height: 84, borderRadius: 16, border: '1.5px dashed var(--color-neutral-400)', display: 'grid', placeItems: 'center', textAlign: 'center', fontSize: 12, cursor: 'pointer', color: 'var(--color-neutral-700)', padding: 6 }}>
                  {uploading ? <span className="spin">Uploading…</span> : <span>+ Scan, photo<br />or PDF</span>}
                  <input type="file" accept={FILE_ACCEPT} multiple hidden onChange={(e) => { addDocs(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
                </label>
              </div>
            </div>
          )}
          {d.dated && (
            <div className="card" style={{ padding: '16px 18px', gap: 10, background: 'var(--color-neutral-100)' }}>
              <div className="field"><label htmlFor="vf">From</label><PartialDate id="vf" value={from} onChange={setFrom} /></div>
              <button type="button" role="checkbox" aria-checked={current} className="bare" onClick={() => setCurrent(!current)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <span style={{ width: 18, height: 18, borderRadius: 6, border: '2px solid var(--color-accent)', background: current ? 'var(--color-accent)' : 'transparent', color: 'var(--color-bg)', display: 'grid', placeItems: 'center', fontSize: 11 }}>{current ? '✓' : ''}</span>
                This is current
              </button>
              {!current && <div className="field"><label htmlFor="vt">To</label><PartialDate id="vt" value={to} onChange={setTo} /></div>}
            </div>
          )}
          {extra.length > 0 && (
            <>
              <button type="button" className="btn btn-ghost" style={{ justifySelf: 'start', fontSize: 13 }} onClick={() => setMore(!more)}>
                {more || extraFilled ? 'Fewer details' : `More details · ${extra.length}`}
              </button>
              {(more || extraFilled) && extra.map(field)}
            </>
          )}
          <div className="field">
            <label>Who can see this</label>
            <Pills value={sensChoice} size={12} onChange={(v) => setSensChoice(v as Sensitivity | 'default')}
              options={[['default', rec?.sensitivityDefault && rec.sensitivity ? `Default (${rec.sensitivity})` : 'Default'], ['standard', 'Standard'], ['sensitive', 'Sensitive'], ['secret', 'Secret']]} />
            <div className="text-muted" style={{ fontSize: 12 }}>Standard can be in your basic profile; sensitive only where you share it; secret is encrypted and never leaves without your confirm.</div>
          </div>
          <div className="field"><label htmlFor="notes">Notes</label><textarea id="notes" className="input" style={{ borderRadius: 20, minHeight: 70 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth remembering" /></div>
          {rec?.updatedByLabel && (
            <div className="text-muted" style={{ fontSize: 12 }}>
              {rec.sourceLabel && rec.sourceLabel !== 'You' && `Added by ${rec.sourceLabel} · `}Last changed by {byWhom(rec.updatedByLabel)} · {longDate(rec.updatedAt)}
            </div>
          )}
          {rec && <RecordChanges d={d} rec={rec} onRestored={onSaved} />}
          {error && <div style={{ color: 'var(--color-accent-700)', fontSize: 13 }}>{error}</div>}
          <button type="submit" hidden />
        </form>
        <div style={{ padding: '14px 28px 22px', display: 'flex', gap: 8, borderTop: '1px solid var(--color-divider)' }}>
          {rec && <button className="btn btn-ghost" onClick={remove} style={{ color: 'var(--color-accent-700)', marginRight: 'auto' }}>Delete</button>}
          <span style={{ flex: rec ? 0 : 1 }} />
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{rec ? 'Save' : `Add ${d.noun}`}</button>
        </div>
      </aside>
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/** Key/value details of a record, with masked secrets. */
export function Details({ d, rec, revealed, contacts, skip = [] }: { d: Domain; rec: Rec; revealed?: Record<string, unknown>; contacts: ContactLite[]; skip?: string[] }) {
  const has = (p: Part) => !skip.includes(p.key) && Array.isArray(rec.data[p.key]) && (rec.data[p.key] as unknown[]).length > 0;
  const docs = rec.documents ?? [];
  const lists = d.parts.filter((p) => p.type === 'list' && has(p) && !rec.masked.includes(p.key));
  const rows = d.parts
    .filter((p) => p.type !== 'list')
    .filter((p) => !skip.includes(p.key) && (rec.data[p.key] !== undefined && rec.data[p.key] !== null || rec.masked.includes(p.key)))
    .map((p) => {
      const masked = rec.masked.includes(p.key) && !revealed;
      const v = revealed ? revealed[p.key] : rec.data[p.key];
      return { p, text: masked ? '••••••' : show(p, v, contacts), masked };
    })
    .filter((r) => r.text);
  if (!rows.length && !docs.length && !lists.length) return null;
  return (
    <>
      <FieldGrid fields={rows.map(({ p, text, masked }) => ({ key: p.key, label: labelOf(p, rec.data), text, type: p.type, secret: p.sensitivity === 'secret', masked }))} />
      {lists.map((p) => <ListTable key={p.key} p={p} rows={(revealed?.[p.key] ?? rec.data[p.key]) as Row[]} contacts={contacts} />)}
      {docs.length > 0 && <div style={{ marginTop: 14 }}><DocTiles docs={docs} /></div>}
    </>
  );
}

export function ListTable({ p, rows, contacts }: { p: Part; rows: Row[]; contacts: ContactLite[] }) {
  const cols = (p.of ?? []).filter((c) => rows.some((r) => r[c.key] !== undefined));
  return (
    <div style={{ marginTop: 14, overflowX: 'auto' }}>
      <div className="text-muted" style={{ fontSize: 11, marginBottom: 4 }}>{p.label}</div>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
        <thead><tr>{cols.map((c) => <th key={c.key} className="text-muted" style={{ textAlign: c.type === 'money' || c.type === 'number' ? 'right' : 'left', fontWeight: 500, fontSize: 11, padding: '4px 8px 4px 0' }}>{c.label}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--color-divider)' }}>
            {cols.map((c) => <td key={c.key} style={{ padding: '6px 8px 6px 0', textAlign: c.type === 'money' || c.type === 'number' ? 'right' : 'left', fontVariantNumeric: 'tabular-nums' }}>{show(c, r[c.key], contacts)}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function useContactsLite() {
  const [list, setList] = useState<ContactLite[]>([]);
  useEffect(() => { get<{ items: ContactLite[] }>('/api/parties').then((r) => setList(r.items)).catch(() => {}); }, []);
  return list;
}

export function useGrouped(domains: Domain[] | null | undefined) {
  return useMemo(() => GROUPS.map((g) => ({ g, items: (domains || []).filter((d) => d.group === g.id) })).filter((x) => x.items.length), [domains]);
}

export const Section = ({ title, blurb, ink, right, children }: { title: string; blurb?: string; ink?: string; right?: ReactNode; children: ReactNode }) => (
  <section style={{ marginTop: 34 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: ink }}>{title}</h3>
        {blurb && <span className="text-muted" style={{ fontSize: 13 }}>{blurb}</span>}
      </div>
      {right}
    </div>
    {children}
  </section>
);

// ── one way to show an entry ───────────────────────────────────────────
/** A field as every entry card shows it: label above value. `links` are entries you can open; `rows` a list's lines. */
export type CardField = { key: string; label: string; text: string; type?: string; secret?: boolean; masked?: boolean; rows?: string[]; links?: { id: string; title: string }[] };

/** The label-over-value grid, the same for your own entries and ones shared with you. */
export function FieldGrid({ fields, onLink }: { fields: CardField[]; onLink?: (id: string) => void }) {
  if (!fields.length) return null;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: '10px 18px', margin: '12px 0 0' }}>
      {fields.map((f) => (
        <div key={f.key} style={{ minWidth: 0, gridColumn: f.type === 'longtext' || f.rows?.length ? '1 / -1' : undefined }}>
          <dt className="text-muted" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>{f.label}{f.secret && <Lock style={{ width: 8, height: 9 }} />}</dt>
          <dd style={{ margin: 0, fontSize: 14, overflowWrap: 'anywhere', whiteSpace: f.type === 'longtext' ? 'pre-wrap' : undefined, fontFamily: f.masked || f.type === 'last4' ? 'var(--mono)' : undefined, color: f.masked ? 'var(--color-neutral-500)' : undefined }}>
            {f.links?.length && onLink
              ? f.links.map((l, i) => <span key={l.id}>{i > 0 && ', '}<button type="button" className="link-btn" onClick={() => onLink(l.id)}>{l.title}</button></span>)
              : f.text}
            {f.rows?.map((r, i) => <div key={i} className="text-muted" style={{ fontSize: 13 }}>{r}</div>)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * An entry card: title, when, then its fields. The same card for your own entries (with actions such as Edit) and
 * for entries someone shares with you (read-only, marked as theirs), so shared data always looks like data.
 */
export function EntryCard({ id, title, range, fields, onLink, actions, theirs, quiet, children }: {
  id?: string; title: string; range?: string; fields: CardField[]; onLink?: (id: string) => void; actions?: ReactNode; theirs?: boolean; quiet?: boolean; children?: ReactNode;
}) {
  return (
    <div id={id} className={`card entry-card${theirs ? ' entry-theirs' : ''}`} style={{ padding: '20px 24px', gap: 0, background: quiet || theirs ? 'var(--color-neutral-100)' : 'var(--color-surface)' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: quiet || theirs ? 17 : 20, lineHeight: 1.2 }}>{title}</div>
          {range && <div className="text-muted" style={{ fontSize: 13, marginTop: 2 }}>{range}</div>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{actions}</div>}
      </div>
      <FieldGrid fields={fields} onLink={onLink} />
      {children}
    </div>
  );
}
