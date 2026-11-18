import { describe, expect, it } from "vitest";

import {
  handleProxy,
  isPlainPath,
  scrubKey,
  signThreadToken,
  upstreamTarget,
  verifyThreadToken,
  type ProxyDeps,
} from "../src/proxy";

const SECRET = "s".repeat(64);
const KEY = "real-revyl-key-1234567890";
const MINE = "11111111-1111-4111-8111-111111111111";
const THEIRS = "22222222-2222-4222-8222-222222222222";
const BASE = "http://127.0.0.1/api/v1/plugins/revyl/http/revyl?p=";

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
}

function setup(overrides: Partial<ProxyDeps> = {}, responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const recorded: string[] = [];
  const deps: ProxyDeps = {
    apiKey: async () => KEY,
    verifyToken: (token) => verifyThreadToken(SECRET, token),
    isOn: async () => true,
    owns: async (_thread, id) => id === MINE,
    liveDevices: async () => 0,
    activeBuilds: async () => 0,
    deviceStarted: async (thread, device) => void recorded.push(`device ${thread} ${device.sessionId} ${device.workflowRunId}`),
    runStarted: async (thread, kind, taskId, targetId) => void recorded.push(`${kind} ${thread} ${taskId} ${targetId}`),
    buildStarted: async (thread, jobId, appId, profile) => void recorded.push(`build ${thread} ${jobId} ${appId}${profile === null ? "" : ` ${profile}`}`),
    caps: { devices: 1, builds: 1 },
    deviceStopped: async (thread, sessionId) => void recorded.push(`stopped ${thread} ${sessionId}`),
    deviceAction: async (thread, runId, action, body, ok, image) =>
      void recorded.push(`action ${thread} ${runId} ${action} ${JSON.stringify(body)} ${ok} ${image === null ? "no-image" : `image ${image.length}`}`),
    log: { warn: () => {} },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
        body: init?.body == null ? null : Buffer.from(init.body as Uint8Array).toString("utf8"),
      });
      const path = new URL(url).pathname;
      const body = responses[path] ?? { ok: true };
      if (body instanceof Uint8Array) return new Response(body as unknown as BodyInit, { status: 200, headers: { "content-type": "image/png" } });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    ...overrides,
  };
  return { deps, calls, recorded };
}

const token = signThreadToken(SECRET, "thr_abc");
const request = (target: string, method = "GET", body?: unknown, auth = token) =>
  new Request(`${BASE}${target}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("tokens and paths", () => {
  it("signs a token one thread can use and refuses a tampered one", () => {
    expect(verifyThreadToken(SECRET, token)).toBe("thr_abc");
    expect(verifyThreadToken(SECRET, token.replace("thr_abc", "thr_xyz"))).toBeNull();
    expect(verifyThreadToken("other".repeat(13), token)).toBeNull();
    expect(verifyThreadToken(SECRET, KEY)).toBeNull();
  });

  it("keeps the upstream query that the CLI glues after ?p=", () => {
    expect(upstreamTarget(`${BASE}/api/v1/apps/?page=1&page_size=100`)).toEqual({ path: "/api/v1/apps/", query: "page=1&page_size=100" });
  });

  it("refuses dot segments and encoded separators", () => {
    expect(isPlainPath(`/api/v1/execution/device-proxy/${MINE}/tap`)).toBe(true);
    expect(isPlainPath(`/api/v1/execution/device-proxy/${MINE}/../${THEIRS}/tap`)).toBe(false);
    expect(isPlainPath(`/api/v1/execution/device-proxy/${MINE}%2f..%2f${THEIRS}/tap`)).toBe(false);
    expect(isPlainPath("/health_check")).toBe(true);
    expect(isPlainPath("/admin")).toBe(false);
  });

  it("refuses escaped letters that Revyl would decode into a route", () => {
    expect(isPlainPath(`/api/v1/%65xecution/device-proxy/${THEIRS}/tap`)).toBe(false);
    expect(isPlainPath("/api/v1/computer-run%73")).toBe(false);
    expect(isPlainPath("/api/v1/%2E%2E/admin")).toBe(false);
    expect(isPlainPath("/api/v1//explorations")).toBe(false);
    for (const control of ["%0A", "%0d", "%09", "%00", "%7F"]) expect(isPlainPath(`/api/v1/execution/start_device${control}`), control).toBe(false);
    // What the CLI does escape (a space in a name) still goes through.
    expect(isPlainPath("/api/v1/tests/name/smoke%20test")).toBe(true);
  });
});

describe("handleProxy", () => {
  it("refuses unknown tokens, threads with the toggle off, and a missing key", async () => {
    expect((await handleProxy(request("/api/v1/apps/", "GET", undefined, KEY), setup().deps)).status).toBe(401);
    expect((await handleProxy(request("/api/v1/apps/"), setup({ isOn: async () => false }).deps)).status).toBe(403);
    expect((await handleProxy(request("/api/v1/apps/"), setup({ apiKey: async () => null }).deps)).status).toBe(503);
  });

  it("sends the real key upstream and never returns it", async () => {
    const { deps, calls } = setup({}, { "/api/v1/entity/users/get_user_uuid": { org_id: "o", api_key: KEY, note: `key ${KEY}` } });
    const response = await handleProxy(request("/api/v1/entity/users/get_user_uuid"), deps);
    expect(calls[0]?.authorization).toBe(`Bearer ${KEY}`);
    const text = await response.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text).api_key).toBe(token);
  });

  it("lets a thread act only on its own devices, runs and builds", async () => {
    const { deps, calls } = setup();
    const theirs = [
      `/api/v1/execution/device-proxy/${THEIRS}/tap`,
      `/api/v1/execution/streaming/worker-connection/${THEIRS}`,
      `/api/v1/execution/device/sessions/${THEIRS}/stop`,
      `/api/v1/execution/tests/status/cancel/${THEIRS}`,
      `/api/v1/workflows/status/cancel/${THEIRS}`,
      `/api/v1/apps/remote/${THEIRS}/cancel`,
      `/api/v1/execution/device/status/cancel/${THEIRS}`,
    ];
    // Reading another thread's session record is refused too.
    expect((await handleProxy(request(`/api/v1/execution/device-sessions/${THEIRS}`), deps)).status).toBe(403);
    // `revyl build cancel` sends DELETE /api/v1/apps/remote/<job>.
    expect((await handleProxy(request(`/api/v1/apps/remote/${THEIRS}`, "DELETE"), deps)).status).toBe(403);
    for (const path of theirs) expect((await handleProxy(request(path, "POST", {}), deps)).status, path).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await handleProxy(request(`/api/v1/execution/device-proxy/${MINE}/tap`, "POST", { x: 1, y: 2 }), deps)).status).toBe(200);
    // Reading a build's status is allowed for any build.
    expect((await handleProxy(request(`/api/v1/apps/remote/${THEIRS}/status`), deps)).status).toBe(200);
  });

  it("lets a cloud build ask for its upload URL, which names no build", async () => {
    // `revyl build` starts with POST /api/v1/apps/remote/upload-url (revyl v0.2.12).
    const { deps, calls } = setup();
    const response = await handleProxy(request("/api/v1/apps/remote/upload-url", "POST", { app_id: "a1" }), deps);
    expect(response.status).toBe(200);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(["POST /api/v1/apps/remote/upload-url"]);
    // Only that exact path: anything after it is still checked as a build id.
    expect((await handleProxy(request("/api/v1/apps/remote/upload-url/x", "POST", {}), deps)).status).toBe(403);
  });

  it("caps devices and builds per thread", async () => {
    const { deps, calls } = setup({ liveDevices: async () => 1, activeBuilds: async () => 1 });
    expect((await handleProxy(request("/api/v1/execution/start_device", "POST", { platform: "ios" }), deps)).status).toBe(409);
    expect((await handleProxy(request("/api/v1/apps/remote", "POST", { app_id: "a" }), deps)).status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it("records the starts it relays", async () => {
    const { deps, recorded } = setup(
      {},
      {
        "/api/v1/execution/start_device": { session_id: MINE.toUpperCase(), workflow_run_id: THEIRS },
        "/api/v1/execution/api/execute_test_id_async": { id: "33333333-3333-4333-8333-333333333333" },
        "/api/v1/workflow-executions": { task_id: "44444444-4444-4444-8444-444444444444" },
        "/api/v1/apps/remote": { build_job_id: "55555555-5555-4555-8555-555555555555" },
      },
    );
    await handleProxy(request("/api/v1/execution/start_device", "POST", { platform: "ios" }), deps);
    await handleProxy(request("/api/v1/execution/api/execute_test_id_async", "POST", { test_id: "t1" }), deps);
    await handleProxy(request("/api/v1/workflow-executions", "POST", { workflow_id: "w1" }), deps);
    // revyl v0.2.12 nests the app and profile in a recipe.
    await handleProxy(request("/api/v1/apps/remote", "POST", { recipe: { app_id: "a1", profile: "unit-tests" }, source: {} }), deps);
    await handleProxy(request(`/api/v1/execution/device/sessions/${MINE}/stop`, "POST", {}), deps);
    expect(recorded).toEqual([
      `device thr_abc ${MINE} ${THEIRS}`,
      "test thr_abc 33333333-3333-4333-8333-333333333333 t1",
      "workflow thr_abc 44444444-4444-4444-8444-444444444444 w1",
      "build thr_abc 55555555-5555-4555-8555-555555555555 a1 unit-tests",
      `stopped thr_abc ${MINE}`,
    ]);
  });
});

describe("refused outright", () => {
  it("keeps share links, explorations and cloud Macs away from agents", async () => {
    const { deps, calls } = setup();
    const refused = [
      ["POST", "/api/v1/report/async-run/generate_shareable_report_link_by_task"],
      ["POST", "/api/v1/report/async-run/generate_shareable_report_link_by_session"],
      ["POST", "/api/v1/workflows/share/generate_shareable_link"],
      ["POST", "/api/v1/explorations"],
      ["POST", "/api/v1/computer-runs"],
      ["DELETE", `/api/v1/computer-runs/${THEIRS}`],
      ["POST", `/api/v1/reports-v3/sessions/${THEIRS}/proof-media`],
      ["POST", `/api/v1/atlas/v2/apps/${MINE}/share`],
    ];
    for (const [method, path] of refused) expect((await handleProxy(request(path!, method, method === "GET" ? undefined : {}), deps)).status, path).toBe(403);
    expect(calls).toHaveLength(0);
    // Reading stays open.
    expect((await handleProxy(request("/api/v1/computer-runs"), deps)).status).toBe(200);
  });
});

describe("older CLIs", () => {
  it("still reads a build's app and profile from the top level", async () => {
    const { deps, recorded } = setup({}, { "/api/v1/apps/remote": { build_job_id: "55555555-5555-4555-8555-555555555555" } });
    await handleProxy(request("/api/v1/apps/remote", "POST", { app_id: "a9", profile: "release" }), deps);
    expect(recorded).toEqual(["build thr_abc 55555555-5555-4555-8555-555555555555 a9 release"]);
  });
});

describe("session lists", () => {
  it("keeps only the thread's own sessions in the org's lists", async () => {
    const { deps } = setup(
      {},
      {
        "/api/v1/execution/device-sessions/active": {
          sessions: [{ id: MINE, app_name: "mine" }, { id: THEIRS, app_name: "theirs" }, { session_id: MINE.toUpperCase() }],
          concurrency_limit: 2,
        },
      },
    );
    const response = await handleProxy(request("/api/v1/execution/device-sessions/active?org_id=o"), deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessions: unknown[]; concurrency_limit: number };
    expect(body.sessions).toEqual([{ id: MINE, app_name: "mine" }, { session_id: MINE.toUpperCase() }]);
    expect(body.concurrency_limit).toBe(2);
  });

  it("counts a cancel of its own device as a stop", async () => {
    const { deps, recorded } = setup();
    await handleProxy(request(`/api/v1/execution/device/status/cancel/${MINE}`, "POST", {}), deps);
    expect(recorded).toEqual([`stopped thr_abc ${MINE}`]);
  });
});

describe("device actions", () => {
  it("reports what the thread did on its own device, screenshots with their bytes", async () => {
    const shot = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const { deps, recorded } = setup(
      {},
      {
        [`/api/v1/execution/device-proxy/${MINE}/tap`]: { success: true, action: "tap" },
        [`/api/v1/execution/device-proxy/${MINE}/input`]: { success: false, action: "input" },
        [`/api/v1/execution/device-proxy/${MINE}/screenshot`]: shot,
      },
    );
    await handleProxy(request(`/api/v1/execution/device-proxy/${MINE}/tap`, "POST", { x: 200, y: 400 }), deps);
    await handleProxy(request(`/api/v1/execution/device-proxy/${MINE}/input`, "POST", { text: "pw" }), deps);
    const screenshot = await handleProxy(request(`/api/v1/execution/device-proxy/${MINE}/screenshot`), deps);
    expect(new Uint8Array(await screenshot.arrayBuffer())).toEqual(shot);
    expect(recorded).toEqual([
      `action thr_abc ${MINE} tap {"x":200,"y":400} true no-image`,
      `action thr_abc ${MINE} input {"text":"pw"} false no-image`,
      `action thr_abc ${MINE} screenshot null true image 9`,
    ]);
  });

  it("reports nothing for another thread's device", async () => {
    const { deps, recorded } = setup();
    expect((await handleProxy(request(`/api/v1/execution/device-proxy/${THEIRS}/tap`, "POST", { x: 1, y: 1 }), deps)).status).toBe(403);
    expect(recorded).toEqual([]);
  });
});

describe("scrubKey", () => {
  it("replaces every copy of the key", () => {
    const out = Buffer.from(scrubKey(new TextEncoder().encode(`${KEY} and ${KEY}`), KEY, "tok")).toString();
    expect(out).toBe("tok and tok");
  });
});
