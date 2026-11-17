import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { MODE_MIGRATIONS } from "../src/mode";
import { STILLS_PER_SESSION, createStillStore } from "../src/stills";

const png = (tag: number) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag]);

function setup() {
  const db = new Database(":memory:");
  for (const statement of MODE_MIGRATIONS) db.exec(statement);
  return createStillStore(db, () => 1000);
}

describe("still store", () => {
  it("numbers screenshots per session and returns the latest or a given one, only to its thread", () => {
    const stills = setup();
    expect(stills.add("thr_a", "s1", png(1))).toBe(1);
    expect(stills.add("thr_a", "s1", png(2))).toBe(2);
    expect(stills.get("thr_a", "s1", null)?.n).toBe(2);
    expect(stills.get("thr_a", "s1", 1)?.png[8]).toBe(1);
    expect(stills.get("thr_b", "s1", null)).toBeNull();
  });

  it("drops unpinned screenshots of devices the thread no longer lists, and all unpinned on archive", () => {
    const stills = setup();
    stills.add("thr_a", "old", png(1));
    stills.add("thr_a", "old", png(2));
    stills.pin("thr_a", "old", 2);
    stills.add("thr_a", "new", png(3));
    stills.keepOnly("thr_a", ["new"]);
    expect(stills.get("thr_a", "old", 1)).toBeNull();
    expect(stills.get("thr_a", "old", 2)).not.toBeNull();
    expect(stills.get("thr_a", "new", 1)).not.toBeNull();
    stills.dropUnpinned("thr_a");
    expect(stills.get("thr_a", "new", 1)).toBeNull();
    expect(stills.get("thr_a", "old", 2)).not.toBeNull();
  });

  it("refuses what is not a PNG", () => {
    expect(setup().add("thr_a", "s1", new TextEncoder().encode("not a png at all"))).toBeNull();
  });

  it("keeps the latest few and every pinned one, until the thread is forgotten", () => {
    const stills = setup();
    stills.add("thr_a", "s1", png(1));
    stills.pin("thr_a", "s1", 1);
    stills.add("thr_a", "s1", png(2));
    for (let i = 0; i < STILLS_PER_SESSION; i++) stills.add("thr_a", "s1", png(3));
    expect(stills.get("thr_a", "s1", 1)).not.toBeNull();
    expect(stills.get("thr_a", "s1", 2)).toBeNull();
    stills.forgetThread("thr_a");
    expect(stills.get("thr_a", "s1", null)).toBeNull();
  });
});
