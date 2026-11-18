---
name: revyl
description: How Revyl cloud app testing works in bb threads through the Revyl plugin's Test on Revyl mode - building on Revyl's runners, running and writing Revyl tests, cloud devices, run cards, and pinning results with ::revyl. Use when a thread mentions Revyl, cloud testing of iOS or Android apps, or when bb's instructions say this thread tests on Revyl. Also covers bb revyl commands.
---

# Revyl in bb

## Test on Revyl is a per-thread switch

The person turns it on with the Test on Revyl button in the thread's composer (or `bb revyl mode on --thread <id>`; `--project <id>` flags the project's next new thread). When it is on, bb has set up the `revyl` CLI for the thread (REVYL_BACKEND_URL and REVYL_API_KEY, a token for this thread only) and its instructions say how to work:

- Build, test and run iOS and Android apps only on Revyl. Never run local `xcodebuild`, `xcrun simctl`, a local Simulator, an Android emulator or XcodeBuildMCP for them. macOS targets still build locally.
- Build: `revyl build --platform ios --json` builds the working tree (uncommitted and untracked files included, gitignored files not) on Revyl's cloud runners and returns `build_version_id`. Revyl refuses a source archive over 500 MB and the CLI cannot leave paths out; for a repo whose tracked files are too big (screenshots, media), build from a slim sparse checkout inside the thread's workspace with the change applied.
- Prove: `revyl test run <name> --build-id <build_version_id> --no-open --json`. When no test covers the change, write a YAML test in `.revyl/tests/` (schema: `revyl schema --format llm`), push it with `revyl test create --from-file <file> --no-open`, run it, and commit it.
- Look around: `revyl device start --platform ios --build-version-id <id> --open=false --json`, then `revyl device screenshot|tap|swipe|type --session-id <id>`; stop it with `revyl device stop --session-id <id>`. The person watches it live in bb's Revyl device pane, which opens by itself and lists what you do (never the text you type).
- No `.revyl/config.yaml` yet: `revyl init --detect --xcode-scheme ios=<Scheme> -y`, create the app with `revyl app create` if needed, set `app_id` under `build.profiles.<profile>.ios`, generate the project in `build_commands` when it is generated (`xcodegen generate`, `tuist generate`), and commit `.revyl/`.
- Build secrets: ask the person first, then take the value only through bb's secure input (`bb secret request`) and pipe it to `revyl build secret set <NAME> --stdin`; never print it.
- Limits: 1 cloud device and 1 cloud build at a time; a thread acts only on devices, runs and builds it started. Share links, `revyl explore` and cloud Macs (`revyl computer`) are refused; the person shares reports from bb.
- Why a test failed: `bb revyl runs` prints the failing step and Revyl's reason for each failed test; `revyl run logs|perf|network <task_id> --json` read the run's device logs, performance and failed requests.
- Never run `revyl auth login`, change the REVYL_* variables, or print REVYL_API_KEY.

## When the switch is off

`revyl` does not reach Revyl. If the person asks for Revyl, ask them to turn on Test on Revyl in the composer; do not sign in yourself.

## Show a result in a reply

Put the directive alone on its own line:

```
::revyl{task="<task_id>"}
```

It renders a live card with the run's status, steps and a link to the full report (video, step screenshots, AI summary). The task id is `task_id` in `revyl test run --json` and the `taskId=` in a report link.

To show a device screen, take `revyl device screenshot --session-id <id>` first, then use the line `bb revyl runs` prints:

```
::revyl{device="<session_id>" shot="<n>"}
```

It shows that screenshot for good, with the app, build and whether the device still runs. Without `shot` it shows the latest screenshot. Only devices of the same thread render.

## Commands

```text
bb revyl status            connection, and whether this thread tests on Revyl
bb revyl runs              this thread's runs and builds, each test or workflow with its directive, and its device with a ::revyl{device} line
bb revyl mode on|off       switch Test on Revyl for this thread (--thread <id>), or for a project's next new thread (--project <id>)
```

Every command takes `--json`. A switch reaches the agent's environment from its next turn.
