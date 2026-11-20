import type { KeyRecord } from '@shared/api';

/** What keeps a key from working although it is on, worst first; null when nothing does. */
export function keyProblem(item: KeyRecord, now: number): { tone: 'danger' | 'warn'; text: string } | null {
  if (item.expiresAt !== null && new Date(item.expiresAt).getTime() <= now) return { tone: 'danger', text: '已过期' };
  if (item.costLimit !== null && item.periodCost >= item.costLimit) return { tone: 'danger', text: '已达限额' };
  if (item.restricted && item.modelIds.length === 0) return { tone: 'warn', text: '未选模型' };
  return null;
}

/** The dialog the keys page has open over its list. */
export type KeyDialogState =
  | { kind: 'create' }
  | { kind: 'edit'; item: KeyRecord }
  | { kind: 'reset'; item: KeyRecord }
  | { kind: 'remove'; item: KeyRecord };
