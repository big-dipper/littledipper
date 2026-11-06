/**
 * The calendar: the owner's events, the dates their data already holds (birthdays, trips,
 * return-by and warranty deadlines, expiries, any date-and-time part) and the events
 * contacts share with them. A read-only view over records; nothing is stored here.
 */
import { ctx } from './ctx.js';
import type { PartyDoc } from './federation.js';
import { isDateTime, normalizeDateTime, type DateTimeValue } from './domains/datetime.js';
import { isCurrent, isPartialDate, listDomains, plainData, recordOut, recordsOf } from './domains/records.js';
import type { DomainDef } from './domains/types.js';

export type CalendarItem = {
  /** Unique per occurrence: a repeating event has one item per day it happens. */
  id: string;
  kind: 'event' | 'birthday' | 'trip' | 'deadline' | 'expiry' | 'moment';
  title: string;
  /** A second line: "turns 40", the part a deadline belongs to… */
  detail?: string;
  /** Local dates covered, inclusive (YYYY-MM-DD). For timed items, in the item's own zone. */
  startDate: string;
  endDate: string;
  allDay: boolean;
  /** Timed items only. */
  start?: DateTimeValue;
  end?: DateTimeValue;
  location?: string;
  repeat?: string;
  domain: string;
  domainLabel: string;
  recordId: string;
  /** Shared by a contact, not the owner's own. */
  contact?: { id: string; name: string };
};

const DAY = 86400_000;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const addDays = (d: string, n: number) => ymd(dayMs(d) + n * DAY);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** A partial date as the last day of its period: 2027 → 2027-12-31, 2027-04 → 2027-04-30. */
function lastDay(v: string) {
  if (v.length === 4) return `${v}-12-31`;
  if (v.length === 7) return `${v}-${pad(daysInMonth(+v.slice(0, 4), +v.slice(5, 7) - 1))}`;
  return v;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const weekday = (d: string) => WEEKDAYS[new Date(dayMs(d)).getUTCDay()];
type Rule = { freq: string; interval: number; count: number | null; until: string | null; byDay: { n: number | null; day: string }[]; byMonthDay: number[] };

/** An iCalendar RRULE (as stored: checked by records.ts) parsed into what the calendar uses. */
function parseRule(rule: string): Rule | null {
  const m = Object.fromEntries(rule.split(';').map((x) => x.split('=')));
  if (!/^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(m.FREQ ?? '')) return null;
  return {
    freq: m.FREQ, interval: Number(m.INTERVAL || 1), count: m.COUNT ? Number(m.COUNT) : null,
    until: m.UNTIL ? `${m.UNTIL.slice(0, 4)}-${m.UNTIL.slice(4, 6)}-${m.UNTIL.slice(6, 8)}` : null,
    byDay: m.BYDAY ? String(m.BYDAY).split(',').map((x) => { const r = x.match(/^([+-]?\d{1,2})?([A-Z]{2})$/)!; return { n: r[1] ? Number(r[1]) : null, day: r[2] }; }) : [],
    byMonthDay: m.BYMONTHDAY ? String(m.BYMONTHDAY).split(',').map(Number) : [],
  };
}

/** Whether a day is an occurrence of the rule, counting from the first day. RFC 5545: dates that don't exist (Feb 30) are skipped. */
function onRule(r: Rule, first: string, day: string): boolean {
  const y0 = +first.slice(0, 4), m0 = +first.slice(5, 7), d0 = +first.slice(8, 10);
  const y = +day.slice(0, 4), m = +day.slice(5, 7), d = +day.slice(8, 10);
  const nthOf = (n: number) => { // the nth (or nth from last) of this weekday in its month
    const dim = daysInMonth(y, m - 1);
    return n > 0 ? Math.ceil(d / 7) === n : Math.ceil((dim - d + 1) / 7) === -n;
  };
  switch (r.freq) {
    case 'DAILY': return ((dayMs(day) - dayMs(first)) / DAY) % r.interval === 0;
    case 'WEEKLY': {
      // Weeks start on Monday (WKST=MO, the default).
      const monday = (x: string) => dayMs(x) - ((new Date(dayMs(x)).getUTCDay() + 6) % 7) * DAY;
      if (Math.round((monday(day) - monday(first)) / (7 * DAY)) % r.interval !== 0) return false;
      return r.byDay.length ? r.byDay.some((b) => b.day === weekday(day)) : weekday(day) === weekday(first);
    }
    case 'MONTHLY': {
      if (((y - y0) * 12 + (m - m0)) % r.interval !== 0) return false;
      if (r.byDay.length) return r.byDay.some((b) => b.day === weekday(day) && (b.n === null || nthOf(b.n)));
      if (r.byMonthDay.length) return r.byMonthDay.some((n) => (n > 0 ? d === n : d === daysInMonth(y, m - 1) + n + 1));
      return d === d0;
    }
    case 'YEARLY': return (y - y0) % r.interval === 0 && m === m0 && d === d0;
  }
  return false;
}

/** Every occurrence of one event (repeating or not) that touches [from, to]. */
function occurrences(base: Omit<CalendarItem, 'id' | 'startDate' | 'endDate' | 'start' | 'end'>, data: Record<string, unknown>, from: string, to: string): CalendarItem[] {
  const start = normalizeDateTime(data.start);
  if (!start) return [];
  const end = normalizeDateTime(data.end);
  const allDay = data.allDay === true;
  const rule = typeof data.repeat === 'string' ? parseRule(data.repeat) : null;
  // How long one occurrence lasts: whole days when all day, otherwise time (an hour if no end).
  const spanDays = allDay && end ? Math.max(0, (dayMs(end.at.slice(0, 10)) - dayMs(start.at.slice(0, 10))) / DAY) : 0;
  const spanMs = !allDay && end ? Date.parse(end.at) - Date.parse(start.at) : 3600_000;
  const out: CalendarItem[] = [];
  const first = start.at.slice(0, 10), time = start.at.slice(10, 19);
  let seen = 0;
  // Walk day by day from the first occurrence (bounded: 60 years), so COUNT is counted from the start, not the window.
  for (let day = first, i = 0; i < 366 * 60; day = addDays(day, 1), i++) {
    if (day > to || (rule?.until && day > rule.until)) break;
    if (rule ? !onRule(rule, first, day) : day !== first) { if (!rule) break; continue; }
    if (rule?.count && ++seen > rule.count) break;
    const s = normalizeDateTime({ at: day + time, tz: start.tz });
    if (!s) continue;
    const e = allDay ? null : normalizeDateTime({ at: new Date(Date.parse(s.at) + spanMs).toISOString(), tz: start.tz });
    const eDate = allDay ? addDays(day, spanDays) : e!.at.slice(0, 10);
    if (eDate >= from) out.push({ ...base, id: `${base.recordId}:${day}`, startDate: day, endDate: eDate, allDay, ...(allDay ? {} : { start: s, end: e! }), ...(rule ? { repeat: data.repeat as string } : {}) });
    if (!rule) break;
  }
  return out;
}

/** A yearly birthday in [from, to] for someone born on `born` (YYYY-MM-DD). */
function birthdays(born: string, from: string, to: string) {
  const out: { day: string; age: number }[] = [];
  for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) {
    if (y < +born.slice(0, 4)) continue;
    const day = `${y}-${born.slice(5, 7)}-${pad(Math.min(+born.slice(8, 10), daysInMonth(y, +born.slice(5, 7) - 1)))}`;
    if (day >= from && day <= to) out.push({ day, age: y - +born.slice(0, 4) });
  }
  return out;
}

/** Everything on the calendar between two local dates, inclusive. */
export async function calendarItems(from: string, to: string, opts: { contacts: boolean }): Promise<CalendarItem[]> {
  const items: CalendarItem[] = [];
  const domains = await listDomains();
  const base = (d: DomainDef, recordId: string) => ({ domain: d.id, domainLabel: d.label, recordId });
  const inRange = (s: string, e: string = s) => e >= from && s <= to;

  for (const d of domains) {
    const recs = await recordsOf(d.id);
    if (!recs.length) continue;
    for (const r of recs) {
      const x = plainData(r);
      const title = recordOut(d, r).title;
      if (d.id === 'events') {
        items.push(...occurrences({ ...base(d, r._id), kind: 'event', title, allDay: false, ...(x.location ? { location: String(x.location) } : {}) }, x, from, to));
        continue;
      }
      // Birthdays, every year: yours (from Birth) and your pets'. People's come from the parties below.
      if ((d.id === 'birth' && isDay(x.date)) || (d.id === 'pets' && isDay(x.birthDate) && isCurrent(d, r))) {
        for (const { day, age } of birthdays(String(d.id === 'birth' ? x.date : x.birthDate), from, to)) {
          items.push({ ...base(d, r._id), id: `${r._id}:birthday:${day.slice(0, 4)}`, kind: 'birthday', title: d.id === 'birth' ? 'Your birthday' : `${x.name ?? title}’s birthday`, ...(age ? { detail: `turns ${age}` } : {}), startDate: day, endDate: day, allDay: true });
        }
      }
      // Trips span their days. Only when the record knows the day.
      if (d.id === 'travel' && isDay(r.validFrom)) {
        const end = isDay(r.validTo) && r.validTo >= r.validFrom ? r.validTo : r.validFrom;
        if (inRange(r.validFrom, end)) items.push({ ...base(d, r._id), id: `${r._id}:trip`, kind: 'trip', title, startDate: r.validFrom, endDate: end, allDay: true });
      }
      for (const p of d.parts) {
        const v = x[p.key];
        // Deadlines and expiries on current records, as on Home's "Coming up".
        if (p.type === 'date' && (p.remind || /expires/i.test(p.key)) && isPartialDate(v) && isCurrent(d, r)) {
          const day = lastDay(v as string);
          if (inRange(day)) items.push({ ...base(d, r._id), id: `${r._id}:${p.key}`, kind: p.remind ? 'deadline' : 'expiry', title, detail: p.label, startDate: day, endDate: day, allDay: true });
        }
        // Any other date-and-time part (a custom "Appointments" category…) is a moment on the calendar.
        if (p.type === 'datetime' && isDateTime(v)) {
          const day = v.at.slice(0, 10);
          if (inRange(day)) items.push({ ...base(d, r._id), id: `${r._id}:${p.key}`, kind: 'moment', title, detail: p.label, startDate: day, endDate: day, allDay: false, start: v, end: v });
        }
      }
    }
  }

  // Birthdays of the people in your life: a party's birthday lives on the party.
  for (const c of await ctx.store.find<PartyDoc>('parties', {})) {
    if (c.type !== 'person' || !isDay(c.birthDate)) continue;
    for (const { day, age } of birthdays(c.birthDate, from, to)) {
      items.push({ domain: 'parties', domainLabel: 'Contacts', recordId: c._id, id: `${c._id}:birthday:${day.slice(0, 4)}`, kind: 'birthday', title: `${c.name}’s birthday`, ...(age ? { detail: `turns ${age}` } : {}), startDate: day, endDate: day, allDay: true });
    }
  }

  // Events contacts share with us, as last synced from their nodes. Their data is theirs: shape-checked, never trusted.
  if (opts.contacts) {
    for (const c of (await ctx.store.find<PartyDoc>('parties', {})).filter((x) => x.node)) {
      const shared = (c.sharedDomains || []).find((s) => s.domain === 'events');
      if (!shared) continue;
      for (const r of shared.records) {
        items.push(...occurrences({
          kind: 'event', title: String(r.title).slice(0, 200), allDay: false, domain: 'events', domainLabel: shared.label, recordId: String(r.id),
          contact: { id: c._id, name: c.name }, ...(typeof r.data?.location === 'string' ? { location: r.data.location.slice(0, 200) } : {}),
        }, (r.data || {}) as Record<string, unknown>, from, to).map((i) => ({ ...i, id: `${c._id}:${i.id}` })));
      }
    }
  }

  const when = (i: CalendarItem) => (i.allDay ? '' : new Date(i.start!.at).toISOString());
  return items.sort((a, b) => a.startDate.localeCompare(b.startDate) || Number(b.allDay) - Number(a.allDay) || when(a).localeCompare(when(b)) || a.title.localeCompare(b.title));
}
