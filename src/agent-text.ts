/**
 * What agents are told, and what `bb revyl runs` prints for them.
 */

import type { Run } from "./model";
import { isActive } from "./shared";

/** At most this many cloud devices and cloud builds per thread at a time. */
export const CAPS = { devices: 1, builds: 1 } as const;

/** Every thread: how run cards and the directive work. */
export const BASE_INSTRUCTIONS = [
  "Revyl (cloud app testing) works only in bb threads with Test on Revyl on; bb then gives revyl a token for the thread. If the person asks for Revyl in a thread where it is off, ask them to turn on Test on Revyl in the composer. Never run `revyl auth login` or set REVYL_API_KEY yourself.",
  "Revyl runs in this thread appear by themselves in a card above the composer.",
  'To show a run\'s result in a reply, put ::revyl{task="<task_id>"} alone on its own line; `bb revyl runs` lists this thread\'s runs with ready-made directives.',
].join(" ");

/** Threads with Test on Revyl on: build, test and run only on Revyl. */
export function testOnRevylInstructions(): string {
  return [
    "This bb thread tests on Revyl. For iOS and Android apps, build, test and run only on Revyl, with the `revyl` CLI:",
    "- Never run local `xcodebuild`, `xcrun simctl`, a local Simulator, an Android emulator or XcodeBuildMCP for those apps, on any machine. macOS targets still build locally: Revyl does not test macOS apps.",
    "- Build on Revyl's cloud runners: `revyl build --platform ios --json` (or `--detach --json`, then `revyl build status <job> --follow --json`). It uploads the working tree, uncommitted and untracked files included, but not gitignored files. Use the `build_version_id` it returns.",
    "- Revyl refuses a source archive over 500 MB (`source archive too large`), and `revyl build` cannot leave paths out. When tracked files make the repo too big (screenshots, media), build from a slim copy inside this thread's workspace: a sparse checkout of only what the build needs, with your change applied, and run `revyl build` there.",
    "- Prove the change with tests: `revyl test run <name> --build-id <build_version_id> --no-open --json`, or `revyl workflow run <name> --no-open`. When no test covers the change, write one as YAML in `.revyl/tests/` (see `revyl schema --format llm`), push it with `revyl test create --from-file <file> --no-open` (or `revyl test push`), and run it. Commit the test with the change.",
    "- To look around by hand: `revyl device start --platform ios --build-version-id <id> --open=false --json`, then `revyl device screenshot/tap/swipe/type --session-id <id>`, and `revyl device stop --session-id <id>` when done. The person watches the device live in bb's Revyl device pane, which opens by itself and lists each thing you do.",
    "- A repo without `.revyl/config.yaml`: run `revyl init --detect --xcode-scheme ios=<Scheme> -y`, create the Revyl app with `revyl app create --name <name> --platform ios --json` if none exists, put its `app_id` under `build.profiles.<profile>.ios`, and make `build_commands` generate the project first when it is generated (`xcodegen generate`, or `tuist generate`). Commit `.revyl/` with the change.",
    "- A cloud build that needs a secret (a gitignored config such as a secrets xcconfig): ask the person first, naming each secret. Get the value only through bb's secure input, never in chat: `bb secret request <NAME> --purpose \"Revyl build secret\" --describe <NAME> \"<what it is>\" --write-env \"$BB_THREAD_STORAGE/revyl-secret.env\"`. Then store it in Revyl without printing it: `( set -a; . \"$BB_THREAD_STORAGE/revyl-secret.env\"; printf %s \"$<NAME>\" ) | revyl build secret set <NAME> --stdin; rm -f \"$BB_THREAD_STORAGE/revyl-secret.env\"`, and reference it by name under the build profile in `.revyl/config.yaml`.",
    `- At most ${CAPS.devices} cloud device and ${CAPS.builds} cloud build run at a time in this thread, and it can act only on devices, runs and builds it started. Stop devices you no longer need; they use paid device minutes.`,
    "- bb set up the CLI for this thread through REVYL_BACKEND_URL and REVYL_API_KEY: the key is a token for this thread only. Never run `revyl auth login`, change those variables, or print REVYL_API_KEY.",
    '- In your reply, pin the proof: ::revyl{task="<task_id>"} alone on its own line for each run that shows the change works. To show a device screen, take `revyl device screenshot` first, then put the `::revyl{device="…" shot="…"}` line that `bb revyl runs` prints alone on its own line.',
  ].join("\n");
}

/** Inserted into the person's next message when the switch flips mid-thread. */
export function switchNote(on: boolean): string {
  return on
    ? "(Test on Revyl is now on for this thread: build, test and run iOS and Android apps only on Revyl, never local xcodebuild, simulators or emulators.)"
    : "(Test on Revyl is now off for this thread: the revyl CLI no longer works here.)";
}

const STATUS_WORD: Record<Run["status"], string> = {
  starting: "starting",
  queued: "queued",
  running: "running",
  passed: "passed",
  failed: "failed",
  cancelled: "canceled",
  timeout: "timed out",
  lost: "not found on Revyl",
};

/** A reply line that shows a device: one screenshot when `shot` is set, else the device as it is. */
export function deviceDirective(sessionId: string, shot: number | null): string {
  return shot === null ? `::revyl{device="${sessionId}"}` : `::revyl{device="${sessionId}" shot="${shot}"}`;
}

export function formatRunsForCli(runs: readonly Run[]): string {
  if (runs.length === 0) return "No Revyl runs in this thread yet.";
  return runs
    .map((run) => {
      const progress = run.done !== null && run.total !== null ? ` ${run.done}/${run.total}` : "";
      if (run.kind === "build") {
        // Enough to tell a test step that failed from a broken build, and one profile from another.
        const lines = [
          `build ${run.name ?? "(unnamed)"}${run.profile ? ` (profile ${run.profile})` : ""}: ${STATUS_WORD[run.status]}`,
          `  job ${run.taskId ?? "(not started yet)"}${run.branchName ? ` · branch ${run.branchName}` : ""}`,
        ];
        if (run.buildId !== null) lines.push(`  build_version_id ${run.buildId}${run.buildVersion ? ` (${run.buildVersion})` : ""}`);
        else if (isActive(run.status)) lines.push("  (no build id yet)");
        else if (run.status === "passed") lines.push("  (Revyl returned no build id)");
        if (run.failedStep && run.status !== "passed") lines.push(`  failed step: ${run.failedStep}`);
        if (run.error && run.status !== "passed") lines.push(`  error: ${run.error}`);
        return lines.join("\n");
      }
      const head = `${run.kind} ${run.name ?? "(unnamed)"}: ${STATUS_WORD[run.status]}${progress}`;
      const directive = run.taskId === null ? "  (no task id yet)" : `  ::revyl{task="${run.taskId}"}`;
      const failure =
        run.status === "failed" && run.failure
          ? [
              `  failed at step ${run.failure.step}${run.failure.description ? `: ${run.failure.description}` : ""}`,
              ...(run.failure.reason ? [`  reason: ${run.failure.reason.replace(/\s+/g, " ").slice(0, 300)}`] : []),
            ]
          : [];
      return [head, ...failure, directive].join("\n");
    })
    .join("\n");
}
