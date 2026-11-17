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
import { del, get, post } from '../api';
import { Icon } from '../icons';
import { useAdmin } from '../pages/admin/Layout';

type Provider = 'anthropic' | 'openai';
type Model = { id: string; label: string; provider: Provider; baseUrl: string | null; model: string; apiKey: string; assistant: { id: string; name: string } | null };
type ToolNote = { name: string; title: string; ok: boolean; note?: string; pending?: boolean };
type Usage = { input: number; output: number };
type Turn =
  | { role: 'user'; text: string; files: { id: string; name: string }[]; at: string }
  | { role: 'assistant'; text: string; tools: ToolNote[]; stopNote?: string; error?: string; usage: Usage; at: string };
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
  return p ? (u.input * p[1] + u.output * p[2]) / 1e6 : null;
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
  const [view, setView] = useState<'chat' | 'models' | 'history'>('chat');
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
  useEffect(() => { loadModels().catch(() => setModels([])); }, []); // eslint-disable-line react-hooks/exhaustive-deps
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

  async function send(said: string) {
    const t = said.trim();
    if (!t || busy || !model) return;
    setBusy(true); setError(''); setText('');
    const files = doc && attach ? doc.pages.map((p) => p.id) : [];
    let c = chat;
    try {
      if (!c || c.modelId !== model.id) c = await post<Chat>('/api/ai/chats', { model: model.id });
      const shown: Turn = { role: 'user', text: t, files: files.map((id) => ({ id, name: doc!.pages.find((p) => p.id === id)!.name })), at: new Date().toISOString() };
      c = { ...c, turns: [...(c.turns ?? []), shown] };
      setChat(c);
      setLive({ text: '', tools: [] });
      const res = await fetch(`/api/ai/chats/${c.id}/messages`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: t, files, context: `${where} (${loc.pathname})` }),
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
          else if (e.type === 'tool') setLive((l) => l && { ...l, tools: l.tools.map((x) => (x.id === e.id ? { ...x, running: false, ok: e.ok, note: e.note, pending: e.pending } : x)) });
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
      <aside className="fb-panel ai-panel" role="dialog" aria-label="Your assistant">
        <header className="ai-head">
          <div className="ai-title">
            <Icon name="sparkle" size={20} />
            {models && models.length > 1 && view === 'chat' ? (
              <select className="ai-model" value={modelId} onChange={(e) => { setModelId(e.target.value); newChat(); }} aria-label="Model">
                {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            ) : <strong>{view === 'models' ? 'AI models' : view === 'history' ? 'Conversations' : model?.label ?? 'Your assistant'}</strong>}
          </div>
          <div className="ai-head-actions">
            {models?.length ? <>
              <button type="button" className="bare fb-plain" onClick={newChat} disabled={busy} title="New conversation">New</button>
              <button type="button" className="bare fb-plain" onClick={() => (view === 'history' ? setView('chat') : openHistory())} disabled={busy}>{view === 'history' ? 'Back' : 'History'}</button>
              <button type="button" className="bare fb-plain" onClick={() => setView(view === 'models' ? 'chat' : 'models')} disabled={busy}>{view === 'models' ? 'Back' : 'Models'}</button>
            </> : null}
            <button type="button" className="bare fb-plain" onClick={onClose} disabled={busy} aria-label="Close">Close</button>
          </div>
        </header>

        {models === null ? <div className="fb-body text-muted">Loading…</div>
          : !models.length || view === 'models' ? <Models models={models} onChange={async (id) => { await loadModels(); if (id) setModelId(id); if (id) setView('chat'); }} />
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
                    <div className="ai-starters">
                      {starters(loc.pathname, doc).map((s) => <button key={s} type="button" onClick={() => send(s)}>{s}</button>)}
                    </div>
                  </div>
                )}
                {turns.map((t, i) => (t.role === 'user' ? (
                  <div key={i} className="ai-msg ai-me">
                    {t.files.length > 0 && <div className="ai-files">📎 {t.files.length === 1 ? t.files[0].name : `${t.files.length} pages`}</div>}
                    {t.text}
                  </div>
                ) : <Answer key={i} text={t.text} tools={t.tools} note={t.stopNote} error={t.error} />))}
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
                <div className="ai-input">
                  <textarea ref={input} rows={2} value={text} disabled={busy} placeholder={busy ? 'Working on it…' : 'Ask, or tell it what to do'}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text); } }} />
                  <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => send(text)}>Send</button>
                </div>
                {chat && (chat.usage.input + chat.usage.output > 0) && (
                  <div className="ai-meter text-muted">This conversation: {tokens(chat.usage.input)} in · {tokens(chat.usage.output)} out{spent !== null ? ` · about $${spent < 0.01 ? spent.toFixed(3) : spent.toFixed(2)}` : ''}</div>
                )}
              </footer>
            </>
          )}
      </aside>
    </div>
  );
}

function Answer({ text, tools, note, error, thinking }: { text: string; tools: (ToolNote & { running?: boolean })[]; note?: string; error?: string; thinking?: boolean }) {
  return (
    <div className="ai-msg ai-them">
      {tools.length > 0 && (
        <ul className="ai-tools">
          {tools.map((t, i) => (
            <li key={i} data-state={t.running ? 'running' : t.pending ? 'pending' : t.ok ? 'ok' : 'failed'}>
              <span className="ai-tool-dot" />
              <span>{t.title}</span>
              {t.note && <span className="text-muted"> · {t.pending ? <Link to="/admin/review">{t.note}</Link> : t.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {thinking && <div className="ai-thinking"><span /><span /><span /></div>}
      {text && <Rich text={text} />}
      {note && <p className="text-muted" style={{ fontSize: 13 }}>{note}</p>}
      {error && <p className="fb-error">{error}</p>}
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
    <div className="fb-body ai-models">
      {models.length > 0 && <>
        <div className="fb-label">Your models</div>
        {models.map((m) => (
          <div key={m.id} className="ai-model-row">
            <div>
              <strong>{m.label}</strong>
              <div className="text-muted" style={{ fontSize: 12.5 }}>{m.provider === 'anthropic' ? 'Anthropic' : m.baseUrl ? new URL(m.baseUrl).host : ''} · {m.model} · key {m.apiKey}</div>
              {m.assistant && <Link to={`/admin/relationships/${m.assistant.id}`} style={{ fontSize: 13 }}>What it can see and change</Link>}
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
    </div>
  );
}
