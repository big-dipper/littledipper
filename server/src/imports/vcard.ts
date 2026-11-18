/**
 * Reading contacts files (vCard 2.1, 3.0 and 4.0): what Google Contacts, iCloud, Outlook and phones export.
 * Each card becomes a plain, checked person or organisation; anything we can't make sense of is left out rather
 * than guessed. Photos are dropped.
 */
import { checkMethod, toE164, type ContactMethod, type PostalAddress } from '../methods.js';

export type Card = {
  /** Position in the file, for telling cards apart. */
  n: number;
  /** The name to show. Falls back to the company, then an email or phone, when the card has no name. */
  name: string;
  /** The card has a person's name (or, for an organisation, a company name), not just an address. */
  named: boolean;
  type: 'person' | 'organisation';
  /** Where they work, and their job title there. */
  org: string;
  title: string;
  methods: ContactMethod[];
  /** YYYY-MM-DD, or YYYY when only the year is known. A birthday without a year isn't kept: dates of birth here are exact. */
  birthDate: string;
  /** Contact labels (Google's Family, Friends…; vCard CATEGORIES). */
  labels: string[];
  note: string;
};

type Line = { group: string; name: string; params: Record<string, string[]>; value: string };

/** Country names as exports write them, to two-letter codes. Others keep the address only if already a code. */
const COUNTRIES: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', usa: 'US', 'u.s.a.': 'US', 'u.s.': 'US', us: 'US', america: 'US',
  canada: 'CA', mexico: 'MX', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  ireland: 'IE', france: 'FR', germany: 'DE', deutschland: 'DE', spain: 'ES', españa: 'ES', italy: 'IT', italia: 'IT', portugal: 'PT',
  netherlands: 'NL', 'the netherlands': 'NL', belgium: 'BE', switzerland: 'CH', austria: 'AT', sweden: 'SE', norway: 'NO', denmark: 'DK',
  finland: 'FI', poland: 'PL', australia: 'AU', 'new zealand': 'NZ', japan: 'JP', china: 'CN', india: 'IN', brazil: 'BR', brasil: 'BR',
  argentina: 'AR', chile: 'CL', colombia: 'CO', peru: 'PE', philippines: 'PH', singapore: 'SG', 'south korea': 'KR', korea: 'KR',
  israel: 'IL', 'south africa': 'ZA', nigeria: 'NG', kenya: 'KE', egypt: 'EG', 'united arab emirates': 'AE', uae: 'AE',
};

/** Contact labels that exports add on their own and that mean nothing to the owner. */
const NOISE_LABELS = new Set(['mycontacts', 'my contacts', 'starred in android', 'imported', 'other contacts']);

function unescape(v: string) {
  return v.replace(/\\([nN,;:\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Split on a separator that isn't escaped. */
function splitUnescaped(v: string, sep: string) {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) { cur += v[i] + v[i + 1]; i++; continue; }
    if (v[i] === sep) { out.push(cur); cur = ''; continue; }
    cur += v[i];
  }
  out.push(cur);
  return out;
}

function decodeQP(v: string, charset: string) {
  const bytes: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) { bytes.push(parseInt(v.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(v.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString(/^(iso-8859-1|latin1|windows-1252)$/i.test(charset) ? 'latin1' : 'utf8');
}

/** The file's lines, unfolded, each split into group, name, parameters and value. */
function lines(text: string): Line[] {
  const raw = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const joined: string[] = [];
  for (const l of raw) {
    const prev = joined.length - 1;
    if ((l.startsWith(' ') || l.startsWith('\t')) && prev >= 0) joined[prev] += l.slice(1);
    // Quoted-printable (vCard 2.1) continues a line that ends in a soft break.
    else if (prev >= 0 && /QUOTED-PRINTABLE/i.test(joined[prev].split(':')[0]) && joined[prev].endsWith('=')) joined[prev] = joined[prev].slice(0, -1) + l;
    else joined.push(l);
  }
  const out: Line[] = [];
  for (const l of joined) {
    if (!l.trim()) continue;
    // The name and parameters end at the first colon outside quotes.
    let i = 0, q = false;
    for (; i < l.length; i++) { if (l[i] === '"') q = !q; else if (l[i] === ':' && !q) break; }
    if (i >= l.length) continue;
    const head = l.slice(0, i), value = l.slice(i + 1);
    const parts = head.split(';');
    const full = parts[0].toUpperCase();
    const dot = full.lastIndexOf('.');
    const params: Record<string, string[]> = {};
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=');
      // vCard 2.1 writes bare types: TEL;HOME;VOICE:
      const k = eq < 0 ? 'TYPE' : p.slice(0, eq).toUpperCase();
      const vals = (eq < 0 ? p : p.slice(eq + 1)).replace(/^"|"$/g, '').split(',').map((x) => x.trim()).filter(Boolean);
      params[k] = [...(params[k] ?? []), ...vals];
    }
    let v = value;
    if (params.ENCODING?.some((e) => /^quoted-printable$/i.test(e))) v = decodeQP(v, params.CHARSET?.[0] ?? 'utf-8');
    out.push({ group: dot < 0 ? '' : full.slice(0, dot), name: dot < 0 ? full : full.slice(dot + 1), params, value: v });
  }
  return out;
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A label for a method from its vCard types: Home, Work, Mobile… (or the custom label Apple keeps beside it). */
function labelOf(l: Line, custom: Map<string, string>) {
  const own = l.group ? custom.get(l.group) : undefined;
  if (own) return tidy(own.replace(/^_\$!<|>!\$_$/g, '')).slice(0, 60);
  const types = (l.params.TYPE ?? []).map((t) => t.toLowerCase());
  if (types.includes('cell') || types.includes('mobile') || types.includes('iphone')) return 'Mobile';
  if (types.includes('home')) return 'Home';
  if (types.includes('work')) return 'Work';
  return '';
}

/** BDAY in its many spellings. Year-less birthdays (--0412, Apple's 1604-04-12) aren't kept. */
function birthDateOf(v: string) {
  const s = v.trim().replace(/T.*$/, '');
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m) {
    if (m[1] === '1604' || m[1] === '0000') return '';
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return Number.isNaN(Date.parse(d)) ? '' : d;
  }
  return /^\d{4}$/.test(s) ? s : '';
}

function postalOf(v: string): PostalAddress | null {
  // ADR: PO box; extended; street; city; region; postal code; country
  const [pobox = '', ext = '', street = '', city = '', region = '', postalCode = '', country = ''] = splitUnescaped(v, ';').map((x, i) => (i === 2 ? unescape(x) : tidy(unescape(x))));
  const c = country ? (COUNTRIES[country.toLowerCase()] ?? (/^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : '')) : 'US';
  const lines = street.split('\n').map(tidy).filter(Boolean);
  const street1 = lines[0] || (pobox ? `PO Box ${pobox.replace(/^p\.?o\.? box\s*/i, '')}` : '');
  if (!c || (!street1 && !city)) return null;
  return { street1, street2: [lines.slice(1).join(', '), ext].filter(Boolean).join(', '), city, region, postalCode, country: c };
}

/** Add a method if it checks out and isn't there already; a value that doesn't check out is dropped. */
function addMethod(list: ContactMethod[], input: Partial<ContactMethod>, country: string) {
  try {
    const m = checkMethod(input, country);
    if (!list.some((x) => x.kind === m.kind && JSON.stringify(x.value) === JSON.stringify(m.value))) list.push(m);
  } catch { /* not a usable address or number */ }
}

/** Every card in the file. `country` is the owner's, for phone numbers written without a country code. */
export function parseVcards(text: string, country = 'US'): Card[] {
  const cards: Card[] = [];
  let cur: Line[] | null = null;
  for (const l of lines(text)) {
    if (l.name === 'BEGIN' && /^vcard$/i.test(l.value.trim())) { cur = []; continue; }
    if (l.name === 'END' && /^vcard$/i.test(l.value.trim())) { if (cur) cards.push(cardOf(cur, cards.length, country)); cur = null; continue; }
    cur?.push(l);
  }
  return cards;
}

function cardOf(ls: Line[], n: number, country: string): Card {
  const custom = new Map(ls.filter((l) => l.name === 'X-ABLABEL').map((l) => [l.group, unescape(l.value)]));
  const one = (name: string) => ls.find((l) => l.name === name)?.value ?? '';
  const fn = tidy(unescape(one('FN')));
  const [family = '', given = '', middle = '', prefix = '', suffix = ''] = splitUnescaped(one('N'), ';').map((x) => tidy(unescape(x).replace(/,/g, ' ')));
  const fromN = tidy([prefix, given, middle, family, suffix].filter(Boolean).join(' '));
  const [company = ''] = splitUnescaped(one('ORG'), ';').map((x) => tidy(unescape(x)));
  const isCompany = /company/i.test(one('X-ABSHOWAS')) || (/^org$/i.test(one('KIND').trim()));
  const personName = fn && fn !== company ? fn : fromN;

  const methods: ContactMethod[] = [];
  for (const l of ls) {
    const label = labelOf(l, custom);
    const v = tidy(unescape(l.value));
    if (!v) continue;
    if (l.name === 'EMAIL') addMethod(methods, { kind: 'email', value: v.replace(/^mailto:/i, ''), label }, country);
    else if (l.name === 'TEL') {
      const num = v.replace(/^tel:/i, '');
      if (toE164(num, country)) addMethod(methods, { kind: 'phone', value: num, label }, country);
    } else if (l.name === 'ADR') {
      const a = postalOf(l.value);
      if (a) addMethod(methods, { kind: 'postal', value: a, label }, country);
    } else if (l.name === 'URL' && !/google\.com\/profiles|plus\.google/i.test(v)) addMethod(methods, { kind: 'website', value: v, label }, country);
  }

  const labels: string[] = [];
  for (const l of ls.filter((x) => x.name === 'CATEGORIES')) {
    for (const c of splitUnescaped(l.value, ',').map((x) => tidy(unescape(x)))) {
      const name = c === 'starred' ? 'Starred' : c;
      if (name && !NOISE_LABELS.has(name.toLowerCase()) && !labels.some((x) => x.toLowerCase() === name.toLowerCase())) labels.push(name.slice(0, 60));
    }
  }

  const type: Card['type'] = isCompany || (!personName && company) ? 'organisation' : 'person';
  const shown = type === 'organisation' ? company || personName : personName;
  const fallback = methods.find((m) => m.kind === 'email' || m.kind === 'phone');
  return {
    n,
    name: (shown || (fallback ? String(fallback.value) : '') || 'No name').slice(0, 200),
    named: !!shown,
    type,
    org: type === 'person' ? company.slice(0, 200) : '',
    title: tidy(unescape(one('TITLE'))).slice(0, 100),
    methods,
    birthDate: type === 'person' ? birthDateOf(one('BDAY')) : '',
    labels,
    note: unescape(one('NOTE')).trim().slice(0, 2000),
  };
}
