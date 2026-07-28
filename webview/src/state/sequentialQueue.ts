/*
 * SequentialQueue — run async tasks one at a time, in submission order.
 * ------------------------------------------------------------------
 * The Skills & Tools toggles (W1.5) persist through Hermes's dashboard
 * `PUT /api/skills/toggle` / `PUT /api/tools/toolsets/{name}`, each of which does
 * a read-modify-write of the `skills.disabled` / `platform_toolsets` list in
 * `config.yaml`. Firing several in parallel RACES that RMW (the desktop client
 * hit exactly this — `apps/desktop/src/index.tsx:362`), so a burst of toggles
 * must be SERIALIZED: each waits for the previous to settle before it starts.
 *
 * This is the minimal primitive for that: a promise "tail" every task chains
 * onto. A task's rejection does NOT break the chain (the next task still runs) —
 * the caller still observes its own task's rejection through the returned
 * promise (used for rollback-on-error). Pure and React-free so it is unit
 * testable in plain node.
 */
export class SequentialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Enqueue `task`; it starts only after every previously-enqueued task has
   * settled. Returns a promise that resolves/rejects with `task`'s own outcome.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    // Chain on both settle paths so a prior rejection can't skip this task.
    const result = this.tail.then(task, task);
    // Advance the tail on a SWALLOWED copy so one failure doesn't reject the
    // chain for later tasks (and doesn't surface as an unhandled rejection).
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
