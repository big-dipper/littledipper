import { ctx } from './ctx.js';
import type { Doc } from './store/index.js';

export type PasskeyRec = { credentialId: string; publicKey: string; counter: number; transports?: string[]; label: string; createdAt: string; lastUsedAt: string | null };

/**
 * The account: how the owner signs in. Their name and email live in Names and Contact methods (see profile.ts).
 * `setup` holds the name and email typed during claim until the claim completes and they become entries.
 */
export type OwnerDoc = Doc & {
  setup?: { name: string; email: string };
  /** True while a claim (or ownership transfer) is in progress. */
  pending?: boolean;
  passkeys: PasskeyRec[];
  passwordHash: string | null;
  totp: { enabled: boolean; secretEnc: string | null; pendingSecretEnc?: string | null };
  recoveryCodeHashes: { hash: string; usedAt: string | null }[];
  prefs: { showTechnical: boolean };
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
