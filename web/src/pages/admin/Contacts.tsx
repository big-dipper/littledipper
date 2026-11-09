import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ago, displayMethod, get, initials, post, STATUS, type Party as Contact } from '../../api';
import { ErrorNote, Loading, Pills, useAction, useAsync } from '../../ui';
import { useAdmin } from './Layout';
import AddContact from './AddContact';
import { fetchCatalog, type Rec } from '../../life';
import BigDipperBanner from './BigDipperBanner';

type Req = { _id: string; contactId: string; peerName: string; fromNode: string; requestedFields: string[]; inviteId: string | null };

export const shareSummary = (c: Contact) => {
  if (!c.node) return '—';
  if (c.status === 'pending_in') return 'Not yet';
  const n = c.share.lines.length + Object.keys(c.share.categories).length + c.share.entries.length;
  return c.share.basic ? (n ? `Basic profile + ${n}` : 'Basic profile') : n ? `${n} item${n === 1 ? '' : 's'} only` : 'Nothing';
};

export default function Contacts() {
  const nav = useNavigate();
  const { refresh } = useAdmin();
  const { run } = useAction();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'node' | 'person' | 'organisation'>('all');
  // ?connect=<invite or address>: someone's invite, opened from their page or after setup, ready to send.
  const [params, setParams] = useSearchParams();
  const [connect] = useState(() => params.get('connect') || '');
  const [modal, setModal] = useState<null | 'person' | 'node' | 'invite'>(connect ? 'node' : null);
  const { data, error, reload } = useAsync(() => get<{ items: Contact[] }>('/api/parties'), []);
  // How you know each person (spouse, reference…), from the Relationships entries that point to them.
  const { data: rels } = useAsync(async () => {
    const [{ items }, catalog] = await Promise.all([get<{ items: Rec[] }>('/api/data/relationships'), fetchCatalog()]);
    const opts = catalog.find((d) => d.id === 'relationships')?.parts.find((p) => p.key === 'relation')?.options ?? [];
    const by = new Map<string, string[]>();
    for (const r of items) if (r.current) by.set(String(r.data.party), [...(by.get(String(r.data.party)) ?? []), opts.find(([k]) => k === r.data.relation)?.[1] ?? String(r.data.relation)]);
    return by;
  }, []);
  const { data: reqs, reload: reloadReqs } = useAsync(() => get<{ items: Req[] }>('/api/federation/requests?status=pending&direction=in'), []);

  if (error) return <ErrorNote error={error} />;
  const term = q.toLowerCase();
  const names = new Map((data?.items || []).map((c) => [c.id, c.name]));
  const worksAt = (c: Contact) => c.affiliations.map((a) => names.get(a.party)).filter(Boolean).join(', ');
  const rows = (data?.items || []).filter((c) => (filter === 'all' || (filter === 'node' ? !!c.node : c.type === filter)) && (!term || c.name.toLowerCase().includes(term) || worksAt(c).toLowerCase().includes(term)));

  const decline = async (r: Req) => {
    if (await run(() => post(`/api/federation/requests/${r._id}/decline`), 'Request declined')) {
      reload(); reloadReqs(); refresh();
    }
  };

  return (
    <div data-screen-label="Relationships" style={{ maxWidth: 1040 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>Relationships</h1><p className="text-muted" style={{ margin: 0 }}>People who also run Little Dipper can connect with you securely. You choose exactly what each of them can see.</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setModal('invite')}>Invite link</button>
          <button className="btn btn-primary" onClick={() => setModal('person')}>Add someone</button>
        </div>
      </div>

      <BigDipperBanner />

      {reqs?.items.map((r) => (
        <div key={r._id} style={{ marginTop: 22, borderRadius: 32, background: 'var(--color-accent-100)', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--color-accent-300)', display: 'grid', placeItems: 'center', fontSize: 13, flex: 'none' }}>{initials(r.peerName)}</span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 600 }}>{r.peerName} wants to connect</div>
            <div style={{ fontSize: 13, color: 'var(--color-accent-800)' }}>
              <span className="mono">{r.fromNode}</span>
              {r.requestedFields.length > 0 && ` · asks for ${r.requestedFields.length} field${r.requestedFields.length === 1 ? '' : 's'}`}
              {r.inviteId ? ' · used your invite link' : ''} · identity confirmed
            </div>
          </div>
          <button className="btn btn-secondary" onClick={() => decline(r)}>Decline</button>
          <button className="btn btn-primary" onClick={() => nav(`/admin/relationships/${r.contactId}`)}>Review request</button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '24px 0 12px', flexWrap: 'wrap' }}>
        <input className="input" aria-label="Search relationships" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <Pills value={filter} options={[['all', 'All'], ['node', 'On Little Dipper'], ['person', 'People'], ['organisation', 'Organisations']]} onChange={setFilter} />
      </div>
      {!data ? <Loading /> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Name</th><th>Relationship</th><th>Status</th><th>You share</th><th>Last activity</th></tr></thead>
            <tbody>
              {rows.map((c) => {
                const sub = c.node ? c.node.url : worksAt(c) || (c.methods[0] ? displayMethod(c.methods[0]) : '');
                return (
                  <tr key={c.id} className="row-btn" tabIndex={0} onClick={() => nav(`/admin/relationships/${c.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/admin/relationships/${c.id}`)}>
                    <td><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ width: 34, height: 34, borderRadius: '50%', background: c.node ? 'var(--color-accent-2-200)' : 'var(--color-accent-200)', display: 'grid', placeItems: 'center', fontSize: 12, flex: 'none' }}>{initials(c.name)}</span>
                      <div><div style={{ fontWeight: 600 }}>{c.name}</div><div className="text-muted" style={{ fontSize: 12, fontFamily: c.node ? 'var(--mono)' : 'inherit' }}>{sub}</div></div>
                    </div></td>
                    <td><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {(rels?.get(c.id) ?? [c.type === 'organisation' ? 'Organisation' : 'Person']).map((l) => <span key={l} className="tag tag-neutral">{l}</span>)}
                      {c.node && <span className="tag tag-accent-2">Little Dipper</span>}
                    </div></td>
                    <td><span className={`tag ${STATUS[c.status][1]}`}>{STATUS[c.status][0]}</span></td>
                    <td style={{ fontSize: 13 }}>{shareSummary(c)}</td>
                    <td className="text-muted" style={{ fontSize: 13 }}>{c.lastActivity.text} · {ago(c.lastActivity.at)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={5} className="text-muted" style={{ fontSize: 14, padding: '18px 8px' }}>{data.items.length ? 'No one matches.' : 'No one here yet. Add someone, or send an invite link.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {modal && <AddContact initialTab={modal} initialAddress={modal === 'node' ? connect : undefined} onClose={() => { setModal(null); if (params.has('connect')) setParams({}, { replace: true }); }} onDone={(id) => { setModal(null); reload(); if (id) nav(`/admin/relationships/${id}`); }} />}
    </div>
  );
}
