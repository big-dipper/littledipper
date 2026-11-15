/**
 * Mark up a screenshot before sending: drop numbered pins, draw lettered boxes, point with arrows, and write a note
 * on each pin or box. Full window, so there's room to be precise. The marks are drawn into the image that's sent,
 * and also sent as a list, so the issue can quote "#2: this total is wrong".
 *
 * Coordinates are in the screenshot's own pixels. Same mark shape as Smith's feedback tool.
 */
import { useEffect, useRef, useState } from 'react';

export type Mark = { kind: 'pin' | 'box' | 'arrow'; x: number; y: number; w?: number; h?: number; x2?: number; y2?: number; comment?: string };
type Tool = Mark['kind'];

const INK = '#e8613c';
const TOOLS: [Tool, string][] = [['pin', 'Pin'], ['box', 'Box'], ['arrow', 'Arrow']];

function letter(n: number) { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; }

/** Number pins and letter boxes in the order placed (arrows have no label). */
export function labels(marks: Mark[]) {
  let p = 0, b = 0;
  return marks.map((m) => (m.kind === 'pin' ? `${++p}` : m.kind === 'box' ? letter(b++) : ''));
}

/** Draw the marks onto a canvas holding the screenshot. `scale`: canvas pixels per screenshot pixel. */
export function paint(ctx: CanvasRenderingContext2D, img: HTMLImageElement, marks: Mark[], scale: number, draft?: Mark | null) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(img, 0, 0, ctx.canvas.width, ctx.canvas.height);
  const unit = Math.max(1, img.naturalWidth / 1400) * scale;
  const all = draft ? [...marks, draft] : marks;
  const tags = labels(all);
  all.forEach((m, i) => {
    ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineWidth = 3 * unit; ctx.lineCap = 'round';
    const x = m.x * scale, y = m.y * scale;
    if (m.kind === 'box') {
      ctx.strokeRect(x, y, (m.w ?? 0) * scale, (m.h ?? 0) * scale);
      tag(ctx, tags[i], x, y - 4 * unit, unit);
    } else if (m.kind === 'arrow') {
      const x2 = (m.x2 ?? m.x) * scale, y2 = (m.y2 ?? m.y) * scale;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
      const a = Math.atan2(y2 - y, x2 - x), head = 14 * unit;
      ctx.beginPath(); ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(a - 0.45), y2 - head * Math.sin(a - 0.45));
      ctx.lineTo(x2 - head * Math.cos(a + 0.45), y2 - head * Math.sin(a + 0.45));
      ctx.closePath(); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(x, y, 13 * unit, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 2.5 * unit; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `700 ${13 * unit}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(tags[i], x, y + 0.5 * unit);
    }
  });
}

function tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, unit: number) {
  ctx.font = `700 ${13 * unit}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 12 * unit, h = 20 * unit;
  ctx.fillStyle = INK; ctx.fillRect(x, y - h, w, h);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 6 * unit, y - h / 2);
}

export function AnnotateOverlay({ screenshot, initial, onCancel, onDone }: {
  screenshot: string; initial: Mark[]; onCancel: () => void; onDone: (png: string, marks: Mark[]) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [marks, setMarks] = useState<Mark[]>(initial);
  const [tool, setTool] = useState<Tool>('pin');
  const [draft, setDraft] = useState<Mark | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const note = useRef<HTMLTextAreaElement>(null);
  // Focus the note once the click that opened it has finished (it would otherwise take focus back).
  useEffect(() => { if (editing !== null) { const t = setTimeout(() => note.current?.focus(), 30); return () => clearTimeout(t); } }, [editing]);

  useEffect(() => { const i = new Image(); i.onload = () => setImg(i); i.src = screenshot; }, [screenshot]);

  // Fit the screenshot to the window (below the toolbar), never larger than it really is.
  useEffect(() => {
    if (!img) return;
    const fit = () => {
      const s = Math.min((window.innerWidth - 48) / img.naturalWidth, (window.innerHeight - 120) / img.naturalHeight, 1);
      setScale(s);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [img]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    paint(c.getContext('2d')!, img, marks, scale, draft);
  }, [img, marks, draft, scale]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') (editing !== null ? setEditing(null) : onCancel()); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [editing, onCancel]);

  const at = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) / scale), y: Math.round((e.clientY - r.top) / scale) };
  };
  const down = (e: React.PointerEvent) => {
    if (editing !== null) setEditing(null); // a click elsewhere closes the note and carries on
    const p = at(e);
    if (tool === 'pin') { setMarks((m) => [...m, { kind: 'pin', ...p, comment: '' }]); setEditing(marks.length); return; }
    (e.target as Element).setPointerCapture(e.pointerId);
    setDraft(tool === 'box' ? { kind: 'box', ...p, w: 0, h: 0, comment: '' } : { kind: 'arrow', ...p, x2: p.x, y2: p.y });
  };
  const move = (e: React.PointerEvent) => {
    if (!draft) return;
    const p = at(e);
    setDraft(draft.kind === 'box' ? { ...draft, w: p.x - draft.x, h: p.y - draft.y } : { ...draft, x2: p.x, y2: p.y });
  };
  const up = () => {
    if (!draft) return;
    let m = draft;
    if (m.kind === 'box') m = { ...m, x: Math.min(m.x, m.x + (m.w ?? 0)), y: Math.min(m.y, m.y + (m.h ?? 0)), w: Math.abs(m.w ?? 0), h: Math.abs(m.h ?? 0) };
    const tiny = m.kind === 'box' ? (m.w ?? 0) < 6 || (m.h ?? 0) < 6 : Math.hypot((m.x2 ?? 0) - m.x, (m.y2 ?? 0) - m.y) < 8;
    setDraft(null);
    if (tiny) return;
    setMarks((ms) => [...ms, m]);
    if (m.kind === 'box') setEditing(marks.length);
  };

  const done = () => {
    if (!img) return;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    paint(c.getContext('2d')!, img, marks, 1);
    onDone(c.toDataURL('image/png'), marks);
  };

  const tags = labels(marks);
  const ed = editing !== null ? marks[editing] : null;
  return (
    <div className="fb-annotate" data-feedback-widget role="dialog" aria-label="Mark up the screenshot">
      <div className="fb-toolbar">
        <strong>Mark it up</strong>
        <div className="fb-tools">
          {TOOLS.map(([k, l]) => <button key={k} type="button" className="bare" data-on={tool === k ? '1' : '0'} onClick={() => setTool(k)}>{l}</button>)}
        </div>
        <button type="button" className="bare fb-plain" onClick={() => setMarks((m) => m.slice(0, -1))} disabled={!marks.length}>Undo</button>
        <button type="button" className="bare fb-plain" onClick={() => setMarks([])} disabled={!marks.length}>Clear</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="bare fb-plain" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={done}>Done</button>
      </div>
      <p className="fb-hint">{tool === 'pin' ? 'Click to drop a numbered pin, then say what’s there.' : tool === 'box' ? 'Drag to draw a box around something.' : 'Drag to point at something.'}</p>
      <div className="fb-stage">
        <div style={{ position: 'relative' }}>
          <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} style={{ cursor: 'crosshair', display: 'block', touchAction: 'none' }} />
          {ed && editing !== null && (
            <div className="card fb-note" style={{ left: Math.min(ed.x * scale + 18, (img?.naturalWidth ?? 0) * scale - 260), top: ed.y * scale + 14 }}
              onPointerDown={(e) => e.stopPropagation()}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{ed.kind === 'pin' ? `Pin ${tags[editing]}` : `Box ${tags[editing]}`}</div>
              <textarea ref={note} rows={3} className="input" value={ed.comment ?? ''} placeholder="What’s here? (optional)"
                onChange={(e) => setMarks((ms) => ms.map((m, i) => (i === editing ? { ...m, comment: e.target.value.slice(0, 500) } : m)))} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                <button type="button" className="bare fb-plain" onClick={() => { setMarks((ms) => ms.filter((_, i) => i !== editing)); setEditing(null); }}>Remove</button>
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>OK</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
