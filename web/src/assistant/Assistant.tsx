/**
 * The in-app assistant: a chat panel beside whatever the owner is looking at. They talk to a model they added
 * (Claude, or an open-weight model on a service they chose), and it works with their Little Dipper through the same
 * tools any assistant uses, under the same rules: what it may see, Review for its changes, undo, the activity log.
 *
 * It knows the page they're on, and on a document it offers to bring the document's pages into the conversation.
 * The node runs each turn (server: ai/engine.ts); this streams the answer as it comes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { del, get, patch, post, put } from '../api';
import { Icon } from '../icons';
import { useAdmin } from '../pages/admin/Layout';

type Provider = 'anthropic' | 'openai';
type Model = { id: string; label: string; provider: Provider; baseUrl: string | null; model: string; apiKey: string; instructions: string; privacy: Privacy; assistant: { id: string; name: string } | null };
type Privacy = { level: 'local' | 'company' | 'router' | 'unknown'; levelLabel: string; goesTo: string; operator: string; site: string | null; note: string; inTransit: string; yourKey: string; sees: string; does: string; verifiedPrivate: boolean };
type Prompt = { id: string; text: string };
type Settings = { instructions: string; prompts: Prompt[] };
type ToolNote = { name: string; title: string; ok: boolean; note?: string; pending?: boolean; reviewIds?: string[] };
type Change = { key: string; label: string; secret: boolean; to: unknown; from?: unknown };
type Review = { id: string; domainLabel: string; recordTitle: string | null; action: 'create' | 'update'; status: 'pending' | 'approved' | 'rejected'; changes: Change[] };
type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
type Turn =
  | { role: 'user'; text: string; files: { id: string; name: string }[]; at: string }
  | { role: 'assistant'; text: string; tools: ToolNote[]; stopNote?: string; error?: string; usage: Usage; at: string; followed?: { all: string; model: string } };
type Chat = { id: string; modelId: string; title: string; usage: Usage; updatedAt: string; turns?: Turn[] };
type Doc = { id: string; title: string; pages: { id: string; name: string; type: string }[] };

const OPEN_KEY = 'ld.assistant.open';
const MODEL_KEY = 'ld.assistant.model';

/** Dollars per million tokens (input, output) for models whose price we know. Others show tokens only. */
const PRICES: [RegExp, number, number][] = [
  [/^claude-opus-5-5/, 4, 20], [/^claude-sonnet-5-5/, 2, 10], [/^claude-haiku-5-5/, 0.1, 0.5],
  [/^claude-fable-5-2/, 8, 40], [/^claude-opus-5$/, 5, 25], [/^claude-sonnet-5$/, 2, 10],
];
function cost(m: Model | undefined, u: Usage) {
  const p = m && m.provider === 'anthropic' ? PRICES.find(([re]) => re.test(m.model)) : undefined;
  if (!p) return null;
  // Cache reads cost a tenth of the input price; writing to the cache costs a quarter more.
  const read = u.cacheRead ?? 0, write = u.cacheWrite ?? 0, plain = Math.max(0, u.input - read - write);
  return (plain * p[1] + write * p[1] * 1.25 + read * p[1] * 0.1 + u.output * p[2]) / 1e6;
}
const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** What to suggest saying, by where the owner is. */
function starters(path: string, doc: Doc | null): string[] {
  if (doc) return ['Add what this document says to my Little Dipper', 'What is this document, and what should I do with it?', 'Is anything in here out of date in my records?'];
  if (path.includes('/calendar')) return ['What’s coming up that I need to deal with this month?', 'Which renewals or expiry dates are coming up soon?'];
  if (path.includes('/people') || path.includes('/relationships')) return ['Whose birthday is coming up?', 'Who haven’t I been in touch with for a while?'];
  return ['What’s coming up this month that I need to deal with?', 'Where’s my car title, and when does my registration run out?', 'I have debts in collections. Help me make a plan.', 'Write my résumé from my work history.'];
}

/** A little formatting for answers: paragraphs, bullet lines and **bold**. Everything else stays plain text. */
function Rich({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>));
  return <>{blocks.map((b, i) => {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>)}</ul>;
    return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l)}</span>)}</p>;
  })}</>;
}

export function AssistantButton() {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } });
  const toggle = (v: boolean) => { setOpen(v); try { localStorage.setItem(OPEN_KEY, v ? '1' : ''); } catch { /* not remembered */ } };
  return (
    <>
      <button type="button" className="bare ab-rail-btn ai-rail-btn" data-on={open ? '1' : '0'} onClick={() => toggle(!open)} title="Your assistant" aria-label="Your assistant" aria-expanded={open}>
        <Icon name="sparkle" size={21} />
      </button>
      {open && <AssistantPanel onClose={() => toggle(false)} />}
    </>
  );
}

function AssistantPanel({ onClose }: { onClose: () => void }) {
  const { refresh } = useAdmin();
  const loc = useLocation();
  const [models, setModels] = useState<Model[] | null>(null);
  const [modelId, setModelId] = useState<string>(() => { try { return localStorage.getItem(MODEL_KEY) || ''; } catch { return ''; } });
  const [view, setView] = useState<'chat' | 'settings' | 'history'>('chat');
  const [settings, setSettings] = useState<Settings>({ instructions: '', prompts: [] });
  const [showPrompts, setShowPrompts] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [added, setAdded] = useState<Doc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<{ text: string; tools: (ToolNote & { id: string; running: boolean })[] } | null>(null);
  const [error, setError] = useState('');
  const [doc, setDoc] = useState<Doc | null>(null);
  const [attach, setAttach] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const loadModels = () => get<{ models: Model[] }>('/api/ai/models').then((r) => {
    setModels(r.models);
    if (!r.models.some((m) => m.id === modelId)) setModelId(r.models[0]?.id ?? '');
  });
  useEffect(() => { loadModels().catch(() => setModels([])); get<Settings>('/api/ai/settings').then(setSettings).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const savePrompts = async (prompts: { id?: string; text: string }[]) => setSettings(await put<Settings>('/api/ai/settings', { prompts }));
  useEffect(() => { try { localStorage.setItem(MODEL_KEY, modelId); } catch { /* not remembered */ } }, [modelId]);
  const model = models?.find((m) => m.id === modelId);

  // On a document's page, offer its pages.
  const docId = /\/documents\/([^/?#]+)/.exec(loc.pathname)?.[1] ?? null;
  useEffect(() => {
    setDoc(null); setAttach(true);
    if (docId) get<Doc>(`/api/documents/${docId}`).then(setDoc).catch(() => setDoc(null));
  }, [docId]);

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [chat?.turns?.length, live?.text, live?.tools.length]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [busy, onClose]);

  const where = useMemo(() => {
    const page = document.querySelector('main h1')?.textContent?.trim();
    return doc ? `the document “${doc.title}”` : page ? `the ${page} page` : 'Little Dipper';
  }, [loc.pathname, doc]); // eslint-disable-line react-hooks/exhaustive-deps

  const newChat = () => { setChat(null); setLive(null); setError(''); setView('chat'); setTimeout(() => input.current?.focus(), 50); };

  /** Files dropped or picked go into Documents (the inbox), then into the next message for the model to read and file. */
  async function upload(list: FileList | File[]) {
    const files = [...list].filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (!files.length) { setError('Drop a photo, scan or PDF.'); return; }
    setUploading(true); setError('');
    try {
      for (const f of files.slice(0, 6)) {
        const res = await fetch(`/api/documents?name=${encodeURIComponent(f.name)}&status=inbox`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': f.type }, body: f });
        const j = await res.json().catch(() => null);
        if (!res.ok) throw new Error(j?.message || `Couldn’t add ${f.name}`);
        setAdded((a) => [...a, j as Doc]);
      }
    } catch (e) { setError((e as Error).message); } finally { setUploading(false); setTimeout(() => input.current?.focus(), 30); }
  }

  async function send(said: string) {
    const t = said.trim() || (added.length ? 'Please read what I added, file it where it belongs, and add what it says to my Little Dipper.' : '');
    if (!t || busy || !model) return;
    setBusy(true); setError(''); setText('');
    const files = [...(doc && attach ? doc.pages.map((p) => p.id) : []), ...added.flatMap((d) => d.pages.map((p) => p.id))];
    const extra = added.length ? ` Documents they just added (in their inbox): ${added.map((d) => `“${d.title}” (${d.id})`).join(', ')}.` : '';
    const allDocs = [...(doc ? [doc] : []), ...added];
    let c = chat;
    try {
      if (!c || c.modelId !== model.id) c = await post<Chat>('/api/ai/chats', { model: model.id });
      const shown: Turn = { role: 'user', text: t, files: files.map((id) => ({ id, name: allDocs.flatMap((d) => d.pages).find((p) => p.id === id)?.name ?? 'page' })), at: new Date().toISOString() };
      setAdded([]);
      c = { ...c, turns: [...(c.turns ?? []), shown] };
      setChat(c);
      setLive({ text: '', tools: [] });
      const res = await fetch(`/api/ai/chats/${c.id}/messages`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: t, files, context: `${where} (${loc.pathname}).${extra}` }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.message || `Couldn’t send it (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 2);
          if (!line.startsWith('data: ')) continue;
          const e = JSON.parse(line.slice(6));
          if (e.type === 'text') setLive((l) => l && { ...l, text: l.text + e.text });
          else if (e.type === 'tool' && e.phase === 'start') setLive((l) => l && { ...l, tools: [...l.tools, { id: e.id, name: e.name, title: e.title, ok: true, running: true }] });
          else if (e.type === 'tool') setLive((l) => l && { ...l, tools: l.tools.map((x) => (x.id === e.id ? { ...x, running: false, ok: e.ok, note: e.note, pending: e.pending, reviewIds: e.reviewIds } : x)) });
          else if (e.type === 'error') setError(e.message);
        }
      }
      // The node saved the turn: take its copy (with usage and title).
      const saved = await get<Chat>(`/api/ai/chats/${c.id}`);
      setChat(saved);
      if (saved.turns?.some((x) => x.role === 'assistant' && x.tools.some((n) => n.pending || (n.ok && n.note === 'Saved')))) refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLive(null); setBusy(false);
      setTimeout(() => input.current?.focus(), 30);
    }
  }

  const openHistory = async () => { setChats((await get<{ chats: Chat[] }>('/api/ai/chats')).chats); setView('history'); };
  const openChat = async (id: string) => { const c = await get<Chat>(`/api/ai/chats/${id}`); setChat(c); setModelId(c.modelId); setView('chat'); };

  const turns = chat?.turns ?? [];
  const spent = chat ? cost(model, chat.usage) : null;

  return (
    <div className="fb-layer ai-layer">
      <div className="fb-scrim ai-scrim" onClick={() => !busy && onClose()} />
      <aside className="fb-panel ai-panel" role="dialog" aria-label="Your assistant" data-dragging={dragging ? '1' : '0'}
        onDragOver={(e) => { if (view === 'chat' && model && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (view === 'chat' && model && !busy) upload(e.dataTransfer.files); }}>
        {dragging && <div className="ai-drop">Drop it here: I’ll file it and read it</div>}
        <header className="ai-head">
          <div className="ai-title">
            <Icon name="sparkle" size={20} />
            {models && models.length > 1 && view === 'chat' ? (
              <select className="ai-model" value={modelId} onChange={(e) => { setModelId(e.target.value); newChat(); }} aria-label="Model">
                {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            ) : <strong>{view === 'settings' ? 'Settings' : view === 'history' ? 'Conversations' : model?.label ?? 'Your assistant'}</strong>}
            {view === 'chat' && model && <button type="button" className="bare ai-info-btn" data-level={model.privacy.level} onClick={() => setShowPrivacy(!showPrivacy)} aria-expanded={showPrivacy} title="Where your words go">ⓘ</button>}
          </div>
          <div className="ai-head-actions">
            {models?.length ? <>
              <button type="button" className="bare fb-plain" onClick={newChat} disabled={busy} title="New conversation">New</button>
              <button type="button" className="bare fb-plain" onClick={() => (view === 'history' ? setView('chat') : openHistory())} disabled={busy}>{view === 'history' ? 'Back' : 'History'}</button>
              <button type="button" className="bare fb-plain" onClick={() => setView(view === 'settings' ? 'chat' : 'settings')} disabled={busy}>{view === 'settings' ? 'Back' : 'Settings'}</button>
            </> : null}
            <button type="button" className="bare fb-plain" onClick={onClose} disabled={busy} aria-label="Close">Close</button>
          </div>
        </header>

        {showPrivacy && view === 'chat' && model && <div className="ai-privacy-pop"><PrivacyBox m={model} /></div>}
        {models === null ? <div className="fb-body text-muted">Loading…</div>
          : !models.length ? <div className="fb-body"><Models models={models} onChange={async (id) => { await loadModels(); if (id) { setModelId(id); setView('chat'); } }} /></div>
          : view === 'settings' ? (
            <div className="fb-body ai-settings">
              <Instructions settings={settings} models={models} modelId={modelId} onSettings={setSettings} onModels={loadModels} />
              <Prompts prompts={settings.prompts} onSave={savePrompts} />
              <Models models={models} onChange={async (id) => { await loadModels(); if (id) { setModelId(id); setView('chat'); } }} />
            </div>
          )
          : view === 'history' ? (
            <div className="fb-body ai-history">
              {!chats.length && <p className="text-muted">No conversations yet.</p>}
              {chats.map((c) => (
                <div key={c.id} className="ai-history-row">
                  <button type="button" className="bare" onClick={() => openChat(c.id)}>
                    <span>{c.title}</span>
                    <small className="text-muted">{models.find((m) => m.id === c.modelId)?.label ?? 'A removed model'} · {new Date(c.updatedAt).toLocaleDateString()}</small>
                  </button>
                  <button type="button" className="bare fb-plain" onClick={async () => { await del(`/api/ai/chats/${c.id}`); setChats(chats.filter((x) => x.id !== c.id)); if (chat?.id === c.id) newChat(); }} aria-label={`Delete ${c.title}`}>Delete</button>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="fb-body ai-convo" ref={scroller}>
                {!turns.length && !live && (
                  <div className="ai-empty">
                    <p className="ai-hello">What can I help with?</p>
                    <p className="text-muted" style={{ fontSize: 13.5 }}>I can find things, fill in forms from what you’ve kept, read documents and suggest updates. {model?.assistant ? <>What I can see and change is up to you, on <Link to={`/admin/relationships/${model.assistant.id}`}>my page</Link>.</> : null}</p>
                    {settings.prompts.length > 0 && <>
                      <div className="ai-group">Your prompts</div>
                      <div className="ai-starters ai-mine">
                        {settings.prompts.map((p) => <button key={p.id} type="button" onClick={() => send(p.text)}><span className="ai-star" aria-hidden>★</span>{p.text}</button>)}
                      </div>
                    </>}
                    <div className="ai-group">{settings.prompts.length ? 'Or try' : 'Try'}</div>
                    <div className="ai-starters">
                      {starters(loc.pathname, doc).map((s) => <button key={s} type="button" onClick={() => send(s)}>{s}</button>)}
                    </div>
                    {(settings.instructions || model?.instructions) && <p className="text-muted ai-following">Following your standing instructions. <button type="button" className="bare ai-link" onClick={() => setView('settings')}>See them</button></p>}
                  </div>
                )}
                {turns.map((t, i) => (t.role === 'user' ? (
                  <div key={i} className="ai-msg ai-me">
                    {t.files.length > 0 && <div className="ai-files">📎 {t.files.length === 1 ? t.files[0].name : `${t.files.length} pages`}</div>}
                    {t.text}
                  </div>
                ) : <Answer key={i} text={t.text} tools={t.tools} note={t.stopNote} error={t.error} followed={t.followed} />))}
                {live && <Answer text={live.text} tools={live.tools} thinking={!live.text && !live.tools.some((x) => x.running)} />}
                {error && !busy && <p className="fb-error">{error}</p>}
              </div>
              <footer className="ai-compose">
                {doc && doc.pages.length > 0 && (
                  <label className="ai-attach">
                    <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
                    Include this document ({doc.pages.length} {doc.pages.length === 1 ? 'page' : 'pages'}). It goes to {model?.provider === 'anthropic' ? 'Anthropic' : model?.baseUrl ? new URL(model.baseUrl).host : 'the model'}.
                  </label>
                )}
                {added.length > 0 && (
                  <div className="ai-added">
                    {added.map((d) => <span key={d.id} className="ai-chip">📎 {d.title}<button type="button" className="bare" aria-label={`Don’t include ${d.title}`} onClick={() => setAdded(added.filter((x) => x.id !== d.id))}>✕</button></span>)}
                    <span className="text-muted" style={{ fontSize: 12 }}>Saved to Documents. It goes to {model?.provider === 'anthropic' ? 'Anthropic' : model?.baseUrl ? new URL(model.baseUrl).host : 'the model'} when you send.</span>
                  </div>
                )}
                {showPrompts && settings.prompts.length > 0 && (
                  <div className="ai-prompt-menu" role="menu">
                    {settings.prompts.map((p) => <button key={p.id} type="button" role="menuitem" onClick={() => { setShowPrompts(false); send(p.text); }}>{p.text}</button>)}
                  </div>
                )}
                <div className="ai-input">
                  <textarea ref={input} rows={2} value={text} disabled={busy} placeholder={busy ? 'Working on it…' : added.length ? 'Say what to do with it, or just send' : 'Ask, tell it what to do, or drop a file here'}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text); } }} />
                  <button type="button" className="btn btn-primary" disabled={busy || uploading || (!text.trim() && !added.length)} onClick={() => send(text)}>Send</button>
                </div>
                <div className="ai-compose-tools">
                  <input ref={picker} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => { if (e.target.files) upload(e.target.files); e.target.value = ''; }} />
                  <button type="button" className="bare fb-plain" disabled={busy || uploading} onClick={() => picker.current?.click()}>{uploading ? 'Adding…' : 'Add a file'}</button>
                  {settings.prompts.length > 0 && <button type="button" className="bare fb-plain" onClick={() => setShowPrompts(!showPrompts)} aria-expanded={showPrompts}>Your prompts</button>}
                  {text.trim() && !settings.prompts.some((p) => p.text === text.trim()) && <button type="button" className="bare fb-plain" onClick={() => savePrompts([...settings.prompts, { text: text.trim() }])}>Save as a prompt</button>}
                </div>
                {chat && (chat.usage.input + chat.usage.output > 0) && (
                  <div className="ai-meter text-muted">This conversation: {tokens(chat.usage.input)} in{chat.usage.cacheRead ? ` (${tokens(chat.usage.cacheRead)} cached)` : ''} · {tokens(chat.usage.output)} out{spent !== null ? ` · about $${spent < 0.01 ? spent.toFixed(3) : spent.toFixed(2)}` : ''}</div>
                )}
              </footer>
            </>
          )}
      </aside>
    </div>
  );
}

function Answer({ text, tools, note, error, thinking, followed }: { text: string; tools: (ToolNote & { running?: boolean })[]; note?: string; error?: string; thinking?: boolean; followed?: { all: string; model: string } }) {
  return (
    <div className="ai-msg ai-them">
      {tools.length > 0 && (
        <ul className="ai-tools">
          {tools.map((t, i) => (
            <li key={i} data-state={t.running ? 'running' : t.pending ? 'pending' : t.ok ? 'ok' : 'failed'}>
              <span className="ai-tool-dot" />
              <span>{t.title}</span>
              {t.note && <span className="text-muted"> · {t.reviewIds?.length ? (t.reviewIds.length === 1 ? 'Suggested a change' : `Suggested ${t.reviewIds.length} changes`) : t.pending ? <Link to="/admin/review">{t.note}</Link> : t.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {tools.some((t) => t.reviewIds?.length) && <ReviewCards ids={tools.flatMap((t) => t.reviewIds ?? [])} />}
      {thinking && <div className="ai-thinking"><span /><span /><span /></div>}
      {text && <Rich text={text} />}
      {note && <p className="text-muted" style={{ fontSize: 13 }}>{note}</p>}
      {error && <p className="fb-error">{error}</p>}
      {followed && <div className="ai-followed" title={[followed.all, followed.model].filter(Boolean).join('\n\n')}>Followed your instructions{followed.model ? ', and this model’s own' : ''}</div>}
    </div>
  );
}

/** What it suggested, right in the conversation: approve it or say no, without going to Review. */
function ReviewCards({ ids }: { ids: string[] }) {
  const { refresh } = useAdmin();
  const [items, setItems] = useState<Review[] | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const key = ids.join(',');
  const load = () => get<{ items: Review[] }>('/api/reviews?status=all').then((r) => setItems(r.items.filter((x) => ids.includes(x.id))));
  useEffect(() => { load().catch(() => setItems([])); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!items?.length) return null;
  const decide = async (id: string, how: 'approve' | 'reject') => {
    setBusy(id); setErr('');
    try { await post(`/api/reviews/${id}/${how}`, {}); await load(); refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const val = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <div className="ai-reviews">
      {items.map((r) => (
        <div key={r.id} className="ai-review" data-status={r.status}>
          <div className="ai-review-head">
            <strong>{r.action === 'create' ? `New in ${r.domainLabel}` : `Change to ${r.recordTitle ?? r.domainLabel}`}</strong>
            {r.status !== 'pending' && <span className="ai-review-done">{r.status === 'approved' ? 'Saved' : 'Not saved'}</span>}
          </div>
          <dl>
            {r.changes.slice(0, 8).map((c) => <div key={c.key}><dt>{c.label}</dt><dd>{c.from !== undefined && r.action === 'update' ? <><s>{val(c.from)}</s> → </> : null}{val(c.to)}</dd></div>)}
          </dl>
          {r.changes.length > 8 && <div className="text-muted" style={{ fontSize: 12 }}>and {r.changes.length - 8} more</div>}
          {r.status === 'pending' && (
            <div className="ai-review-actions">
              <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => decide(r.id, 'approve')}>{busy === r.id ? 'Saving…' : 'Approve'}</button>
              <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => decide(r.id, 'reject')}>No</button>
              <Link to="/admin/review" className="fb-plain" style={{ marginLeft: 'auto' }}>Change it in Review</Link>
            </div>
          )}
        </div>
      ))}
      {err && <p className="fb-error">{err}</p>}
    </div>
  );
}

/** Standing instructions: one set every model follows, and extra ones for the model chosen here (for trying models out). */
function Instructions({ settings, models, modelId, onSettings, onModels }: { settings: Settings; models: Model[]; modelId: string; onSettings: (s: Settings) => void; onModels: () => Promise<void> }) {
  const [all, setAll] = useState(settings.instructions);
  const [which, setWhich] = useState(modelId);
  const m = models.find((x) => x.id === which);
  const [own, setOwn] = useState(m?.instructions ?? '');
  const [saved, setSaved] = useState('');
  useEffect(() => setAll(settings.instructions), [settings.instructions]);
  useEffect(() => setOwn(models.find((x) => x.id === which)?.instructions ?? ''), [which, models]);
  const flash = (s: string) => { setSaved(s); setTimeout(() => setSaved(''), 1800); };
  return (
    <section>
      <div className="fb-label">Your standing instructions</div>
      <p className="text-muted ai-help">Every model follows these in every conversation. Say how you’d like it to work for you: what you’re focused on, how to talk to you, what to always check.</p>
      <textarea className="input ai-area" rows={4} value={all} onChange={(e) => setAll(e.target.value)} placeholder="e.g. I’m paying off debt. Always look for ways to save money. Keep answers short." />
      <div className="ai-row">
        <button type="button" className="btn btn-secondary" disabled={all === settings.instructions} onClick={async () => { onSettings(await put<Settings>('/api/ai/settings', { instructions: all })); flash('all'); }}>Save</button>
        {saved === 'all' && <span className="text-muted ai-saved">Saved</span>}
      </div>
      {models.length > 0 && <>
        <div className="fb-label">Extra instructions for one model</div>
        <p className="text-muted ai-help">Added to the ones above, for this model only. Handy for trying how different models respond.</p>
        {models.length > 1 && <select className="input" value={which} onChange={(e) => setWhich(e.target.value)} style={{ marginBottom: 8 }}>{models.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>}
        <textarea className="input ai-area" rows={3} value={own} onChange={(e) => setOwn(e.target.value)} placeholder={`e.g. Answer in Spanish.`} />
        <div className="ai-row">
          <button type="button" className="btn btn-secondary" disabled={own === (m?.instructions ?? '')} onClick={async () => { await patch(`/api/ai/models/${which}`, { instructions: own }); await onModels(); flash('own'); }}>Save for {m?.label ?? 'this model'}</button>
          {saved === 'own' && <span className="text-muted ai-saved">Saved</span>}
        </div>
      </>}
    </section>
  );
}

/** Saved prompts: one click to ask them again. */
function Prompts({ prompts, onSave }: { prompts: Prompt[]; onSave: (p: { id?: string; text: string }[]) => Promise<void> }) {
  const [draft, setDraft] = useState('');
  return (
    <section>
      <div className="fb-label">Your prompts</div>
      <p className="text-muted ai-help">Things you ask often, one click away. You can also save any message as a prompt while you type.</p>
      {prompts.map((p) => (
        <div key={p.id} className="ai-prompt-row">
          <span>{p.text}</span>
          <button type="button" className="bare fb-plain" onClick={() => onSave(prompts.filter((x) => x.id !== p.id))} aria-label={`Remove “${p.text}”`}>Remove</button>
        </div>
      ))}
      <div className="ai-row">
        <input className="input" style={{ flex: 1 }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="e.g. Check my bills for anything I can cut"
          onKeyDown={async (e) => { if (e.key === 'Enter' && draft.trim()) { await onSave([...prompts, { text: draft.trim() }]); setDraft(''); } }} />
        <button type="button" className="btn btn-secondary" disabled={!draft.trim()} onClick={async () => { await onSave([...prompts, { text: draft.trim() }]); setDraft(''); }}>Add</button>
      </div>
    </section>
  );
}

/** Where your words go with this model, and what it can do on your Little Dipper, in plain words. */
function PrivacyBox({ m }: { m: Model }) {
  const p = m.privacy;
  return (
    <div className="ai-privacy" data-level={p.level}>
      <div className="ai-privacy-head"><span className="ai-privacy-dot" />{p.levelLabel}</div>
      <dl>
        <dt>Your words go to</dt><dd>{p.operator}{p.goesTo && p.operator !== p.goesTo ? <span className="text-muted"> ({p.goesTo})</span> : null}</dd>
        <dt>On the way</dt><dd>{p.inTransit}</dd>
        <dt>Their side</dt><dd>{p.note}{p.site ? <> <a href={`https://${p.site}`} target="_blank" rel="noreferrer">{p.site}</a></> : null}</dd>
        <dt>It can see</dt><dd>{p.sees}</dd>
        <dt>It can do</dt><dd>{p.does}{m.assistant && <> · <Link to={`/admin/relationships/${m.assistant.id}`}>change</Link></>}</dd>
        <dt>Your API key</dt><dd>{p.yourKey}</dd>
      </dl>
    </div>
  );
}

/** Add, see and remove models. The API key is pasted here and never shown again. */
function Models({ models, onChange }: { models: Model[]; onChange: (newId?: string) => Promise<void> }) {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState('claude-opus-5-5');
  const [baseUrl, setBaseUrl] = useState('');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = (p: Provider) => { setProvider(p); setModel(p === 'anthropic' ? 'claude-opus-5-5' : ''); };

  async function add() {
    setBusy(true); setError('');
    try {
      const m = await post<Model>('/api/ai/models', { provider, model, apiKey, label: label || undefined, ...(provider === 'openai' ? { baseUrl } : {}) });
      setApiKey(''); setLabel('');
      await onChange(m.id);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <section className="ai-models">
      {models.length > 0 && <>
        <div className="fb-label">Your models</div>
        {models.map((m) => (
          <div key={m.id} className="ai-model-row">
            <div>
              <strong>{m.label}</strong>
              <div className="text-muted" style={{ fontSize: 12.5 }}>{m.provider === 'anthropic' ? 'Anthropic' : m.baseUrl ? new URL(m.baseUrl).host : ''} · {m.model} · key {m.apiKey}</div>
              <PrivacyBox m={m} />
            </div>
            <button type="button" className="bare fb-plain" onClick={async () => { await del(`/api/ai/models/${m.id}`); await onChange(); }}>Remove</button>
          </div>
        ))}
      </>}

      <div className="fb-label">{models.length ? 'Add another' : 'Add a model to talk to'}</div>
      {!models.length && <p className="text-muted" style={{ fontSize: 13.5, marginTop: 0 }}>Bring your own API key. Your Little Dipper talks to the model directly; you pay the service for what you use. What the model reads goes to the service that runs it.</p>}
      <div className="fb-kinds" role="radiogroup" aria-label="Where the model runs">
        <button type="button" role="radio" aria-checked={provider === 'anthropic'} data-on={provider === 'anthropic' ? '1' : '0'} onClick={() => pick('anthropic')}>Claude (Anthropic)</button>
        <button type="button" role="radio" aria-checked={provider === 'openai'} data-on={provider === 'openai' ? '1' : '0'} onClick={() => pick('openai')}>An open-weight model</button>
      </div>
      {provider === 'openai' && <>
        <div className="fb-label">The service’s API address</div>
        <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" style={{ width: '100%' }} />
        <p className="text-muted" style={{ fontSize: 12.5 }}>Any service with an OpenAI-compatible API: OpenRouter, Together, Fireworks, Hugging Face, your own cloud.</p>
      </>}
      <div className="fb-label">Model</div>
      <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider === 'anthropic' ? 'claude-opus-5-5' : 'e.g. qwen/qwen-2.5-vl-72b-instruct'} style={{ width: '100%' }} />
      <div className="fb-label">API key</div>
      <input className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste it here" style={{ width: '100%' }} />
      <div className="fb-label">Name <span className="text-muted" style={{ fontWeight: 400 }}>(optional)</span></div>
      <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={provider === 'anthropic' ? 'Claude' : 'e.g. Qwen'} style={{ width: '100%' }} />
      {error && <p className="fb-error" style={{ marginTop: 12 }}>{error}</p>}
      <div style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-primary" disabled={busy || !model.trim() || !apiKey.trim() || (provider === 'openai' && !baseUrl.trim())} onClick={add}>{busy ? 'Adding…' : 'Add model'}</button>
      </div>
      <p className="text-muted" style={{ fontSize: 12.5, marginTop: 14 }}>It starts out seeing everything except secret details, and its changes wait for you in Review. Change that on its page any time.</p>
    </section>
  );
}
