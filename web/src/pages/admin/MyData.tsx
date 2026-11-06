import { Link } from 'react-router-dom';
import { get, LINE_SOURCE, SENS, type ProfileResp } from '../../api';
import { ErrorNote, Loading, useAsync } from '../../ui';

/**
 * Profile basics: your current facts, worked out from your categories. Nothing is typed here: each line links to the
 * entry it comes from, so a fact is changed in one place and the profile, your account name and your public page follow.
 */
export default function MyData() {
  const { data, error } = useAsync(() => get<ProfileResp>('/api/profile'), []);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const byKey = new Map(data.items.map((l) => [l.key, l]));

  return (
    <div data-screen-label="My data" style={{ maxWidth: 960 }}>
      <Link className="btn btn-ghost" to="/admin/life" style={{ marginBottom: 14 }}>← My data</Link>
      <h1>Profile basics</h1>
      <p className="text-muted" style={{ margin: 0, maxWidth: 620 }}>Your current facts, kept up to date from your categories. Change a fact where it lives and it updates here. Your basic profile (what every connection sees) is the lines marked Standard.</p>
      <div className="text-muted" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '18px 0 8px', fontSize: 12 }}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="tag tag-neutral">Standard</span>in your basic profile</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="tag tag-accent-2">Sensitive</span>only where you share it</span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="tag tag-accent">Secret</span>never leaves your Little Dipper</span>
      </div>
      <div className="card" style={{ padding: '6px 24px', marginTop: 12 }}>
        {data.lines.map(({ key, label }) => {
          const l = byKey.get(key);
          const [domain, source] = LINE_SOURCE[key] ?? ['', ''];
          // Birth name only appears when it differs from today's legal name; no prompt for it.
          if (!l && key === 'birth_name') return null;
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 0', borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap' }}>
              <div style={{ width: 190, flex: 'none' }} className="text-muted">{label}</div>
              <div style={{ flex: 1, minWidth: 200, fontSize: 15, overflowWrap: 'anywhere' }}>{l ? l.value : <span className="text-muted">Not added</span>}</div>
              {l && <span className={`tag ${SENS[l.sensitivity][1]}`}>{SENS[l.sensitivity][0]}</span>}
              {l?.public && <span className="tag tag-neutral">Public</span>}
              {!!l?.sharedWith && <span className="text-muted" style={{ fontSize: 12 }}>{l.sharedWith} can see</span>}
              {domain && <Link className="btn btn-ghost" style={{ fontSize: 13 }} to={`/admin/life/${domain}`}>{l ? `Edit in ${source}` : `Add in ${source}`}</Link>}
            </div>
          );
        })}
      </div>
      <p className="text-muted" style={{ fontSize: 13, marginTop: 14 }}>Want to keep something else? Add a category in My data: it can hold a single detail.</p>
    </div>
  );
}
