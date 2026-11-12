/**
 * The owner's profile: their current facts, worked out from the categories every time. Nothing is stored here, so it
 * can't drift: change your legal name in Names and the profile, the account name and the public page follow.
 *
 * Each line says where it comes from and is exactly as sensitive as the parts it shows (the street address is
 * sensitive, the city it's in may not be). Distinct legal facts stay on distinct lines: a residency is never shown as
 * a citizenship, and a non-citizen national is never shown as a citizen.
 */
import { BUILT_IN_DOMAINS } from './domains/catalog.js';
import { countryName, entrySens, isCurrent, maxSens, partSens, plainData, recordsOf, sortRecords, type RecordDoc } from './domains/records.js';
import type { DomainDef } from './domains/types.js';
import type { Sensitivity } from './fields.js';
import { displayPhone } from './methods.js';
import { canonicalUrl, displayAddr, getNode } from './node.js';
import { basicLines } from './shares.js';

export type ProfileLine = {
  key: string;
  label: string;
  value: string;
  sensitivity: Sensitivity;
  /** The entries it was worked out from: edit those to change it. */
  from: { domain: string; recordId: string }[];
};

/** The categories the profile reads. A change in one of them changes what connections see in the basic profile. */
export const PROFILE_DOMAINS = new Set(['names', 'birth', 'citizenship', 'residences', 'contact_methods', 'relationships']);

/** Every line the profile can have, in order, with its label: what other screens offer before a value exists. */
export const PROFILE_LINES: [string, string][] = [
  ['little_dipper', 'Little Dipper'], ['preferred_name', 'Name'], ['legal_name', 'Legal name'], ['birth_name', 'Birth name'], ['born', 'Born'],
  ['citizenship', 'Citizenship'], ['nationality', 'Non-citizen nationality'], ['residency', 'Residency status'],
  ['marital_status', 'Marital status'], ['lives_in', 'Lives in'], ['address', 'Home address'], ['mailing_address', 'Mailing address'], ['email', 'Email'], ['phone', 'Phone'],
];

const dom = (id: string) => BUILT_IN_DOMAINS.find((d) => d.id === id)!;
const label = (key: string) => PROFILE_LINES.find(([k]) => k === key)![1];

/** How sensitive a value made of these parts of an entry is: the most sensitive of them. */
function sensOf(d: DomainDef, r: RecordDoc, keys: string[]): Sensitivity {
  const plain = plainData(r);
  const entry = entrySens(d, r, plain);
  return keys.reduce<Sensitivity>((s, k) => {
    const p = d.parts.find((x) => x.key === k);
    return p && plain[k] !== undefined ? maxSens(s, partSens(d, p, entry)) : s;
  }, 'standard');
}
const most = (xs: Sensitivity[]) => xs.reduce<Sensitivity>((a, b) => maxSens(a, b), 'standard');

function line(key: string, value: string, sensitivity: Sensitivity, from: { d: DomainDef; r: RecordDoc }[]): ProfileLine | null {
  return value ? { key, label: label(key), value, sensitivity, from: from.map(({ d, r }) => ({ domain: d.id, recordId: r._id })) } : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 1984-03-09 → 9 Mar 1984; partial dates as far as they go. */
const friendlyDate = (v: string) => { const [y, m, d] = v.split('-'); return [d && String(+d), m && MONTHS[+m - 1], y].filter(Boolean).join(' '); };

const current = (d: DomainDef, recs: RecordDoc[]) => sortRecords(d, recs.filter((r) => isCurrent(d, r)));

export async function profileLines(): Promise<ProfileLine[]> {
  const out: (ProfileLine | null)[] = [];

  // Your Little Dipper: the address people use and the Node ID that never changes. On every card, always.
  const n = await getNode();
  out.push({ key: 'little_dipper', label: label('little_dipper'), value: `${displayAddr(canonicalUrl(n))} · ${n._id}`, sensitivity: 'standard', from: [] });

  // Names: current preferred and legal; a birth name only when it differs from today's legal name.
  const names = dom('names');
  const allNames = await recordsOf('names');
  const nameOf = (r: RecordDoc) => String(plainData(r).full ?? '');
  const cur = current(names, allNames);
  const preferred = cur.find((r) => plainData(r).kind === 'preferred');
  // A legal name is its own entry, or the name you go by when you've said it's also your legal name.
  const isLegal = (r: RecordDoc) => { const v = plainData(r); return v.kind === 'legal' || (v.kind === 'preferred' && v.alsoLegal === true); };
  const legal = cur.find((r) => plainData(r).kind === 'legal') ?? cur.find(isLegal);
  const birthName = sortRecords(names, allNames.filter((r) => isLegal(r) && plainData(r).reason === 'birth')).at(-1);
  if (preferred) out.push(line('preferred_name', nameOf(preferred), sensOf(names, preferred, ['full']), [{ d: names, r: preferred }]));
  // Sensitive like any legal name, unless you set the entry yourself.
  if (legal) out.push(line('legal_name', nameOf(legal), legal.sensitivity ? sensOf(names, legal, ['full']) : maxSens('sensitive', sensOf(names, legal, ['full'])), [{ d: names, r: legal }]));
  if (birthName && (!legal || nameOf(birthName) !== nameOf(legal))) out.push(line('birth_name', nameOf(birthName), maxSens('sensitive', sensOf(names, birthName, ['full'])), [{ d: names, r: birthName }]));

  // Birth: "9 Mar 1984, 06:42:17, Peoria, Illinois, United States". The time only if it was given.
  const birth = dom('birth');
  const [b] = await recordsOf('birth');
  if (b) {
    const v = plainData(b);
    const place = [v.city, v.region, v.country ? countryName(String(v.country)) : ''].filter(Boolean).join(', ');
    const when = [friendlyDate(String(v.date)), v.time ? String(v.time) : ''].filter(Boolean).join(', ');
    out.push(line('born', [when, place].filter(Boolean).join(', '), sensOf(birth, b, ['date', 'time', 'city', 'region', 'country']), [{ d: birth, r: b }]));
  }

  // Citizenship, non-citizen nationality and residency: three different legal facts, three lines.
  const cit = dom('citizenship');
  const statuses = current(cit, await recordsOf('citizenship'));
  const group = (keep: (s: string) => boolean, show: (v: Record<string, unknown>) => string) => {
    const rs = statuses.filter((r) => keep(String(plainData(r).status)));
    return { value: rs.map((r) => show(plainData(r))).join('; '), sens: most(rs.map((r) => sensOf(cit, r, ['country', 'status']))), from: rs.map((r) => ({ d: cit, r })) };
  };
  const statusLabel = (s: unknown) => cit.parts.find((p) => p.key === 'status')!.options!.find(([k]) => k === s)?.[1] ?? String(s);
  for (const [key, keep, show] of [
    ['citizenship', (s: string) => s === 'citizen', (v: Record<string, unknown>) => countryName(String(v.country))],
    ['nationality', (s: string) => s === 'noncitizen_national', (v: Record<string, unknown>) => countryName(String(v.country))],
    ['residency', (s: string) => !['citizen', 'noncitizen_national'].includes(s), (v: Record<string, unknown>) => `${countryName(String(v.country))}: ${statusLabel(v.status).toLowerCase()}`],
  ] as const) {
    const g = group(keep, show);
    out.push(line(key, g.value, g.sens, g.from));
  }

  // Marital status, worked out from Relationships: only what the entries say. No partner entries means no line
  // (unknown is not "single"); an annulled marriage leaves nothing to report.
  const rel = dom('relationships');
  const partners = (await recordsOf('relationships')).filter((r) => ['spouse', 'civil_union', 'domestic_partner'].includes(String(plainData(r).relation)));
  const now = current(rel, partners)[0];
  const lastEnded = sortRecords(rel, partners.filter((r) => !isCurrent(rel, r)))[0];
  let marital = '', from: RecordDoc | undefined;
  if (now) {
    const v = plainData(now);
    marital = { spouse: 'Married', civil_union: 'In a civil union', domestic_partner: 'In a domestic partnership' }[String(v.relation)] ?? '';
    if (v.legallySeparated === true) marital += ', legally separated';
    from = now;
  } else if (lastEnded) {
    const v = plainData(lastEnded);
    marital = v.endedBy === 'death' ? 'Widowed' : v.endedBy === 'divorce' ? (v.relation === 'spouse' ? 'Divorced' : 'Partnership dissolved') : '';
    from = lastEnded;
  }
  if (marital && from) out.push(line('marital_status', marital, sensOf(rel, from, ['relation', 'endedBy']), [{ d: rel, r: from }]));

  // Where you live: the primary current home (or the most recent current one).
  const res = dom('residences');
  const homes = current(res, await recordsOf('residences'));
  const home = homes.find((r) => plainData(r).primary === true) ?? homes[0];
  if (home) {
    const v = plainData(home);
    const country = v.country ? countryName(String(v.country)) : '';
    out.push(line('lives_in', [v.city, v.region, country].filter(Boolean).join(', '), sensOf(res, home, ['city', 'region', 'country']), [{ d: res, r: home }]));
    out.push(line('address', [v.street1, v.street2, v.city, [v.region, v.postalCode].filter(Boolean).join(' '), country].filter(Boolean).join(', '), sensOf(res, home, ['street1', 'street2', 'city', 'region', 'postalCode', 'country']), [{ d: res, r: home }]));
  }

  // Mailing address: the main postal contact method, for mail that doesn't go home (a PO box, work).
  const cmAll = dom('contact_methods');
  const postal = current(cmAll, await recordsOf('contact_methods')).filter((r) => plainData(r).kind === 'postal');
  const mainPostal = postal.find((r) => plainData(r).primary === true) ?? postal[0];
  if (mainPostal) {
    const v = plainData(mainPostal);
    const a = (v.address && typeof v.address === 'object' ? v.address : {}) as Record<string, string>;
    const text = [a.street1, a.street2, a.city, [a.region, a.postalCode].filter(Boolean).join(' '), a.country ? countryName(a.country) : ''].filter(Boolean).join(', ');
    out.push(line('mailing_address', text, sensOf(cmAll, mainPostal, ['address']), [{ d: cmAll, r: mainPostal }]));
  }

  // Main email and phone.
  const cm = dom('contact_methods');
  const methods = current(cm, await recordsOf('contact_methods'));
  for (const kind of ['email', 'phone'] as const) {
    const mine = methods.filter((r) => plainData(r).kind === kind);
    const main = mine.find((r) => plainData(r).primary === true) ?? mine.sort((a, c) => a.createdAt.localeCompare(c.createdAt))[0];
    if (main) {
      const value = String(plainData(main).value);
      out.push(line(kind, kind === 'phone' ? displayPhone(value) : value, sensOf(cm, main, ['value']), [{ d: cm, r: main }]));
    }
  }
  return out.filter((x): x is ProfileLine => !!x);
}

/** The owner's name everywhere it's shown (sidebar, "shared by", passkeys): preferred, else legal. */
export async function ownerName(): Promise<string> {
  const lines = await profileLines();
  return lines.find((l) => l.key === 'preferred_name')?.value || lines.find((l) => l.key === 'legal_name')?.value || '';
}

/** The name on the public page and in connection requests: the Names entry chosen for it, else ownerName(). */
export async function publicName(pp: { nameId: string | null } | null): Promise<string> {
  if (pp?.nameId) {
    const r = (await recordsOf('names')).find((x) => x._id === pp.nameId);
    if (r) return String(plainData(r).full ?? '');
  }
  return ownerName();
}

/** The owner's main email, if they've added one. */
export async function ownerEmail(): Promise<string> {
  return (await profileLines()).find((l) => l.key === 'email')?.value ?? '';
}

/** Lines another party may read: the owner's basic profile list, plus extra lines shared one by one. Secret lines never leave. */
export async function linesFor(opts: { basic: boolean; extra: string[] }) {
  const basic = opts.basic ? await basicLines() : [];
  return (await profileLines()).filter((l) => l.sensitivity !== 'secret' && (basic.includes(l.key) || opts.extra.includes(l.key)));
}
