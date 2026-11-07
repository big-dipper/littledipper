import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, type AuditEvent } from '../../api';
import { ErrorNote, Loading, useAsync } from '../../ui';

const TONE = { peer: 'var(--color-accent-2)', request: 'var(--color-accent)', owner: 'var(--color-neutral-500)', system: 'var(--color-neutral-500)' };
const PAGE = 100;

/**
 * The activity log: everything that happened on your Little Dipper, including what you did yourself. Home shows only
 * what happened without you; this is the full record, for when you want to know who touched what, and when.
 */
export default function Activity() {
  const { data, error } = useAsync(() => get<{ items: AuditEvent[] }>(`/api/audit?limit=${PAGE}`), []);
  const [more, setMore] = useState<AuditEvent[]>([]);
  const [end, setEnd] = useState(false);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const items = [...data.items, ...more];
  const loadMore = async () => {
    const next = (await get<{ items: AuditEvent[] }>(`/api/audit?limit=${PAGE}&before=${encodeURIComponent(items[items.length - 1].at)}`)).items;
    setMore([...more, ...next]);
    if (next.length < PAGE) setEnd(true);
  };
  let day = '';
  return (
    <div data-screen-label="Activity log" style={{ maxWidth: 760 }}>
      <Link className="btn btn-ghost" to="/admin/settings" style={{ marginBottom: 14 }}>← Settings</Link>
      <h1>Activity log</h1>
      <p className="text-muted" style={{ margin: '0 0 18px' }}>Everything that happened on your Little Dipper: what you did, what people and assistants read or changed, and when.</p>
      {items.map((a) => {
        const d = new Date(a.at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const head = d !== day ? (day = d) : null;
        return (
          <div key={a._id}>
            {head && <div className="card-kicker" style={{ margin: '18px 0 2px' }}>{head}</div>}
            <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--color-divider)', alignItems: 'flex-start' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 7, flex: 'none', background: TONE[a.tone] }} />
              <div style={{ flex: 1, fontSize: 14 }}>{a.text}</div>
              <span className="text-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
            </div>
          </div>
        );
      })}
      {!items.length && <p className="text-muted">Nothing yet.</p>}
      {items.length >= PAGE && !end && <button className="btn btn-secondary" onClick={loadMore} style={{ marginTop: 16 }}>Show earlier</button>}
    </div>
  );
}
