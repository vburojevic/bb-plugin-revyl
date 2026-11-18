/**
 * Turns thread events into runs, and keeps active runs current.
 *
 * Two loops feed one store:
 *
 *  - `ingest` reads a thread's new events after bb says its sequence moved,
 *    and records the runs and sessions the agent started (detect.ts);
 *  - `tick`, driven by a background service, polls Revyl for every active
 *    run: it first binds a run seen only as a command to its Revyl task id
 *    (by name and start time in the test's history), then follows its status.
 *
 * Nothing here imports bb. `TrackerHost` is the seam the server and tests fill.
 */

import { RevylCliError, type RevylCli } from "./revyl-cli";
import {
  detectCommand,
  detectMcpRun,
  detectSessionIds,
  detectTaskIds,
  type DetectedKind,
} from "./detect";
import { isActive, type Run, type RunFailure, type RunKind, type Session, type SessionEnd } from "./model";
import { mapHistory, mapStatus, mapTestReport, mapWorkflowStatus, num, obj, arr, str, bool } from "./revyl-json";
import { PINNED_SCOPE, scopeOf, type Store } from "./store";

export interface ThreadEventRow {
  seq: number;
  type: string;
  createdAt: number;
  data: unknown;
}

export interface TrackerHost {
  /** Item events after `afterSeq`, oldest first, at most EVENT_PAGE. */
  listEvents(threadId: string, afterSeq: number): Promise<ThreadEventRow[]>;
  /** The newest item events, newest first, at most EVENT_PAGE. */
  listLatestEvents(threadId: string): Promise<ThreadEventRow[]>;
  /** The thread's checkout when it is on this machine, else null. */
  threadCwd(threadId: string): Promise<string | null>;
  /** Tell open clients a scope's runs or sessions changed. */
  publish(scope: string): void;
  /** Test names by test id, for workflow children. */
  testNames(): Promise<ReadonlyMap<string, string>>;
  /** A test's or workflow's name by id, or an app's name for a build. */
  targetName(kind: RunKind, id: string): Promise<string | null>;
  /** Folder `revyl device` commands run in (they write session files there). */
  deviceCwd: string;
  now(): number;
  log(level: "info" | "warn", message: string, detail?: Record<string, unknown>): void;
}

/**
 * When a thread is first seen (a fresh install, or events bb sent while the
 * plugin was not loaded), its recent item events are read back this far, so a
 * run already in flight still gets its card. Older runs are history.
 */
const FIRST_SIGHT_WINDOW_MS = 30 * 60_000;
/** A run seen as a command but never found on Revyl is given up after this. */
const BIND_GIVE_UP_MS = 10 * 60_000;
/** History entries may start a little before bb recorded the command. */
const START_SLACK_MS = 30_000;
/** Consecutive read failures before an active run is marked lost. */
const MAX_MISSES = 40;
/** bb returns at most this many thread events per read. */
export const EVENT_PAGE = 100;
/** How often active runs are polled. */
export const TICK_MS = 4_000;
/** How often a live device session is checked for having ended on Revyl. */
const SESSION_CHECK_MS = 30_000;

let pendingCounter = 0;

export function newRun(fields: Partial<Run> & Pick<Run, "kind" | "threadId" | "startedAt" | "origin">): Run {
  const taskId = fields.taskId ?? null;
  return {
    key: taskId ?? `pending:${fields.startedAt}:${++pendingCounter}`,
    name: null,
    taskId,
    targetId: null,
    status: taskId === null ? "starting" : "queued",
    done: null,
    total: null,
    passed: null,
    failed: null,
    updatedAt: fields.startedAt,
    finishedAt: null,
    durationSeconds: null,
    buildId: null,
    buildVersion: null,
    branchName: null,
    cwd: null,
    error: null,
    sourceItemId: null,
    children: [],
    misses: 0,
    ...fields,
  };
}

export class Tracker {
  private readonly ingesting = new Map<string, Promise<void>>();
  private readonly sessionChecked = new Map<string, number>();
  private readonly pendingIngest = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly cli: RevylCli,
    private readonly host: TrackerHost,
  ) {}

  /** bb says this thread's events advanced. Coalesces overlapping calls. */
  ingest(threadId: string, latestSeq: number): Promise<void> {
    const running = this.ingesting.get(threadId);
    if (running !== undefined) {
      this.pendingIngest.add(threadId);
      return running;
    }
    const work = this.ingestNow(threadId, latestSeq).finally(() => {
      this.ingesting.delete(threadId);
      // A follow-up read runs detached: its failure (a bb request timing out)
      // must not escape as an uncaught error.
      if (this.pendingIngest.delete(threadId)) {
        this.ingest(threadId, latestSeq).catch((error: unknown) =>
          this.host.log("warn", "ingest", { error: error instanceof Error ? error.message : String(error) }),
        );
      }
    });
    this.ingesting.set(threadId, work);
    return work;
  }

  private async ingestNow(threadId: string, latestSeq: number): Promise<void> {
    let cursor = await this.store.cursor(threadId);
    if (cursor === null) {
      const recent = (await this.host.listLatestEvents(threadId))
        .filter((row) => this.host.now() - row.createdAt <= FIRST_SIGHT_WINDOW_MS)
        .sort((a, b) => a.seq - b.seq);
      for (const row of recent) await this.handleEvent(threadId, row);
      cursor = Math.max(latestSeq, ...recent.map((row) => row.seq));
      await this.store.setCursor(threadId, cursor);
      // Events newer than latestSeq that arrived meanwhile are read below.
    }
    for (let page = 0; page < 20; page++) {
      const rows = await this.host.listEvents(threadId, cursor);
      if (rows.length === 0) break;
      for (const row of rows) {
        await this.handleEvent(threadId, row);
        cursor = Math.max(cursor, row.seq);
      }
      await this.store.setCursor(threadId, cursor);
      if (rows.length < EVENT_PAGE) break;
    }
  }

  private async handleEvent(threadId: string, row: ThreadEventRow): Promise<void> {
    const item = obj(obj(row.data).item);
    const itemType = str(item.type);
    if (itemType === null) return;
    if (row.type === "item/started") {
      if (itemType === "commandExecution") {
        const command = str(item.command);
        if (command === null) return;
        const detection = detectCommand(command);
        if (detection.runs.length === 0) return;
        const cwd = await this.host.threadCwd(threadId);
        await this.addPending(
          threadId,
          detection.runs.map((run) => ({
            kind: run.kind,
            name: run.name,
            cwd: resolveChdir(cwd, run.chdir),
            itemId: str(item.id),
          })),
          row.createdAt,
        );
        return;
      }
      const mcp = detectMcpRun(item);
      if (mcp !== null) {
        const cwd = await this.host.threadCwd(threadId);
        await this.addPending(threadId, [{ kind: mcp.kind, name: mcp.name, cwd: mcp.chdir ?? cwd, itemId: str(item.id) }], row.createdAt);
      }
      return;
    }
    if (row.type === "item/completed") {
      const text =
        itemType === "commandExecution"
          ? `${str(item.command) ?? ""}\n${str(item.aggregatedOutput) ?? ""}`
          : JSON.stringify(item);
      const taskIds = detectTaskIds(text);
      if (taskIds.length > 0) await this.bindTaskIds(threadId, str(item.id), taskIds, row.createdAt);
      if (/\bdevice\b/.test(text)) {
        const sessionIds = detectSessionIds(text);
        if (sessionIds.length > 0) await this.addSessions(threadId, sessionIds, row.createdAt, text);
      }
    }
  }

  private async addPending(
    threadId: string,
    detected: Array<{ kind: DetectedKind; name: string; cwd: string | null; itemId: string | null }>,
    at: number,
  ): Promise<void> {
    await this.store.updateRuns(threadId, (runs) => [
      ...detected
        .filter((d) => d.itemId === null || !runs.some((run) => run.sourceItemId === d.itemId && run.name === d.name))
        // The proxy may have recorded this start before the command event arrived.
        .filter(
          (d) =>
            !runs.some(
              (run) =>
                run.taskId !== null &&
                run.kind === d.kind &&
                (run.name === null || run.name === d.name) &&
                Math.abs(run.startedAt - at) < 2 * 60_000,
            ),
        )
        .map((d) =>
          newRun({
            kind: d.kind,
            name: d.name,
            threadId,
            startedAt: at,
            origin: "agent",
            cwd: d.cwd,
            sourceItemId: d.itemId,
          }),
        ),
      ...runs,
    ]);
    this.host.publish(threadId);
  }

  private async bindTaskIds(
    threadId: string,
    itemId: string | null,
    taskIds: Array<{ kind: RunKind; taskId: string }>,
    at: number,
  ): Promise<void> {
    await this.store.updateRuns(threadId, (runs) => {
      const next = [...runs];
      for (const { kind, taskId } of taskIds) {
        if (next.some((run) => run.taskId === taskId)) continue;
        // Prefer the run this very tool call created, then the oldest unbound
        // run of the same kind.
        const unbound = next
          .filter((run) => run.taskId === null && run.kind === kind)
          .sort((a, b) => a.startedAt - b.startedAt);
        const match = (itemId === null ? undefined : unbound.find((run) => run.sourceItemId === itemId)) ?? unbound[0];
        if (match !== undefined) {
          const index = next.indexOf(match);
          next[index] = { ...match, key: taskId, taskId, status: "queued", error: null, sourceItemId: null, updatedAt: at };
        } else {
          next.unshift(newRun({ kind, taskId, threadId, startedAt: at, origin: "agent" }));
        }
      }
      return next;
    });
    this.host.publish(threadId);
  }

  private async addSessions(threadId: string, sessionIds: string[], at: number, text: string): Promise<void> {
    const platform = text.match(/"platform"\s*:\s*"(ios|android|web)"/i)?.[1]?.toLowerCase() ?? null;
    const width = num(text.match(/"screen_width"\s*:\s*(\d+)/)?.[1]);
    const height = num(text.match(/"screen_height"\s*:\s*(\d+)/)?.[1]);
    await this.store.updateSessions(threadId, (sessions) => [
      ...sessionIds
        .filter((id) => !sessions.some((session) => session.sessionId === id))
        .map(
          (sessionId): Session => ({
            sessionId,
            threadId,
            platform,
            appName: null,
            screenWidth: width,
            screenHeight: height,
            startedAt: at,
            stoppedAt: null,
            origin: "agent",
            idleTimeoutSeconds: null,
          }),
        ),
      ...sessions,
    ]);
    this.host.publish(threadId);
  }

  /**
   * A test or workflow run the proxy saw a thread start. A run already shown
   * from the agent's command (no task id yet) takes the id instead of a
   * second card appearing.
   */
  async recordStart(threadId: string, kind: "test" | "workflow", taskId: string, targetId: string | null): Promise<void> {
    const now = this.host.now();
    const name = targetId === null ? null : await this.host.targetName(kind, targetId);
    await this.store.updateRuns(threadId, (runs) => {
      if (runs.some((run) => run.taskId === taskId)) return runs;
      const pending = runs
        .filter((run) => run.taskId === null && run.kind === kind && now - run.startedAt < 3 * 60_000)
        .filter((run) => name === null || run.name === null || run.name === name || run.name === targetId)
        .sort((a, b) => a.startedAt - b.startedAt)[0];
      if (pending !== undefined) {
        return runs.map((run) =>
          run === pending
            ? { ...run, key: taskId, taskId, targetId, name: name ?? run.name, status: "queued" as const, sourceItemId: null, updatedAt: now }
            : run,
        );
      }
      return [newRun({ kind, taskId, targetId, name, threadId, startedAt: now, origin: "agent" }), ...runs];
    });
    this.host.publish(threadId);
  }

  /** A cloud build the proxy saw a thread start. */
  async recordBuild(threadId: string, jobId: string, appId: string | null, profile: string | null = null): Promise<void> {
    const now = this.host.now();
    const appName = appId === null ? null : await this.host.targetName("build", appId);
    await this.store.updateRuns(threadId, (runs) =>
      runs.some((run) => run.taskId === jobId)
        ? runs
        : [{ ...newRun({ kind: "build", taskId: jobId, targetId: appId, name: appName, threadId, startedAt: now, origin: "agent" }), profile }, ...runs],
    );
    this.host.publish(threadId);
  }

  /** A device the proxy saw a thread start; it carries the id device actions use. */
  async recordDevice(threadId: string, sessionId: string, workflowRunId: string | null, platform: string | null): Promise<void> {
    const now = this.host.now();
    await this.store.updateSessions(threadId, (sessions) => {
      const known = sessions.find((session) => session.sessionId === sessionId);
      if (known !== undefined) {
        return sessions.map((session) => (session === known ? { ...session, workflowRunId: workflowRunId ?? session.workflowRunId ?? null } : session));
      }
      return [
        {
          sessionId,
          workflowRunId,
          threadId,
          platform: platform?.toLowerCase() ?? null,
          appName: null,
          screenWidth: null,
          screenHeight: null,
          startedAt: now,
          stoppedAt: null,
          origin: "agent",
          idleTimeoutSeconds: null,
        } satisfies Session,
        ...sessions,
      ];
    });
    this.host.publish(threadId);
  }

  /** Record a run bb itself started (from a card, the page or a directive). */
  async addStarted(scope: string, run: Run): Promise<void> {
    await this.store.updateRuns(scope, (runs) => [run, ...runs.filter((other) => other.key !== run.key)]);
    this.host.publish(scope);
  }

  /** Follow a task id a `::revyl` directive names, when no thread tracks it. */
  async pin(taskId: string, kind: RunKind | null): Promise<Run | null> {
    const scopes = [...(await this.store.activeScopes()), PINNED_SCOPE];
    const known = await this.store.findRun(taskId, scopes);
    if (known !== null) return known.run;
    const resolvedKind = kind ?? (await this.guessKind(taskId));
    if (resolvedKind === null) return null;
    const run = newRun({ kind: resolvedKind, taskId, threadId: null, startedAt: this.host.now(), origin: "agent" });
    const polled = await this.poll(run);
    await this.store.updateRuns(PINNED_SCOPE, (runs) => [polled, ...runs.filter((other) => other.taskId !== taskId)]);
    return polled;
  }

  private async guessKind(taskId: string): Promise<RunKind | null> {
    try {
      const report = await this.cli.json(["test", "report", taskId, "--no-steps"]);
      if (str(obj(report).test_id) !== null || str(obj(report).execution_id) !== null) return "test";
    } catch {
      // Not a test task; try a workflow.
    }
    try {
      const status = await this.cli.json(["workflow", "status", taskId]);
      if (str(obj(status).workflow_id) !== null || Array.isArray(obj(status).tests)) return "workflow";
    } catch {
      // Neither.
    }
    return null;
  }

  /**
   * Mark sessions that ended on Revyl (idle timeout, or the agent stopped
   * them) so cards stop calling them live. Revyl answers `device info` for an
   * ended session with an error naming its terminal state.
   */
  async checkSessions(signal?: AbortSignal): Promise<void> {
    const now = this.host.now();
    for (const scope of await this.store.liveSessionScopes()) {
      for (const session of await this.store.sessions(scope)) {
        if (signal?.aborted) return;
        if (session.stoppedAt !== null) continue;
        if (now - (this.sessionChecked.get(session.sessionId) ?? 0) < SESSION_CHECK_MS) continue;
        this.sessionChecked.set(session.sessionId, now);
        let ended = false;
        let endedBy: SessionEnd = "revyl";
        try {
          await this.cli.json(["device", "info", "--session-id", session.sessionId], { cwd: this.host.deviceCwd, timeoutMs: 20_000 });
        } catch (error) {
          ended = error instanceof RevylCliError && error.kind === "failed" && /terminal state|not found|no session/i.test(error.message);
          if (ended && /terminal state:\s*timeout/i.test((error as Error).message)) endedBy = "timeout";
        }
        if (!ended) continue;
        await this.store.updateSessions(scope, (sessions) =>
          sessions.map((other) => (other.sessionId === session.sessionId && other.stoppedAt === null ? { ...other, stoppedAt: now, endedBy } : other)),
        );
        this.host.publish(scope);
      }
    }
  }

  /** One pass over every active run in every scope. */
  async tick(signal?: AbortSignal): Promise<void> {
    await this.checkSessions(signal);
    const scopes = await this.store.activeScopes();
    for (const scope of scopes) {
      if (signal?.aborted) return;
      const runs = await this.store.runs(scope);
      const active = runs.filter((run) => isActive(run.status));
      if (active.length === 0) {
        await this.store.updateRuns(scope, (current) => current);
        continue;
      }
      const updates = new Map<string, Run>();
      for (const run of active) {
        if (signal?.aborted) return;
        let next = run.taskId === null ? await this.bind(run, runs, updates) : await this.poll(run);
        // A test that just failed: ask Revyl once which step it stopped at, and why.
        if (next.kind === "test" && next.status === "failed" && next.failure == null && next.taskId !== null) {
          next = { ...next, failure: await this.failureOf(next.taskId) };
        }
        if (!sameRun(run, next)) updates.set(run.key, next);
      }
      if (updates.size > 0) {
        await this.store.updateRuns(scope, (current) =>
          current.map((run) => {
            const update = updates.get(run.key);
            return update === undefined ? run : { ...update, key: update.taskId ?? update.key };
          }),
        );
        this.host.publish(scope);
      }
    }
  }

  /** Find the Revyl execution for a run seen only as a command. */
  private async bind(run: Run, all: readonly Run[], claimed: ReadonlyMap<string, Run>): Promise<Run> {
    const now = this.host.now();
    if (run.kind === "build" || run.name === null || now - run.startedAt > BIND_GIVE_UP_MS) {
      return { ...run, status: "lost", error: "Revyl never reported this run.", updatedAt: now, finishedAt: now };
    }
    const taken = new Set(
      [...all, ...claimed.values()].map((other) => other.taskId).filter((id): id is string => id !== null),
    );
    try {
      const raw = await this.cli.json([run.kind, "history", run.name, "--limit", "5"], { cwd: run.cwd });
      const entries = mapHistory(raw)
        .filter((entry) => entry.startedAtMs === null || entry.startedAtMs >= run.startedAt - START_SLACK_MS)
        .filter((entry) => !taken.has(entry.taskId))
        .sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
      const entry = entries[0];
      const targetId = str(obj(raw).test_id) ?? str(obj(raw).workflow_id);
      if (entry === undefined) return { ...run, targetId: targetId ?? run.targetId, misses: 0 };
      return {
        ...run,
        taskId: entry.taskId,
        targetId: targetId ?? run.targetId,
        status: entry.status,
        done: entry.done,
        total: entry.total,
        error: null,
        sourceItemId: null,
        misses: 0,
        updatedAt: now,
      };
    } catch (error) {
      return this.miss(run, error);
    }
  }

  /** Read a bound run's current state from Revyl. */
  async poll(run: Run): Promise<Run> {
    const now = this.host.now();
    if (run.taskId === null) return run;
    try {
      if (run.kind === "build") {
        const raw = obj(await this.cli.json(["build", "status", run.taskId], { cwd: this.host.deviceCwd, timeoutMs: 30_000 }));
        const status = mapStatus(raw.status, null);
        const finished = !isActive(status);
        const problem = str(raw.error);
        const fix = str(raw.suggested_fix);
        // Revyl's steps, when it sent them, are the whole answer: a step that failed then passed clears.
        const steps = Array.isArray(raw.steps) ? raw.steps.map(obj) : null;
        const failing = steps?.find((step) => mapStatus(step.status, null) === "failed") ?? null;
        const failedStep = steps === null ? (run.failedStep ?? null) : failing === null ? null : (str(failing.name) ?? str(failing.command));
        return {
          ...run,
          name: run.name ?? (str(raw.app_id) === null ? null : await this.host.targetName("build", str(raw.app_id)!)),
          status,
          buildId: str(raw.version_id) ?? run.buildId,
          buildVersion: str(raw.version) ?? run.buildVersion,
          branchName: str(raw.branch_name) ?? run.branchName,
          durationSeconds: finished && run.durationSeconds === null ? Math.round((now - run.startedAt) / 1000) : run.durationSeconds,
          finishedAt: finished ? (run.finishedAt ?? now) : null,
          misses: 0,
          error: problem === null ? null : fix === null ? problem : `${problem} ${fix}`,
          failedStep,
          updatedAt: now,
        };
      }
      if (run.kind === "workflow") {
        const raw = await this.cli.json(["workflow", "status", run.taskId], { cwd: run.cwd });
        const report = mapWorkflowStatus(raw, run.taskId, await this.host.testNames(), run.name);
        const finished = !isActive(report.status);
        return {
          ...run,
          name: run.name ?? realName(report.name) ?? (run.targetId === null ? null : await this.host.targetName("workflow", run.targetId)),
          targetId: str(obj(raw).workflow_id) ?? run.targetId,
          status: report.status,
          done: report.completed,
          total: report.total,
          passed: report.passed,
          failed: report.failed,
          children: report.tests,
          durationSeconds: finished ? parseDurationLabel(report.durationLabel) : run.durationSeconds,
          finishedAt: finished ? (run.finishedAt ?? now) : null,
          misses: 0,
          error: null,
          updatedAt: now,
        };
      }
      const lookup = run.targetId ?? run.name;
      if (lookup !== null) {
        const raw = await this.cli.json(["test", "history", lookup, "--limit", "10"], { cwd: run.cwd });
        const root = obj(raw);
        const item = arr(root.items).map(obj).find((entry) => str(entry.task_id) === run.taskId || str(entry.id) === run.taskId);
        if (item !== undefined) {
          const status = mapStatus(item.status, bool(item.success));
          const finished = !isActive(status);
          return {
            ...run,
            name: run.name ?? realName(str(root.test_name)) ?? (run.targetId === null ? null : await this.host.targetName("test", run.targetId)),
            targetId: str(root.test_id) ?? run.targetId,
            status,
            done: num(item.steps_completed),
            total: num(item.total_steps),
            durationSeconds: num(item.duration),
            buildId: str(item.build_id) ?? run.buildId,
            buildVersion: str(item.build_version) ?? run.buildVersion,
            branchName: str(item.branch_name) ?? run.branchName,
            finishedAt: finished ? (run.finishedAt ?? now) : null,
            misses: 0,
            error: null,
            updatedAt: now,
          };
        }
      }
      // Not in recent history (or no name yet): read the report itself.
      const raw = await this.cli.json(["test", "report", run.taskId, "--no-steps"], { cwd: run.cwd });
      const report = mapTestReport(raw, run.taskId, now);
      const root = obj(raw);
      const finished = !isActive(report.status);
      return {
        ...run,
        name: run.name ?? realName(report.testName),
        targetId: str(root.test_id) ?? run.targetId,
        status: report.status,
        done: report.passedSteps + report.failedSteps,
        total: report.totalSteps,
        durationSeconds: report.durationSeconds,
        buildId: str(root.resolved_build_id) ?? run.buildId,
        buildVersion: report.buildVersion ?? run.buildVersion,
        branchName: str(root.branch_name) ?? run.branchName,
        finishedAt: finished ? (run.finishedAt ?? now) : null,
        misses: 0,
        error: null,
        updatedAt: now,
      };
    } catch (error) {
      return this.miss(run, error);
    }
  }

  /** The failing step of a finished test run, from `revyl run summary`. */
  async failureOf(taskId: string): Promise<RunFailure | null> {
    try {
      const root = obj(await this.cli.json(["run", "summary", taskId], { cwd: this.host.deviceCwd, timeoutMs: 30_000 }));
      const index = num(root.failed_step_index);
      if (index === null) return null;
      const step = arr(root.steps).map(obj).find((candidate) => num(candidate.index) === index) ?? null;
      return { step: index + 1, description: str(step?.description), reason: str(step?.status_reason) };
    } catch {
      return null;
    }
  }

  private miss(run: Run, error: unknown): Run {
    const now = this.host.now();
    const misses = run.misses + 1;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RevylCliError && (error.kind === "missing" || error.kind === "signed-out")) {
      // The card says why; keep the run active so it recovers after sign-in.
      return { ...run, misses, error: message, updatedAt: now };
    }
    if (misses >= MAX_MISSES) {
      this.host.log("warn", "giving up on a run", { kind: run.kind, misses });
      return { ...run, misses, status: "lost", error: message, finishedAt: now, updatedAt: now };
    }
    return { ...run, misses, updatedAt: run.updatedAt };
  }
}

/** Revyl echoes the identifier it was given as the name; an id is not a name. */
function realName(name: string | null): string | null {
  return name === null || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name) ? null : name;
}

function resolveChdir(cwd: string | null, chdir: string | null): string | null {
  if (chdir === null) return cwd;
  if (chdir.startsWith("/")) return chdir;
  if (cwd === null) return null;
  return `${cwd.replace(/\/$/, "")}/${chdir}`;
}

/** "3m 20s", "1m 9s", "69.5s" → seconds. */
export function parseDurationLabel(label: string | null): number | null {
  if (label === null) return null;
  let seconds = 0;
  let matched = false;
  for (const match of label.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/g)) {
    matched = true;
    const value = Number(match[1]);
    seconds += match[2] === "h" ? value * 3600 : match[2] === "m" ? value * 60 : value;
  }
  return matched ? Math.round(seconds * 10) / 10 : null;
}

function sameRun(a: Run, b: Run): boolean {
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
}
