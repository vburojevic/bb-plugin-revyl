/**
 * The plugin's own vocabulary, shared by server and app.
 *
 * Revyl JSON is mapped into these shapes at the boundary (see `revyl-json.ts`),
 * so the UI never reads a raw CLI field and a CLI change breaks one mapper,
 * not five components.
 */

import { z } from "zod";

export const runStatusSchema = z.enum([
  "starting", // seen in the thread, not yet found on Revyl
  "queued",
  "running",
  "passed",
  "failed",
  "cancelled",
  "timeout",
  "lost", // never found on Revyl, or Revyl stopped answering for it
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export { isActive } from "./shared";

export const runKindSchema = z.enum(["test", "workflow", "build"]);
/** Kinds a person can start, re-run or look up history for. */
export const startableKindSchema = z.enum(["test", "workflow"]);
export type RunKind = z.infer<typeof runKindSchema>;

export const runChildSchema = z.object({
  taskId: z.string(),
  testId: z.string().nullable(),
  name: z.string().nullable(),
  status: runStatusSchema,
});
export type RunChild = z.infer<typeof runChildSchema>;

export const runFailureSchema = z.object({
  /** 1-based step number. */
  step: z.number(),
  description: z.string().nullable(),
  reason: z.string().nullable(),
});
export type RunFailure = z.infer<typeof runFailureSchema>;

export const runSchema = z.object({
  /** Stable local key: the task id once known, else `pending:<n>`. */
  key: z.string(),
  threadId: z.string().nullable(),
  kind: runKindSchema,
  name: z.string().nullable(),
  taskId: z.string().nullable(),
  /** Test id (tests) or workflow id (workflows). */
  targetId: z.string().nullable(),
  status: runStatusSchema,
  /** Tests: steps. Workflows: tests. */
  done: z.number().nullable(),
  total: z.number().nullable(),
  passed: z.number().nullable(),
  failed: z.number().nullable(),
  startedAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().nullable(),
  durationSeconds: z.number().nullable(),
  buildId: z.string().nullable(),
  buildVersion: z.string().nullable(),
  branchName: z.string().nullable(),
  origin: z.enum(["agent", "bb"]),
  /** Where the CLI should run to resolve the name (the thread's checkout). */
  cwd: z.string().nullable(),
  error: z.string().nullable(),
  /** The agent tool call that started it, until Revyl gives a task id. */
  sourceItemId: z.string().nullable(),
  children: z.array(runChildSchema),
  /** How many polls in a row could not find or read the run. */
  misses: z.number(),
  // Builds, added in 0.2.5: the build profile, and the step that failed.
  profile: z.string().nullable().optional(),
  failedStep: z.string().nullable().optional(),
  /** Tests, added in 0.2.7: the step a failed run stopped at, and Revyl's reason. */
  failure: runFailureSchema.nullable().optional(),
});
export type Run = z.infer<typeof runSchema>;

/** One thing the agent did on a device, as the proxy saw it. Never typed text. */
export const deviceActionSchema = z.object({
  kind: z.string(),
  label: z.string(),
  at: z.number(),
});
export type DeviceAction = z.infer<typeof deviceActionSchema>;

/** Who or what ended a device session. */
export const sessionEndSchema = z.enum(["agent", "person", "timeout", "revyl", "archived"]);
export type SessionEnd = z.infer<typeof sessionEndSchema>;

export const sessionSchema = z.object({
  sessionId: z.string(),
  /** The id device actions use; known when the proxy saw the start. */
  workflowRunId: z.string().nullable().optional(),
  threadId: z.string().nullable(),
  platform: z.string().nullable(),
  appName: z.string().nullable(),
  screenWidth: z.number().nullable(),
  screenHeight: z.number().nullable(),
  startedAt: z.number(),
  stoppedAt: z.number().nullable(),
  origin: z.enum(["agent", "bb"]),
  /** Idle timeout bb asked for, in seconds, for sessions started from bb. */
  idleTimeoutSeconds: z.number().nullable(),
  // Added in 0.2.4; older stored sessions lack them.
  appId: z.string().nullable().optional(),
  buildVersion: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  endedBy: sessionEndSchema.nullable().optional(),
  /** The agent's latest actions on the device, newest first. */
  actions: z.array(deviceActionSchema).optional(),
  /** Number of the latest screenshot kept for this session (see stills). */
  lastStill: z.number().nullable().optional(),
});
export type Session = z.infer<typeof sessionSchema>;

export const reportStepSchema = z.object({
  index: z.number(),
  type: z.string(),
  description: z.string(),
  status: z.enum(["passed", "failed", "warning", "running", "pending", "skipped"]),
  reasoning: z.string().nullable(),
  videoStart: z.number().nullable(),
  videoEnd: z.number().nullable(),
  screenshotUrl: z.string().nullable(),
});
export type ReportStep = z.infer<typeof reportStepSchema>;

export const testReportSchema = z.object({
  taskId: z.string(),
  testName: z.string().nullable(),
  appName: z.string().nullable(),
  platform: z.string().nullable(),
  deviceModel: z.string().nullable(),
  osVersion: z.string().nullable(),
  buildVersion: z.string().nullable(),
  success: z.boolean().nullable(),
  status: runStatusSchema,
  durationSeconds: z.number().nullable(),
  startedAt: z.string().nullable(),
  summary: z.string().nullable(),
  insights: z.array(z.string()),
  steps: z.array(reportStepSchema),
  videoUrl: z.string().nullable(),
  reportUrl: z.string().nullable(),
  passedSteps: z.number(),
  failedSteps: z.number(),
  totalSteps: z.number(),
  /** Seconds until the media URLs above expire; null when unknown. */
  mediaExpiresInSeconds: z.number().nullable(),
});
export type TestReport = z.infer<typeof testReportSchema>;

export const workflowReportSchema = z.object({
  taskId: z.string(),
  name: z.string().nullable(),
  status: runStatusSchema,
  durationLabel: z.string().nullable(),
  passed: z.number(),
  failed: z.number(),
  total: z.number(),
  completed: z.number(),
  reportUrl: z.string().nullable(),
  tests: z.array(runChildSchema),
});
export type WorkflowReport = z.infer<typeof workflowReportSchema>;

export const cliStatusSchema = z.object({
  state: z.enum(["ready", "missing", "no-key", "error"]),
  /** This machine's revyl CLI is signed in machine-wide, so agents could bypass the proxy. */
  machineSignedIn: z.boolean(),
  version: z.string().nullable(),
  binary: z.string().nullable(),
  orgName: z.string().nullable(),
  email: z.string().nullable(),
  message: z.string().nullable(),
  checkedAt: z.number(),
});
export type CliStatus = z.infer<typeof cliStatusSchema>;

export const appSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string().nullable(),
  latestVersion: z.string().nullable(),
});
export type RevylApp = z.infer<typeof appSchema>;

export const testSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string().nullable(),
  appId: z.string().nullable(),
  appName: z.string().nullable(),
  tags: z.array(z.string()),
});
export type TestSummary = z.infer<typeof testSummarySchema>;

export const workflowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  testIds: z.array(z.string()).nullable(),
});
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

export const browserScopeSchema = z.enum(["project", "org"]);
export type BrowserScope = z.infer<typeof browserScopeSchema>;

export const catalogSchema = z.object({
  scope: browserScopeSchema,
  /** True when the project has a Revyl config with something linked. */
  projectLinked: z.boolean(),
  /** Why project scope fell back to the whole org, when it did. */
  fallbackReason: z.string().nullable(),
  apps: z.array(appSchema),
  tests: z.array(testSummarySchema),
  workflows: z.array(workflowSummarySchema),
  loadedAt: z.number(),
});
export type Catalog = z.infer<typeof catalogSchema>;

export const historyEntrySchema = z.object({
  taskId: z.string(),
  status: runStatusSchema,
  startedAt: z.string().nullable(),
  durationLabel: z.string().nullable(),
  done: z.number().nullable(),
  total: z.number().nullable(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
