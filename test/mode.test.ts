import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { MODE_MIGRATIONS, createModeStore, isNewThreadStart } from "../src/mode";

function store(now = () => 1_000_000) {
  const db = new Database(":memory:");
  for (const statement of MODE_MIGRATIONS) db.exec(statement);
  return createModeStore(db, now);
}

describe("mode store", () => {
  it("switches a thread and forgets it", () => {
    const modes = store();
    expect(modes.isOn("t1")).toBe(false);
    modes.set("t1", true);
    expect(modes.isOn("t1")).toBe(true);
    modes.forget("t1");
    expect(modes.known("t1")).toBe(false);
  });

  it("owns only the ids recorded for that thread", () => {
    const modes = store();
    modes.own("t1", "ABC", null, "def");
    expect(modes.owns("t1", "abc")).toBe(true);
    expect(modes.owns("t1", "DEF")).toBe(true);
    expect(modes.owns("t2", "abc")).toBe(false);
    modes.forget("t1");
    expect(modes.owns("t1", "abc")).toBe(false);
  });

  it("lets the first message of a new thread claim a fresh project flag once", () => {
    let now = 1_000_000;
    const modes = store(() => now);
    modes.setPending("p1", true);
    expect(modes.claimPending("p1")).toBe(true);
    expect(modes.claimPending("p1")).toBe(false);
    modes.setPending("p1", true);
    now += 31 * 60_000;
    expect(modes.claimPending("p1")).toBe(false);
  });

  it("treats only a person's first message in a new thread as a start", () => {
    const base = { attempt: "start-turn", initiator: "user", origin: "app", senderThreadId: null, threadCreatedAt: 0, now: 1_000 };
    expect(isNewThreadStart(base)).toBe(true);
    expect(isNewThreadStart({ ...base, origin: null })).toBe(false);
    expect(isNewThreadStart({ ...base, senderThreadId: "thr_parent" })).toBe(false);
    expect(isNewThreadStart({ ...base, initiator: "agent" })).toBe(false);
  });
});
