import { describe, expect, it } from "vitest";

import { formatRunsForCli } from "../src/agent-text";
import { newRun } from "../src/tracker";

const build = (overrides: Record<string, unknown>) => ({
  ...newRun({ kind: "build", taskId: "acbb96cb-10b9-44b8-af48-cc73d9f4af3b", targetId: "app", name: "Tasklet iOS", threadId: "thr", startedAt: 0, origin: "agent" }),
  branchName: "bb/night",
  ...overrides,
});

describe("formatRunsForCli for tests", () => {
  it("says which step a failed test stopped at, and why", () => {
    const run = {
      ...newRun({ kind: "test", taskId: "3c5cfe81-dd1e-4fab-a209-5b34f4061939", targetId: "t", name: "complete-task", threadId: "thr", startedAt: 0, origin: "agent" }),
      status: "failed" as const,
      done: 4,
      total: 4,
      failure: { step: 4, description: "Verify Buy milk shows as done", reason: "The circle next to Buy milk is still empty." },
    };
    expect(formatRunsForCli([run])).toBe(
      [
        "test complete-task: failed 4/4",
        "  failed at step 4: Verify Buy milk shows as done",
        "  reason: The circle next to Buy milk is still empty.",
        '  ::revyl{task="3c5cfe81-dd1e-4fab-a209-5b34f4061939"}',
      ].join("\n"),
    );
  });
});

describe("formatRunsForCli for builds", () => {
  it("tells a failed test step from a broken build, with the job and profile", () => {
    const text = formatRunsForCli([
      build({ status: "failed", profile: "unit-tests", failedStep: "bash .revyl/scripts/unit-tests.sh", error: "bash .revyl/scripts/unit-tests.sh failed with exit code 65" }),
    ]);
    expect(text).toBe(
      [
        "build Tasklet iOS (profile unit-tests): failed",
        "  job acbb96cb-10b9-44b8-af48-cc73d9f4af3b · branch bb/night",
        "  failed step: bash .revyl/scripts/unit-tests.sh",
        "  error: bash .revyl/scripts/unit-tests.sh failed with exit code 65",
      ].join("\n"),
    );
    expect(text).not.toContain("no build id yet");
  });

  it("never says a finished build's id is still to come", () => {
    const passed = formatRunsForCli([build({ status: "passed", profile: "unit-tests", failedStep: "stale" })]);
    expect(passed).toContain("(Revyl returned no build id)");
    expect(passed).not.toContain("yet");
    expect(passed).not.toContain("failed step");
    expect(formatRunsForCli([build({ status: "running" })])).toContain("(no build id yet)");
  });

  it("names the profile and build of a passed build", () => {
    expect(formatRunsForCli([build({ status: "passed", profile: "development", buildId: "v-1", buildVersion: "remote-acbb96cb" })])).toBe(
      [
        "build Tasklet iOS (profile development): passed",
        "  job acbb96cb-10b9-44b8-af48-cc73d9f4af3b · branch bb/night",
        "  build_version_id v-1 (remote-acbb96cb)",
      ].join("\n"),
    );
  });
});
