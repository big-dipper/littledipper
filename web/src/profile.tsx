/**
 * The public profile, drawn from what /public/profile returns: one card with who you are and what you say about
 * yourself, then each section folded to a line that still says something ("Design lead at Alder Studio · 3 jobs").
 * The editor preview uses the same component.
 */
import { useState, type ReactNode } from 'react';
import { initials, type FileRef } from './api';
import { duration, fmtRange, Mono } from './life';
import { Lightbox, Thumb } from './docs';

type Field = { key: string; label: string; value: string };
type Contact = { kind: string; value: string; label: string; href?: string };
type Item = { id: string; title: string; fields: (Field & { type: string })[]; validFrom: string | null; validTo: string | null; current: boolean; contact?: Contact };
type Page = FileRef & { url: string };
export type ViewSection =
  | { type: 'details'; fields: Field[] }
  | { type: 'about'; text: string }
  | { type: 'domain'; domain: string; title: string; dated: boolean; group?: string; noun?: string; items: Item[] }
  | { type: 'resume'; title: string; document: { title: string; updatedAt: string; pages: Page[] } };
export type ProfileViewData = { displayName: string; headline: string; avatarUrl: string | null; sections: ViewSection[] };

export function Portrait({ name, url, size }: { name: string; url: string | null; size: number }) {
  return url
    ? <img src={url} alt={name} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block', background: 'var(--color-neutral-200)' }} />
    : <span aria-hidden style={{ width: size, height: size, borderRadius: '50%', background: 'var(--color-accent-200)', color: 'var(--color-accent-800)', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-heading)', fontSize: size * 0.36 }}>{initials(name)}</span>;
}

const plural = (n: number, noun: string) => `${n} ${n === 1 ? noun : noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;
const monthYear = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

/** The folded line for personal details: the facts people look for first, kept short. */
function detailsSummary(fields: Field[]) {
  const pick = (k: string) => fields.find((f) => f.key === k)?.value;
  const year = pick('born')?.match(/\b\d{4}\b/)?.[0];
  const parts = [year && `Born ${year}`, pick('citizenship'), pick('marital_status'), pick('lives_in')].filter(Boolean).slice(0, 3);
  return parts.length ? parts.join(' · ') : fields.map((f) => f.label).join(', ');
}

function sectionSummary(s: Exclude<ViewSection, { type: 'about' }>) {
  if (s.type === 'details') return detailsSummary(s.fields);
  if (s.type === 'resume') return `${s.document.pages.length > 1 ? `${s.document.pages.length} pages · ` : ''}Updated ${monthYear(s.document.updatedAt)}`;
  if (s.items.every((it) => it.contact)) return [...new Set(s.items.map((it) => it.contact!.label))].join(' · ');
  return s.items.length > 1 ? `${s.items[0].title} · ${plural(s.items.length, s.noun ?? 'entry')}` : s.items[0].title;
}

const ICONS: Record<string, ReactNode> = {
  email: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M4 7l8 6 8-6" /></>,
  phone: <path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 4.5 5.5a2 2 0 0 1 2-2z" strokeLinejoin="round" />,
  website: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z" /></>,
  social: <><rect x="4" y="4" width="16" height="16" rx="5" /><circle cx="12" cy="12" r="3.6" /><circle cx="16.8" cy="7.2" r="1.1" fill="currentColor" /></>,
  messaging: <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" strokeLinejoin="round" />,
  postal: <><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" strokeLinejoin="round" /><circle cx="12" cy="10" r="2.4" /></>,
};
const ContactIcon = ({ kind, size }: { kind: string; size: number }) => (
  <svg aria-hidden viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} style={{ flex: 'none', color: 'var(--color-accent-700)' }}>{ICONS[kind] ?? ICONS.website}</svg>
);

/** compact: the smaller version in the editor's preview. actions: the Connect button, inside the card. */
export function ProfileView({ p, compact, actions }: { p: ProfileViewData; compact?: boolean; actions?: ReactNode }) {
  const [viewing, setViewing] = useState<Page[] | null>(null);
  const h = compact ? { name: 24, head: 13, body: 13, photo: 60, pad: '18px 20px', fold: 30 } : { name: 34, head: 16, body: 15, photo: 84, pad: '26px 28px', fold: 36 };
  const about = p.sections.filter((s): s is Extract<ViewSection, { type: 'about' }> => s.type === 'about');
  // Where you live reads best beside your name, so it moves out of the details into the card. The name the card
  // already shows isn't said twice: a new owner's page shouldn't open a fold that holds only their name.
  const livesIn = p.sections.flatMap((s) => (s.type === 'details' ? s.fields : [])).find((f) => f.key === 'lives_in')?.value;
  const inCard = (f: Field) => f.key === 'lives_in' || (f.key === 'preferred_name' && f.value === p.displayName);
  const folds = p.sections
    .map((s) => (s.type === 'details' ? { ...s, fields: s.fields.filter((f) => !inCard(f)) } : s))
    .filter((s): s is Exclude<ViewSection, { type: 'about' }> => s.type !== 'about' && (s.type !== 'details' || s.fields.length > 0));

  return (
    <div className={`pp${compact ? ' pp-compact' : ''}`} style={{ display: 'grid', gap: compact ? 10 : 14, maxWidth: 640 }}>
      <div className="card" style={{ padding: h.pad, gap: compact ? 12 : 16 }}>
        <div style={{ display: 'flex', gap: compact ? 12 : 18, alignItems: 'center' }}>
          <Portrait name={p.displayName} url={p.avatarUrl} size={h.photo} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: h.name, margin: 0, lineHeight: 1.05 }}>{p.displayName}</h1>
            {p.headline && <p style={{ fontSize: h.head, margin: '4px 0 0', textWrap: 'pretty' }}>{p.headline}</p>}
            {livesIn && <p className="text-muted" style={{ fontSize: h.head - 2, margin: '4px 0 0', display: 'flex', gap: 5, alignItems: 'center' }}><ContactIcon kind="postal" size={h.head - 2} />{livesIn}</p>}
          </div>
        </div>
        {about.map((s, i) => <p key={i} style={{ fontSize: h.body, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0, maxWidth: '58ch', textWrap: 'pretty' }}>{s.text}</p>)}
        {actions && <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</div>}
      </div>

      {folds.map((s, i) => (
        <details key={i} className="card pp-fold">
          <summary>
            <Mono d={{ label: s.type === 'details' ? 'Personal details' : s.title, group: s.type === 'domain' ? s.group ?? 'work' : s.type === 'details' ? 'identity' : 'work' }} size={h.fold} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600, fontSize: compact ? 13 : 15 }}>{s.type === 'details' ? 'Personal details' : s.title}</span>
              <span className="text-muted" style={{ display: 'block', fontSize: compact ? 11 : 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sectionSummary(s)}</span>
            </span>
            <span className="pp-chev" aria-hidden>›</span>
          </summary>
          <div className="pp-fold-inner">
            {s.type === 'details' && (
              <div className="pp-grid2">
                {s.fields.map((f) => <div key={f.key} style={{ fontSize: compact ? 12 : 14 }}><span className="text-muted" style={{ display: 'block', fontSize: compact ? 11 : 12 }}>{f.label}</span>{f.value}</div>)}
              </div>
            )}

            {s.type === 'domain' && s.items.every((it) => it.contact) && (
              <div style={{ display: 'grid', gap: 2 }}>
                {s.items.map(({ id, contact: c }) => {
                  const row = <><ContactIcon kind={c!.kind} size={compact ? 15 : 18} /><span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: compact ? 12 : 14 }}>{c!.value}</span><span className="text-muted" style={{ fontSize: compact ? 11 : 12 }}>{c!.label}</span></>;
                  return c!.href
                    ? <a key={id} className="pp-contact" href={c!.href} target={c!.kind === 'email' || c!.kind === 'phone' ? undefined : '_blank'} rel="noopener noreferrer">{row}</a>
                    : <div key={id} className="pp-contact">{row}</div>;
                })}
              </div>
            )}

            {s.type === 'domain' && !s.items.every((it) => it.contact) && (
              <div style={{ display: 'grid', gap: compact ? 12 : 18, position: 'relative', paddingLeft: s.dated ? (compact ? 16 : 22) : 0 }}>
                {s.dated && <div aria-hidden style={{ position: 'absolute', left: compact ? 4 : 6, top: 8, bottom: 8, width: 2, background: 'var(--color-neutral-300)', borderRadius: 2 }} />}
                {s.items.map((it) => {
                  const long = it.fields.filter((f) => f.type === 'longtext');
                  const short = it.fields.filter((f) => f.type !== 'longtext');
                  return (
                    <div key={it.id} style={{ position: 'relative' }}>
                      {s.dated && <span aria-hidden style={{ position: 'absolute', left: compact ? -16 : -22, top: compact ? 5 : 7, width: compact ? 10 : 14, height: compact ? 10 : 14, borderRadius: '50%', background: it.current ? 'var(--color-accent)' : 'var(--color-bg)', border: '2px solid var(--color-accent)' }} />}
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: compact ? 14 : 18, lineHeight: 1.25 }}>{it.title}</div>
                      {(it.validFrom || it.validTo) && <div className="text-muted" style={{ fontSize: compact ? 11 : 13 }}>{fmtRange(it.validFrom, it.validTo)}{it.validFrom ? ` · ${duration(it.validFrom, it.validTo)}` : ''}</div>}
                      {short.length > 0 && <div style={{ fontSize: compact ? 12 : 14, marginTop: 2 }}>{short.map((f) => f.value).join(' · ')}</div>}
                      {long.map((f) => <p key={f.key} style={{ fontSize: compact ? 12 : 14, margin: '6px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.55, maxWidth: '62ch' }}>{f.value}</p>)}
                    </div>
                  );
                })}
              </div>
            )}

            {s.type === 'resume' && (
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="bare" aria-label={`View ${s.document.title}`} onClick={() => setViewing(s.document.pages)}><Thumb page={s.document.pages[0]} url={s.document.pages[0].url} size={compact ? 44 : 60} /></button>
                <div style={{ flex: 1, minWidth: 120, fontWeight: 600, fontSize: compact ? 13 : 15 }}>{s.document.title}</div>
                <button className="btn btn-secondary" style={{ fontSize: compact ? 12 : 14 }} onClick={() => setViewing(s.document.pages)}>View</button>
                <a className="btn btn-primary" style={{ fontSize: compact ? 12 : 14 }} href={`${s.document.pages[0].url}?download=1`}>Download</a>
              </div>
            )}
          </div>
        </details>
      ))}

      {!about.length && !folds.length && <p className="text-muted" style={{ margin: '8px 0 0', fontSize: compact ? 13 : undefined }}>Nothing else here is public yet.</p>}
      {viewing && <Lightbox title={p.displayName} pages={viewing} urlFor={(x) => (x as Page).url} onClose={() => setViewing(null)} />}
    </div>
  );
}
