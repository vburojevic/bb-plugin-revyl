/**
 * Which threads have Test on Revyl on.
 *
 * The switch is per thread. An existing thread sets it from its composer. A
 * thread that does not exist yet (the new-thread composer) cannot be named,
 * so that composer leaves a short-lived flag on its project; the first
 * message a person sends to a new thread of that project claims it (the
 * `message.dispatch` hook), before the agent's session starts. The same
 * pattern as the Limrun plugin's Build on Limrun.
 *
 * SQLite, not key-value storage: bb asks for a thread's instructions
 * synchronously, so the answer must be a synchronous read.
 */
import type Database from "better-sqlite3";

export const MODE_MIGRATIONS = [
  `CREATE TABLE thread_modes (
     thread_id TEXT PRIMARY KEY,
     on_revyl INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE pending_modes (
     project_id TEXT PRIMARY KEY,
     set_at INTEGER NOT NULL
   )`,
  // What a thread may act on through the proxy: only ids the proxy saw it
  // start, or bb started for it. Never ids that merely appeared in its output.
  `CREATE TABLE owned_ids (
     thread_id TEXT NOT NULL,
     id TEXT NOT NULL,
     PRIMARY KEY (thread_id, id)
   )`,
  // Screenshots the agent took of its devices (see src/stills.ts).
  `CREATE TABLE device_stills (
     session_id TEXT NOT NULL,
     n INTEGER NOT NULL,
     thread_id TEXT NOT NULL,
     taken_at INTEGER NOT NULL,
     png BLOB NOT NULL,
     pinned INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (session_id, n)
   )`,
];

/** A new-thread toggle left longer than this no longer applies. */
export const PENDING_FOR_MS = 30 * 60_000;

export interface DispatchFacts {
  attempt: string;
  initiator: string;
  /** bb sets it for a new thread's first message, null for follow-ups. */
  origin: unknown;
  senderThreadId: string | null;
  threadCreatedAt: number;
  now: number;
}

/**
 * Whether a dispatch is a person's first message in a new thread, the only
 * one that may claim a project's new-thread flag. A follow-up (origin null)
 * or a thread an agent started (a sender thread) never does.
 */
export function isNewThreadStart(facts: DispatchFacts): boolean {
  return (
    facts.attempt === "start-turn" &&
    facts.initiator === "user" &&
    facts.origin !== null &&
    facts.senderThreadId === null &&
    facts.now - facts.threadCreatedAt < PENDING_FOR_MS
  );
}

export function createModeStore(db: Database.Database, now: () => number = Date.now) {
  return {
    isOn(threadId: string): boolean {
      const row = db.prepare(`SELECT on_revyl FROM thread_modes WHERE thread_id = ?`).get(threadId) as
        | { on_revyl: number }
        | undefined;
      return row?.on_revyl === 1;
    },

    /** Whether the thread was ever switched either way. */
    known(threadId: string): boolean {
      return db.prepare(`SELECT 1 FROM thread_modes WHERE thread_id = ?`).get(threadId) !== undefined;
    },

    set(threadId: string, on: boolean): void {
      db.prepare(
        `INSERT INTO thread_modes (thread_id, on_revyl, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET on_revyl = excluded.on_revyl, updated_at = excluded.updated_at`,
      ).run(threadId, on ? 1 : 0, now());
    },

    forget(threadId: string): void {
      db.prepare(`DELETE FROM thread_modes WHERE thread_id = ?`).run(threadId);
      db.prepare(`DELETE FROM owned_ids WHERE thread_id = ?`).run(threadId);
    },

    own(threadId: string, ...ids: Array<string | null | undefined>): void {
      const insert = db.prepare(`INSERT OR IGNORE INTO owned_ids (thread_id, id) VALUES (?, ?)`);
      for (const id of ids) if (id) insert.run(threadId, id.toLowerCase());
    },

    owns(threadId: string, id: string): boolean {
      return db.prepare(`SELECT 1 FROM owned_ids WHERE thread_id = ? AND id = ?`).get(threadId, id.toLowerCase()) !== undefined;
    },

    setPending(projectId: string, on: boolean): void {
      if (on) {
        db.prepare(
          `INSERT INTO pending_modes (project_id, set_at) VALUES (?, ?)
           ON CONFLICT(project_id) DO UPDATE SET set_at = excluded.set_at`,
        ).run(projectId, now());
      } else {
        db.prepare(`DELETE FROM pending_modes WHERE project_id = ?`).run(projectId);
      }
    },

    pending(projectId: string): boolean {
      const row = db.prepare(`SELECT set_at FROM pending_modes WHERE project_id = ?`).get(projectId) as
        | { set_at: number }
        | undefined;
      return row !== undefined && now() - row.set_at < PENDING_FOR_MS;
    },

    /** Takes the project's new-thread flag, if one is fresh. */
    claimPending(projectId: string): boolean {
      const fresh = this.pending(projectId);
      db.prepare(`DELETE FROM pending_modes WHERE project_id = ?`).run(projectId);
      return fresh;
    },
  };
}

