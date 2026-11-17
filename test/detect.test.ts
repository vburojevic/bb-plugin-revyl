import { describe, expect, it } from "vitest";

import { detectCommand, detectMcpRun, detectSessionIds, detectTaskIds, splitSegments } from "../src/detect";

describe("detectCommand", () => {
  it("finds a plain test run", () => {
    expect(detectCommand("revyl test run add-task").runs).toEqual([
      { kind: "test", name: "add-task", chdir: null },
    ]);
  });

  it("finds a workflow run behind env vars, cd and a pipe", () => {
    const command =
      'export REVYL_NO_UPDATE_NOTIFIER=1; cd "$P"; ( revyl workflow run smoke --no-wait --json 2>&1; echo "EXIT=$?" ) | tee out.log';
    expect(detectCommand(command).runs).toEqual([{ kind: "workflow", name: "smoke", chdir: null }]);
  });

  it("skips flag values and reads -C", () => {
    const { runs } = detectCommand("revyl -C apps/ios test run --build-id 123 login-flow --timeout 600");
    expect(runs).toEqual([{ kind: "test", name: "login-flow", chdir: "apps/ios" }]);
  });

  it("reads inline flag values and quoted names", () => {
    const { runs } = detectCommand(`revyl test run --branch=main "checkout flow"`);
    // A name with a space is not something the CLI resolves; refuse it.
    expect(runs).toEqual([]);
    expect(detectCommand(`revyl test run 'checkout-flow' --branch=main`).runs[0]?.name).toBe("checkout-flow");
  });

  it("finds two runs chained with &&", () => {
    const { runs } = detectCommand("revyl test run a && revyl test run b");
    expect(runs.map((run) => run.name)).toEqual(["a", "b"]);
  });

  it("accepts an absolute path to the binary", () => {
    expect(detectCommand("/opt/homebrew/bin/revyl test run a").runs).toHaveLength(1);
  });

  it("ignores other revyl commands and lookalikes", () => {
    expect(detectCommand("revyl test report abc --json").runs).toEqual([]);
    expect(detectCommand("revyl test status add-task").runs).toEqual([]);
    expect(detectCommand("echo revyl test run is great").runs).toEqual([]);
    expect(detectCommand("grep 'revyl test run' notes.md").runs).toEqual([]);
    expect(detectCommand("npm test").runs).toEqual([]);
  });

  it("refuses shell expansions as names", () => {
    expect(detectCommand("revyl test run $TEST").runs).toEqual([]);
  });

  it("reads a command wrapped in a shell, as Codex records it", () => {
    expect(detectCommand(`/bin/zsh -lc "revyl test run smoke --no-wait"`).runs).toEqual([{ kind: "test", name: "smoke", chdir: null }]);
    expect(detectCommand(`bash -c 'cd app && revyl workflow run nightly'`).runs.map((run) => run.name)).toEqual(["nightly"]);
  });

  it("skips values of every flag that takes one", () => {
    expect(detectCommand("revyl test run --var user=bob login").runs[0]?.name).toBe("login");
    expect(detectCommand("revyl test run --orientation landscape login").runs[0]?.name).toBe("login");
  });
});

describe("splitSegments", () => {
  it("keeps quoted separators inside a token", () => {
    expect(splitSegments(`echo "a; b" && ls`)).toEqual([["echo", "a; b"], ["ls"]]);
  });
});

describe("detectTaskIds", () => {
  it("reads test and workflow report links", () => {
    const text = [
      '"report_link": "https://app.revyl.ai/tests/report?taskId=11111111-1111-4111-8111-111111111111"',
      "https://app.revyl.ai/workflows/report?taskId=22222222-2222-4222-8222-222222222222",
      "https://app.revyl.ai/tests/report?taskId=11111111-1111-4111-8111-111111111111",
    ].join("\n");
    expect(detectTaskIds(text)).toEqual([
      { kind: "test", taskId: "11111111-1111-4111-8111-111111111111" },
      { kind: "workflow", taskId: "22222222-2222-4222-8222-222222222222" },
    ]);
  });
});

describe("detectSessionIds", () => {
  it("reads a device start result but not a report's session id", () => {
    const start = '{"session_id": "33333333-3333-4333-8333-333333333333", "viewer_url": "https://app.revyl.ai/sessions/33333333-3333-4333-8333-333333333333"}';
    expect(detectSessionIds(start)).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(detectSessionIds('{"session_id": "44444444-4444-4444-8444-444444444444"}')).toEqual([]);
  });
});

describe("detectMcpRun", () => {
  it("reads a Revyl MCP run_test call", () => {
    expect(detectMcpRun({ type: "mcpToolCall", server: "revyl", tool: "run_test", arguments: { test_name: "login" } })).toEqual({
      kind: "test",
      name: "login",
      chdir: null,
    });
    expect(detectMcpRun({ type: "dynamicToolCall", tool: "mcp__revyl__run_workflow", input: { workflow_name: "smoke" } })?.kind).toBe(
      "workflow",
    );
  });

  it("refuses a name that would reach the CLI as a flag", () => {
    expect(detectMcpRun({ tool: "mcp__revyl__run_test", arguments: { test_name: "--from-checkout" } })).toBeNull();
  });

  it("ignores other servers", () => {
    expect(detectMcpRun({ server: "github", tool: "run_test", arguments: { test_name: "x" } })).toBeNull();
  });
});
