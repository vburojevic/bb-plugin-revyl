# Verified against a live Revyl account

Observed on 2026-11-16 with Revyl CLI v0.2.12 (Homebrew `revylai/tap/revyl`), bb 0.49.0, Plugin SDK 0.6.132, on a free-plan org with an iOS app built from `demo/ios` (Tasklet). Where this file and the Revyl docs disagree, this file is what the CLI actually did.

## CLI and auth

- `revyl auth status --json` returns `{auth_method, authenticated, email, expired, org_id, org_name, user_id}`.
- `revyl auth persist-cloud-env` with `REVYL_API_KEY` in the child environment signs the CLI in without the key ever appearing in argv or output. `~/.revyl` then holds `client-identity.json` and `cloud-runtime.json`; no `credentials.json` was written.
- CLI start-up is about 0.06 s (`revyl version`).
- `--json` is not consistent: `test create --json` and `workflow create --json` print human lines around or instead of JSON. Parse the last JSON object in stdout, never the whole stream.
- Billing notices (`queue_notice`) appear inside run and session JSON even when a device was free.

## Runs

- `revyl test run <name> --json` (blocking) prints human progress lines (`▶ running [2/5 steps] → <step>`) and the JSON object only at the end. The task id is not printed before the run finishes.
- `revyl test run <name> --no-wait --json` and `revyl workflow run <name> --no-wait --json` return `{task_id, report_link, status: "queued", ...}` at once.
- `revyl test history <name> --json` lists executions newest first: `items[].{task_id, status, started_at, steps_completed, total_steps, success, has_report}`. A blocking run appears here while it runs, which is how a card binds to it before the CLI prints its id.
- `revyl test report <task_id> --json` (about 28 KB) works for running and finished tests, including test executions inside a workflow. It holds:
  - `steps[]` with `step_description`, `step_type`, `status`, `effective_status` (use this one: a failed validation had `status: success` and `effective_status: failed`), `validation_reasoning`, `video_timestamp_start/end`, and `actions[]` with `screenshot_before_url` and `reasoning`.
  - `tldr.{test_case, insights[], key_moments[]}` and `test_goal_summary`, the AI summary.
  - `video_url`, `device_state_url`, `hardware_metrics_url` and every screenshot URL are presigned S3 URLs that expire after 3600 s. The viewer must fetch a fresh report when it opens and never persist these URLs.
  - `whep_url`, `session_id`, `device_model`, `os_version`, `platform`, `duration_seconds`.
- `revyl workflow status <task_id> --json` returns `{status, completed_tests, total_tests, passed_tests, failed_tests, report_url, tests[]}`. `tests[].id` is the test execution id (works with `test report`), `tests[].test_id` the test; there is no test name, so names come from `revyl test remote --json`.
- A workflow's `status` stayed `running` for about a minute after both tests had finished, then became `failed`.
- Cancel: `revyl test cancel <task_id>`, `revyl workflow cancel <task_id>`. Cancel is a request: on a finished test it still exits 0 ("Test cancellation requested ... Status: completed"). A cancelled workflow then reports itself and each test as `cancelled`; a cancelled test report has `session_status: cancelled` with `success: false`.
- Re-run on the same build: `revyl test run <name> --build-id <resolved_build_id>`.

## Device sessions and the stream

- `revyl device start --platform ios --app-id <id> --open=false --timeout 600 --json` returned in 22 s with `session_id`, `viewer_url`, `screen_width/height` and `device_ready: true`.
- `revyl device info -s <session> --json` returns `whep_url` (Cloudflare Realtime, `revyl-realtime-bridge.revyl.workers.dev/play/<id>`).
- The WHEP endpoint answers CORS preflight with `access-control-allow-origin: *` and needs no auth header; the URL is the capability. Treat it as sensitive: never log it.
- bb's web UI serves no Content-Security-Policy header, so a plugin frame can open a WebRTC connection to it.
- `revyl device tap -s <session> --x <x> --y <y> --json` took 1.3 to 2.0 s per call end to end, while the device reported `latency_ms` of 28 to 58. Touch input through the CLI therefore lands about 1.5 s after the click; the panel shows a pending marker until it lands.
- `revyl device stop -s <session> --json` returns `{stopped: true}`, also for a session that had already ended (exit 0).
- `revyl device type` needs a point: without `--x/--y` or `--target` it fails with "device type needs the field to type into". The panel sends the last tapped point.
- `revyl device info` for an ended session exits 1 with `Error: session <id> is in terminal state: completed|timeout; ...`, and for an unknown id with `session not found or not accessible`. The poller uses this to mark sessions ended by the idle timeout or by the agent.
- `revyl device ...` writes `.revyl/device-sessions.json` (it includes the account email) in the folder it runs in, so the plugin runs its device commands in a temporary folder.
- Measured in bb: a device started from the panel streamed about 21 s after the click (device start included); the idle timeout set to 1 minute ended a session after 74 to 77 s without input.

## bb side

- bb returns at most 100 thread events per `threads.events.list` call, and does not replay events sent while a plugin was not loaded.
- The Codex provider records shell commands wrapped as `/bin/zsh -lc "<command>"`; Claude Code records the bare command.
- A plugin side-panel tab whose launcher is hidden (`useVisible: () => false`) cannot be opened with `openTab`.
- The sidebar page gets no current project from `useBbContext()`.

- A Claude Code thread's shell command appears in thread events as `item/started` with `data.item.type: "commandExecution"` and the full `command` text the moment it starts, and as `item/completed` with `aggregatedOutput` and `exitCode` when it ends. This is how the plugin sees `revyl test run` in a thread without wrapping the CLI.

## Proxy and cloud builds (2026-11-17, revyl 0.2.12)

- Every authenticated call goes to `REVYL_BACKEND_URL` with `Authorization: Bearer <REVYL_API_KEY>`. The CLI accepts any stand-in token without checking it locally. `REVYL_API_KEY` from the environment wins over a stored sign-in.
- The CLI appends paths verbatim, query included: with `REVYL_BACKEND_URL=<bb route>?p=` the request is `…?p=/api/v1/apps/?page=1&page_size=100`. The proxy reads everything after `?p=` as path plus query.
- `GET /api/v1/entity/users/get_user_uuid` (called by most commands) returns the account's `api_key`. The proxy replaces the real key in every reply with the thread's token.
- Starts and their ids:
  - `POST /api/v1/execution/start_device` returns `session_id` and `workflow_run_id`.
  - `POST /api/v1/execution/api/execute_test_id_async` (body `test_id`) returns `id`, the task id.
  - `POST /api/v1/workflow-executions` (body `workflow_id`) returns `task_id`.
  - `POST /api/v1/apps/remote` (body `app_id`, `recipe`, `source`) returns `build_job_id`.
- Calls on one device or run:
  - `/api/v1/execution/device-proxy/<workflow_run_id>/…` (`tap`, `input`, `swipe`, `go_home`, `health`) and `/api/v1/execution/streaming/worker-connection/<workflow_run_id>`, which returns a worker credential and the WHEP URL.
  - `POST /api/v1/execution/device/sessions/<session_id>/stop`.
  - `POST /api/v1/execution/tests/status/cancel/<task_id>` and `POST /api/v1/workflows/status/cancel/<task_id>`.
  - `GET /api/v1/apps/remote/<job>/status`.
- Bypassing the backend URL: the build source and artifact uploads go to presigned S3 URLs (no key), and the update check goes to github.com unless `REVYL_NO_UPDATE_NOTIFIER=1`.
- `revyl auth persist-cloud-env` stores the key in plain text in `~/.revyl/cloud-runtime.json`; `revyl auth logout` deletes it.
- Cloud builds: `revyl build --platform ios --json` built the demo on image `ios-macos-26-xcode-27.0` in about 40 s on the free plan. The upload is `git ls-files --cached --others --exclude-standard`: uncommitted and untracked files go, gitignored ones do not, and the runner gets no `.git`. An XcodeGen project builds with `xcodegen generate` in `build_commands` (the generated `.xcodeproj` is gitignored). Config: `build.profiles.<profile>.ios.{app_id, build_commands, output_path}` plus `project.id`; without `project.id` the build fails with "project is required". Build seconds draw the same credits as iOS device minutes.
