/**
 * Map raw Revyl CLI JSON into the plugin's model.
 *
 * Field names come from what the CLI actually printed (docs/verified.md). The
 * readers are tolerant: a missing or renamed field becomes null, never a
 * throw, so one CLI change degrades a detail instead of the whole card.
 */

import type {
  HistoryEntry,
  ReportStep,
  RevylApp,
  RunChild,
  RunStatus,
  TestReport,
  TestSummary,
  WorkflowReport,
  WorkflowSummary,
} from "./model";

type Json = Record<string, unknown>;

export const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;
export const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};
export const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/**
 * One status vocabulary for every Revyl status string. `success` decides
 * pass or fail once a run is over, because Revyl reports a finished failing
 * test as `completed` with `success: false`.
 */
export function mapStatus(raw: unknown, success: boolean | null = null): RunStatus {
  const status = (str(raw) ?? "").toLowerCase();
  switch (status) {
    case "queued":
    case "pending":
    case "waiting":
      return "queued";
    case "starting":
    case "setup":
    case "setting_up":
    case "provisioning":
    case "running":
    case "in_progress":
    case "active":
      return "running";
    case "completed":
    case "complete":
    case "finished":
    case "done":
      return success === false ? "failed" : success === true ? "passed" : "passed";
    case "success":
    case "succeeded":
    case "passed":
      return "passed";
    case "failed":
    case "failure":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "stopped":
      return "cancelled";
    case "timeout":
    case "timed_out":
      return "timeout";
    default:
      if (success === true) return "passed";
      if (success === false) return "failed";
      return "running";
  }
}

export function parseIsoMs(value: unknown): number | null {
  const text = str(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export interface HistoryItem extends HistoryEntry {
  startedAtMs: number | null;
}

/** `revyl test history <name|id> --json` and `revyl workflow history ... --json`. */
export function mapHistory(raw: unknown): HistoryItem[] {
  const root = obj(raw);
  const items = arr(root.items ?? root.executions);
  return items.map((value) => {
    const item = obj(value);
    const taskId = str(item.task_id) ?? str(item.execution_id) ?? str(item.id) ?? "";
    const success = bool(item.success);
    return {
      taskId,
      status: mapStatus(item.status, success),
      startedAt: str(item.started_at) ?? str(item.execution_time),
      startedAtMs: parseIsoMs(item.started_at ?? item.execution_time),
      durationLabel: str(item.duration_formatted) ?? str(item.duration),
      done: num(item.steps_completed) ?? num(item.completed_tests),
      total: num(item.total_steps) ?? num(item.total_tests),
    };
  }).filter((item) => item.taskId !== "");
}

function stepStatus(raw: Json): ReportStep["status"] {
  const effective = (str(raw.effective_status) ?? "").toLowerCase();
  const status = effective !== "" ? effective : (str(raw.status) ?? "").toLowerCase();
  switch (status) {
    case "passed":
    case "success":
    case "completed":
      return "passed";
    case "failed":
    case "failure":
    case "error":
      return "failed";
    case "warning":
      return "warning";
    case "running":
    case "in_progress":
      return "running";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

const EXPIRES = /[?&]X-Amz-Expires=(\d+)/i;
const SIGNED_AT = /[?&]X-Amz-Date=(\d{8}T\d{6}Z)/i;

/** Seconds left on a presigned S3 URL, from its own query string. */
export function presignedSecondsLeft(url: string | null, now = Date.now()): number | null {
  if (url === null) return null;
  const expires = url.match(EXPIRES);
  const signed = url.match(SIGNED_AT);
  if (expires === null || signed === null) return null;
  const stamp = signed[1]!;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
  const signedAt = Date.parse(iso);
  if (!Number.isFinite(signedAt)) return null;
  return Math.round((signedAt + Number(expires[1]) * 1000 - now) / 1000);
}

/** `revyl test report <task-id> --json`. */
export function mapTestReport(raw: unknown, taskId: string, now = Date.now()): TestReport {
  const root = obj(raw);
  const tldr = obj(root.tldr);
  const steps = arr(root.steps)
    .map((value, position) => {
      const step = obj(value);
      const actions = arr(step.actions).map(obj);
      const screenshot =
        actions.map((action) => str(action.screenshot_before_url)).find((url) => url !== null) ?? null;
      const reasoning =
        str(step.validation_reasoning) ??
        actions.map((action) => str(action.reasoning)).find((text) => text !== null) ??
        null;
      return {
        index: num(step.execution_order) ?? position,
        type: str(step.step_type) ?? "step",
        description: str(step.step_description) ?? "",
        status: stepStatus(step),
        reasoning,
        videoStart: num(step.video_timestamp_start),
        videoEnd: num(step.video_timestamp_end),
        screenshotUrl: screenshot,
      } satisfies ReportStep;
    })
    .sort((a, b) => a.index - b.index);
  const success = bool(root.success);
  const finished = str(root.completed_at) !== null;
  const passed = steps.filter((step) => step.status === "passed").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const videoUrl = str(root.video_url);
  const session = mapStatus(root.session_status, null);
  const status: RunStatus = finished
    ? session === "cancelled" || session === "timeout"
      ? session
      : success === false || failed > 0
        ? "failed"
        : "passed"
    : mapStatus(root.session_status ?? root.status, null);
  return {
    taskId,
    testName: str(root.test_name),
    appName: str(root.app_name),
    platform: str(root.platform),
    deviceModel: str(root.device_model),
    osVersion: str(root.os_version),
    buildVersion: str(root.build_version),
    success,
    status,
    durationSeconds: num(root.duration_seconds),
    startedAt: str(root.started_at),
    summary: str(tldr.test_case) ?? str(root.test_goal_summary),
    insights: arr(tldr.insights).map(str).filter((text): text is string => text !== null),
    steps,
    videoUrl,
    reportUrl: str(root.report_url),
    passedSteps: num(root.effective_passed_steps) ?? passed,
    failedSteps: num(root.effective_failed_steps) ?? failed,
    totalSteps: num(root.total_steps) ?? steps.length,
    mediaExpiresInSeconds: presignedSecondsLeft(videoUrl, now),
  };
}

/** `revyl workflow status <task-id> --json`. Test names come from a catalog. */
export function mapWorkflowStatus(
  raw: unknown,
  taskId: string,
  testNames: ReadonlyMap<string, string>,
  workflowName: string | null,
): WorkflowReport {
  const root = obj(raw);
  const tests: RunChild[] = arr(root.tests).map((value) => {
    const test = obj(value);
    const testId = str(test.test_id);
    return {
      taskId: str(test.id) ?? str(test.task_id) ?? "",
      testId,
      name: str(test.test_name) ?? (testId === null ? null : (testNames.get(testId) ?? null)),
      status: mapStatus(test.status, bool(test.success)),
    };
  });
  const total = num(root.total_tests) ?? tests.length;
  const passed = num(root.passed_tests) ?? tests.filter((test) => test.status === "passed").length;
  const failed = num(root.failed_tests) ?? tests.filter((test) => test.status === "failed").length;
  let status = mapStatus(root.status, null);
  // Revyl keeps a workflow `running` for about a minute after its last test
  // ends. Every child finished is the answer the user is waiting for.
  if (status === "running" && tests.length > 0 && tests.every((test) => !["queued", "running", "starting"].includes(test.status))) {
    status = tests.some((test) => test.status === "failed" || test.status === "timeout") ? "failed" : "passed";
  }
  return {
    taskId,
    name: str(root.workflow_name) ?? workflowName,
    status,
    durationLabel: str(root.duration),
    passed,
    failed,
    total,
    completed: num(root.completed_tests) ?? passed + failed,
    reportUrl: str(root.report_url),
    tests,
  };
}

export function mapApps(raw: unknown): RevylApp[] {
  return arr(obj(raw).apps).map((value) => {
    const app = obj(value);
    return {
      id: str(app.id) ?? "",
      name: str(app.name) ?? "Untitled app",
      platform: str(app.platform),
      latestVersion: str(app.latest_version),
    };
  }).filter((app) => app.id !== "");
}

export function mapTests(raw: unknown): TestSummary[] {
  return arr(obj(raw).tests).map((value) => {
    const test = obj(value);
    return {
      id: str(test.id) ?? "",
      name: str(test.name) ?? "Untitled test",
      platform: str(test.platform),
      appId: str(test.app_id),
      appName: str(test.app_name),
      tags: arr(test.tags).map((tag) => str(obj(tag).name) ?? str(tag)).filter((name): name is string => name !== null),
    };
  }).filter((test) => test.id !== "");
}

export function mapWorkflows(raw: unknown): WorkflowSummary[] {
  const list = Array.isArray(raw) ? raw : arr(obj(raw).workflows);
  return list.map((value) => {
    const workflow = obj(value);
    const testIds = Array.isArray(workflow.test_ids) ? arr(workflow.test_ids).map(str).filter((id): id is string => id !== null) : null;
    return { id: str(workflow.id) ?? "", name: str(workflow.name) ?? "Untitled workflow", testIds };
  }).filter((workflow) => workflow.id !== "");
}

/**
 * An iOS unified-log line without its date, thread, activity and process
 * columns: "22:23:41 Tasklet: (UIKitCore) …". Other lines pass through.
 */
export function tidyLogLine(raw: string): string {
  const match = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2})\.\d+[-+]\d{4}\s+\S+\s+\S+\s+\S+\s+\d+\s+\d+\s+([\s\S]*)$/.exec(raw);
  return match === null ? raw : `${match[1]} ${match[2]}`;
}
