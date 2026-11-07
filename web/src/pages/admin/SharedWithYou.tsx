import { useState } from 'react';
import type { SharedDomain } from '../../api';
import { EntryCard, fmtRange, GROUPS, Mono, type CardField, type Domain } from '../../life';

/**
 * What someone shares with you, laid out the way your own data is: grouped (Health, Money…), each category folded
 * with its count, each entry in the same card as yours, read-only and marked as theirs. Empty categories aren't
 * shown. A link to another entry they share opens it; links to anything else were never sent.
 */
export default function SharedWithYou({ domains, catalog, first, heading, note }: { domains: SharedDomain[]; catalog: Domain[]; first: string; heading?: string; note?: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const shown = domains.filter((sd) => sd.records.length > 0);
  if (!shown.length) return null;
  const groupOfDomain = (id: string) => catalog.find((d) => d.id === id)?.group ?? 'other';
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Open the category holding a linked entry, then bring the entry into view.
  const openEntry = (recordId: string) => {
    const sd = shown.find((x) => x.records.some((r) => r.id === recordId));
    if (!sd) return;
    setOpen((s) => new Set(s).add(sd.domain));
    setTimeout(() => {
      const el = document.getElementById(`shared-${recordId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.classList.add('entry-flash');
      setTimeout(() => el?.classList.remove('entry-flash'), 1400);
    }, 60);
  };
  const groups = [...GROUPS.map((g) => g.id), 'other'].map((g) => [g, shown.filter((sd) => groupOfDomain(sd.domain) === g)] as const).filter(([, l]) => l.length);

  return (
    <div className="card" style={{ padding: '20px 24px', gap: 14 }}>
      <div>
        <div className="card-kicker">{heading ?? `Shared with you by ${first}`}</div>
        <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{note ?? `Kept up to date by ${first}. It’s theirs: you can read it, not change it.`}</div>
      </div>
      {groups.map(([g, list]) => (
        <div key={g} style={{ display: 'grid', gap: 8 }}>
          <div className="text-muted" style={{ fontSize: 12, fontWeight: 600 }}>{GROUPS.find((x) => x.id === g)?.label ?? 'Other'}</div>
          {list.map((sd) => {
            const d = catalog.find((x) => x.id === sd.domain) ?? { label: sd.label, group: g };
            const isOpen = open.has(sd.domain);
            return (
              <div key={sd.domain} style={{ display: 'grid', gap: 10 }}>
                <button type="button" className="bare" onClick={() => toggle(sd.domain)} aria-expanded={isOpen}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', textAlign: 'left', padding: '4px 0' }}>
                  <Mono d={{ label: sd.label, group: d.group }} size={32} />
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{sd.label}</span>
                  <span className="text-muted" style={{ fontSize: 12 }}>{sd.records.length} {sd.records.length === 1 ? 'entry' : 'entries'} {isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && sd.records.map((r) => (
                  <EntryCard key={r.id} id={`shared-${r.id}`} theirs title={r.title} range={fmtRange(r.validFrom, r.validTo) || undefined} onLink={openEntry}
                    fields={r.fields.map((f): CardField => ({ key: f.key, label: f.label, text: f.value, type: f.type, rows: f.rows, links: f.links }))} />
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
