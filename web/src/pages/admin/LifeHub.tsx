import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, type ProfileLine as Field } from '../../api';
import { ErrorNote, Loading, useAsync } from '../../ui';
import { fetchCatalog, fmtDate, groupOf, Lock, Mono, Section, useGrouped, type Domain } from '../../life';

type Attention = { domain: string; domainLabel: string; id: string; title: string; part: string; date: string; expired: boolean };

export default function LifeHub() {
  const nav = useNavigate();
  // Relationships live on each person's page, tasks in the action bar, events on the Calendar, notes on their own page and Birth on Profile basics (its Born line), not here.
  const { data: domains, error } = useAsync(() => fetchCatalog().then((ds) => ds.filter((d) => !d.livesOn)), []);
  const { data: fields } = useAsync(() => get<{ items: Field[] }>('/api/profile'), []);
  const { data: attention } = useAsync(() => get<{ items: Attention[] }>('/api/attention'), []);
  const { data: timeline } = useAsync(() => get<{ items: { validFrom: string }[] }>('/api/timeline'), []);
  const [q, setQ] = useState('');
  const grouped = useGrouped(domains?.filter((d) => !q || `${d.label} ${d.description}`.toLowerCase().includes(q.toLowerCase())));

  if (error) return <ErrorNote error={error} />;
  if (!domains) return <Loading />;

  const started = domains.filter((d) => d.count > 0).length;
  const entries = domains.reduce((n, d) => n + d.count, 0);
  const filled = fields?.items.filter((f) => !!f.value).length ?? 0;
  const years = timeline?.items.length ? new Date().getFullYear() - +timeline.items[timeline.items.length - 1].validFrom.slice(0, 4) : 0;
  const core = fields?.items.filter((f) => ['preferred_name', 'legal_name', 'born', 'lives_in'].includes(f.key)) ?? [];

  return (
    <div data-screen-label="My data" style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>My data</h1>
          <p className="text-muted" style={{ margin: 0, maxWidth: 640 }}>Everything about you, kept in one place. Only you see this page. You choose, category by category, what each contact and each app can see.</p>
        </div>
        <input className="input" aria-label="Find a category" placeholder="Find a category" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
      </div>

      {!q && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))', gap: 18, marginTop: 26 }}>
          <Link to="/admin/life/profile" className="card" style={{ padding: '22px 24px', gap: 10, textDecoration: 'none', color: 'inherit' }}>
            <div className="card-kicker">Profile basics</div>
            <div className="card-title" style={{ fontSize: 22 }}>{core.find((f) => f.key === 'preferred_name')?.value || core.find((f) => f.key === 'legal_name')?.value || 'Your name'}</div>
            <div className="card-body">{filled} core facts · your basic profile and public page are built from these</div>
          </Link>
          <Link to="/admin/lifestream" className="card" style={{ padding: '22px 24px', gap: 10, textDecoration: 'none', color: 'inherit', background: 'var(--color-accent-2-100)', position: 'relative', overflow: 'hidden' }}>
            <div className="card-kicker" style={{ color: 'var(--color-accent-2-800)' }}>Lifestream</div>
            <div className="card-title" style={{ fontSize: 22 }}>{timeline?.items.length ? `${timeline.items.length} moments${years ? ` across ${years} years` : ''}` : 'Your story starts here'}</div>
            <div className="card-body">Homes, jobs, schools and milestones, laid out in order. Background checks and applications ask for exactly this.</div>
            <TimelineSpark n={timeline?.items.length ?? 0} />
          </Link>
          <div className="card" style={{ padding: '22px 24px', gap: 10, background: attention?.items.length ? 'var(--color-accent-100)' : undefined }}>
            <div className="card-kicker">Coming up</div>
            {attention?.items.length ? attention.items.slice(0, 3).map((a) => (
              <button key={a.id + a.part} className="bare" onClick={() => nav(`/admin/life/${a.domain}`)} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.expired ? 'var(--color-accent-700)' : 'var(--color-accent-400)', flex: 'none' }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 14 }}><strong style={{ fontWeight: 600 }}>{a.title}</strong><span className="text-muted"> · {a.part.toLowerCase()} {fmtDate(a.date)}</span></span>
                {a.expired && <span className="tag tag-accent">Expired</span>}
              </button>
            )) : <div className="card-body">Nothing expires in the next six months. Add expiry dates to IDs, licenses and registrations and they’ll show up here.</div>}
          </div>
        </div>
      )}

      {!q && (
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center', marginTop: 22, fontSize: 13 }} className="text-muted">
          <span><strong style={{ color: 'var(--color-text)' }}>{started}</strong> of {domains.length} categories started</span>
          <span><strong style={{ color: 'var(--color-text)' }}>{entries}</strong> entries</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Lock style={{ color: 'var(--color-accent-700)' }} /> Secret details are encrypted and never leave without your confirmation</span>
        </div>
      )}

      {grouped.map(({ g, items }) => (
        <Section key={g.id} title={g.label} blurb={g.blurb} ink={g.ink}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,240px),1fr))', gap: 14 }}>
            {items.map((d) => <Tile key={d.id} d={d} />)}
          </div>
        </Section>
      ))}
    </div>
  );
}

function Tile({ d }: { d: Domain }) {
  const g = groupOf(d.group);
  const empty = d.count === 0;
  return (
    <Link to={`/admin/life/${d.id}`} className="card" style={{ padding: '18px 20px', gap: 10, textDecoration: 'none', color: 'inherit', minHeight: 132, background: empty ? 'transparent' : 'var(--color-surface)', border: empty ? '1.5px dashed var(--color-neutral-300)' : '1.5px solid transparent', transition: 'transform .15s' }}
      onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-2px)')} onMouseLeave={(e) => (e.currentTarget.style.transform = '')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Mono d={d} size={38} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, lineHeight: 1.15, display: 'flex', alignItems: 'center', gap: 6 }}>
            {d.label}{d.sensitivity === 'secret' && <Lock style={{ color: 'var(--color-accent-700)' }} />}
          </div>
          <div className="text-muted" style={{ fontSize: 12 }}>{empty ? 'Not started' : `${d.count} ${d.count === 1 ? d.noun : plural(d.noun)}${d.currentCount && d.currentCount !== d.count ? ` · ${d.currentCount} current` : ''}`}</div>
        </div>
      </div>
      {empty && (
        <div style={{ fontSize: 13, color: 'var(--color-neutral-600)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{d.description}</div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }}>
        {d.sharedWith > 0 && <span className="tag tag-accent-2">Shared with {d.sharedWith}</span>}
        {empty && <span style={{ fontSize: 12, color: g.ink, fontWeight: 600 }}>Add {/^[aeiou]/i.test(d.noun) ? 'an' : 'a'} {d.noun} →</span>}
      </div>
    </Link>
  );
}

export const plural = (n: string) => (/(s|x|ch|sh)$/.test(n) ? `${n}es` : /[^aeiou]y$/.test(n) ? `${n.slice(0, -1)}ies` : /^(ID)$/.test(n) ? 'IDs' : `${n}s`);

/** Decorative dots that hint at a line of life events. */
function TimelineSpark({ n }: { n: number }) {
  const dots = Math.min(Math.max(n, 3), 12);
  return (
    <div aria-hidden style={{ position: 'relative', height: 16, marginTop: 4 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 7, height: 2, background: 'var(--color-accent-2-300)', borderRadius: 2 }} />
      {Array.from({ length: dots }, (_, i) => (
        <span key={i} style={{ position: 'absolute', top: 3, left: `${(i / (dots - 1)) * 96}%`, width: 10, height: 10, borderRadius: '50%', background: i < n ? 'var(--color-accent-2-600)' : 'var(--color-accent-2-200)', border: '2px solid var(--color-accent-2-100)' }} />
      ))}
    </div>
  );
}
