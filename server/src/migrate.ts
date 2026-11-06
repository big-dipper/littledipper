/**
 * Data migrations, run at boot and after claim. Idempotent: each step runs at most once per node.
 *
 * 0.4 started every node fresh (the data model was rebuilt with no migration from 0.3), so there are no steps yet.
 * Add new ones with once('step-id', async () => { … }).
 */
import { ctx } from './ctx.js';
import { getNode } from './node.js';

/** Run a migration step at most once per node. */
export async function once(id: string, step: () => Promise<void>) {
  const n = await getNode();
  if (n.migrations?.includes(id)) return;
  await step();
  await ctx.store.update('nodes', n._id, { migrations: [...(n.migrations ?? []), id] });
}

export async function runMigrations(_log: (m: string) => void = () => {}) {
  void ctx;
}
