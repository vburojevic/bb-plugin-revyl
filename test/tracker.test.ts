import { describe, expect, it } from "vitest";

import { RevylCliError, type RevylCli } from "../src/revyl-cli";
import { Store, type Kv } from "../src/store";
import { Tracker, type ThreadEventRow } from "../src/tracker";

class MemoryKv implements Kv {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.data.get(key) as T | undefined;
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}

const T0 = Date.parse("2026-11-16T19:53:00Z");
const TASK = "11111111-1111-4111-8111-111111111111";
const WF_TASK = "22222222-2222-4222-8222-222222222222";

function setup() {
  let now = T0;
  const events: ThreadEventRow[] = [];
  const responses = new Map<string, unknown>();
  const calls: string[][] = [];
  const published: string[] = [];
  const cli = {
    async json(args: readonly string[]) {
      calls.push([...args]);
      const key = args.slice(0, 3).join(" ");
      if (!responses.has(key)) throw new Error(`no fake for ${key}`);
      const response = responses.get(key);
      if (response instanceof Error) throw response;
      return response;
    },
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  } as unknown as RevylCli;
  const store = new Store(new MemoryKv());
  const tracker = new Tracker(store, cli, {
    listEvents: async (_threadId, afterSeq) => events.filter((row) => row.seq > afterSeq),
    listLatestEvents: async () => [...events].reverse(),
    threadCwd: async () => "/work/app",
    publish: (scope) => published.push(scope),
    testNames: async () => new Map([["test-a", "add-task"]]),
    targetName: async (kind: string, id: string) => (kind === "test" && id === "test-a" ? "add-task" : null),
    deviceCwd: "/tmp/device",
    now: () => now,
    log: () => {},
  });
  let seq = 0;
  const event = (type: string, item: Record<string, unknown>, at = now) => {
    events.push({ seq: ++seq, type, createdAt: at, data: { item } });
    return seq;
  };
  return {
    tracker,
    store,
    responses,
    calls,
    published,
    event,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const historyWith = (status: string, steps: number, success: boolean | null) => ({
  test_id: "test-a",
  test_name: "add-task",
  items: [
    {
      task_id: TASK,
      status,
      success,
      started_at: new Date(T0 + 2_000).toISOString(),
      steps_completed: steps,
      total_steps: 5,
      build_id: "build-1",
      build_version: "1.0.1",
      branch_name: "base",
      duration: 69.5,
    },
  ],
});

describe("Tracker", () => {
  it("shows a blocking run from its command, binds it by history, and follows it to the end", async () => {
    const t = setup();
    const seq = t.event("item/started", { type: "commandExecution", id: "i1", command: "revyl test run add-task --json" });
    await t.tracker.ingest("thr", seq);
    let [run] = await t.store.runs("thr");
    expect(run).toMatchObject({ kind: "test", name: "add-task", status: "starting", taskId: null, cwd: "/work/app" });

    t.responses.set("test history add-task", historyWith("running", 2, null));
    t.advance(4_000);
    await t.tracker.tick();
    [run] = await t.store.runs("thr");
    expect(run).toMatchObject({ taskId: TASK, key: TASK, status: "running", done: 2, total: 5 });

    // History looked up by id echoes the id as test_name; the card keeps the real name.
    t.responses.set("test history test-a", { ...historyWith("completed", 5, true), test_name: "55555555-5555-4555-8555-555555555555" });
    t.advance(4_000);
    await t.tracker.tick();
    [run] = await t.store.runs("thr");
    expect(run).toMatchObject({ name: "add-task", status: "passed", done: 5, buildId: "build-1", buildVersion: "1.0.1" });
    expect(run?.finishedAt).not.toBeNull();
    expect(await t.store.activeScopes()).toEqual([]);

    // The command's own output then names the same task: no second card.
    const done = t.event("item/completed", {
      type: "commandExecution",
      id: "i1",
      command: "revyl test run add-task --json",
      aggregatedOutput: `{"report_link": "https://app.revyl.ai/tests/report?taskId=${TASK}"}`,
    });
    await t.tracker.ingest("thr", done);
    expect(await t.store.runs("thr")).toHaveLength(1);
  });

  it("binds a --no-wait run to the task id its own output prints", async () => {
    const t = setup();
    t.event("item/started", { type: "commandExecution", id: "i9", command: "revyl workflow run smoke --no-wait --json" });
    const seq = t.event("item/completed", {
      type: "commandExecution",
      id: "i9",
      command: "revyl workflow run smoke --no-wait --json",
      aggregatedOutput: `{"task_id": "${WF_TASK}", "report_link": "https://app.revyl.ai/workflows/report?taskId=${WF_TASK}"}`,
    });
    await t.tracker.ingest("thr", seq);
    const runs = await t.store.runs("thr");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "workflow", name: "smoke", taskId: WF_TASK, status: "queued" });
  });

  it("creates a run from a report link alone, as a Revyl MCP call leaves", async () => {
    const t = setup();
    const seq = t.event("item/completed", {
      type: "mcpToolCall",
      server: "revyl",
      tool: "run_test",
      result: { content: [{ type: "text", text: `Report: https://app.revyl.ai/tests/report?taskId=${TASK}` }] },
    });
    await t.tracker.ingest("thr", seq);
    const [run] = await t.store.runs("thr");
    expect(run).toMatchObject({ kind: "test", taskId: TASK, name: null });
  });

  it("reads each event once", async () => {
    const t = setup();
    const seq = t.event("item/started", { type: "commandExecution", id: "i1", command: "revyl test run add-task" });
    await t.tracker.ingest("thr", seq);
    await t.tracker.ingest("thr", seq);
    expect(await t.store.runs("thr")).toHaveLength(1);
  });

  it("gives up on a run Revyl never reports", async () => {
    const t = setup();
    const seq = t.event("item/started", { type: "commandExecution", id: "i1", command: "revyl test run ghost" });
    await t.tracker.ingest("thr", seq);
    t.responses.set("test history ghost", { items: [] });
    t.advance(11 * 60_000);
    await t.tracker.tick();
    const [run] = await t.store.runs("thr");
    expect(run?.status).toBe("lost");
  });

  it("follows a workflow and names its tests", async () => {
    const t = setup();
    const seq = t.event("item/completed", {
      type: "commandExecution",
      id: "i2",
      command: "revyl workflow run smoke --no-wait",
      aggregatedOutput: `https://app.revyl.ai/workflows/report?taskId=${WF_TASK}`,
    });
    await t.tracker.ingest("thr", seq);
    t.responses.set(`workflow status ${WF_TASK}`, {
      status: "running",
      workflow_id: "wf-1",
      total_tests: 2,
      completed_tests: 1,
      tests: [
        { id: "c1", test_id: "test-a", status: "completed", success: true },
        { id: "c2", test_id: "test-b", status: "running" },
      ],
    });
    await t.tracker.tick();
    const [run] = await t.store.runs("thr");
    expect(run).toMatchObject({ status: "running", done: 1, total: 2, targetId: "wf-1" });
    expect(run?.children.map((child) => child.name)).toEqual(["add-task", null]);
  });

  it("marks a device session ended when Revyl reports it in a terminal state", async () => {
    const t = setup();
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const seq = t.event("item/completed", {
      type: "commandExecution",
      id: "d1",
      command: "revyl device start --platform ios --json",
      aggregatedOutput: `{"session_id": "${sessionId}", "viewer_url": "https://app.revyl.ai/sessions/${sessionId}", "platform": "ios"}`,
    });
    await t.tracker.ingest("thr", seq);
    expect((await t.store.sessions("thr"))[0]).toMatchObject({ sessionId, stoppedAt: null, origin: "agent" });

    t.responses.set("device info --session-id", new RevylCliError("failed", `Error: session ${sessionId} is in terminal state: completed`, 1));
    await t.tracker.tick();
    expect((await t.store.sessions("thr"))[0]?.stoppedAt).not.toBeNull();
    expect(await t.store.liveSessionScopes()).toEqual([]);
  });

  it("gives a run the proxy saw start to the card already shown from the agent's command", async () => {
    const t = setup();
    const seq = t.event("item/started", { type: "commandExecution", id: "c1", command: "revyl test run add-task --json" });
    await t.tracker.ingest("thr", seq);
    await t.tracker.recordStart("thr", "test", TASK, "test-a");
    const runs = await t.store.runs("thr");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ taskId: TASK, key: TASK, name: "add-task", targetId: "test-a", status: "queued" });
    // The same start reported twice stays one card.
    await t.tracker.recordStart("thr", "test", TASK, "test-a");
    expect(await t.store.runs("thr")).toHaveLength(1);
  });

  it("follows a cloud build the proxy saw start until Revyl reports its build", async () => {
    const t = setup();
    const job = "77777777-7777-4777-8777-777777777777";
    await t.tracker.recordBuild("thr", job, "app-1", "unit-tests");
    t.responses.set(`build status ${job}`, { status: "running", app_id: "app-1", branch_name: "main" });
    await t.tracker.tick();
    expect((await t.store.runs("thr"))[0]).toMatchObject({ kind: "build", status: "running", branchName: "main" });
    t.responses.set(`build status ${job}`, { status: "success", version_id: "build-9", version: "remote-1", branch_name: "main" });
    await t.tracker.tick();
    expect((await t.store.runs("thr"))[0]).toMatchObject({ status: "passed", buildId: "build-9", buildVersion: "remote-1", profile: "unit-tests" });
    expect(await t.store.activeScopes()).toEqual([]);
  });

  it("asks Revyl once which step a failed test stopped at", async () => {
    const t = setup();
    await t.tracker.recordStart("thr", "test", TASK, "test-a");
    t.responses.set("test history test-a", historyWith("failed", 3, false));
    t.responses.set(`run summary ${TASK}`, {
      failed_step_index: 2,
      steps: [
        { index: 0, description: "Open the list", status: "passed" },
        { index: 1, description: "Tap add", status: "passed" },
        { index: 2, description: "Check the new task", status: "failed", status_reason: "No new row appeared." },
      ],
    });
    await t.tracker.tick();
    expect((await t.store.runs("thr"))[0]).toMatchObject({ status: "failed", failure: { step: 3, description: "Check the new task", reason: "No new row appeared." } });
    expect(t.calls.filter((call) => call[0] === "run")).toHaveLength(1);
  });

  it("keeps the step a failed build stopped at", async () => {
    const t = setup();
    const job = "88888888-8888-4888-8888-888888888888";
    await t.tracker.recordBuild("thr", job, "app-1", "unit-tests");
    t.responses.set(`build status ${job}`, {
      status: "failed",
      error: "bash .revyl/scripts/unit-tests.sh failed with exit code 65",
      steps: [
        { index: 0, name: "Prepare project", status: "success" },
        { index: 1, name: "bash .revyl/scripts/unit-tests.sh", status: "failed" },
        { index: 2, name: "xcodebuild", status: null },
      ],
    });
    await t.tracker.tick();
    expect((await t.store.runs("thr"))[0]).toMatchObject({
      status: "failed",
      buildId: null,
      failedStep: "bash .revyl/scripts/unit-tests.sh",
      error: "bash .revyl/scripts/unit-tests.sh failed with exit code 65",
    });
  });

  it("clears a failed step once Revyl's steps no longer show one", async () => {
    const t = setup();
    const job = "99999999-9999-4999-8999-999999999999";
    await t.tracker.recordBuild("thr", job, "app-1", "development");
    t.responses.set(`build status ${job}`, { status: "running", steps: [{ name: "flaky", status: "error" }] });
    await t.tracker.tick();
    expect((await t.store.runs("thr"))[0]?.failedStep).toBe("flaky");
    t.responses.set(`build status ${job}`, { status: "success", version_id: "v-2", steps: [{ name: "flaky", status: "success" }] });
    await t.tracker.tick();
    expect((await t.store.runs("thr"))[0]).toMatchObject({ status: "passed", failedStep: null });
  });

  it("records a device the proxy saw start with the id device actions use", async () => {
    const t = setup();
    await t.tracker.recordDevice("thr", "sess-1", "run-1", "ios");
    expect((await t.store.sessions("thr"))[0]).toMatchObject({ sessionId: "sess-1", workflowRunId: "run-1", stoppedAt: null });
  });

  it("adds no second card when the proxy records the start before the command event arrives", async () => {
    const t = setup();
    await t.tracker.recordStart("thr", "test", TASK, "test-a");
    const seq = t.event("item/started", { type: "commandExecution", id: "c9", command: "revyl test run add-task --json" });
    await t.tracker.ingest("thr", seq);
    const runs = await t.store.runs("thr");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ taskId: TASK, name: "add-task" });
  });

  it("keeps a failing follow-up read from escaping", async () => {
    const t = setup();
    const seq = t.event("item/started", { type: "commandExecution", id: "x1", command: "revyl test run add-task" });
    const failing = new Tracker(t.store, {} as RevylCli, {
      listEvents: async () => {
        throw new Error("BB request timed out after 75 seconds.");
      },
      listLatestEvents: async () => [],
      threadCwd: async () => null,
      publish: () => {},
      testNames: async () => new Map(),
      targetName: async () => null,
      deviceCwd: "/tmp/device",
      now: () => T0,
      log: () => {},
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const first = failing.ingest("thr", seq);
    const second = failing.ingest("thr", seq); // coalesced: runs again after the first
    await expect(first).rejects.toThrow(/timed out/);
    await expect(second).rejects.toThrow(/timed out/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});
