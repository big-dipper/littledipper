import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, LINE_SOURCE, put, type ProfileResp } from '../../api';
import { ErrorNote, Loading, Toggle, useAction, useAsync } from '../../ui';
import { fetchCatalog, Lock, RecordEditor, useContactsLite, type Domain, type Rec } from '../../life';
import { itemLabel, loadSharing, RELATION_LABEL, type Relation, type SharingData } from '../../sharing';
import { Dialog } from '../../ui';

/** Lines that stay out of view here: worked out for forms and assistants, but not part of your card. */
const OFF_CARD = new Set(['marital_status']);
/** Lines most people never have; no "Add" prompt for them. */
const RARE = new Set(['birth_name', 'nationality']);

/**
 * Profile basics, as a "Me" card: your facts, grouped by who sees them. "Everyone you're connected with" is your basic
 * profile, a list you edit with the switches; everything else goes only to people you choose, on their page.
 * Tap a fact to change it right here; it's saved where it lives (Names, Residences…), so it's never typed twice.
 */
export default function MyData() {
  const { data, error, reload } = useAsync(() => get<ProfileResp>('/api/profile'), []);
  const { data: catalog } = useAsync(fetchCatalog, []);
  const contacts = useContactsLite();
  const { run } = useAction();
  const [editing, setEditing] = useState<{ d: Domain; rec: Rec | null } | null>(null);

  if (error) return <ErrorNote error={error} />;
  if (!data || !catalog) return <Loading />;
  const byKey = new Map(data.items.map((l) => [l.key, l]));
  const inBasic = new Set(data.basic);
  const basic = data.lines.filter(({ key }) => inBasic.has(key));
  const chosen = data.lines.filter(({ key }) => !inBasic.has(key) && !OFF_CARD.has(key) && (byKey.has(key) || !RARE.has(key)));

  const setBasic = async (key: string, on: boolean) => {
    const keys = data.basic.filter((k) => k !== 'little_dipper');
    const next = on ? [...keys, key] : keys.filter((k) => k !== key);
    if (await run(() => put('/api/profile/basic', { lines: next }), on ? 'Everyone you’re connected with will see it' : 'Only people you choose will see it')) reload();
  };

  /** Open the entry a line comes from, or a new one in its category. */
  const open = async (key: string) => {
    const l = byKey.get(key);
    const [domain] = LINE_SOURCE[key] ?? [];
    const d = catalog.find((x) => x.id === (l?.from[0]?.domain ?? domain));
    if (!d) return;
    const rec = l?.from[0] ? await run(() => get<Rec>(`/api/data/${d.id}/${l.from[0].recordId}`)) : null;
    setEditing({ d, rec: rec || null });
  };

  const row = (key: string, label: string, inBasic: boolean) => {
    const l = byKey.get(key);
    const fixed = key === 'little_dipper';
    const secret = l?.sensitivity === 'secret';
    return (
      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 0', borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap' }}>
        <button className="bare" disabled={fixed} onClick={() => open(key)} style={{ display: 'flex', gap: 14, flex: 1, minWidth: 240, textAlign: 'left', cursor: fixed ? 'default' : 'pointer' }}>
          <span className="text-muted" style={{ width: 170, flex: 'none' }}>{label}</span>
          <span style={{ flex: 1, fontSize: 15, overflowWrap: 'anywhere' }}>{l ? l.value : <span style={{ color: 'var(--color-accent-700)' }}>Add</span>}</span>
        </button>
        {fixed ? <span className="text-muted" style={{ fontSize: 12 }}>Always shared</span>
          : secret ? <span className="text-muted" style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}><Lock />Only you</span>
            : l && <Toggle on={inBasic} label={`${label} for everyone you’re connected with`} onChange={() => setBasic(key, !inBasic)} />}
      </div>
    );
  };

  return (
    <div data-screen-label="My data" style={{ maxWidth: 860 }}>
      <Link className="btn btn-ghost" to="/admin/life" style={{ marginBottom: 14 }}>← My data</Link>
      <h1>Profile basics</h1>
      <p className="text-muted" style={{ margin: 0, maxWidth: 620 }}>Your core facts. Tap one to change it. The switch says whether everyone you’re connected with sees it.</p>

      <div className="card" style={{ padding: '18px 24px 6px', marginTop: 22 }}>
        <div className="card-kicker">Everyone you’re connected with sees</div>
        {basic.map(({ key, label }) => row(key, label, true))}
      </div>

      <div className="card" style={{ padding: '18px 24px 6px', marginTop: 18 }}>
        <div className="card-kicker">Only people you choose</div>
        <div className="text-muted" style={{ fontSize: 12, margin: '4px 0 4px' }}>You pick these for each person, when you connect or later on their page.</div>
        {chosen.map(({ key, label }) => row(key, label, false))}
      </div>

      <Suggestions />

      <p className="text-muted" style={{ fontSize: 13, marginTop: 14 }}>Want to keep something else? Add a category in My data: it can hold a single detail.</p>
      {editing && <RecordEditor d={editing.d} rec={editing.rec} contacts={contacts} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

/** Things a relationship can suggest beyond profile lines, in words. */
const CATEGORY_ITEMS = ['category:employment:current', 'category:residences:current', 'category:education:all', 'category:credentials:all', 'category:events:all'];

/**
 * "Suggestions when you connect": what each relationship pre-ticks when you say who someone is. Only suggestions:
 * you see them ticked and can untick before connecting.
 */
function Suggestions() {
  const [data, setData] = useState<SharingData | null>(null);
  const [editing, setEditing] = useState<{ relation: Relation; items: string[] } | null>(null);
  const { run, busy } = useAction();
  const load = () => loadSharing().then(setData).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);
  if (!data) return null;
  const choices = [...data.profile.lines.map((l) => l.key).filter((k) => !['little_dipper', 'preferred_name', 'marital_status', 'nationality', 'birth_name'].includes(k) && !data.profile.basic.includes(k)), ...CATEGORY_ITEMS];
  const save = async () => {
    if (!editing) return;
    if (await run(() => put('/api/profile/suggestions', { relation: editing.relation, items: editing.items }), 'Suggestions saved')) { setEditing(null); load(); }
  };
  return (
    <div className="card" style={{ padding: '18px 24px 10px', marginTop: 18 }}>
      <div className="card-kicker">Suggestions when you connect</div>
      <div className="text-muted" style={{ fontSize: 12, margin: '4px 0 6px' }}>When you say who someone is, these come pre-ticked. You can always untick them.</div>
      {(Object.keys(RELATION_LABEL) as Relation[]).map((r) => (
        <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0', borderBottom: '1px solid var(--color-divider)' }}>
          <span style={{ width: 130, flex: 'none' }}>{RELATION_LABEL[r]}</span>
          <span className="text-muted" style={{ flex: 1, fontSize: 14 }}>{data.suggestions[r].map((x) => itemLabel(x, data)).join(' · ') || 'Nothing extra'}</span>
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setEditing({ relation: r, items: data.suggestions[r] })}>Edit</button>
        </div>
      ))}
      {editing && (
        <Dialog title={`When someone is ${RELATION_LABEL[editing.relation].toLowerCase()}`} onClose={() => setEditing(null)} width={480} actions={<>
          <button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>Save</button>
        </>}>
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="text-muted" style={{ fontSize: 13 }}>Pre-tick these, on top of your basic profile:</div>
            {choices.map((x) => (
              <label key={x} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
                <input type="checkbox" checked={editing.items.includes(x)} onChange={() => setEditing({ ...editing, items: editing.items.includes(x) ? editing.items.filter((y) => y !== x) : [...editing.items, x] })} />
                {itemLabel(x, data)}
              </label>
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}
