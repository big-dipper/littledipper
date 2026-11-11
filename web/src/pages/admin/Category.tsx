import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { get, longDate, post, SENS } from '../../api';
import { ErrorNote, Loading, useAction, useAsync } from '../../ui';
import { byWhom, Details, duration, EntryCard, fetchCatalog, fmtRange, groupOf, Lock, money, Mono, RecordEditor, useContactsLite, type ContactLite, type Domain, type Rec, type Version } from '../../life';
import { plural } from './LifeHub';
import { CopyList, SendCopy } from './Copies';


/** A sentence that explains why a category is worth filling in. */
const WHY: Record<string, string> = {
  residences: 'Rental applications, background checks and government forms ask for 5–10 years of addresses.',
  employment: 'Job applications, loans and clearance forms all want your work history with dates and supervisors.',
  ids: 'Keep every number and expiry date in one place. You’ll get a heads-up before anything expires.',
  education: 'Degrees and dates for applications and your résumé.',
  health: 'Allergies, medications and directives, ready for a new doctor or an emergency.',
  insurance: 'Policy and member numbers when you need to file a claim.',
  relationships: 'The people closest to you, and who to call in an emergency.',
  contact_methods: 'Every way to reach you. Your primary email and phone show in your profile.',
  preferences: 'Sizes, tastes and habits: what lets an assistant actually help.',
  travel: 'Visa and clearance applications ask where you’ve been and when.',
};

type Money = { amount: number; currency: string };

/** Sums per currency of one money part, each entry weighted (a payment in euros isn't added to dollars). */
function sums(recs: [Rec, number][], key: string): Money[] {
  const by = new Map<string, number>();
  for (const [r, w] of recs) { const m = r.data[key] as Money | undefined; if (m?.currency && w > 0) by.set(m.currency, (by.get(m.currency) ?? 0) + m.amount * w); }
  return [...by].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
}
const sumText = (ms: Money[]) => (ms.length ? ms.map(money).join(' + ') : 'Nothing yet');

/** Income at a glance: this year so far and the last 12 months, worked out from the payments. */
function IncomeTotals({ items }: { items: Rec[] }) {
  const now = new Date();
  const yearStart = `${now.getFullYear()}-01-01`;
  const yearAgo = new Date(now.getTime() - 365 * 86400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const day = (v: string) => Date.parse(`${v}T00:00:00Z`) / 86400_000;
  // The share of an entry inside the window: a W-2 for all of last year counts only for the months that overlap.
  // Without a period, the payment counts in full on the day it was received.
  const share = (r: Rec, from: string) => {
    const a = r.data.periodStart as string | undefined, b = r.data.periodEnd as string | undefined;
    if (a?.length === 10 && b?.length === 10 && b >= a) {
      const overlap = Math.min(day(b), day(today)) - Math.max(day(a), day(from)) + 1;
      return Math.max(0, overlap) / (day(b) - day(a) + 1);
    }
    return String(r.data.received ?? '') >= from ? 1 : 0;
  };
  const tiles: [string, [Rec, number][]][] = [yearStart, yearAgo].map((from, i) => [i ? 'Last 12 months' : 'This year so far', items.map((r) => [r, share(r, from)] as [Rec, number]).filter(([, w]) => w > 0)]);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 22 }}>
      {tiles.map(([label, recs]) => (
        <div key={label} className="card" style={{ padding: '18px 22px', gap: 4 }}>
          <div className="card-kicker">{label}</div>
          <div className="card-title" style={{ fontSize: 24 }}>{sumText(sums(recs, 'amount'))}</div>
          <div className="text-muted" style={{ fontSize: 12 }}>{recs.length} payment{recs.length === 1 ? '' : 's'}{recs.some(([, w]) => w < 1) ? ', some in part' : ''}{sums(recs, 'gross').length ? ` · ${sumText(sums(recs, 'gross'))} gross where known` : ''}</div>
        </div>
      ))}
    </div>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const signed = (m: Money, dir: string) => `${dir === 'in' ? '+' : dir === 'out' ? '−' : ''}${money(m)}`;

/**
 * The master ledger: every transaction as one line, newest first, a heading per month with what came in and went out.
 * Not a bank: no balances, just the story of where money came from and went.
 */
function Ledger({ d, items, contacts, onEdit }: { d: Domain; items: Rec[]; contacts: ContactLite[]; onEdit: (r: Rec) => void }) {
  const { data: accts } = useAsync(() => get<{ items: Rec[] }>('/api/data/financial_accounts'), []);
  const [dir, setDir] = useState('all');
  const acct = (id: unknown) => (accts?.items.find((a) => a.id === id)?.title ?? '');
  const who = (id: unknown) => contacts.find((c) => c.id === id)?.name ?? '';
  const label = (key: string, v: unknown) => d.parts.find((p) => p.key === key)?.options?.find(([k]) => k === v)?.[1] ?? '';
  const rows = items.filter((r) => dir === 'all' || r.data.direction === dir)
    .sort((a, b) => String(b.data.date ?? '').localeCompare(String(a.data.date ?? '')));
  const months = [...rows.reduce((m, r) => m.set(String(r.data.date ?? '').slice(0, 7), [...(m.get(String(r.data.date ?? '').slice(0, 7)) ?? []), r]), new Map<string, Rec[]>())];
  const tot = (list: Rec[], which: string) => { const t = sums(list.filter((r) => r.data.direction === which).map((r) => [r, 1]), 'amount'); return t.length ? t.map(money).join(' + ') : '—'; };
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
        {(['in', 'out'] as const).map((w) => (
          <div key={w} className="card" style={{ padding: '18px 22px', gap: 4 }}>
            <div className="card-kicker">{w === 'in' ? 'Money in' : 'Money out'}</div>
            <div className="card-title" style={{ fontSize: 24 }}>{tot(items, w)}</div>
            <div className="text-muted" style={{ fontSize: 12 }}>{items.filter((r) => r.data.direction === w).length} transactions shown</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '18px 0 6px' }}>
        {[['all', 'All'], ['in', 'Money in'], ['out', 'Money out'], ['transfer', 'Transfers']].map(([k, l]) => (
          <button key={k} className={`btn ${dir === k ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: 12, padding: '6px 14px' }} onClick={() => setDir(k)}>{l}</button>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>Date</th><th>With</th><th>What for</th><th>Account</th><th>How</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
          <tbody>
            {months.map(([ym, list]) => [
              <tr key={ym}>
                <td colSpan={6} style={{ paddingTop: 18, borderBottom: '1px solid var(--color-divider)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <strong>{ym ? `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : 'No date'}</strong>
                    <span className="text-muted" style={{ fontSize: 12 }}>In {tot(list, 'in')} · Out {tot(list, 'out')}</span>
                  </div>
                </td>
              </tr>,
              ...list.map((r) => {
                const m = r.data.amount as Money | undefined;
                const di = String(r.data.direction ?? '');
                return (
                  <tr key={r.id} className="row-btn" tabIndex={0} onClick={() => onEdit(r)} onKeyDown={(e) => e.key === 'Enter' && onEdit(r)} style={{ cursor: 'pointer' }}>
                    <td style={{ whiteSpace: 'nowrap' }}>{String(r.data.date ?? '').slice(8, 10)} {MONTHS[Number(String(r.data.date ?? '').slice(5, 7)) - 1]?.slice(0, 3)}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{di === 'transfer' ? 'Transfer' : who(r.data.counterparty) || '—'}</div>
                      {(r.data.description || r.data.entry) ? <div className="text-muted" style={{ fontSize: 12 }}>{[r.data.description as string, r.data.entry ? 'has details' : ''].filter(Boolean).join(' · ')}</div> : null}
                    </td>
                    <td>{label('category', r.data.category) || <span className="text-muted">—</span>}</td>
                    <td style={{ fontSize: 13 }}>{di === 'transfer' ? `${acct(r.data.account) || '?'} → ${acct(r.data.toAccount) || '?'}` : acct(r.data.account) || <span className="text-muted">—</span>}</td>
                    <td style={{ fontSize: 13 }}>{label('method', r.data.method).replace(/\s*\(.*\)$/, '') || <span className="text-muted">—</span>}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: di === 'in' ? 'var(--color-accent-2-700)' : 'inherit' }}>{m ? signed(m, di) : '—'}</td>
                  </tr>
                );
              }),
            ])}
          </tbody>
        </table>
        {!rows.length && <div className="text-muted" style={{ fontSize: 13, padding: '12px 0' }}>Nothing matches.</div>}
      </div>
    </div>
  );
}

export default function Category() {
  const { domain = '' } = useParams();
  const contacts = useContactsLite();
  const { data: catalog, reload: reloadCatalog } = useAsync(fetchCatalog, []);
  const { data, error, reload } = useAsync(() => get<{ items: Rec[] }>(`/api/data/${domain}`), [domain]);
  const { data: deleted, reload: reloadDeleted } = useAsync(() => get<{ items: Version[]; keepDays: number }>(`/api/data/${domain}/deleted`), [domain]);
  const { run } = useAction();
  const [editing, setEditing] = useState<Rec | 'new' | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(0);
  // A relationship's "Between you" links here searched for them.
  const [params] = useSearchParams();
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const [year, setYear] = useState('all');

  const d = catalog?.find((x) => x.id === domain);
  if (error) return <div><Link className="btn btn-ghost" to="/admin/life">← My data</Link><ErrorNote error={error} /></div>;
  if (!d || !data) return <Loading />;
  const g = groupOf(d.group);
  // Long lists (payments, receipts) get a search box and, when entries have a date, a year filter.
  const searchable = data.items.length > 5 || !!q;
  const yearOf = (r: Rec) => String((d.sortBy && r.data[d.sortBy]) ?? r.validFrom ?? '').slice(0, 4);
  const years = d.sortBy ? [...new Set(data.items.map(yearOf).filter(Boolean))].sort().reverse() : [];
  const needle = q.trim().toLowerCase();
  const shown = data.items.filter((r) => (year === 'all' || yearOf(r) === year) && (!needle || r.title.toLowerCase().includes(needle) || JSON.stringify(r.data).toLowerCase().includes(needle) || (r.notes ?? '').toLowerCase().includes(needle)));
  const current = d.dated ? shown.filter((r) => r.current) : shown;
  const past = d.dated ? shown.filter((r) => !r.current) : [];
  const done = () => { setEditing(null); reload(); reloadCatalog(); reloadDeleted(); };
  const bringBack = async (v: Version) => { if (await run(() => post(`/api/data/${d.id}/${v.record.id}/history/${v.version}/restore`))) done(); };

  return (
    <div data-screen-label={d.label} style={{ maxWidth: 980 }}>
      <Link className="btn btn-ghost" to="/admin/life" style={{ marginBottom: 14 }}>← My data</Link>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <Mono d={d} size={64} />
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="card-kicker" style={{ color: g.ink }}>{g.label}</div>
          <h1 style={{ margin: 0 }}>{d.label}</h1>
          <p className="text-muted" style={{ margin: '4px 0 0', maxWidth: 620 }}>{d.description}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {data.items.length > 0 && <button className="btn btn-secondary" onClick={() => setSending(true)}>Send a copy</button>}
          {/* A one-entry category (Birth, Health basics) is edited, never added to, once it has its entry. */}
          {!(d.single && data.items.length > 0) && <button className="btn btn-primary" onClick={() => setEditing('new')}>Add {/^[aeiou]/i.test(d.noun) ? 'an' : 'a'} {d.noun}</button>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '18px 0 6px' }}>
        <span className={`tag ${SENS[d.sensitivity][1]}`} style={{ gap: 4 }}>{d.sensitivity === 'secret' && <Lock style={{ width: 8, height: 9 }} />}{SENS[d.sensitivity][0]}</span>
        <span className="tag tag-neutral">{d.sharedWith ? `Shared with ${d.sharedWith} contact${d.sharedWith === 1 ? '' : 's'}` : 'Not shared with anyone'}</span>
      </div>

      {d.id === 'income' && data.items.length > 0 && <IncomeTotals items={data.items} />}

      {searchable && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 22 }}>
          <input className="input" type="search" placeholder={`Search ${plural(d.noun)}…`} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px', maxWidth: 360 }} />
          {years.length > 1 && <select className="input" value={year} onChange={(e) => setYear(e.target.value)} style={{ width: 'auto' }} aria-label="Year">
            <option value="all">All years</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>}
          {(needle || year !== 'all') && <span className="text-muted" style={{ fontSize: 13 }}>{shown.length} of {data.items.length}</span>}
        </div>
      )}

      {d.id === 'transactions' && data.items.length > 0 ? <Ledger d={d} items={shown} contacts={contacts} onEdit={(r) => setEditing(r)} /> : data.items.length === 0 ? (
        <div className="card" style={{ marginTop: 22, padding: '34px 30px', gap: 10, alignItems: 'flex-start', background: g.wash, position: 'relative', overflow: 'hidden' }}>
          <div aria-hidden style={{ position: 'absolute', right: -60, top: -60, width: 200, height: 200, borderRadius: '50%', background: 'var(--color-neutral-100)', opacity: 0.5 }} />
          <div className="card-title" style={{ fontSize: 22, position: 'relative' }}>No {plural(d.noun)} yet</div>
          <div style={{ fontSize: 14, maxWidth: 520, position: 'relative' }}>{WHY[d.id] ?? d.description}</div>
          <button className="btn btn-primary" style={{ marginTop: 6, position: 'relative' }} onClick={() => setEditing('new')}>Add your first {d.noun}</button>
        </div>
      ) : (
        <>
          {current.length > 0 && (
            <div style={{ marginTop: 22 }}>
              {d.dated && <h4>Current</h4>}
              <div style={{ display: 'grid', gap: 14 }}>
                {current.map((r) => <RecordCard key={r.id} d={d} r={r} contacts={contacts} onEdit={() => setEditing(r)} />)}
              </div>
            </div>
          )}
          {past.length > 0 && (
            <div style={{ marginTop: 30 }}>
              <h4>History</h4>
              <div style={{ position: 'relative', paddingLeft: 26 }}>
                <div aria-hidden style={{ position: 'absolute', left: 7, top: 10, bottom: 10, width: 2, background: 'var(--color-neutral-300)', borderRadius: 2 }} />
                <div style={{ display: 'grid', gap: 14 }}>
                  {past.map((r) => (
                    <div key={r.id} style={{ position: 'relative' }}>
                      <span aria-hidden style={{ position: 'absolute', left: -25, top: 24, width: 14, height: 14, borderRadius: '50%', background: 'var(--color-bg)', border: `3px solid ${g.ink}` }} />
                      <RecordCard d={d} r={r} contacts={contacts} onEdit={() => setEditing(r)} quiet />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {deleted && deleted.items.length > 0 && (
        <div style={{ marginTop: 30 }}>
          <h4>Recently deleted</h4>
          <p className="text-muted" style={{ fontSize: 13, margin: '0 0 10px' }}>Kept for {deleted.keepDays} days, then gone for good. Documents filed only on an entry were deleted with it and don’t come back.</p>
          <div style={{ display: 'grid', gap: 8 }}>
            {deleted.items.map((v) => (
              <div key={v.version} className="card" style={{ padding: '12px 18px', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, background: 'var(--color-neutral-100)' }}>
                <div style={{ flex: 1 }}>
                  <div>{v.record.title}</div>
                  <div className="text-muted" style={{ fontSize: 12 }}>Deleted by {byWhom(v.byLabel)} · {longDate(v.at)}</div>
                </div>
                <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => bringBack(v)}>Bring back</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 30 }}><CopyList query={`domain=${d.id}`} version={sent} heading={<h4>Copies you’ve sent</h4>} /></div>

      {sending && catalog && <SendCopy catalog={catalog} start={d.id} onClose={() => setSending(false)} onSent={() => setSent((n) => n + 1)} />}
      {editing && <RecordEditor d={d} rec={editing === 'new' ? null : editing} contacts={contacts} onClose={() => setEditing(null)} onSaved={done} />}
    </div>
  );
}

function RecordCard({ d, r, contacts, onEdit, quiet }: { d: Domain; r: Rec; contacts: ContactLite[]; onEdit: () => void; quiet?: boolean }) {
  const { run } = useAction();
  const [revealed, setRevealed] = useState<Record<string, unknown> | null>(null);
  const reveal = async () => {
    if (revealed) return setRevealed(null);
    const x = await run(() => post<Rec>(`/api/data/${d.id}/${r.id}/reveal`));
    if (x) setRevealed(x.data);
  };
  const range = fmtRange(r.validFrom, r.validTo);
  return (
    <EntryCard
      title={revealed ? r.title.replace(/•+/g, '…') : r.title} quiet={quiet} fields={[]}
      range={range ? `${range}${r.validFrom ? ` · ${duration(r.validFrom, r.validTo)}` : ''}` : undefined}
      actions={<>
        {r.masked.length > 0 && <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={reveal}>{revealed ? 'Hide' : 'Reveal'}</button>}
        <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={onEdit}>Edit</button>
      </>}>
      <Details d={d} rec={r} revealed={revealed ?? undefined} contacts={contacts} />
      {r.notes && <p className="text-muted" style={{ fontSize: 13, margin: '12px 0 0', whiteSpace: 'pre-wrap' }}>{r.notes}</p>}
    </EntryCard>
  );
}

