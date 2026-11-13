import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, get, post } from '../api';
import { fetchCatalog, GROUPS, type Domain } from '../life';
import { Brand, Circle, Loading, Pills } from '../ui';

/**
 * The consent page an AI assistant sends you to when it connects (OAuth). The same choices as sharing with anyone:
 * what it sees (categories, with or without their secret details, or Everything), what it can change, and until when.
 * The assistant becomes one of your relationships; you can change all of this later on its page.
 */
type Write = 'none' | 'suggest' | 'make';
type Cat = { domain: string; scope: 'all' | 'current'; includeSecret: boolean };
type Choice = { everything: { includeSecret: boolean } | null; basic: boolean; categories: Cat[]; write: Write };
type Info = { client: { name: string; uri: string | null; verified: boolean; redirectHost: string }; previous: Choice | null };

const WRITES: [Write, string, string][] = [
  ['none', 'Nothing', 'It answers questions from what you let it see, and changes nothing.'],
  ['suggest', 'Suggests changes', 'Its changes wait for you to approve them. Documents it adds wait in your inbox.'],
  ['make', 'Makes changes', 'Its changes are saved straight away, and you can see and undo them.'],
];

export default function Authorize() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const request = useMemo(() => Object.fromEntries(params.entries()), [params]);
  const [info, setInfo] = useState<Info | null>(null);
  const [catalog, setCatalog] = useState<Domain[] | null>(null);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState<'custom' | 'everything'>('custom');
  const [everySecret, setEverySecret] = useState(false);
  const [basic, setBasic] = useState(true);
  const [cats, setCats] = useState<Record<string, Cat>>({});
  const [write, setWrite] = useState<Write>('suggest');
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<Info>(`/api/oauth/request?${params.toString()}`)
      .then((i) => {
        setInfo(i);
        // Connected before: start from what you chose last time.
        const p = i.previous;
        if (p) {
          setPreset(p.everything ? 'everything' : 'custom');
          setEverySecret(!!p.everything?.includeSecret);
          setBasic(p.basic);
          setCats(Object.fromEntries(p.categories.map((c) => [c.domain, c])));
          setWrite(p.write);
        }
        return fetchCatalog().then(setCatalog);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) nav(`/login?next=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`, { replace: true });
        else setError((e as Error).message);
      });
  }, [params, nav]);

  const hasSecrets = (d: Domain) => d.parts.some((p) => p.sensitivity === 'secret' && !p.deprecated);
  const toggle = (d: Domain, on: boolean) => setCats((c) => { const n = { ...c }; if (on) n[d.id] = { domain: d.id, scope: 'all', includeSecret: false }; else delete n[d.id]; return n; });
  const nothing = preset === 'custom' && !basic && !Object.keys(cats).length;

  const answer = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ redirect: string }>('/api/oauth/authorize', {
        ...request, approve, write,
        ...(preset === 'everything' ? { everything: { includeSecret: everySecret } } : { basic, categories: Object.values(cats) }),
        expiresAt: until ? new Date(`${until}T23:59:59`).toISOString() : null,
      });
      window.location.assign(r.redirect);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const name = info?.client.name ?? 'An assistant';
  return (
    <div data-screen-label="Connect an assistant" style={{ minHeight: '100%', position: 'relative', overflow: 'hidden', padding: '40px clamp(20px,7vw,96px) 64px' }}>
      <Circle style={{ right: -180, top: -140, width: 520, height: 520, background: 'var(--color-accent-2-200)', opacity: 0.7 }} />
      <div style={{ position: 'relative', maxWidth: 640 }}>
        <div style={{ marginBottom: 28 }}><Brand name="Little Dipper" /></div>
        {error && !info ? (
          <>
            <h1 style={{ fontSize: 36 }}>This connection can’t go ahead</h1>
            <p style={{ fontSize: 16 }}>{error}</p>
          </>
        ) : !info || !catalog ? <Loading /> : (
          <>
            <span className="tag tag-accent">Connect an assistant</span>
            <h1 style={{ marginTop: 14, fontSize: 40, textWrap: 'pretty' }}>{name} wants to connect to your Little Dipper.</h1>
            <p className="text-muted" style={{ fontSize: 14, marginTop: 0 }}>
              “{name}” is the name it gave itself: Little Dipper can’t check it. When you finish, you’ll go back to <strong>{info.client.redirectHost}</strong>. If that isn’t the assistant you were using, don’t connect.
            </p>
            <div className="card" style={{ padding: '14px 18px', gap: 6, marginTop: 8 }}>
              <div style={{ fontSize: 14 }}><strong>What it’s good for:</strong> answering questions from your records, filling in forms, filing documents and keeping things up to date.</div>
              <div style={{ fontSize: 14 }}><strong>Worth knowing:</strong> what it reads leaves your Little Dipper and goes to the company that runs {name}. You can see everything it does, undo its changes, and end its access any time.</div>
            </div>

            <h3 style={{ marginTop: 28 }}>What it sees</h3>
            <Pills value={preset} onChange={setPreset} options={[['custom', 'Choose'], ['everything', 'Everything']]} />
            {preset === 'everything' ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                <div className="text-muted" style={{ fontSize: 13 }}>Every category, your profile and every document, including anything you add later.</div>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={everySecret} onChange={(e) => setEverySecret(e.target.checked)} />
                  Include secret details too (ID and account numbers, and the like)
                </label>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 14, marginTop: 12 }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={basic} onChange={(e) => setBasic(e.target.checked)} />
                  Your basic profile (the lines every connection gets)
                </label>
                {GROUPS.map((g) => {
                  // One-at-a-time categories (tasks, notes) are never handed over whole; Everything includes them.
                  const ds = catalog.filter((d) => d.group === g.id && !(d as Domain & { oneAtATime?: boolean }).oneAtATime);
                  if (!ds.length) return null;
                  return (
                    <div key={g.id}>
                      <div className="text-muted" style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 4 }}>{g.label}</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 4 }}>
                        {ds.map((d) => {
                          const c = cats[d.id];
                          return (
                            <div key={d.id} style={{ display: 'grid', gap: 2 }}>
                              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
                                <input type="checkbox" checked={!!c} onChange={(e) => toggle(d, e.target.checked)} />
                                {d.label}
                              </label>
                              {c && hasSecrets(d) && (
                                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, paddingLeft: 24, cursor: 'pointer' }} className="text-muted">
                                  <input type="checkbox" checked={c.includeSecret} onChange={(e) => setCats({ ...cats, [d.id]: { ...c, includeSecret: e.target.checked } })} />
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

            <h3 style={{ marginTop: 28 }}>What it can change</h3>
            <div style={{ display: 'grid', gap: 6 }}>
              {WRITES.map(([m, label, text]) => (
                <label key={m} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', padding: '10px 14px', borderRadius: 16, border: `1px solid ${write === m ? 'var(--color-accent)' : 'var(--color-divider)'}`, background: write === m ? 'var(--color-accent-100)' : 'transparent' }}>
                  <input type="radio" name="write" checked={write === m} onChange={() => setWrite(m)} style={{ marginTop: 3 }} />
                  <span><span style={{ fontWeight: 600 }}>{label}</span><br /><span className="text-muted" style={{ fontSize: 13 }}>{text}</span></span>
                </label>
              ))}
            </div>
            <p className="text-muted" style={{ fontSize: 12.5 }}>Whatever you choose, changes to who you are (legal name, IDs, current address, email, phone) and secret details always wait for you.</p>

            <h3 style={{ marginTop: 28 }}>Until</h3>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Pills value={until ? 'date' : 'end'} onChange={(v) => setUntil(v === 'date' ? new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10) : '')} options={[['end', 'Until I end it'], ['date', 'Until a date']]} />
              {until && <input className="input" type="date" aria-label="Until" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} style={{ maxWidth: 180 }} />}
            </div>
            <p className="text-muted" style={{ fontSize: 12.5 }}>You can change any of this, or end it, on {name}’s page in Relationships. Planning a custom address for your Little Dipper? Set it up first: changing the address later means reconnecting your assistants.</p>

            {error && <p style={{ color: 'var(--color-accent-700)', fontSize: 13 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={busy || nothing} onClick={() => answer(true)} style={{ fontSize: 16, padding: '12px 26px' }}>Connect {name}</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => answer(false)}>Don’t connect</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
