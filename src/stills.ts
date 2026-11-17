/**
 * Screenshots an agent took of its cloud devices, kept so the device pane can
 * show the last screen after a device stops and a reply can pin one screen
 * (`::revyl{device="<session>" shot="<n>"}`). Revyl keeps no screenshot of a
 * plain device session, so these are the only copies.
 *
 * Numbered per session from 1. The latest few of each device the thread
 * still lists are kept, plus the ones a reply shows (pinned, up to a cap per
 * device). Archiving drops all but the pinned; deleting the thread drops all.
 */
import type Database from "better-sqlite3";

export const STILLS_PER_SESSION = 12;
/** At most this many pinned screenshots per device; later pins are not kept past the latest few. */
export const PINS_PER_SESSION = 24;
/** A PNG larger than this is not kept (Revyl's iPhone screenshots are ~150 KB). */
export const MAX_STILL_BYTES = 4 * 1024 * 1024;

export interface Still {
  n: number;
  takenAt: number;
  png: Buffer;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
export const isPng = (bytes: Uint8Array) => bytes.length > 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);

export function createStillStore(db: Database.Database, now: () => number = Date.now) {
  return {
    /** Keep a screenshot; returns its number, or null when it is not a PNG we keep. */
    add(threadId: string, sessionId: string, png: Uint8Array): number | null {
      if (!isPng(png) || png.length > MAX_STILL_BYTES) return null;
      return db.transaction(() => {
        const row = db.prepare(`SELECT MAX(n) AS n FROM device_stills WHERE session_id = ?`).get(sessionId) as { n: number | null };
        const n = (row.n ?? 0) + 1;
        db.prepare(`INSERT INTO device_stills (session_id, n, thread_id, taken_at, png) VALUES (?, ?, ?, ?, ?)`).run(
          sessionId,
          n,
          threadId,
          now(),
          Buffer.from(png),
        );
        db.prepare(`DELETE FROM device_stills WHERE session_id = ? AND n <= ? AND pinned = 0`).run(sessionId, n - STILLS_PER_SESSION);
        return n;
      })();
    },

    /** One screenshot by number, or the latest; only from the given thread. */
    get(threadId: string, sessionId: string, n: number | null): Still | null {
      const row = (
        n === null
          ? db
              .prepare(`SELECT n, taken_at, png FROM device_stills WHERE session_id = ? AND thread_id = ? ORDER BY n DESC LIMIT 1`)
              .get(sessionId, threadId)
          : db.prepare(`SELECT n, taken_at, png FROM device_stills WHERE session_id = ? AND thread_id = ? AND n = ?`).get(sessionId, threadId, n)
      ) as { n: number; taken_at: number; png: Buffer } | undefined;
      return row === undefined ? null : { n: row.n, takenAt: row.taken_at, png: row.png };
    },

    /** Keep this screenshot past the latest few: a reply shows it. */
    pin(threadId: string, sessionId: string, n: number): void {
      const row = db.prepare(`SELECT COUNT(*) AS pins FROM device_stills WHERE session_id = ? AND pinned = 1`).get(sessionId) as { pins: number };
      if (row.pins >= PINS_PER_SESSION) return;
      db.prepare(`UPDATE device_stills SET pinned = 1 WHERE session_id = ? AND thread_id = ? AND n = ?`).run(sessionId, threadId, n);
    },

    /** Drop unpinned screenshots of devices the thread no longer lists. */
    keepOnly(threadId: string, sessionIds: readonly string[]): void {
      const listed = new Set(sessionIds);
      const rows = db.prepare(`SELECT DISTINCT session_id FROM device_stills WHERE thread_id = ? AND pinned = 0`).all(threadId) as Array<{ session_id: string }>;
      const drop = db.prepare(`DELETE FROM device_stills WHERE thread_id = ? AND session_id = ? AND pinned = 0`);
      for (const row of rows) if (!listed.has(row.session_id)) drop.run(threadId, row.session_id);
    },

    /** An archived thread keeps only the screenshots its replies show. */
    dropUnpinned(threadId: string): void {
      db.prepare(`DELETE FROM device_stills WHERE thread_id = ? AND pinned = 0`).run(threadId);
    },

    forgetThread(threadId: string): void {
      db.prepare(`DELETE FROM device_stills WHERE thread_id = ?`).run(threadId);
    },
  };
}
