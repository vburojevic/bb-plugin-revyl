/**
 * The Revyl proxy on the bb server.
 *
 * A thread with Test on Revyl on gets, through bb's per-thread provider
 * environment, `REVYL_BACKEND_URL` pointing at this route and `REVYL_API_KEY`
 * set to a token for that thread alone. The Revyl CLI sends every
 * authenticated call to that backend with `Authorization: Bearer <key>`
 * (verified against revyl 0.2.12, docs/verified.md), so on any bb machine:
 *
 * - the real API key is added here and never leaves the server. Revyl's
 *   account endpoint echoes the key back, so every response is scrubbed of it;
 * - a thread acts only on device sessions, runs and builds it started, and
 *   runs at most `caps.devices` devices and `caps.builds` builds at a time;
 * - starts are recorded as they pass, so the thread's card shows them before
 *   the CLI prints anything.
 *
 * bb plugin routes match exact paths only, so the Revyl path rides after
 * `?p=`. The CLI appends paths to REVYL_BACKEND_URL verbatim, query included,
 * so everything after `?p=` is the upstream path and query, unencoded.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { DEVICE_ACTION } from "./device-actions";

export const PROXY_ROUTE = "/revyl";
export const REVYL_API = "https://backend.revyl.ai";

export interface ProxyLog {
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface StartedDevice {
  sessionId: string;
  workflowRunId: string | null;
  platform: string | null;
}

export interface ProxyDeps {
  /** The real Revyl API key, or null when none is set. */
  apiKey(): Promise<string | null>;
  verifyToken(token: string): string | null;
  isOn(threadId: string): Promise<boolean>;
  /** Whether this thread started the session, run or build with this id. */
  owns(threadId: string, id: string): Promise<boolean>;
  liveDevices(threadId: string): Promise<number>;
  activeBuilds(threadId: string): Promise<number>;
  deviceStarted(threadId: string, device: StartedDevice): Promise<void>;
  runStarted(threadId: string, kind: "test" | "workflow", taskId: string, targetId: string | null): Promise<void>;
  buildStarted(threadId: string, jobId: string, appId: string | null, profile: string | null): Promise<void>;
  /** The thread stopped one of its devices; it no longer counts against the cap. */
  deviceStopped(threadId: string, sessionId: string): Promise<void>;
  /**
   * The thread acted on one of its devices (`runId` is the device's workflow
   * run id). `image` holds a screenshot's PNG bytes. Called after Revyl answered.
   */
  deviceAction?(threadId: string, runId: string, action: string, body: Record<string, unknown> | null, ok: boolean, image: Uint8Array | null): Promise<void>;
  caps: { devices: number; builds: number };
  fetch?: typeof fetch;
  upstream?: string;
  log: ProxyLog;
}

const TOKEN_PREFIX = "bbrvl";
const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** `bbrvl.<thread id>.<mac>`: lets one thread, and only it, through the proxy. */
export function signThreadToken(secret: string, threadId: string): string {
  const mac = createHmac("sha256", secret).update(`revyl-thread:${threadId}`).digest("base64url").slice(0, 32);
  return `${TOKEN_PREFIX}.${threadId}.${mac}`;
}

export function verifyThreadToken(secret: string, token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !THREAD_ID.test(parts[1]!)) return null;
  const expected = Buffer.from(signThreadToken(secret, parts[1]!));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given) ? parts[1]! : null;
}

/**
 * The upstream path and query from the request URL: everything after the
 * first `?p=`. `URL.searchParams` would split the upstream query apart.
 */
export function upstreamTarget(requestUrl: string): { path: string; query: string } | null {
  const at = requestUrl.indexOf("?p=");
  if (at === -1) return null;
  const rest = requestUrl.slice(at + 3);
  const mark = rest.indexOf("?");
  return mark === -1 ? { path: rest, query: "" } : { path: rest.slice(0, mark), query: rest.slice(mark + 1) };
}

/**
 * A Revyl path the proxy will look at: `/api/…` or `/health_check`, no `.`
 * or `..` segment, no encoded dot, slash or backslash, and unchanged by URL
 * normalization. Without this, `/device-proxy/<mine>/../<theirs>/tap` would
 * pass the ownership check on `<mine>` and reach someone else's device.
 */
export function isPlainPath(path: string): boolean {
  if (path !== "/health_check" && !path.startsWith("/api/")) return false;
  if (/%2e|%2f|%5c|\\/i.test(path)) return false;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  try {
    return new URL(path, "https://revyl.invalid").pathname === path;
  } catch {
    return false;
  }
}

// Any segment: an id format Revyl changes later must still be checked, not skipped.
const ID = "([^/]+)";
/** Paths that act on one device, run or build: the id must be the thread's own. */
const OWNED: Array<{ pattern: RegExp; methods: ReadonlySet<string> | null }> = [
  { pattern: new RegExp(`^/api/v1/execution/device-proxy/${ID}(/|$)`), methods: null },
  { pattern: new RegExp(`^/api/v1/execution/streaming/worker-connection/${ID}$`), methods: null },
  { pattern: new RegExp(`^/api/v1/execution/device/sessions/${ID}(/|$)`), methods: null },
  // A session's record (app, build, branch) and its artifacts.
  { pattern: new RegExp(`^/api/v1/execution/device-sessions/${ID}(/|$)`), methods: null },
  { pattern: new RegExp(`^/api/v1/execution/device/status/cancel/${ID}$`), methods: null },
  { pattern: new RegExp(`^/api/v1/execution/tests/status/cancel/${ID}$`), methods: null },
  { pattern: new RegExp(`^/api/v1/workflows/status/cancel/${ID}$`), methods: null },
  // Reading a build's status is fine; anything else on it is not. `revyl
  // build cancel` sends DELETE /api/v1/apps/remote/<job>, with no trailing part.
  { pattern: new RegExp(`^/api/v1/apps/remote/${ID}(/|$)`), methods: new Set(["POST", "PUT", "PATCH", "DELETE"]) },
];
/**
 * CLI paths under an owned prefix whose segment is a word, not an id. Exact
 * paths only, so an unknown segment stays checked. `revyl build` asks for its
 * source upload URL before any build exists (revyl v0.2.12).
 */
const NOT_IDS: ReadonlySet<string> = new Set([
  "/api/v1/apps/remote/upload-url",
  // Lists of the org's device sessions; their replies keep only the thread's own (see SESSION_LISTS).
  "/api/v1/execution/device-sessions/active",
  "/api/v1/execution/device-sessions/history",
]);
/** Org-wide session lists: the reply is cut down to the sessions the thread owns. */
const SESSION_LISTS: ReadonlySet<string> = new Set(["/api/v1/execution/device-sessions/active", "/api/v1/execution/device-sessions/history"]);
const SESSION_ID_FIELDS = ["id", "session_id", "workflow_run_id"] as const;

const START_DEVICE = "/api/v1/execution/start_device";
const START_TEST = "/api/v1/execution/api/execute_test_id_async";
const START_WORKFLOW = "/api/v1/workflow-executions";
const START_BUILD = "/api/v1/apps/remote";

function refuse(status: number, message: string): Response {
  return new Response(JSON.stringify({ detail: message, code: "bb_revyl_proxy" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One start at a time per thread and kind, so racing starts can't pass a cap together. */
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

const asText = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.length === 0) return null;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Replace every occurrence of the real key in a response body with the thread's token. */
export function scrubKey(bytes: Uint8Array, key: string, token: string): Uint8Array {
  if (key.length < 8 || bytes.length === 0) return bytes;
  const text = Buffer.from(bytes).toString("utf8");
  if (!text.includes(key)) return bytes;
  return new TextEncoder().encode(text.split(key).join(token));
}

export async function handleProxy(request: Request, deps: ProxyDeps): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const upstream = deps.upstream ?? REVYL_API;
  const target = upstreamTarget(request.url);
  if (target === null || !isPlainPath(target.path)) {
    return refuse(400, "bb's Revyl proxy only takes plain /api/ paths.");
  }

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const threadId = deps.verifyToken(token);
  if (threadId === null) return refuse(401, "This revyl is not set up by a bb thread with Test on Revyl on.");
  if (!(await deps.isOn(threadId))) {
    return refuse(403, "Test on Revyl is off for this bb thread. Turn it on in the thread's composer.");
  }
  const key = await deps.apiKey();
  if (key === null) return refuse(503, "The bb Revyl plugin has no Revyl API key. Add one on bb's Revyl page.");

  const method = request.method.toUpperCase();
  const raw = method === "GET" || method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer());
  const body = raw !== null && raw.length > 0 ? raw : null;

  for (const rule of NOT_IDS.has(target.path) ? [] : OWNED) {
    const match = rule.pattern.exec(target.path);
    if (match === null || (rule.methods !== null && !rule.methods.has(method))) continue;
    if (!(await deps.owns(threadId, match[1]!.toLowerCase()))) {
      deps.log.warn("refused another thread's device, run or build", { threadId, path: target.path.replace(/[0-9a-f-]{36}/gi, "<id>") });
      return refuse(403, "This device, run or build belongs to another bb thread. A thread acts only on what it started.");
    }
  }

  const send = async () => {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    for (const name of ["accept", "content-type", "user-agent", "x-revyl-client", "x-request-id", "x-revyl-traceparent", "x-revyl-trace-handoff"]) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return doFetch(`${upstream}${target.path}${target.query ? `?${target.query}` : ""}`, {
      method,
      headers,
      body: body === null ? undefined : (body as unknown as BodyInit),
    });
  };

  const relay = async (
    response: Response,
    after?: (json: Record<string, unknown>) => Promise<void>,
    afterBytes?: (bytes: Uint8Array, contentType: string) => Promise<void>,
    rewrite?: (json: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => {
    let bytes: Uint8Array = new Uint8Array(await response.arrayBuffer());
    if (rewrite !== undefined && response.ok) {
      const json = parseJson(bytes);
      bytes = json === null ? new TextEncoder().encode("{}") : new TextEncoder().encode(JSON.stringify(await rewrite(json)));
    }
    if (after !== undefined && response.ok) {
      const json = parseJson(bytes);
      if (json !== null) await after(json).catch((cause) => deps.log.warn("could not record a start", { error: String(cause) }));
    }
    if (afterBytes !== undefined && response.ok) {
      await afterBytes(bytes, response.headers.get("content-type") ?? "").catch((cause) =>
        deps.log.warn("could not record a device action", { error: String(cause) }),
      );
    }
    bytes = scrubKey(bytes, key, token);
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "retry-after", "x-request-id"]) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return new Response(bytes.length > 0 ? (bytes as unknown as BodyInit) : null, { status: response.status, headers });
  };

  const requestJson = body === null ? null : parseJson(body);

  if (method === "POST" && target.path === START_DEVICE) {
    return oneAtATime(`${threadId}:device`, async () => {
      const live = await deps.liveDevices(threadId);
      if (live >= deps.caps.devices) {
        return refuse(409, `This bb thread already runs ${live} Revyl device, its limit. Stop it first: revyl device stop --session-id <id>.`);
      }
      return relay(await send(), async (json) => {
        const sessionId = asText(json.session_id);
        if (sessionId === null) return;
        await deps.deviceStarted(threadId, {
          sessionId: sessionId.toLowerCase(),
          workflowRunId: asText(json.workflow_run_id)?.toLowerCase() ?? null,
          platform: asText(json.platform) ?? asText(requestJson?.platform),
        });
      });
    });
  }

  if (method === "POST" && target.path === START_BUILD) {
    return oneAtATime(`${threadId}:build`, async () => {
      const active = await deps.activeBuilds(threadId);
      if (active >= deps.caps.builds) {
        return refuse(409, `This bb thread already runs ${active} Revyl cloud build, its limit. Wait for it or cancel it: revyl build cancel <job>.`);
      }
      return relay(await send(), async (json) => {
        const jobId = asText(json.build_job_id);
        // revyl v0.2.12 sends { recipe: { app_id, profile, … }, source, … }.
        const recipe = requestJson?.recipe !== null && typeof requestJson?.recipe === "object" ? (requestJson.recipe as Record<string, unknown>) : null;
        if (jobId !== null) {
          await deps.buildStarted(
            threadId,
            jobId.toLowerCase(),
            asText(recipe?.app_id) ?? asText(requestJson?.app_id),
            asText(recipe?.profile) ?? asText(requestJson?.profile),
          );
        }
      });
    });
  }

  if (method === "GET" && SESSION_LISTS.has(target.path)) {
    return relay(await send(), undefined, undefined, async (json) => {
      const mine = async (item: unknown) => {
        if (item === null || typeof item !== "object") return false;
        for (const field of SESSION_ID_FIELDS) {
          const value = asText((item as Record<string, unknown>)[field]);
          if (value !== null && (await deps.owns(threadId, value.toLowerCase()))) return true;
        }
        return false;
      };
      const out: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(json)) {
        if (!Array.isArray(value)) {
          out[field] = value;
          continue;
        }
        const keep = await Promise.all(value.map(mine));
        out[field] = value.filter((_, index) => keep[index]);
      }
      return out;
    });
  }

  const stop =
    new RegExp(`^/api/v1/execution/device/sessions/${ID}/stop$`).exec(target.path) ??
    new RegExp(`^/api/v1/execution/device/status/cancel/${ID}$`).exec(target.path);
  if (method === "POST" && stop !== null) {
    return relay(await send(), async () => {
      await deps.deviceStopped(threadId, stop[1]!.toLowerCase());
    });
  }

  const deviceCall = DEVICE_ACTION.exec(target.path);
  if (deviceCall !== null && deps.deviceAction !== undefined) {
    const [, runId, action] = deviceCall as unknown as [string, string, string];
    return relay(await send(), undefined, async (bytes, contentType) => {
      const image = contentType.startsWith("image/") ? bytes : null;
      const answer = image === null ? parseJson(bytes) : null;
      await deps.deviceAction!(threadId, runId.toLowerCase(), action, requestJson, answer?.success !== false, image);
    });
  }

  if (method === "POST" && target.path === START_TEST) {
    return relay(await send(), async (json) => {
      const taskId = asText(json.id) ?? asText(json.task_id);
      if (taskId !== null) await deps.runStarted(threadId, "test", taskId.toLowerCase(), asText(requestJson?.test_id));
    });
  }

  if (method === "POST" && target.path === START_WORKFLOW) {
    return relay(await send(), async (json) => {
      const taskId = asText(json.task_id) ?? asText(json.id);
      if (taskId !== null) await deps.runStarted(threadId, "workflow", taskId.toLowerCase(), asText(requestJson?.workflow_id));
    });
  }

  return relay(await send());
}
