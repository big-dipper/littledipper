/** Sensitivity: how widely a fact may travel. Standard can be in your basic profile; secret is encrypted and never public. */
export type Sensitivity = 'standard' | 'sensitive' | 'secret';
export const SENSITIVITIES: Sensitivity[] = ['standard', 'sensitive', 'secret'];

/** A secret value as shown before it's revealed: the last four characters at most. */
export function mask(v: string) {
  if (!v) return '';
  const tail = v.replace(/\s/g, '').slice(-4);
  return '•••• ' + (v.length > 6 ? tail : '');
}
