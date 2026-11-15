/**
 * Appearance controls: a color theme, light or dark, text size and a font. The same controls in two places: a
 * palette button at the foot of the right-hand rail (quick to reach, to play with) and Settings → Appearance (where
 * people look for it). Changes show straight away and are saved on your Little Dipper, so every device follows.
 */
import { useEffect, useRef, useState } from 'react';
import { FONTS, MODES, TEXT_SIZES, THEMES, resolve, type Appearance, type Theme } from '../../appearance';
import { Pills } from '../../ui';
import { Icon } from '../../icons';
import { useAdmin } from './Layout';

/** A theme as a small swatch: its paper with the two accents on it, in light or dark. */
function Swatch({ t, dark, on, onPick, size = 44 }: { t: Theme; dark: boolean; on: boolean; onPick: () => void; size?: number }) {
  const s = dark ? t.dark : t.light;
  return (
    <button type="button" className="bare" onClick={onPick} aria-pressed={on} title={`${t.label}: ${t.note}`} aria-label={t.label}
      style={{ display: 'grid', justifyItems: 'center', gap: 5, cursor: 'pointer', fontSize: 11.5, color: 'var(--color-text)' }}>
      <span style={{
        width: size, height: size, borderRadius: '50%', background: s.bg, position: 'relative', overflow: 'hidden',
        boxShadow: on ? '0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-accent)' : `inset 0 0 0 1px ${s.surface}, 0 0 0 1px var(--color-divider)`,
      }}>
        <span style={{ position: 'absolute', left: '18%', top: '18%', width: '64%', height: '64%', borderRadius: '50%', background: `conic-gradient(${s.accent} 0 50%, ${s.accent2} 0 75%, ${s.surface} 0)` }} />
      </span>
      <span style={{ fontWeight: on ? 600 : 400, whiteSpace: 'nowrap' }}>{t.label}</span>
    </button>
  );
}

export function AppearanceControls({ compact }: { compact?: boolean }) {
  const { appearance: a, setAppearance } = useAdmin();
  const set = (patch: Partial<Appearance>) => setAppearance({ ...a, ...patch });
  const dark = resolve(a).dark;
  const label = (t: string) => <div style={{ fontWeight: 600, fontSize: 14 }}>{t}</div>;
  return (
    <div style={{ display: 'grid', gap: compact ? 16 : 22 }}>
      <div style={{ display: 'grid', gap: 10 }}>
        {label('Colors')}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${compact ? 64 : 76}px, 1fr))`, gap: compact ? 12 : 16 }}>
          {THEMES.map((t) => <Swatch key={t.id} t={t} dark={dark} on={a.theme === t.id} onPick={() => set({ theme: t.id })} size={compact ? 40 : 48} />)}
        </div>
        {!compact && <div className="text-muted" style={{ fontSize: 13 }}>{THEMES.find((t) => t.id === a.theme)?.note}</div>}
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {label('Light or dark')}
        <Pills value={a.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {label('Text size')}
        <Pills value={a.textSize} options={TEXT_SIZES.map(([k, l]) => [k, l])} onChange={(textSize) => set({ textSize })} />
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {label('Font')}
        <div style={{ display: 'grid', gap: 6, gridTemplateColumns: compact ? '1fr 1fr' : '1fr' }}>
          {FONTS.map((f) => (
            <button key={f.id} type="button" className="bare" onClick={() => set({ font: f.id })} aria-pressed={a.font === f.id}
              style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 12px', borderRadius: 14, cursor: 'pointer', background: a.font === f.id ? 'var(--color-accent-100)' : 'transparent', border: `1px solid ${a.font === f.id ? 'var(--color-accent-300)' : 'var(--color-divider)'}` }}>
              <span style={{ fontFamily: f.heading, fontWeight: f.headingWeight, fontSize: compact ? 15 : 17, minWidth: compact ? 0 : 150 }}>{f.label}</span>
              {!compact && <span className="text-muted" style={{ fontFamily: f.body, fontSize: 13 }}>{f.note}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The palette at the foot of the right-hand rail, opening the controls beside it. */
export function AppearanceButton() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={box} className="ab-appearance">
      <button type="button" className="bare ab-rail-btn" data-on={open ? '1' : '0'} onClick={() => setOpen(!open)} title="Appearance" aria-label="Appearance" aria-expanded={open}>
        <Icon name="palette" size={20} />
      </button>
      {open && (
        <div className="card ab-popover" role="dialog" aria-label="Appearance">
          <AppearanceControls compact />
        </div>
      )}
    </div>
  );
}
