/**
 * What an assistant sees and what it can change: the same choices whether it connects from outside (OAuth consent)
 * or is a model you add inside Little Dipper. Nothing is pre-chosen on first setup: the owner decides.
 * Everything can be changed later on the assistant's page.
 */
import { GROUPS, type Domain } from './life';

export type Write = 'none' | 'suggest' | 'make';
export type Cat = { domain: string; scope: 'all' | 'current'; includeSecret: boolean };
export type Access = { preset: 'custom' | 'everything' | null; everySecret: boolean; basic: boolean; cats: Record<string, Cat>; write: Write | null };
export type AccessChoice = { everything: { includeSecret: boolean } | null; basic: boolean; categories: Cat[]; write: Write };

export const WRITES: [Write, string, string][] = [
  ['none', 'Nothing', 'It answers questions from what you let it see, and changes nothing.'],
  ['suggest', 'Suggests changes', 'Its changes wait for you to approve them. Documents it adds wait in your inbox.'],
  ['make', 'Makes changes', 'Its changes are saved straight away, and you can see and undo them.'],
];

export const emptyAccess = (): Access => ({ preset: null, everySecret: false, basic: true, cats: {}, write: null });

/** Start from what was chosen before (reconnecting). */
export function accessFrom(p: AccessChoice): Access {
  return { preset: p.everything ? 'everything' : 'custom', everySecret: !!p.everything?.includeSecret, basic: p.basic, cats: Object.fromEntries(p.categories.map((c) => [c.domain, c])), write: p.write };
}

/** Ready to send: it sees something, and the owner picked what it can change. */
export const accessReady = (a: Access) => !!a.write && (a.preset === 'everything' || (a.preset === 'custom' && (a.basic || Object.keys(a.cats).length > 0)));

export function accessPayload(a: Access) {
  return a.preset === 'everything'
    ? { everything: { includeSecret: a.everySecret }, write: a.write }
    : { basic: a.basic, categories: Object.values(a.cats), write: a.write };
}

const choiceStyle = (on: boolean) => ({
  display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', padding: '10px 14px', borderRadius: 16,
  border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-divider)'}`, background: on ? 'var(--color-accent-100)' : 'transparent',
}) as const;

export function AccessChooser({ catalog, value: a, onChange, name }: { catalog: Domain[]; value: Access; onChange: (a: Access) => void; name: string }) {
  const set = (p: Partial<Access>) => onChange({ ...a, ...p });
  const hasSecrets = (d: Domain) => d.parts.some((p) => p.sensitivity === 'secret' && !p.deprecated);
  const toggle = (d: Domain, on: boolean) => { const n = { ...a.cats }; if (on) n[d.id] = { domain: d.id, scope: 'all', includeSecret: false }; else delete n[d.id]; set({ cats: n }); };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <h3 style={{ margin: '8px 0 0', fontSize: 18 }}>What {name} sees</h3>
      <div style={{ display: 'grid', gap: 6 }}>
        <label style={choiceStyle(a.preset === 'everything')}>
          <input type="radio" name="sees" checked={a.preset === 'everything'} onChange={() => set({ preset: 'everything' })} style={{ marginTop: 3 }} />
          <span><span style={{ fontWeight: 600 }}>Everything</span><br /><span className="text-muted" style={{ fontSize: 13 }}>Most helpful: it can answer anything about your life. Every category, your profile and every document, including what you add later.</span></span>
        </label>
        <label style={choiceStyle(a.preset === 'custom')}>
          <input type="radio" name="sees" checked={a.preset === 'custom'} onChange={() => set({ preset: 'custom' })} style={{ marginTop: 3 }} />
          <span><span style={{ fontWeight: 600 }}>Only what I choose</span><br /><span className="text-muted" style={{ fontSize: 13 }}>Pick categories. It can only help with those.</span></span>
        </label>
      </div>
      {a.preset === 'everything' && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer', paddingLeft: 4 }}>
          <input type="checkbox" checked={a.everySecret} onChange={(e) => set({ everySecret: e.target.checked })} />
          Include secret details too (ID and account numbers, and the like)
        </label>
      )}
      {a.preset === 'custom' && (
        <div style={{ display: 'grid', gap: 14, marginTop: 6 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
            <input type="checkbox" checked={a.basic} onChange={(e) => set({ basic: e.target.checked })} />
            Your basic profile (the lines every connection gets)
          </label>
          {GROUPS.map((g) => {
            // One-at-a-time categories (tasks, notes) are never handed over whole; Everything includes them.
            const ds = catalog.filter((d) => d.group === g.id && !(d as Domain & { oneAtATime?: boolean }).oneAtATime);
            if (!ds.length) return null;
            return (
              <div key={g.id}>
                <div className="text-muted" style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 4 }}>{g.label}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 4 }}>
                  {ds.map((d) => {
                    const c = a.cats[d.id];
                    return (
                      <div key={d.id} style={{ display: 'grid', gap: 2 }}>
                        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!c} onChange={(e) => toggle(d, e.target.checked)} />
                          {d.label}
                        </label>
                        {c && hasSecrets(d) && (
                          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, paddingLeft: 24, cursor: 'pointer' }} className="text-muted">
                            <input type="checkbox" checked={c.includeSecret} onChange={(e) => set({ cats: { ...a.cats, [d.id]: { ...c, includeSecret: e.target.checked } } })} />
                            with secret details
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h3 style={{ margin: '18px 0 0', fontSize: 18 }}>What {name} can change</h3>
      <div style={{ display: 'grid', gap: 6 }}>
        {WRITES.map(([m, label, text]) => (
          <label key={m} style={choiceStyle(a.write === m)}>
            <input type="radio" name="write" checked={a.write === m} onChange={() => set({ write: m })} style={{ marginTop: 3 }} />
            <span><span style={{ fontWeight: 600 }}>{label}</span><br /><span className="text-muted" style={{ fontSize: 13 }}>{text}</span></span>
          </label>
        ))}
      </div>
      <p className="text-muted" style={{ fontSize: 12.5, margin: '4px 0 0' }}>Whatever you choose, changes to who you are (legal name, IDs, current address, email, phone) and secret details always wait for you.</p>
    </div>
  );
}
