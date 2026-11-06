/**
 * Contact methods: one shape for everyone, the owner's and every party's (email, phone, postal address,
 * website, social and messaging handles). Values are checked by kind; phones are stored in E.164
 * (+15035550148) and shown in a friendlier form.
 */
import { bad } from './auth.js';
import { isPartialDate } from './domains/records.js';

export const METHOD_KINDS = ['email', 'phone', 'postal', 'website', 'social', 'messaging'] as const;
export type MethodKind = (typeof METHOD_KINDS)[number];
export type PostalAddress = { street1?: string; street2?: string; city?: string; region?: string; postalCode?: string; country: string };

export type ContactMethod = {
  kind: MethodKind;
  /** A postal method holds an address; every other kind a string. */
  value: string | PostalAddress;
  /** Social and messaging: which service (Instagram, Signal…). */
  service?: string;
  /** Personal, Work… */
  label?: string;
  /** The main one of its kind. At most one per kind. */
  primary?: boolean;
  /** Old numbers and addresses are kept as history, so mail from them still matches. */
  validFrom?: string | null;
  validTo?: string | null;
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * A phone number in E.164, or null. Accepts +44 20 7946 0958, (503) 555-0148 and the like; a number without
 * a country code takes `country`'s (only North America is known so far, so others need the +).
 */
export function toE164(raw: string, country = 'US'): string | null {
  const s = raw.trim();
  const ext = s.match(/\s*(?:x|ext\.?|extension)\s*(\d{1,6})$/i);
  const main = ext ? s.slice(0, ext.index) : s;
  if (!/^[+\d(][\d\s().\-]*$/.test(main)) return null;
  const digits = main.replace(/\D/g, '');
  let e164: string;
  if (main.startsWith('+')) e164 = `+${digits}`;
  else if (['US', 'CA'].includes(country) && digits.length === 10) e164 = `+1${digits}`;
  else if (['US', 'CA'].includes(country) && digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  else return null;
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) return null;
  return ext ? `${e164};ext=${ext[1]}` : e164;
}

/** +15035550148 → (503) 555-0148; others in international form. */
export function displayPhone(e164: string): string {
  const [num, ext] = e164.split(';ext=');
  const d = num.slice(1);
  const out = d.startsWith('1') && d.length === 11 ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : `+${d}`;
  return ext ? `${out} ext. ${ext}` : out;
}

export function displayMethod(m: ContactMethod): string {
  if (m.kind === 'postal' && typeof m.value === 'object') {
    const a = m.value;
    return [a.street1, a.street2, a.city, [a.region, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ');
  }
  if (m.kind === 'phone') return displayPhone(String(m.value));
  if ((m.kind === 'social' || m.kind === 'messaging') && m.service) return `${m.value} on ${m.service}`;
  return String(m.value);
}

function checkPostal(v: unknown): PostalAddress {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('invalid_value', 'A postal address needs its lines and a country');
  const a = v as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of ['street1', 'street2', 'city', 'region', 'postalCode', 'country']) {
    const x = String(a[k] ?? '').trim().slice(0, 200);
    if (x) out[k] = k === 'country' ? x.toUpperCase() : x;
  }
  if (!/^[A-Z]{2}$/.test(out.country ?? '')) throw bad('invalid_value', 'A postal address needs a two-letter country code, e.g. US');
  return out as PostalAddress;
}

/** One method, checked and normalised. `country` is where the owner lives, for phone numbers typed without a code. */
export function checkMethod(input: unknown, country = 'US'): ContactMethod {
  const m = (input ?? {}) as Partial<ContactMethod> & Record<string, unknown>;
  if (!METHOD_KINDS.includes(m.kind as MethodKind)) throw bad('invalid_value', `Kind must be one of ${METHOD_KINDS.join(', ')}`);
  const kind = m.kind as MethodKind;
  let value: ContactMethod['value'];
  const raw = typeof m.value === 'string' ? m.value.trim() : m.value;
  switch (kind) {
    case 'email':
      if (!EMAIL.test(String(raw))) throw bad('invalid_value', `${raw} isn’t an email address`);
      value = String(raw).replace(/@(.*)$/, (_, dom: string) => `@${dom.toLowerCase()}`);
      break;
    case 'phone': {
      const e = toE164(String(raw ?? ''), country);
      if (!e) throw bad('invalid_value', `${raw} isn’t a phone number. Numbers outside North America need their country code, e.g. +44…`);
      value = e;
      break;
    }
    case 'website':
      try { value = new URL(/^https?:\/\//.test(String(raw)) ? String(raw) : `https://${raw}`).toString(); } catch { throw bad('invalid_value', `${raw} isn’t a web address`); }
      break;
    case 'social': case 'messaging':
      if (!raw || String(raw).length > 200) throw bad('invalid_value', 'Add the handle or number');
      if (!String(m.service ?? '').trim()) throw bad('invalid_value', 'Say which service, e.g. Instagram or Signal');
      value = String(raw);
      break;
    case 'postal':
      value = checkPostal(raw);
      break;
  }
  for (const k of ['validFrom', 'validTo'] as const) if (m[k] && !isPartialDate(m[k])) throw bad('invalid_value', `${k}: use YYYY, YYYY-MM or YYYY-MM-DD`);
  return {
    kind, value,
    ...(kind === 'social' || kind === 'messaging' ? { service: String(m.service).trim().slice(0, 60) } : {}),
    ...(m.label ? { label: String(m.label).trim().slice(0, 60) } : {}),
    ...(m.primary ? { primary: true } : {}),
    ...(m.validFrom ? { validFrom: m.validFrom } : {}),
    ...(m.validTo ? { validTo: m.validTo } : {}),
  };
}

/** A list of methods: each checked, at most one primary per kind (the last one marked wins). */
export function checkMethods(list: unknown, country = 'US'): ContactMethod[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw bad('invalid_value', 'Contact methods must be a list');
  if (list.length > 50) throw bad('invalid_value', 'Up to 50 contact methods');
  const out = list.map((m) => checkMethod(m, country));
  for (const kind of METHOD_KINDS) {
    const primaries = out.filter((m) => m.kind === kind && m.primary);
    for (const m of primaries.slice(0, -1)) delete m.primary;
  }
  return out;
}
