/**
 * Runs and sessions per thread, in the plugin's key-value storage.
 *
 * One key per thread keeps a thread's card a single read. Runs started from
 * the test browser page belong to no thread and live under `PAGE_SCOPE`; runs
 * pinned only by a `::revyl` directive live under `PINNED_SCOPE`.
 */

import { isActive, type Run, type Session } from "./model";

export interface Kv {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export const PAGE_SCOPE = "_page";
export const PINNED_SCOPE = "_pinned";

/** Finished runs kept per scope; active runs are never dropped. */
const MAX_FINISHED_RUNS = 20;
const MAX_SESSIONS = 10;

const runsKey = (scope: string) => `runs:${scope}`;
const sessionsKey = (scope: string) => `sessions:${scope}`;
const ACTIVE_KEY = "active-scopes";
const LIVE_SESSIONS_KEY = "live-session-scopes";

export const scopeOf = (threadId: string | null) => threadId ?? PAGE_SCOPE;

export class Store {
  /** Serializes writes per key so concurrent pollers never lose an update. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly kv: Kv) {}

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  async runs(scope: string): Promise<Run[]> {
    return (await this.kv.get<Run[]>(runsKey(scope))) ?? [];
  }

  async sessions(scope: string): Promise<Session[]> {
    return (await this.kv.get<Session[]>(sessionsKey(scope))) ?? [];
  }

  async activeScopes(): Promise<string[]> {
    return (await this.kv.get<string[]>(ACTIVE_KEY)) ?? [];
  }

  /** Apply `change` to a scope's runs; returns the new list. */
  async updateRuns(scope: string, change: (runs: Run[]) => Run[]): Promise<Run[]> {
    const next = await this.withLock(runsKey(scope), async () => {
      const updated = prune(change(await this.runs(scope)));
      await this.kv.set(runsKey(scope), updated);
      return updated;
    });
    await this.markActive(scope, next.some((run) => isActive(run.status)));
    return next;
  }

  async updateSessions(scope: string, change: (sessions: Session[]) => Session[]): Promise<Session[]> {
    const next = await this.withLock(sessionsKey(scope), async () => {
      const updated = change(await this.sessions(scope))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_SESSIONS);
      await this.kv.set(sessionsKey(scope), updated);
      return updated;
    });
    await this.markIn(LIVE_SESSIONS_KEY, scope, next.some((session) => session.stoppedAt === null));
    return next;
  }

  /** Scopes that have a device session not yet seen to end. */
  async liveSessionScopes(): Promise<string[]> {
    return (await this.kv.get<string[]>(LIVE_SESSIONS_KEY)) ?? [];
  }

  async findRun(taskId: string, scopes: readonly string[]): Promise<{ scope: string; run: Run } | null> {
    for (const scope of scopes) {
      const run = (await this.runs(scope)).find((candidate) => candidate.taskId === taskId);
      if (run !== undefined) return { scope, run };
    }
    return null;
  }

  async cursor(threadId: string): Promise<number | null> {
    const value = await this.kv.get<number>(`cursor:${threadId}`);
    return typeof value === "number" ? value : null;
  }

  async setCursor(threadId: string, seq: number): Promise<void> {
    await this.kv.set(`cursor:${threadId}`, seq);
  }

  async forgetThread(threadId: string): Promise<void> {
    await this.kv.delete(runsKey(threadId));
    await this.kv.delete(sessionsKey(threadId));
    await this.kv.delete(`cursor:${threadId}`);
    await this.markActive(threadId, false);
    await this.markIn(LIVE_SESSIONS_KEY, threadId, false);
  }

  private markActive(scope: string, active: boolean): Promise<void> {
    return this.markIn(ACTIVE_KEY, scope, active);
  }

  private async markIn(key: string, scope: string, present: boolean): Promise<void> {
    await this.withLock(key, async () => {
      const scopes = new Set((await this.kv.get<string[]>(key)) ?? []);
      if (present === scopes.has(scope)) return;
      if (present) scopes.add(scope);
      else scopes.delete(scope);
      await this.kv.set(key, [...scopes]);
    });
  }
}

/** Newest first; every active run kept; finished runs capped. */
export function prune(runs: Run[]): Run[] {
  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
  const active = sorted.filter((run) => isActive(run.status));
  const finished = sorted.filter((run) => !isActive(run.status)).slice(0, MAX_FINISHED_RUNS);
  return [...active, ...finished].sort((a, b) => b.startedAt - a.startedAt);
}
