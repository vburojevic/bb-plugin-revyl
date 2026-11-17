import { describe, expect, it } from "vitest";

import { DEVICE_ACTION, describeDeviceAction } from "../src/device-actions";

describe("describeDeviceAction", () => {
  it("names the actions revyl v0.2.12 sends, with their bodies as seen", () => {
    expect(describeDeviceAction("tap", { x: 200, y: 400 })?.label).toBe("Tapped at 200, 400");
    expect(describeDeviceAction("swipe", { direction: "up", duration_ms: 500, x: 200, y: 600 })?.label).toBe("Swiped up from 200, 600");
    expect(describeDeviceAction("go_home", null)?.label).toBe("Went to the home screen");
    expect(describeDeviceAction("screenshot", null)?.label).toBe("Took a screenshot");
  });

  it("never keeps free text, its length, or a full link", () => {
    const typed = describeDeviceAction("input", { clear_first: true, text: "hunter2", x: 1, y: 2 });
    expect(typed?.label).toBe("Typed text");
    expect(JSON.stringify(typed)).not.toContain("hunter2");
    const step = describeDeviceAction("instruction", { instruction: "log in with test@example.com / hunter2" });
    expect(step?.label).toBe("Ran an instruction step");
    expect(describeDeviceAction("swipe", { direction: "a".repeat(500), x: 1, y: 2 })?.label).toBe("Swiped from 1, 2");
    const link = describeDeviceAction("open_url", { url: "https://example.com/reset?token=secret" });
    expect(link?.label).toBe("Opened a link to example.com");
    expect(JSON.stringify(link)).not.toContain("secret");
  });

  it("skips polls, marks failures and keeps unknown actions readable", () => {
    expect(describeDeviceAction("health", null)).toBeNull();
    expect(describeDeviceAction("logs", null)).toBeNull();
    expect(describeDeviceAction("tap", { x: 1, y: 2 }, false)?.label).toBe("Tapped at 1, 2 (failed)");
    expect(describeDeviceAction("rotate_device", null)?.label).toBe("Rotate device");
    expect(describeDeviceAction("validation", { description: "The dashboard shows" })?.label).toBe("Ran a validation step");
  });

  it("matches only one action segment after the run id", () => {
    expect(DEVICE_ACTION.exec("/api/v1/execution/device-proxy/run-1/tap")?.slice(1)).toEqual(["run-1", "tap"]);
    expect(DEVICE_ACTION.exec("/api/v1/execution/device-proxy/run-1/tap/extra")).toBeNull();
  });
});
