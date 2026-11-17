/**
 * The RPC contract between server.ts and the app. Both schemas run at the
 * wire boundary; the app imports only the type.
 */

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  browserScopeSchema,
  catalogSchema,
  cliStatusSchema,
  historyEntrySchema,
  runKindSchema,
  startableKindSchema,
  runSchema,
  sessionSchema,
  testReportSchema,
  workflowReportSchema,
} from "./model";

const id = z.string().trim().min(1).max(200);
const uuid = z.string().regex(/^[0-9a-f-]{36}$/i, "expected a Revyl id");
const threadId = z.string().trim().min(1).max(100).nullable();

export { REALTIME_RUNS, REALTIME_THREAD_STATE } from "./shared";

const projectId = z.string().trim().min(1).max(100);

export const rpcContract = defineRpcContract({
  thread_mode: {
    input: z.object({ threadId: id }).strict(),
    output: z.object({ on: z.boolean() }),
  },
  set_thread_mode: {
    input: z.object({ threadId: id, on: z.boolean() }).strict(),
    output: z.object({ on: z.boolean() }),
  },
  pending_mode: {
    input: z.object({ projectId }).strict(),
    output: z.object({ on: z.boolean() }),
  },
  set_pending_mode: {
    input: z.object({ projectId, on: z.boolean() }).strict(),
    output: z.object({ on: z.boolean() }),
  },
  set_api_key: {
    input: z.object({ key: z.string().trim().min(8).max(500) }).strict(),
    output: z.object({ connected: z.boolean(), error: z.string().nullable() }),
  },
  clear_api_key: {
    input: z.object({}).strict(),
    output: z.object({ connected: z.boolean() }),
  },
  status: {
    input: z.object({ refresh: z.boolean().optional() }).strict(),
    output: cliStatusSchema,
  },
  thread_runs: {
    input: z.object({ threadId: id }).strict(),
    output: z.object({
      runs: z.array(runSchema),
      sessions: z.array(sessionSchema),
      agentBusy: z.boolean(),
    }),
  },
  page_runs: {
    input: z.object({}).strict(),
    output: z.object({ runs: z.array(runSchema) }),
  },
  run_get: {
    input: z.object({ taskId: uuid, kind: runKindSchema.nullable(), threadId }).strict(),
    output: runSchema.nullable(),
  },
  test_report: {
    input: z.object({ taskId: uuid }).strict(),
    output: testReportSchema,
  },
  workflow_report: {
    input: z.object({ taskId: uuid, name: z.string().max(200).nullable().optional() }).strict(),
    output: workflowReportSchema,
  },
  catalog: {
    input: z
      .object({
        scope: browserScopeSchema,
        projectId: z.string().max(100).nullable(),
        force: z.boolean().optional(),
      })
      .strict(),
    output: catalogSchema,
  },
  linked_projects: {
    input: z.object({}).strict(),
    output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) }),
  },
  history: {
    input: z.object({ kind: startableKindSchema, targetId: uuid }).strict(),
    output: z.object({ entries: z.array(historyEntrySchema) }),
  },
  start_run: {
    input: z
      .object({
        threadId,
        kind: startableKindSchema,
        targetId: uuid,
        name: id,
        projectId: z.string().max(100).nullable(),
      })
      .strict(),
    output: runSchema,
  },
  rerun: {
    input: z.object({ threadId, key: id }).strict(),
    output: runSchema,
  },
  cancel: {
    input: z.object({ threadId, key: id }).strict(),
    output: runSchema,
  },
  dismiss_finished: {
    input: z.object({ threadId }).strict(),
    output: z.object({ removed: z.number() }),
  },
  session_info: {
    input: z.object({ sessionId: uuid }).strict(),
    output: z.object({
      alive: z.boolean(),
      whepUrl: z.string().nullable(),
      platform: z.string().nullable(),
      screenWidth: z.number().nullable(),
      screenHeight: z.number().nullable(),
      viewerUrl: z.string().nullable(),
      idleTimeoutSeconds: z.number().nullable(),
      lastActivityAt: z.number().nullable(),
    }),
  },
  /** One kept screenshot of a thread's device: by number, or the latest. `pin` keeps it past the latest few. */
  device_still: {
    input: z.object({ threadId: id, sessionId: uuid, n: z.number().int().positive().nullable(), pin: z.boolean().optional() }).strict(),
    output: z.object({ n: z.number(), takenAt: z.number(), dataUrl: z.string() }).nullable(),
  },
  session_start: {
    input: z.object({ threadId: id, appId: uuid }).strict(),
    output: sessionSchema,
  },
  session_stop: {
    input: z.object({ threadId: id, sessionId: uuid }).strict(),
    output: z.object({ stopped: z.boolean() }),
  },
  session_input: {
    input: z
      .object({
        threadId: id,
        sessionId: uuid,
        action: z.discriminatedUnion("type", [
          z.object({ type: z.literal("tap"), x: z.number().int().min(0).max(10000), y: z.number().int().min(0).max(10000) }),
          z.object({
            type: z.literal("swipe"),
            x: z.number().int().min(0).max(10000),
            y: z.number().int().min(0).max(10000),
            direction: z.enum(["up", "down", "left", "right"]),
          }),
          z.object({
            type: z.literal("type"),
            text: z.string().min(1).max(500),
            // Revyl types into the field at this point; the CLI requires it.
            x: z.number().int().min(0).max(10000),
            y: z.number().int().min(0).max(10000),
          }),
          z.object({ type: z.literal("home") }),
          z.object({ type: z.literal("back") }),
        ]),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), latencyMs: z.number().nullable() }),
  },
});

export type RpcContract = typeof rpcContract;
