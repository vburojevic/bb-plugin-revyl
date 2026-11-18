import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseJsonOutput } from "../src/revyl-cli";
import {
  mapApps,
  mapHistory,
  mapStatus,
  mapTestReport,
  mapTests,
  mapWorkflowStatus,
  mapWorkflows,
  presignedSecondsLeft,
} from "../src/revyl-json";
import { parseDurationLabel } from "../src/tracker";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const json = (name: string) => JSON.parse(fixture(name)) as unknown;

describe("parseJsonOutput", () => {
  it("reads the object after a blocking run's progress lines", () => {
    const result = parseJsonOutput(fixture("test-run-blocking.txt")) as Record<string, unknown>;
    expect(result.status).toBe("completed");
    expect(result.success).toBe(true);
    expect(typeof result.task_id).toBe("string");
  });

  it("reads plain JSON and refuses text", () => {
    expect(parseJsonOutput('[{"id":"a"}]')).toEqual([{ id: "a" }]);
    expect(() => parseJsonOutput("✓ Created workflow: smoke")).toThrow();
  });
});

describe("mapStatus", () => {
  it("decides finished runs by success", () => {
    expect(mapStatus("completed", true)).toBe("passed");
    expect(mapStatus("completed", false)).toBe("failed");
    expect(mapStatus("queued")).toBe("queued");
    expect(mapStatus("running")).toBe("running");
    expect(mapStatus("cancelled")).toBe("cancelled");
  });
});

describe("mapTestReport", () => {
  it("maps a passing report", () => {
    const report = mapTestReport(json("report.json"), "task", Date.parse("2026-11-16T20:00:00Z"));
    expect(report.status).toBe("passed");
    expect(report.testName).toBe("add-task");
    expect(report.steps).toHaveLength(5);
    expect(report.steps.every((step) => step.status === "passed")).toBe(true);
    expect(report.steps[0]?.screenshotUrl).toMatch(/^https:\/\//);
    expect(report.summary).toBeTruthy();
    expect(report.videoUrl).toMatch(/\.mp4\?/);
    expect(report.mediaExpiresInSeconds).toBeGreaterThan(3000);
  });

  it("uses effective_status: a failed validation reports status success", () => {
    const report = mapTestReport(json("report-failed.json"), "task");
    expect(report.status).toBe("failed");
    expect(report.steps.map((step) => step.status)).toEqual(["passed", "passed", "passed", "failed"]);
    expect(report.steps[3]?.reasoning).toMatch(/1 open/);
    expect(report.failedSteps).toBe(1);
  });
});

describe("cancelled runs", () => {
  it("reads a cancelled session as cancelled, not failed", () => {
    const raw = json("report-failed.json") as Record<string, unknown>;
    const report = mapTestReport({ ...raw, session_status: "cancelled", success: false }, "task");
    expect(report.status).toBe("cancelled");
  });
});

describe("presignedSecondsLeft", () => {
  it("counts down from the signature time", () => {
    const url = "https://x.s3.amazonaws.com/v.mp4?X-Amz-Date=20261116T195432Z&X-Amz-Expires=3600";
    expect(presignedSecondsLeft(url, Date.parse("2026-11-16T20:54:32Z"))).toBe(0);
    expect(presignedSecondsLeft("https://example.com/v.mp4", 0)).toBeNull();
  });
});

describe("history, catalog and workflow mapping", () => {
  it("maps test history", () => {
    const [entry] = mapHistory(json("history.json"));
    expect(entry?.status).toBe("passed");
    expect(entry?.done).toBe(5);
    expect(entry?.startedAtMs).toBeGreaterThan(0);
  });

  it("maps workflow history", () => {
    const [entry] = mapHistory(json("wf-history.json"));
    expect(entry?.status).toBe("failed");
    expect(entry?.total).toBe(2);
  });

  it("maps a finished workflow with names from the catalog", () => {
    const tests = mapTests(json("test-remote.json"));
    const names = new Map(tests.map((test) => [test.id, test.name]));
    const report = mapWorkflowStatus(json("wf-status-final.json"), "task", names, "smoke");
    expect(report.status).toBe("failed");
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.tests.map((test) => [test.name, test.status])).toEqual([
      ["add-task", "passed"],
      ["complete-task", "failed"],
    ]);
  });

  it("treats a workflow whose tests all finished as finished", () => {
    const raw = json("wf-status-final.json") as Record<string, unknown>;
    const report = mapWorkflowStatus({ ...raw, status: "running" }, "task", new Map(), null);
    expect(report.status).toBe("failed");
  });

  it("maps apps, tests and workflows", () => {
    expect(mapApps(json("app-list.json"))[0]?.platform).toBe("iOS");
    expect(mapTests(json("test-remote.json")).map((test) => test.tags)).toEqual([["smoke"], ["smoke"]]);
    expect(mapWorkflows(json("wf-list.json"))[0]?.name).toBe("smoke");
  });
});

describe("parseDurationLabel", () => {
  it("reads Revyl's duration labels", () => {
    expect(parseDurationLabel("3m 20s")).toBe(200);
    expect(parseDurationLabel("69.5s")).toBe(69.5);
    expect(parseDurationLabel(null)).toBeNull();
  });
});

describe("tidyLogLine", () => {
  it("keeps the time and the message of an iOS log line", async () => {
    const { tidyLogLine } = await import("../src/revyl-json");
    expect(
      tidyLogLine("2026-11-17 22:23:41.961699-0800 0x6e0a Error 0x40503 2242 0 Tasklet: (UIKitCore) [com.apple.UIKit:UIFocus] caching"),
    ).toBe("22:23:41 Tasklet: (UIKitCore) [com.apple.UIKit:UIFocus] caching");
    expect(tidyLogLine("plain line")).toBe("plain line");
  });
});
