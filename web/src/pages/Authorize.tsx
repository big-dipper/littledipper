import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, get, post } from '../api';
import { fetchCatalog, type Domain } from '../life';
import { Brand, Circle, Loading, Pills } from '../ui';
import { AccessChooser, accessFrom, accessPayload, accessReady, emptyAccess, type AccessChoice } from '../assistantAccess';

/**
 * The consent page an AI assistant sends you to when it connects (OAuth). The same choices as sharing with anyone:
 * what it sees (categories, with or without their secret details, or Everything), what it can change, and until when.
 * The assistant becomes one of your relationships; you can change all of this later on its page.
 */
type Info = { client: { name: string; uri: string | null; verified: boolean; redirectHost: string }; previous: AccessChoice | null };

export default function Authorize() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const request = useMemo(() => Object.fromEntries(params.entries()), [params]);
  const [info, setInfo] = useState<Info | null>(null);
  const [catalog, setCatalog] = useState<Domain[] | null>(null);
  const [error, setError] = useState('');
  // Nothing pre-chosen the first time: the owner decides what it sees and can change.
  const [access, setAccess] = useState(emptyAccess);
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<Info>(`/api/oauth/request?${params.toString()}`)
      .then((i) => {
        setInfo(i);
        // Connected before: start from what you chose last time.
        if (i.previous) setAccess(accessFrom(i.previous));
        return fetchCatalog().then(setCatalog);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) nav(`/login?next=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`, { replace: true });
        else setError((e as Error).message);
      });
  }, [params, nav]);


  const answer = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ redirect: string }>('/api/oauth/authorize', {
        ...request, approve,
        ...(approve ? accessPayload(access) : { write: 'none' }),
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
      <div style={{ position: 'relative', maxWidth: 640, margin: '0 auto' }}>
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

            <div style={{ marginTop: 20 }}><AccessChooser catalog={catalog} value={access} onChange={setAccess} name={name} /></div>

            <h3 style={{ marginTop: 28 }}>Until</h3>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Pills value={until ? 'date' : 'end'} onChange={(v) => setUntil(v === 'date' ? new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10) : '')} options={[['end', 'Until I end it'], ['date', 'Until a date']]} />
              {until && <input className="input" type="date" aria-label="Until" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} style={{ maxWidth: 180 }} />}
            </div>
            <p className="text-muted" style={{ fontSize: 12.5 }}>You can change any of this, or end it, on {name}’s page in Relationships. Planning a custom address for your Little Dipper? Set it up first: changing the address later means reconnecting your assistants.</p>

            {!accessReady(access) && <p className="text-muted" style={{ fontSize: 13 }}>Choose what {name} sees and what it can change to continue.</p>}
            {error && <p style={{ color: 'var(--color-accent-700)', fontSize: 13 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={busy || !accessReady(access)} onClick={() => answer(true)} style={{ fontSize: 16, padding: '12px 26px' }}>Connect {name}</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => answer(false)}>Don’t connect</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
