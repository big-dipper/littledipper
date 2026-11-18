import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ago, get, post } from '../../api';
import { ErrorNote, Toggle, useAction, useAsync } from '../../ui';
import { useAdmin } from './Layout';

type Relation = 'spouse' | 'partner' | 'child' | 'parent' | 'sibling' | 'grandparent' | 'grandchild' | 'other_family' | 'friend' | 'colleague' | 'manager' | 'mentor' | 'reference' | 'other';
type Rules = {
  merge: boolean; skipNoName: boolean; skipEmailOnly: boolean; organisations: boolean; workplaces: boolean;
  only: string[] | null; relations: Record<string, Relation>; companies: { match: string; relation: Relation }[]; rest: 'add' | 'skip';
};
type Counted = { name: string; count: number };
type Summary = { cards: number; people: number; duplicates: number; alreadyHere: number; noName: number; emailOnly: number; businesses: number; withBirthday: number; labels: Counted[]; unlabelled: number; companies: Counted[]; emailDomains: Counted[] };
type Preset = { id: string; label: string; text: string; rules: Rules };
type Opened = { id: string; name: string; summary: Summary; presets: Preset[] };
type Plan = { groups: { id: string; text: string; names: string[] }[]; totals: { adding: number; updating: number; relationships: number; workplaces: number; leftOut: number } };
type Past = { id: string; name: string; counts: { people: number; updated: number; relationships: number; organisations: number }; createdAt: string; undoneAt: string | null };
type Model = { id: string; label: string };

const RELATIONS: [Relation, string][] = [
  ['other_family', 'Family'], ['spouse', 'Spouse'], ['partner', 'Partner'], ['parent', 'Parent'], ['child', 'Child'], ['sibling', 'Sibling'],
  ['grandparent', 'Grandparent'], ['grandchild', 'Grandchild'], ['friend', 'Friend'], ['colleague', 'Colleague'], ['manager', 'Manager'],
  ['mentor', 'Mentor'], ['reference', 'Reference'], ['other', 'Other'],
];
const n = (x: number) => x.toLocaleString('en-US');
const s = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

export default function ImportPeople() {
  const nav = useNavigate();
  const { refresh } = useAdmin();
  const { run, busy } = useAction();
  const [file, setFile] = useState<Opened | null>(null);
  const [preset, setPreset] = useState('clean');
  const [rules, setRules] = useState<Rules | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [words, setWords] = useState('');
  const [said, setSaid] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const [done, setDone] = useState<Past | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const { data: past, reload: reloadPast } = useAsync(() => get<{ imports: Past[] }>('/api/imports'), []);
  const { data: models } = useAsync(() => get<{ models: Model[] }>('/api/ai/models'), []);
  useEffect(() => { if (!model && models?.models[0]) setModel(models.models[0].id); }, [models, model]);

  // Every change to the rules shows its plan.
  useEffect(() => {
    if (!file || !rules) return;
    let live = true;
    post<Plan>(`/api/imports/${file.id}/plan`, { rules }).then((p) => live && setPlan(p)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [file, rules]);

  async function open(f: File) {
    setError(''); setDone(null);
    const res = await fetch(`/api/imports/contacts?name=${encodeURIComponent(f.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'text/vcard' }, body: f });
    const j = await res.json().catch(() => null);
    if (!res.ok) { setError(j?.message || 'That file couldn’t be read. Export your contacts as vCard (.vcf).'); return; }
    const o = j as Opened;
    setFile(o); setPreset('clean'); setRules(o.presets[0].rules); setSaid(''); setWords('');
  }

  function choose(p: Preset) { setPreset(p.id); setRules(p.rules); setSaid(''); }
  const change = (patch: Partial<Rules>) => { setPreset('custom'); setRules((r) => (r ? { ...r, ...patch } : r)); };

  async function writeRules() {
    if (!file || !rules || !words.trim()) return;
    setThinking(true); setError('');
    try {
      const r = await post<{ said: string; rules: Rules; plan: Plan }>(`/api/imports/${file.id}/rules`, { text: words, model, rules });
      setPreset('custom'); setRules(r.rules); setSaid(r.said);
    } catch (e) { setError((e as Error).message); }
    setThinking(false);
  }

  async function go() {
    if (!file || !rules) return;
    const r = await run(() => post<Past>(`/api/imports/${file.id}/run`, { rules }));
    if (r) { setDone(r); setFile(null); setPlan(null); reloadPast(); refresh(); }
  }

  async function undo(p: Past) {
    const r = await run(() => post<{ relationships: number; removed: number; kept: string[]; restored: number }>(`/api/imports/${p.id}/undo`), (x) =>
      x.kept.length ? `Undone. ${x.kept.length} ${x.kept.length === 1 ? 'person was' : 'people were'} kept because you’ve used them since.` : 'Undone');
    if (r) { reloadPast(); refresh(); if (done?.id === p.id) setDone(null); }
  }

  const labels = file?.summary.labels ?? [];
  const sum = file?.summary;

  return (
    <div data-screen-label="Import people" style={{ maxWidth: 860 }}>
      <Link to="/admin/relationships" className="text-muted" style={{ fontSize: 14 }}>← Relationships</Link>
      <h1 style={{ marginTop: 8 }}>Bring in your people</h1>
      <p className="text-muted" style={{ marginTop: 0 }}>From Google Contacts, your iPhone, Outlook or anywhere that exports a contacts file. You see the plan before anything is added, and you can undo it in one step.</p>

      {done && (
        <div className="imp-card imp-done">
          <div style={{ fontWeight: 600, fontSize: 17 }}>Added {s(done.counts.people, 'person', 'people')}{done.counts.updated ? `, and filled in ${n(done.counts.updated)} you already had` : ''}.</div>
          <div className="text-muted" style={{ fontSize: 14, marginTop: 4 }}>{done.counts.relationships ? `${n(done.counts.relationships)} with how you know them. ` : ''}{done.counts.people > done.counts.relationships ? 'Anyone without a relation is waiting under “To sort”.' : ''}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn btn-primary" onClick={() => nav(done.counts.people > done.counts.relationships ? '/admin/relationships?show=sort' : '/admin/relationships')}>{done.counts.people > done.counts.relationships ? 'See who to sort' : 'See them'}</button>
            <button className="btn btn-secondary" onClick={() => undo(done)} disabled={busy}>Undo this import</button>
          </div>
        </div>
      )}

      {!file && (
        <>
          <div className="imp-card">
            <div style={{ fontWeight: 600 }}>Get your file</div>
            <ul className="imp-how">
              <li><b>Google:</b> contacts.google.com → Export → vCard. Pick a label to export just those people.</li>
              <li><b>iPhone:</b> icloud.com/contacts → select all → Export vCard.</li>
              <li><b>Tip:</b> label people first (Family, Friends, Work). Labels come along, and they’re the easiest way to say who’s who.</li>
            </ul>
          </div>
          <div className={`imp-drop${over ? ' on' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void open(f); }} onClick={() => picker.current?.click()} role="button" tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && picker.current?.click()}>
            <div style={{ fontWeight: 600, fontSize: 17 }}>Drop your contacts file here</div>
            <div className="text-muted" style={{ fontSize: 14 }}>or click to choose it (.vcf)</div>
            <input ref={picker} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void open(f); e.target.value = ''; }} />
          </div>
          {error && <ErrorNote error={new Error(error)} />}
        </>
      )}

      {file && sum && rules && (
        <>
          <div className="imp-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 600 }}>{file.name}</div>
              <button className="bare fb-plain" onClick={() => { setFile(null); setPlan(null); }}>Use another file</button>
            </div>
            <div className="imp-counts">
              <span><b>{n(sum.cards)}</b> cards</span>
              {sum.duplicates > 0 && <span><b>{n(sum.duplicates)}</b> look like duplicates</span>}
              {sum.alreadyHere > 0 && <span><b>{n(sum.alreadyHere)}</b> already here</span>}
              {sum.noName > 0 && <span><b>{n(sum.noName)}</b> have no name</span>}
              {sum.emailOnly > 0 && <span><b>{n(sum.emailOnly)}</b> just an email</span>}
              {sum.businesses > 0 && <span><b>{n(sum.businesses)}</b> businesses</span>}
            </div>
            {labels.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>{labels.map((l) => <span key={l.name} className="tag tag-neutral">{l.name} · {n(l.count)}</span>)}{sum.unlabelled > 0 && <span className="tag tag-neutral">No label · {n(sum.unlabelled)}</span>}</div>}
          </div>

          <h2 className="imp-h">How should this go?</h2>
          <div className="imp-presets">
            {file.presets.map((p) => (
              <button key={p.id} type="button" className="imp-preset" data-on={preset === p.id ? '1' : '0'} onClick={() => choose(p)}>
                <div style={{ fontWeight: 600 }}>{p.label}</div>
                <div className="text-muted" style={{ fontSize: 13 }}>{p.text}</div>
              </button>
            ))}
          </div>

          <div className="imp-words">
            <textarea className="input" rows={2} placeholder="Or say it in your own words: “only friends and family, plus anyone at Acme as co-workers. Skip people with just an email.”" value={words} onChange={(e) => setWords(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void writeRules(); }} disabled={!models?.models.length} />
            {models?.models.length ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {models.models.length > 1 && <select className="input" style={{ width: 'auto' }} value={model} onChange={(e) => setModel(e.target.value)} aria-label="Assistant">{models.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>}
                <button className="btn btn-secondary" onClick={writeRules} disabled={thinking || !words.trim()}>{thinking ? 'Working it out…' : 'Make it so'}</button>
                <span className="text-muted" style={{ fontSize: 12 }}>Your assistant sees the counts, labels and companies above, not your contacts.</span>
              </div>
            ) : <div className="text-muted" style={{ fontSize: 13 }}>Add an assistant to describe it in your own words. The choices above work without one.</div>}
            {said && <div className="imp-said">{said}</div>}
          </div>

          <details className="imp-fine">
            <summary>Fine-tune</summary>
            <div className="imp-toggles">
              {([['merge', 'Combine duplicates and people already here'], ['skipNoName', 'Leave out cards with no name'], ['skipEmailOnly', 'Leave out cards that are just an email'], ['organisations', 'Bring in businesses'], ['workplaces', 'Note where people work']] as [keyof Rules, string][]).map(([k, label]) => (
                <label key={k} className="imp-toggle"><Toggle on={!!rules[k]} onChange={() => change({ [k]: !rules[k] } as Partial<Rules>)} label={label} /><span>{label}</span></label>
              ))}
            </div>
            {labels.length > 0 && (
              <table className="table imp-labels">
                <thead><tr><th>Label</th><th>Bring in</th><th>They’re your</th></tr></thead>
                <tbody>{labels.map((l) => {
                  const inOnly = !rules.only || rules.only.includes(l.name);
                  return (
                    <tr key={l.name}>
                      <td>{l.name} <span className="text-muted">· {n(l.count)}</span></td>
                      <td><input type="checkbox" checked={inOnly} onChange={() => {
                        const all = labels.map((x) => x.name);
                        const cur = rules.only ?? all;
                        const next = inOnly ? cur.filter((x) => x !== l.name) : [...cur, l.name];
                        change({ only: next.length === all.length && !rules.only ? null : next });
                      }} aria-label={`Bring in ${l.name}`} /></td>
                      <td><select className="input" style={{ width: 'auto' }} value={rules.relations[l.name] ?? ''} onChange={(e) => {
                        const rel = { ...rules.relations };
                        if (e.target.value) rel[l.name] = e.target.value as Relation; else delete rel[l.name];
                        change({ relations: rel });
                      }}><option value="">Not sure yet</option>{RELATIONS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}
            {rules.only && <div className="text-muted" style={{ fontSize: 13, marginTop: 8 }}>Only people with a ticked label{rules.companies.length ? ', or at the companies below,' : ''} come in.</div>}
            {!rules.only && (
              <label className="imp-toggle" style={{ marginTop: 10 }}><Toggle on={rules.rest === 'add'} onChange={() => change({ rest: rules.rest === 'add' ? 'skip' : 'add' })} label="Add people with no relation to sort later" /><span>Add people with no relation, to sort later</span></label>
            )}
            {rules.companies.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {rules.companies.map((c, i) => <span key={i} className="tag tag-accent">{c.match} → {RELATIONS.find(([k]) => k === c.relation)?.[1]} <button className="bare" aria-label="Remove" onClick={() => change({ companies: rules.companies.filter((_, j) => j !== i) })}>×</button></span>)}
              </div>
            )}
          </details>

          <h2 className="imp-h">The plan</h2>
          {!plan ? <div className="text-muted">Working it out…</div> : (
            <div className="imp-plan">
              {plan.groups.map((g) => (
                <details key={g.id} className="imp-group" data-kind={g.id.split(':')[0]}>
                  <summary>{g.text}</summary>
                  <div className="imp-names">{g.names.slice(0, 300).join(' · ')}{g.names.length > 300 ? ` · and ${n(g.names.length - 300)} more` : ''}</div>
                </details>
              ))}
              {plan.groups.length === 0 && <div className="text-muted">Nothing to bring in with these choices.</div>}
            </div>
          )}
          {error && <ErrorNote error={new Error(error)} />}
          <div style={{ display: 'flex', gap: 10, marginTop: 18, alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={go} disabled={busy || !plan || plan.totals.adding + plan.totals.updating === 0}>
              {plan ? `Import ${s(plan.totals.adding, 'person', 'people')}${plan.totals.updating ? ` · update ${n(plan.totals.updating)}` : ''}` : 'Import'}
            </button>
            <span className="text-muted" style={{ fontSize: 13 }}>You can undo it afterwards.</span>
          </div>
        </>
      )}

      {!!past?.imports.length && (
        <>
          <h2 className="imp-h">Past imports</h2>
          <div className="imp-plan">
            {past.imports.map((p) => (
              <div key={p.id} className="imp-past">
                <div><div style={{ fontWeight: 600 }}>{p.name}</div><div className="text-muted" style={{ fontSize: 13 }}>{s(p.counts.people, 'person', 'people')}{p.counts.updated ? ` · ${n(p.counts.updated)} filled in` : ''} · {ago(p.createdAt)}{p.undoneAt ? ' · undone' : ''}</div></div>
                {!p.undoneAt && <button className="btn btn-secondary" onClick={() => undo(p)} disabled={busy}>Undo</button>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
