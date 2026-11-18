/**
 * Wiring, and only wiring.
 *
 * Every rule lives in a module under `src/` that imports nothing from bb:
 * detection (detect.ts), CLI calls (revyl-cli.ts), JSON mapping
 * (revyl-json.ts), storage (store.ts), run tracking (tracker.ts) and the test
 * browser (catalog.ts). This file connects them to settings, storage, thread
 * events, a background poller, RPC, realtime, a CLI command and agent
 * instructions.
 *
 * Every `bb.*` call reachable from work that can outlive this instance goes
 * through `safely`: publishing through a disposed handle throws, and from a
 * detached continuation that would take the bb server down.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_PluginRpcRefusal as PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";

import { CatalogService, readProjectLink } from "./src/catalog";
import { REALTIME_RUNS, REALTIME_THREAD_STATE, rpcContract } from "./src/contract";
import { endedLabel } from "./src/shared";
import { isActive, type CliStatus, type Run, type RunKind, type Session, type SessionEnd } from "./src/model";
import { RevylCli, RevylCliError, firstLine, locateRevyl } from "./src/revyl-cli";
import { arr, mapHistory, mapTestReport, mapWorkflowStatus, num, obj, str } from "./src/revyl-json";
import { PAGE_SCOPE, PINNED_SCOPE, Store, scopeOf } from "./src/store";
import { EVENT_PAGE, TICK_MS, Tracker, newRun, type ThreadEventRow } from "./src/tracker";
import { BASE_INSTRUCTIONS, CAPS, deviceDirective, formatRunsForCli, testOnRevylInstructions } from "./src/agent-text";
import { MODE_MIGRATIONS, createModeStore, isNewThreadStart } from "./src/mode";
import { PROXY_ROUTE, REVYL_API, handleProxy, signThreadToken, verifyThreadToken } from "./src/proxy";
import { describeDeviceAction } from "./src/device-actions";
import { createStillStore } from "./src/stills";

export { rpcContract };

const STATUS_TTL_MS = 60_000;
/** Agent providers bb ships; each needs its own environment resolver. */
const PROVIDER_IDS = ["claude-code", "codex", "acp-cursor"] as const;
const CWD_TTL_MS = 5 * 60_000;

export default async function plugin(bb: BbPluginApi) {
  let disposed = false;
  bb.onDispose(() => {
    disposed = true;
  });
  const safely = <T>(label: string, work: () => T): T | undefined => {
    if (disposed) return undefined;
    try {
      return work();
    } catch (error) {
      if (!disposed) bb.log.warn(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  const detach = (label: string, work: Promise<unknown>) => {
    work.catch((error) => {
      if (!disposed) bb.log.warn(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      secret: true,
      label: "Revyl API key",
      description: "From app.revyl.ai, Settings, API Keys. Kept on the bb server; agents and browsers never see it.",
    },
    cliPath: {
      type: "string",
      label: "Revyl CLI path",
      description: "Leave empty to find revyl on PATH, in ~/.revyl/bin, /opt/homebrew/bin or /usr/local/bin.",
      default: "",
    },
    sessionIdleMinutes: {
      type: "number",
      label: "Device idle timeout (minutes)",
      description: "A device session started from bb stops after this long without input, so minutes don't leak.",
      default: 10,
    },
  });
  const { cliPath, sessionIdleMinutes } = await settings.get();
  const idleSeconds = Math.round(Math.min(120, Math.max(1, Number(sessionIdleMinutes) || 10)) * 60);

  // `revyl device ...` keeps a session file (with the account email) in
  // `.revyl/` of whatever folder it runs in. Device commands name their app
  // and session explicitly, so they run here instead of in the user's repo.
  const deviceCwd = join(tmpdir(), "bb-plugin-revyl");
  mkdirSync(deviceCwd, { recursive: true, mode: 0o700 });
  // An empty auth folder: the plugin's CLI calls use only the key below,
  // never a sign-in stored on this machine.
  const authDir = join(deviceCwd, "auth");
  mkdirSync(authDir, { recursive: true, mode: 0o700 });

  // The real key: the plugin's secret setting, read fresh so a pasted key
  // applies at once.
  const currentKey = async (): Promise<string | null> => {
    const value = (await settings.get()).apiKey;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const cliEnv = (key: string) => ({ REVYL_API_KEY: key, REVYL_AUTH_DIRECTORY: authDir });
  const locate = () => locateRevyl(cliPath === "" ? null : cliPath);
  const cli = new RevylCli(locate, async () => {
    const key = await currentKey();
    return key === null ? null : cliEnv(key);
  });

  // Threads with Test on Revyl on, and the secret their proxy tokens are signed with.
  const db = bb.storage.database();
  bb.storage.migrate(db, MODE_MIGRATIONS);
  const modes = createModeStore(db);
  const stills = createStillStore(db);
  let proxySecret = await bb.storage.kv.get<string>("proxy-secret");
  if (typeof proxySecret !== "string" || proxySecret.length < 32) {
    proxySecret = randomBytes(32).toString("hex");
    await bb.storage.kv.set("proxy-secret", proxySecret);
  }
  const secret = proxySecret;
  const store = new Store(bb.storage.kv);
  const catalog = new CatalogService(cli);

  const publishRuns = (scope: string) => safely("publish runs", () => bb.realtime.publish(REALTIME_RUNS, { scope }));

  // --- Devices --------------------------------------------------------------
  /** Mark a device ended, once, with who or what ended it. */
  const endSession = async (threadId: string, sessionIds: ReadonlySet<string>, by: SessionEnd) => {
    const now = Date.now();
    await store.updateSessions(threadId, (sessions) =>
      sessions.map((session) => (sessionIds.has(session.sessionId) && session.stoppedAt === null ? { ...session, stoppedAt: now, endedBy: by } : session)),
    );
    publishRuns(threadId);
  };

  /**
   * The app, build and branch a device runs, from Revyl's session record
   * (`revyl device info` does not include them). Best effort.
   */
  const loadSessionDetails = async (threadId: string, sessionId: string, attempt = 1): Promise<void> => {
    const key = await currentKey();
    if (key === null) return;
    const response = await fetch(`${REVYL_API}/api/v1/execution/device-sessions/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": "bb-plugin-revyl" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    const raw = response.ok ? obj(await response.json()) : {};
    if (str(raw.app_name) === null && str(raw.build_version) === null) {
      // A session record can trail the start by a moment.
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return loadSessionDetails(threadId, sessionId, attempt + 1);
      }
      return;
    }
    // The thread may have been deleted meanwhile; never recreate its record.
    if (!(await store.sessions(threadId)).some((session) => session.sessionId === sessionId)) return;
    await store.updateSessions(threadId, (sessions) =>
      sessions.map((session) =>
        session.sessionId === sessionId
          ? {
              ...session,
              appId: str(raw.app_id) ?? session.appId ?? null,
              appName: session.appName ?? str(raw.app_name),
              buildVersion: str(raw.build_version) ?? session.buildVersion ?? null,
              branchName: str(raw.branch_name) ?? session.branchName ?? null,
            }
          : session,
      ),
    );
    publishRuns(threadId);
  };

  /**
   * Stop a device and wait until Revyl confirms it. `revyl device stop` waits
   * a while and can still answer `stopped: false` while cleanup runs; a
   * device marked ended too early would keep using minutes unseen.
   */
  const stopDevice = async (sessionId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const root = obj(await cli.json(["device", "stop", "--session-id", sessionId], { cwd: deviceCwd, timeoutMs: 60_000 }));
        if (root.stopped !== false) return true;
      } catch (error) {
        if (error instanceof RevylCliError && /terminal state|not found|no session/i.test(error.message)) return true;
        if (attempt === 2) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
    return false;
  };

  // Read-only Revyl facts the UI shows often, cached briefly.
  let billingCache: { at: number; value: Promise<Record<string, unknown> | null> } | null = null;
  let targetsCache: { at: number; value: Promise<Record<string, unknown>> } | null = null;

  /** Something the agent did on one of its devices, as the proxy saw it. */
  const recordDeviceAction = async (
    threadId: string,
    runId: string,
    action: string,
    body: Record<string, unknown> | null,
    ok: boolean,
    image: Uint8Array | null,
  ) => {
    const described = describeDeviceAction(action, body, ok);
    if (described === null) return;
    const session = (await store.sessions(threadId)).find((candidate) => candidate.workflowRunId === runId || candidate.sessionId === runId);
    if (session === undefined) return;
    const still = image === null ? null : stills.add(threadId, session.sessionId, image);
    const now = Date.now();
    await store.updateSessions(threadId, (sessions) =>
      sessions.map((other) =>
        other.sessionId === session.sessionId
          ? { ...other, actions: [{ ...described, at: now }, ...(other.actions ?? [])].slice(0, 8), lastStill: still ?? other.lastStill ?? null }
          : other,
      ),
    );
    publishRuns(threadId);
  };

  // The machine the bb server runs on: the only one whose paths the CLI can use.
  let primaryHost: Promise<string | null> | null = null;
  const isLocalHost = async (hostId: string): Promise<boolean> => {
    primaryHost ??= bb.sdk.system.config().then(
      (config) => config.primaryHostId,
      () => null,
    );
    const local = await primaryHost;
    if (local === null) primaryHost = null;
    return local !== null && local === hostId;
  };

  // Where the CLI runs for a thread: its checkout, when that is on this machine.
  const cwdCache = new Map<string, { path: string | null; at: number }>();
  const threadCwd = async (threadId: string): Promise<string | null> => {
    const cached = cwdCache.get(threadId);
    if (cached !== undefined && Date.now() - cached.at < CWD_TTL_MS) return cached.path;
    let path: string | null = null;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId) {
        const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
        if ((await isLocalHost(environment.hostId)) && environment.path !== null && existsSync(environment.path)) {
          path = environment.path;
        }
      }
    } catch {
      path = null;
    }
    cwdCache.set(threadId, { path, at: Date.now() });
    return path;
  };

  // A project's checkout on this machine, for the test browser's project scope.
  const projectRoot = async (projectId: string | null): Promise<string | null> => {
    if (projectId === null) return null;
    try {
      const environments = await bb.sdk.environments.list({ projectId });
      const list = Array.isArray(environments) ? environments : (obj(environments).environments as unknown[]) ?? [];
      const candidates = (list as Array<Record<string, unknown>>)
        .filter((environment) => typeof environment.path === "string" && existsSync(environment.path as string))
        .sort((a, b) => Number(a.isWorktree === true) - Number(b.isWorktree === true));
      for (const environment of candidates) {
        if (await isLocalHost(String(environment.hostId))) return environment.path as string;
      }
    } catch {
      return null;
    }
    return null;
  };

  const tracker = new Tracker(store, cli, {
    listEvents: async (threadId, afterSeq) => {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(afterSeq),
        limit: String(EVENT_PAGE),
        order: "asc",
        types: ["item/started", "item/completed"],
      });
      return rows as unknown as ThreadEventRow[];
    },
    listLatestEvents: async (threadId) => {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        limit: String(EVENT_PAGE),
        order: "desc",
        types: ["item/started", "item/completed"],
      });
      return rows as unknown as ThreadEventRow[];
    },
    threadCwd,
    publish: publishRuns,
    testNames: () => catalog.testNames(),
    targetName: async (kind, id) => {
      try {
        const org = await catalog.orgCatalog();
        const list = kind === "test" ? org.tests : kind === "workflow" ? org.workflows : org.apps;
        return list.find((item) => item.id === id)?.name ?? null;
      } catch {
        return null;
      }
    },
    deviceCwd,
    now: () => Date.now(),
    log: (level, message, detail) =>
      safely("log", () => bb.log[level](detail === undefined ? message : `${message} ${JSON.stringify(detail)}`)),
  });

  // --- Status, cached so the card and settings can ask often. -------------
  /**
   * Whether this machine's own revyl CLI holds a key (`revyl auth login` or
   * `persist-cloud-env`). Agents here could use it to bypass the proxy.
   */
  const machineSignedIn = (): boolean => {
    for (const name of ["cloud-runtime.json", "credentials.json"]) {
      try {
        const data = JSON.parse(readFileSync(join(homedir(), ".revyl", name), "utf8")) as Record<string, unknown>;
        if (Object.entries(data).some(([field, value]) => /key|token/i.test(field) && typeof value === "string" && value.length > 8)) return true;
      } catch {
        // No file, or not JSON: no sign-in there.
      }
    }
    return false;
  };

  let status: CliStatus | null = null;
  const readStatus = async (refresh = false): Promise<CliStatus> => {
    if (!refresh && status !== null && Date.now() - status.checkedAt < STATUS_TTL_MS) return status;
    const binary = cli.binary();
    const base = { binary, version: null, orgName: null, email: null, message: null, checkedAt: Date.now(), machineSignedIn: machineSignedIn() };
    if (binary === null) {
      status = { ...base, state: "missing", message: "Install the Revyl CLI on the bb server's machine: brew install RevylAI/tap/revyl" };
      return status;
    }
    if ((await currentKey()) === null) {
      status = { ...base, state: "no-key", message: "Add your Revyl API key on bb's Revyl page." };
      return status;
    }
    try {
      const version = obj(await cli.json(["version"], { timeoutMs: 10_000 }));
      const auth = obj(await cli.json(["auth", "status"], { timeoutMs: 15_000 }));
      status = { ...base, state: "ready", version: str(version.version), orgName: str(auth.org_name), email: str(auth.email) };
    } catch (error) {
      status = { ...base, state: "error", message: error instanceof Error ? error.message : String(error) };
    }
    return status;
  };

  /** Check a key with Revyl, then keep it in the plugin's secret settings. */
  const connectKey = async (key: string): Promise<{ connected: boolean; error: string | null }> => {
    if (locate() === null) return { connected: false, error: "Install the Revyl CLI on the bb server's machine first: brew install RevylAI/tap/revyl" };
    try {
      // `auth status` trusts any key; listing apps is the real check.
      await new RevylCli(locate, async () => cliEnv(key)).json(["app", "list"], { timeoutMs: 20_000 });
    } catch (error) {
      if (error instanceof RevylCliError && error.kind === "signed-out") {
        return { connected: false, error: "Revyl refused this key. Check it in app.revyl.ai, Settings, API Keys." };
      }
      const message = error instanceof Error ? firstLine(error.message) : "Revyl refused this key.";
      return { connected: false, error: message.split(key).join("<key>") };
    }
    await settings.experimental_set({ apiKey: key });
    return { connected: true, error: null };
  };

  // A new or removed key, from any place it can be set, invalidates what was read with the old one.
  settings.onChange((next, prev) => {
    if (next.apiKey !== prev.apiKey) {
      status = null;
      catalog.reset();
    }
  });

  let linkedProjects: { projects: Array<{ id: string; name: string }>; at: number } | null = null;

  const refuse = (code: "conflict" | "forbidden" | "invalid" | "not_found", message: string) =>
    new PluginRpcRefusal({ code, message });

  const cliError = (error: unknown): never => {
    if (error instanceof RevylCliError) {
      if (error.kind === "missing") throw refuse("forbidden", "The Revyl CLI is not installed on the bb server's machine.");
      if (error.kind === "signed-out") throw refuse("forbidden", "Revyl is not connected. Add your API key on bb's Revyl page.");
      throw refuse("conflict", error.message);
    }
    throw error;
  };

  const agentBusy = async (threadId: string): Promise<boolean> => {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread.status === "active" || thread.status === "starting";
    } catch {
      return false;
    }
  };

  const findRun = async (threadId: string | null, key: string) => {
    const scope = scopeOf(threadId);
    const run = (await store.runs(scope)).find((candidate) => candidate.key === key || candidate.taskId === key);
    if (run === undefined) throw refuse("not_found", "That run is no longer tracked here.");
    return { scope, run };
  };

  /** Start a run with --no-wait and record it in the scope it belongs to. */
  const startRun = async (args: {
    threadId: string | null;
    kind: RunKind;
    target: string;
    name: string | null;
    buildId: string | null;
    cwd: string | null;
  }): Promise<Run> => {
    const command =
      args.kind === "test"
        ? ["test", "run", args.target, "--no-wait", "--no-open", ...(args.buildId === null ? [] : ["--build-id", args.buildId])]
        : ["workflow", "run", args.target, "--no-wait", "--no-open"];
    let raw: Record<string, unknown>;
    try {
      raw = obj(await cli.json(command, { cwd: args.cwd, timeoutMs: 120_000 }));
    } catch (error) {
      return cliError(error);
    }
    const taskId = str(raw.task_id);
    if (taskId === null) {
      throw refuse("conflict", str(raw.error) ?? "Revyl did not start the run.");
    }
    const run = newRun({
      kind: args.kind,
      taskId,
      threadId: args.threadId,
      startedAt: Date.now(),
      origin: "bb",
      name: str(raw.test_name) ?? str(raw.workflow_name) ?? args.name,
      targetId: str(raw.test_id) ?? str(raw.workflow_id) ?? (args.target.match(/^[0-9a-f-]{36}$/i) ? args.target : null),
      cwd: args.cwd,
      buildId: args.buildId,
    });
    if (args.threadId !== null) modes.own(args.threadId, taskId);
    await tracker.addStarted(scopeOf(args.threadId), run);
    return run;
  };

  bb.rpc.register(rpcContract, {
    thread_mode: ({ threadId }) => ({ on: modes.isOn(threadId) }),
    set_thread_mode: ({ threadId, on }) => {
      modes.set(threadId, on);
      bb.log.info(`test on revyl ${on ? "on" : "off"} for a thread`);
      return { on };
    },
    pending_mode: ({ projectId }) => ({ on: modes.pending(projectId) }),
    set_pending_mode: ({ projectId, on }) => {
      modes.setPending(projectId, on);
      return { on: modes.pending(projectId) };
    },
    set_api_key: ({ key }) => connectKey(key),
    clear_api_key: async () => {
      await settings.experimental_set({ apiKey: null });
      return { connected: false };
    },
    status: ({ refresh }) => readStatus(refresh === true),

    thread_runs: async ({ threadId }) => ({
      runs: await store.runs(threadId),
      sessions: await store.sessions(threadId),
      agentBusy: await agentBusy(threadId),
    }),

    page_runs: async () => ({ runs: await store.runs(PAGE_SCOPE) }),

    run_get: async ({ taskId, kind, threadId }) => {
      const id = taskId.toLowerCase();
      if (threadId !== null) {
        const own = (await store.runs(threadId)).find((run) => run.taskId === id);
        if (own !== undefined) return own;
      }
      try {
        return await tracker.pin(id, kind);
      } catch (error) {
        return cliError(error);
      }
    },

    test_report: async ({ taskId }) => {
      try {
        return mapTestReport(await cli.json(["test", "report", taskId], { timeoutMs: 60_000 }), taskId);
      } catch (error) {
        return cliError(error);
      }
    },

    workflow_report: async ({ taskId, name }) => {
      try {
        const raw = await cli.json(["workflow", "status", taskId], { timeoutMs: 60_000 });
        // Workflow status carries no name; the caller or a tracked run knows it.
        const known = name ?? (await store.findRun(taskId, [...(await store.activeScopes()), PAGE_SCOPE, PINNED_SCOPE]))?.run.name ?? null;
        return mapWorkflowStatus(raw, taskId, await catalog.testNames(), known);
      } catch (error) {
        return cliError(error);
      }
    },

    catalog: async ({ scope, projectId, force }) => {
      try {
        return await catalog.catalog(scope, await projectRoot(projectId), force === true);
      } catch (error) {
        return cliError(error);
      }
    },

    linked_projects: async () => {
      if (linkedProjects !== null && Date.now() - linkedProjects.at < 60_000) return { projects: linkedProjects.projects };
      const projects: Array<{ id: string; name: string }> = [];
      const list = await bb.sdk.projects.list();
      for (const project of (Array.isArray(list) ? list : []).slice(0, 100)) {
        const root = await projectRoot(project.id);
        if (root !== null && (await readProjectLink(root)) !== null) projects.push({ id: project.id, name: project.name });
      }
      linkedProjects = { projects, at: Date.now() };
      return { projects };
    },

    history: async ({ kind, targetId }) => {
      try {
        const raw = await cli.json([kind, "history", targetId, "--limit", "10"]);
        return { entries: mapHistory(raw).map(({ startedAtMs: _drop, ...entry }) => entry) };
      } catch (error) {
        return cliError(error);
      }
    },

    start_run: async ({ threadId, kind, targetId, name, projectId }) =>
      startRun({
        threadId,
        kind,
        target: targetId,
        name,
        buildId: null,
        cwd: threadId !== null ? await threadCwd(threadId) : await projectRoot(projectId),
      }),

    rerun: async ({ threadId, key }) => {
      const { run } = await findRun(threadId, key);
      const target = run.targetId ?? run.name;
      if (run.kind === "build" || target === null) throw refuse("invalid", "This run has no test or workflow to run again.");
      return startRun({
        threadId,
        kind: run.kind as "test" | "workflow",
        target,
        name: run.name,
        // A re-run reuses the original build so it answers "does it still fail?".
        buildId: run.kind === "test" ? run.buildId : null,
        cwd: run.cwd,
      });
    },

    cancel: async ({ threadId, key }) => {
      const { scope, run } = await findRun(threadId, key);
      if (run.taskId === null) throw refuse("conflict", "Revyl has not given this run an id yet. Try again in a few seconds.");
      if (!isActive(run.status)) return run;
      let result: Awaited<ReturnType<typeof cli.exec>>;
      try {
        result = await cli.exec([run.kind, "cancel", run.taskId], { cwd: run.cwd, timeoutMs: 30_000 });
      } catch (error) {
        return cliError(error);
      }
      if (result.exitCode !== 0) throw refuse("conflict", firstLine(result.stderr || result.stdout) || "Revyl did not cancel the run.");
      // Cancel is a request: read what Revyl says now, and let the poller
      // follow it if the run has not stopped yet.
      const next = await tracker.poll(run);
      await store.updateRuns(scope, (runs) => runs.map((other) => (other.key === run.key ? next : other)));
      publishRuns(scope);
      return next;
    },

    dismiss_finished: async ({ threadId }) => {
      const scope = scopeOf(threadId);
      let removed = 0;
      await store.updateRuns(scope, (runs) => {
        const kept = runs.filter((run) => isActive(run.status));
        removed = runs.length - kept.length;
        return kept;
      });
      publishRuns(scope);
      return { removed };
    },

    session_info: async ({ sessionId }) => {
      try {
        const raw = obj(await cli.json(["device", "info", "--session-id", sessionId], { cwd: deviceCwd, timeoutMs: 20_000 }));
        const whepUrl = str(raw.whep_url);
        // `idle_timeout` is a Go duration in nanoseconds.
        const idleNanos = num(raw.idle_timeout);
        const lastActivity = Date.parse(str(raw.last_activity) ?? "");
        return {
          alive: whepUrl !== null || str(raw.session_id) !== null,
          whepUrl,
          platform: str(raw.platform),
          screenWidth: num(raw.screen_width),
          screenHeight: num(raw.screen_height),
          viewerUrl: str(raw.viewer_url),
          idleTimeoutSeconds: idleNanos === null || idleNanos <= 0 ? null : Math.round(idleNanos / 1e9),
          lastActivityAt: Number.isFinite(lastActivity) ? lastActivity : null,
        };
      } catch (error) {
        // Only Revyl saying the session is over ends it here; a hiccup is an error the pane retries.
        if (error instanceof RevylCliError && error.kind === "failed" && /terminal state|not found|no session/i.test(error.message)) {
          return { alive: false, whepUrl: null, platform: null, screenWidth: null, screenHeight: null, viewerUrl: null, idleTimeoutSeconds: null, lastActivityAt: null };
        }
        return cliError(error);
      }
    },

    device_still: async ({ threadId, sessionId, n, pin }) => {
      const still = stills.get(threadId, sessionId, n);
      if (still === null) return null;
      if (pin === true) stills.pin(threadId, sessionId, still.n);
      return { n: still.n, takenAt: still.takenAt, dataUrl: `data:image/png;base64,${still.png.toString("base64")}` };
    },

    billing: async () => {
      if (billingCache === null || Date.now() - billingCache.at > 5 * 60_000) {
        billingCache = { at: Date.now(), value: cli.json(["billing", "status"], { cwd: deviceCwd, timeoutMs: 30_000 }).then(obj, () => null) };
      }
      const root = await billingCache.value;
      if (root === null) return null;
      const minutes = obj(root.free_minutes);
      const iosRate = arr(root.rates).map(obj).find((rate) => str(rate.platform)?.toLowerCase() === "ios") ?? null;
      return {
        planName: str(root.plan_name) ?? str(root.plan),
        iosMinutesLeft: num(minutes.ios_left),
        iosMinutesTotal: num(minutes.ios_total),
        androidMinutesLeft: num(minutes.android_left),
        usdPerMinute: num(iosRate?.usd_per_minute),
        minutesThisPeriod: num(root.minutes_this_period),
        periodEnd: str(root.period_end),
        concurrentDevices: num(root.concurrent_devices),
        billingUrl: str(root.billing_url),
      };
    },

    device_targets: async () => {
      if (targetsCache === null || Date.now() - targetsCache.at > 60 * 60_000) {
        targetsCache = { at: Date.now(), value: cli.json(["device", "targets"], { cwd: deviceCwd, timeoutMs: 30_000 }).then(obj, () => ({})) };
      }
      const root = await targetsCache.value;
      // Revyl spells these keys Model and Runtime.
      const list = (value: unknown) =>
        arr(value)
          .map(obj)
          .map((target) => ({ model: str(target.Model) ?? str(target.model), os: str(target.Runtime) ?? str(target.runtime) }))
          .filter((target): target is { model: string; os: string } => target.model !== null && target.os !== null);
      return { ios: list(root.ios), android: list(root.android) };
    },

    run_diagnostics: async ({ taskId }) => {
      const notes: { perf: string | null; logs: string | null; network: string | null } = { perf: null, logs: null, network: null };
      const quiet = (error: unknown) => (error instanceof Error ? firstLine(error.message) : String(error)).replace(/^Error:\s*/, "");
      const [perfRaw, logsRaw, networkRaw] = await Promise.all([
        cli.json(["run", "perf", taskId], { cwd: deviceCwd, timeoutMs: 45_000 }).then(obj, (error: unknown) => ((notes.perf = quiet(error)), null)),
        cli
          .json(["run", "logs", taskId, "--level", "warn,error", "--tail", "60"], { cwd: deviceCwd, timeoutMs: 45_000 })
          .then(obj, (error: unknown) => ((notes.logs = quiet(error)), null)),
        cli
          .json(["run", "network", taskId, "--failed", "--compact"], { cwd: deviceCwd, timeoutMs: 45_000 })
          .then(obj, (error: unknown) => ((notes.network = quiet(error)), null)),
      ]);
      const summary = perfRaw === null ? null : obj(perfRaw.summary);
      const perf =
        summary === null
          ? null
          : {
              avgCpu: num(summary.avg_cpu_percent),
              peakCpu: num(summary.peak_cpu_percent),
              avgMemoryMb: num(summary.avg_memory_rss_kb) === null ? null : Math.round(num(summary.avg_memory_rss_kb)! / 1024),
              peakMemoryMb: num(summary.peak_memory_rss_kb) === null ? null : Math.round(num(summary.peak_memory_rss_kb)! / 1024),
              avgFps: num(summary.avg_fps),
              minFps: num(summary.min_fps),
            };
      // Log lines can carry tokens: shown on request, never stored, clipped.
      const logs =
        logsRaw === null
          ? null
          : {
              lines: arr(logsRaw.lines)
                .map(obj)
                .slice(-60)
                .map((line) => ({ level: str(line.Level) ?? str(line.level) ?? "", text: (str(line.Raw) ?? str(line.raw) ?? "").slice(0, 400) })),
              matched: num(logsRaw.matched) ?? 0,
              total: num(logsRaw.total),
            };
      const requestList = networkRaw === null ? [] : arr(networkRaw.requests ?? networkRaw.items ?? networkRaw.entries).map(obj);
      const network =
        networkRaw === null
          ? null
          : {
              total: num(networkRaw.total_requests) ?? num(networkRaw.total),
              failed: num(networkRaw.failed_requests) ?? num(networkRaw.failed),
              requests: requestList.slice(0, 30).map((request) => {
                let host: string | null = str(request.host);
                let path: string | null = null;
                try {
                  const url = new URL(str(request.url) ?? "");
                  host ??= url.host;
                  path = url.pathname;
                } catch {
                  path = str(request.path);
                }
                return {
                  method: str(request.method),
                  host,
                  path,
                  status: num(request.status_code) ?? num(request.status),
                  durationMs: num(request.duration_ms),
                };
              }),
            };
      const partial = Boolean(perfRaw?.partial) || Boolean(logsRaw?.partial) || Boolean(networkRaw?.partial);
      return { perf, logs, network, notes, partial };
    },

    session_start: async ({ threadId, appId, deviceModel, osVersion }) => {
      const live = (await store.sessions(threadId)).filter((session) => session.stoppedAt === null).length;
      if (live >= CAPS.devices) throw refuse("conflict", `This thread already runs ${live} Revyl device, its limit. Stop it first.`);
      const org = await catalog.orgCatalog().catch(cliError);
      const app = org.apps.find((candidate) => candidate.id === appId);
      if (app === undefined) throw refuse("not_found", "That app is not in your Revyl org.");
      const platform = (app.platform ?? "ios").toLowerCase();
      let raw: Record<string, unknown>;
      try {
        raw = obj(
          await cli.json(
            [
              "device",
              "start",
              "--platform",
              platform,
              "--app-id",
              appId,
              "--open=false",
              "--timeout",
              String(idleSeconds),
              ...(deviceModel ? ["--device-model", deviceModel] : []),
              ...(osVersion ? ["--os-version", osVersion] : []),
            ],
            { cwd: deviceCwd, timeoutMs: 180_000 },
          ),
        );
      } catch (error) {
        return cliError(error);
      }
      const sessionId = str(raw.session_id);
      if (sessionId === null) throw refuse("conflict", str(raw.error) ?? "Revyl did not start a device.");
      const session: Session = {
        sessionId,
        workflowRunId: str(raw.workflow_run_id)?.toLowerCase() ?? null,
        threadId,
        platform: str(raw.platform) ?? platform,
        appName: app.name,
        screenWidth: num(raw.screen_width),
        screenHeight: num(raw.screen_height),
        startedAt: Date.now(),
        stoppedAt: null,
        origin: "bb",
        idleTimeoutSeconds: idleSeconds,
      };
      modes.own(threadId, sessionId, str(raw.workflow_run_id));
      const listed = await store.updateSessions(threadId, (sessions) => [session, ...sessions.filter((other) => other.sessionId !== sessionId)]);
      stills.keepOnly(threadId, listed.map((other) => other.sessionId));
      publishRuns(threadId);
      detach("load device details", loadSessionDetails(threadId, sessionId));
      return session;
    },

    session_stop: async ({ threadId, sessionId }) => {
      let stopped: boolean;
      try {
        stopped = await stopDevice(sessionId);
      } catch (error) {
        return cliError(error);
      }
      if (!stopped) throw refuse("conflict", "Revyl is still stopping the device. Try Stop again in a moment.");
      await endSession(threadId, new Set([sessionId]), "person");
      return { stopped: true };
    },

    session_input: async ({ threadId, sessionId, action }) => {
      if (await agentBusy(threadId)) {
        throw refuse("conflict", "The agent is working in this thread. Touch input unlocks when it goes idle.");
      }
      const target = ["--session-id", sessionId];
      // Typed text goes through the environment (`--text-env`), so it never shows in the process list.
      const env: Record<string, string> = {};
      const steps: string[][] = [];
      switch (action.type) {
        case "tap":
          steps.push(["device", "tap", ...target, "--x", String(action.x), "--y", String(action.y)]);
          break;
        case "swipe":
          steps.push(["device", "swipe", ...target, "--direction", action.direction, "--x", String(action.x), "--y", String(action.y)]);
          break;
        case "type":
          env.BB_REVYL_TYPED = action.text;
          // Typing adds to what the field holds, like a keyboard.
          steps.push(["device", "type", ...target, "--x", String(action.x), "--y", String(action.y), "--text-env", "BB_REVYL_TYPED", "--clear-first=false"]);
          break;
        case "key":
          steps.push(["device", "key", action.key, ...target]);
          break;
        case "navigate":
          steps.push(["device", "navigate", ...target, "--url", action.url]);
          break;
        case "relaunch":
          steps.push(["device", "kill-app", ...target], ["device", "launch", ...target]);
          break;
        default:
          steps.push(["device", action.type, ...target]);
      }
      try {
        let last: Record<string, unknown> = {};
        for (const args of steps) last = obj(await cli.json(args, { cwd: deviceCwd, timeoutMs: 30_000, env }));
        return { ok: last.success !== false, latencyMs: num(last.latency_ms) };
      } catch (error) {
        return cliError(error);
      }
    },
  });

  // --- Thread events ------------------------------------------------------
  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    detach("ingest", tracker.ingest(thread.id, Number(sequence)));
  });
  const publishThreadState = (threadId: string, busy: boolean) =>
    safely("publish thread state", () => bb.realtime.publish(REALTIME_THREAD_STATE, { threadId, busy }));
  bb.events.on("thread.active", ({ thread }) => publishThreadState(thread.id, true));
  bb.events.on("thread.idle", ({ thread }) => publishThreadState(thread.id, false));
  bb.events.on("thread.failed", ({ thread }) => publishThreadState(thread.id, false));
  // Archiving or deleting a thread stops what it left running on Revyl: only
  // runs, builds and devices it started, and only those marked once Revyl
  // accepted the stop.
  const cleanUpThread = async (threadId: string) => {
    const runs = (await store.runs(threadId)).filter((run) => isActive(run.status) && run.taskId !== null && modes.owns(threadId, run.taskId));
    const live = (await store.sessions(threadId)).filter((session) => session.stoppedAt === null && modes.owns(threadId, session.sessionId));
    const done = new Set<string>();
    for (const run of runs) {
      const result = await cli.exec([run.kind, "cancel", run.taskId!], { cwd: deviceCwd, timeoutMs: 30_000 }).catch(() => null);
      if (result?.exitCode === 0) done.add(run.taskId!);
    }
    for (const session of live) {
      if (await stopDevice(session.sessionId).catch(() => false)) done.add(session.sessionId);
    }
    if (done.size === 0) return;
    const now = Date.now();
    await store.updateRuns(threadId, (current) =>
      current.map((run) => (run.taskId !== null && done.has(run.taskId) ? { ...run, status: "cancelled" as const, finishedAt: now, updatedAt: now } : run)),
    );
    await endSession(threadId, done, "archived");
    const stopped = live.filter((session) => done.has(session.sessionId)).length;
    bb.log.info(`stopped ${stopped} device(s) and cancelled ${done.size - stopped} run(s) of an archived thread`);
    publishRuns(threadId);
  };
  bb.events.on("thread.archived", ({ thread }) =>
    detach(
      "clean up thread",
      cleanUpThread(thread.id).finally(() => stills.dropUnpinned(thread.id)),
    ),
  );
  bb.events.on("thread.deleted", ({ thread }) =>
    detach(
      "forget thread",
      cleanUpThread(thread.id).finally(async () => {
        modes.forget(thread.id);
        stills.forgetThread(thread.id);
        await store.forgetThread(thread.id);
      }),
    ),
  );

  // --- Poller -------------------------------------------------------------
  // bb does not replay thread events sent while the plugin was not loaded.
  // Catch up on threads that were busy recently, once per load.
  const catchUp = async (signal: AbortSignal) => {
    const threads = await bb.sdk.threads.list({ limit: 40 });
    const recent = threads.filter(
      (thread) => thread.status === "active" || Date.now() - Number(thread.updatedAt ?? 0) < 30 * 60_000,
    );
    for (const thread of recent) {
      if (signal.aborted) return;
      const [latest] = await bb.sdk.threads.events.list({ threadId: thread.id, limit: "1", order: "desc" });
      if (latest !== undefined) await tracker.ingest(thread.id, Number(latest.seq));
    }
  };

  bb.background.service("run-poller", {
    async start(signal) {
      await catchUp(signal).catch((error) => {
        if (!signal.aborted) bb.log.warn(`catch up: ${error instanceof Error ? error.message : String(error)}`);
      });
      while (!signal.aborted) {
        try {
          await tracker.tick(signal);
        } catch (error) {
          if (!signal.aborted) bb.log.warn(`poll: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, TICK_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  // --- Agents -------------------------------------------------------------
  bb.agents.contributeInstructions(({ threadId }) =>
    threadId && modes.isOn(threadId) ? `${BASE_INSTRUCTIONS}\n${testOnRevylInstructions()}` : BASE_INSTRUCTIONS,
  );

  // The proxy every Test on Revyl thread's revyl talks to. bb routes match
  // exact paths only, so the Revyl path rides after ?p= (see src/proxy.ts).
  const proxyDeps = {
    apiKey: currentKey,
    verifyToken: (token: string) => verifyThreadToken(secret, token),
    isOn: async (threadId: string) => modes.isOn(threadId),
    owns: async (threadId: string, id: string) => modes.owns(threadId, id),
    liveDevices: async (threadId: string) => (await store.sessions(threadId)).filter((session) => session.stoppedAt === null).length,
    activeBuilds: async (threadId: string) =>
      (await store.runs(threadId)).filter((run) => run.kind === "build" && isActive(run.status)).length,
    deviceStarted: async (threadId: string, device: { sessionId: string; workflowRunId: string | null; platform: string | null }) => {
      modes.own(threadId, device.sessionId, device.workflowRunId);
      await tracker.recordDevice(threadId, device.sessionId, device.workflowRunId, device.platform);
      // A thread lists its latest few devices; screenshots of older ones go unless a reply shows them.
      stills.keepOnly(threadId, (await store.sessions(threadId)).map((session) => session.sessionId));
      detach("load device details", loadSessionDetails(threadId, device.sessionId));
    },
    runStarted: async (threadId: string, kind: "test" | "workflow", taskId: string, targetId: string | null) => {
      modes.own(threadId, taskId);
      await tracker.recordStart(threadId, kind, taskId, targetId);
    },
    buildStarted: async (threadId: string, jobId: string, appId: string | null, profile: string | null) => {
      modes.own(threadId, jobId);
      await tracker.recordBuild(threadId, jobId, appId, profile);
    },
    // The CLI stops by session id; a cancel may name the device's run id.
    deviceStopped: async (threadId: string, id: string) => {
      const matched = (await store.sessions(threadId)).filter((session) => session.sessionId === id || session.workflowRunId === id);
      await endSession(threadId, new Set(matched.map((session) => session.sessionId)), "agent");
    },
    deviceAction: recordDeviceAction,
    caps: CAPS,
    log: {
      warn: (message: string, data?: Record<string, unknown>) => safely("log", () => bb.log.warn(data ? `${message} ${JSON.stringify(data)}` : message)),
    },
  };
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    bb.http.route(method, PROXY_ROUTE, (context) => handleProxy(context.req.raw, proxyDeps), { auth: "none" });
  }

  // The agent's environment, for threads with Test on Revyl on: revyl talks to
  // the proxy above with a token for that thread alone.
  const contributeEnv = bb.providers?.experimental_contributeEnv;
  if (typeof contributeEnv === "function") {
    for (const providerId of PROVIDER_IDS) {
      try {
        contributeEnv.call(bb.providers, providerId, (context) =>
          context.threadId !== null && modes.isOn(context.threadId)
            ? [
                {
                  name: "REVYL_BACKEND_URL",
                  value: { serverPath: `/api/v1/plugins/${bb.pluginId}/http${PROXY_ROUTE}?p=` },
                  reason: "Test on Revyl: revyl reaches Revyl through the bb server, which holds the key",
                },
                {
                  name: "REVYL_API_KEY",
                  value: signThreadToken(secret, context.threadId),
                  reason: "Test on Revyl: a token for this thread alone; the real Revyl key stays on the bb server",
                },
                { name: "REVYL_NO_UPDATE_NOTIFIER", value: "1", reason: "Test on Revyl: keeps revyl's JSON output clean" },
              ]
            : [],
        );
      } catch (error) {
        bb.log.warn(`no provider environment for ${providerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    bb.log.warn("this bb offers no provider environment; Test on Revyl cannot set up revyl for agents");
  }

  // A new thread whose composer had Test on Revyl on: its project carries a
  // short-lived flag, claimed by the first message a person sends there.
  bb.experimental_hooks.on("message.dispatch", (context) => {
    const thread = context.thread;
    const start = isNewThreadStart({
      attempt: context.attempt,
      initiator: context.initiator,
      origin: context.origin,
      senderThreadId: context.senderThreadId,
      threadCreatedAt: thread.createdAt,
      now: Date.now(),
    });
    if (start && !modes.known(thread.id) && modes.claimPending(context.project.id)) {
      modes.set(thread.id, true);
      bb.log.info("test on revyl on for a new thread");
      publishRuns(thread.id);
    }
    return { action: "proceed" };
  });

  bb.cli.register({
    name: "revyl",
    summary: "Test on Revyl per thread, the runs bb is tracking, and the connection",
    commands: [
      { name: "runs", summary: "List this thread's Revyl runs with their ::revyl directive", usage: "bb revyl runs [--thread <id>] [--json]" },
      { name: "status", summary: "Show whether Revyl is connected, and whether this thread tests on Revyl", usage: "bb revyl status [--thread <id>] [--json]" },
      {
        name: "connect",
        summary: "Connect Revyl with a key read from a file on the bb server's machine (REVYL_API_KEY=... or the bare key)",
        usage: "bb revyl connect --key-file <path> [--json]",
      },
      { name: "disconnect", summary: "Forget the Revyl key", usage: "bb revyl disconnect [--json]" },
      {
        name: "mode",
        summary: "Turn Test on Revyl on or off for a thread, or for the next new thread of a project",
        usage: "bb revyl mode [on|off] [--thread <id> | --project <id>] [--json]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const rest = argv.filter((arg) => arg !== "--json");
      const [command] = rest;
      const option = (name: string) => {
        const at = rest.indexOf(name);
        return at === -1 ? null : (rest[at + 1] ?? null);
      };
      if (command === "status") {
        const current = await readStatus(true);
        const threadId = option("--thread") ?? ctx.threadId ?? null;
        const on = threadId === null ? null : modes.isOn(threadId);
        const lines = [
          current.state === "ready" ? `Revyl connected: ${current.orgName ?? "an org"} (CLI ${current.version ?? "?"}).` : (current.message ?? current.state),
          ...(on === null ? [] : [`Test on Revyl is ${on ? "on" : "off"} for this thread.`]),
          ...(current.machineSignedIn ? ["Warning: this machine's revyl CLI is signed in on its own; run `revyl auth logout`."] : []),
        ];
        return {
          exitCode: current.state === "ready" ? 0 : 1,
          stdout: json ? JSON.stringify({ ...current, testOnRevyl: on }) : lines.join("\n"),
        };
      }
      if (command === "connect") {
        const path = option("--key-file");
        if (path === null) return { exitCode: 1, stderr: "Usage: bb revyl connect --key-file <path>  (a file on the bb server's machine)" };
        let key: string | null = null;
        try {
          const text = readFileSync(path, "utf8");
          const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith("REVYL_API_KEY="));
          let value = (line === undefined ? text : line.slice("REVYL_API_KEY=".length)).trim();
          if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.endsWith(value[0]!)) value = value.slice(1, -1);
          key = value === "" ? null : value;
        } catch {
          return { exitCode: 1, stderr: `Cannot read ${path} on the bb server's machine.` };
        }
        if (key === null) return { exitCode: 1, stderr: "The file holds no key." };
        const result = await connectKey(key);
        return {
          exitCode: result.connected ? 0 : 1,
          stdout: json ? JSON.stringify(result) : result.connected ? "Revyl connected. The key is kept in bb's secret settings." : `Not connected: ${result.error}`,
        };
      }
      if (command === "disconnect") {
        await settings.experimental_set({ apiKey: null });
        return { exitCode: 0, stdout: json ? JSON.stringify({ connected: false }) : "Revyl disconnected." };
      }
      if (command === "mode") {
        const value = rest[1];
        const projectId = option("--project");
        const threadId = projectId === null ? (option("--thread") ?? ctx.threadId ?? null) : null;
        if (value !== undefined && value !== "on" && value !== "off" && !value.startsWith("--")) {
          return { exitCode: 1, stderr: "Usage: bb revyl mode [on|off] [--thread <id> | --project <id>]" };
        }
        const set = value === "on" ? true : value === "off" ? false : null;
        if (projectId !== null) {
          if (set !== null) modes.setPending(projectId, set);
          const on = modes.pending(projectId);
          return {
            exitCode: 0,
            stdout: json
              ? JSON.stringify({ projectId, nextThread: on })
              : on
                ? "The next new thread of this project, started within 30 minutes, tests on Revyl."
                : "New threads of this project start with Test on Revyl off.",
          };
        }
        if (threadId === null) return { exitCode: 1, stderr: "Pass --thread <id> or --project <id>, or run this inside a bb thread." };
        // The person decides where Revyl runs: an agent may switch other
        // threads it orchestrates, never the thread it runs in.
        if (set !== null && threadId === ctx.threadId) {
          return { exitCode: 1, stderr: "Only the person switches Test on Revyl for this thread: the button in its composer." };
        }
        if (set !== null) {
          modes.set(threadId, set);
          publishRuns(threadId);
        }
        const on = modes.isOn(threadId);
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ threadId, on })
            : `Test on Revyl is ${on ? "on" : "off"} for this thread.${set === null ? "" : " It applies from the agent's next turn."}`,
        };
      }
      if (command === "runs") {
        const flag = rest.indexOf("--thread");
        const threadId = flag === -1 ? (ctx.threadId ?? null) : (rest[flag + 1] ?? null);
        if (threadId === null) return { exitCode: 1, stderr: "Pass --thread <id>, or run this inside a bb thread." };
        const runs = await store.runs(threadId);
        // The live device, or the latest one, with a directive that pins its
        // latest screenshot so a reply keeps showing that screen.
        const sessions = await store.sessions(threadId);
        const devices = sessions.filter((session) => session.stoppedAt === null);
        const latest = devices[0] ?? sessions[0];
        const deviceLines: string[] = [];
        const directives: Record<string, string> = {};
        if (latest !== undefined) {
          const shot = latest.lastStill ?? null;
          // The thread's own agent is about to put this line in a reply.
          if (shot !== null && threadId === ctx.threadId) stills.pin(threadId, latest.sessionId, shot);
          const directive = deviceDirective(latest.sessionId, shot);
          directives[latest.sessionId] = directive;
          deviceLines.push(
            `${["device", latest.platform, latest.appName].filter(Boolean).join(" ")}: ${latest.stoppedAt === null ? "live" : endedLabel(latest.endedBy)}${shot === null ? "" : `, latest screenshot ${shot}`}\n  --session-id ${latest.sessionId}\n  ${directive}`,
          );
        }
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify({ runs, devices, directives }) : [formatRunsForCli(runs), ...deviceLines].join("\n"),
        };
      }
      return {
        exitCode: command === undefined || command === "help" || command === "--help" ? 0 : 1,
        stdout:
          "Usage:\n  bb revyl runs [--thread <id>] [--json]\n  bb revyl status [--thread <id>] [--json]\n  bb revyl mode [on|off] [--thread <id> | --project <id>] [--json]\n  bb revyl connect --key-file <path>\n  bb revyl disconnect",
      };
    },
  });

  // Runs pinned only by a directive are kept briefly; drop old finished ones.
  detach(
    "prune pinned",
    store.updateRuns(PINNED_SCOPE, (runs) => runs.filter((run) => isActive(run.status) || Date.now() - run.updatedAt < 86_400_000)),
  );
  bb.log.info("loaded");
}
