import { bad } from './auth.js';
import { ctx } from './ctx.js';
import type { Doc } from './store/index.js';

/**
 * How the owner's screens look: ids the web skin defines (a theme, a font pairing), plus light or dark and text
 * size. Kept as given, so a new theme in the skin needs no server change; a skin falls back on ids it doesn't know.
 */
export type Appearance = { theme: string; mode: 'light' | 'dark' | 'system'; textSize: 'standard' | 'larger' | 'largest'; font: string };
export function checkAppearance(v: unknown): Appearance {
  const a = (v ?? {}) as Record<string, unknown>;
  const id = (x: unknown, what: string) => { const s = String(x ?? ''); if (!/^[a-z0-9-]{1,40}$/.test(s)) throw bad('invalid_value', `appearance.${what}: a short id`); return s; };
  const one = <T extends string>(x: unknown, ok: readonly T[], what: string) => { if (!ok.includes(x as T)) throw bad('invalid_value', `appearance.${what}: one of ${ok.join(', ')}`); return x as T; };
  return { theme: id(a.theme, 'theme'), mode: one(a.mode, ['light', 'dark', 'system'] as const, 'mode'), textSize: one(a.textSize, ['standard', 'larger', 'largest'] as const, 'textSize'), font: id(a.font, 'font') };
}

export type PasskeyRec = { credentialId: string; publicKey: string; counter: number; transports?: string[]; label: string; createdAt: string; lastUsedAt: string | null };

/**
 * The account: how the owner signs in. Their name and email live in Names and Contact methods (see profile.ts).
 * `setup` holds the name and email typed during claim until the claim completes and they become entries.
 */
export type OwnerDoc = Doc & {
  setup?: { name: string };
  /** True while a claim (or ownership transfer) is in progress. */
  pending?: boolean;
  passkeys: PasskeyRec[];
  passwordHash: string | null;
  totp: { enabled: boolean; secretEnc: string | null; pendingSecretEnc?: string | null };
  recoveryCodeHashes: { hash: string; usedAt: string | null }[];
  prefs: { showTechnical: boolean; appearance?: Appearance };
  /** The profile lines every connection gets by default; unset means the default list (shares.ts). */
  basicProfile?: string[];
  /** What each relationship pre-ticks at connect time; unset means the defaults (shares.ts). */
  suggestions?: Partial<Record<string, string[]>>;
  createdAt: string;
};

export const getOwner = () => ctx.store.findOne<OwnerDoc>('owners', { pending: { $ne: true } });
export const getPendingOwner = () => ctx.store.findOne<OwnerDoc>('owners', { pending: true });

/** During setup the in-progress owner, otherwise the current one. */
export async function ownerFor(mode: 'setup' | 'session') {
  return mode === 'setup' ? getPendingOwner() : getOwner();
}
