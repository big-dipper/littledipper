/**
 * Reading "Pick up kids at 3 on Saturday" as an event: what, which day, what time. No AI, no network: chrono-node
 * finds the date words, and what's left is the title. Always shown as a preview the person can fix before saving.
 */
import * as chrono from 'chrono-node';

export type When = { title: string; date: string | null; time: string | null; endTime: string | null };

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** What's left once the date words are gone: "Pick up kids", not "Pick up kids at on". */
function tidy(text: string) {
  const t = text.replace(/\s+/g, ' ').trim()
    .replace(/[\s,]+(on|at|by|for|this|next|from|until|,|-)$/i, '')
    .replace(/^(on|at|by)\s+/i, '')
    .trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** A bare "at 3" means the afternoon: few plans are at 3 in the morning. Explicit am/pm always wins. */
function likelyHour(c: chrono.ParsedComponents, d: Date) {
  if (c.isCertain('hour') && !c.isCertain('meridiem') && d.getHours() >= 1 && d.getHours() <= 6) d.setHours(d.getHours() + 12);
  return d;
}

export function readWhen(text: string, now = new Date()): When {
  const found = chrono.parse(text, now, { forwardDate: true })[0];
  if (!found) return { title: tidy(text), date: null, time: null, endTime: null };
  const title = tidy(`${text.slice(0, found.index)} ${text.slice(found.index + found.text.length)}`);
  const start = likelyHour(found.start, found.start.date());
  const timed = found.start.isCertain('hour');
  const end = found.end && found.end.isCertain('hour') ? likelyHour(found.end, found.end.date()) : null;
  return { title: title || tidy(text), date: ymd(start), time: timed ? hm(start) : null, endTime: end ? hm(end) : null };
}

/** "Sat 14 Nov · 3:00 PM": how the preview reads back what it understood. */
export function sayWhen(date: string | null, time: string | null) {
  if (!date) return '';
  const d = new Date(`${date}T${time ?? '12:00'}`);
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return time ? `${day} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : day;
}
