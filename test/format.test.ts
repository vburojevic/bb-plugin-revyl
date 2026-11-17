import { describe, expect, it } from "vitest";

import { formatMinutes, formatWhen } from "../app/format";

const NOW = new Date(2026, 10, 17, 15, 0).getTime();

describe("formatWhen", () => {
  it("says Today and Yesterday only for those days, never for the future", () => {
    expect(formatWhen(new Date(2026, 10, 17, 0, 0).toISOString(), NOW)).toMatch(/^Today /);
    expect(formatWhen(new Date(2026, 10, 16, 23, 59).toISOString(), NOW)).toMatch(/^Yesterday /);
    expect(formatWhen(new Date(2026, 10, 18, 9, 0).toISOString(), NOW)).not.toMatch(/^(Today|Yesterday)/);
    expect(formatWhen(new Date(2025, 0, 2, 9, 0).toISOString(), NOW)).toMatch(/2025/);
    expect(formatWhen("not a date", NOW)).toBe("");
  });
});

describe("formatMinutes", () => {
  it("rounds down and says under a minute below one", () => {
    expect(formatMinutes(10_000)).toBe("under a minute");
    expect(formatMinutes(90_000)).toBe("1 min");
    expect(formatMinutes(65 * 60_000)).toBe("1 h 5 min");
  });
});
