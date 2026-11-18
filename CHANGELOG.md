# Changelog

## 0.2.7

- A failed test says which step it stopped at and Revyl's reason: on the run card, on its reply card ("failed at step 4 of 4") and in `bb revyl runs`.
- The report pane has a Performance, logs and network section (CPU, memory and frame rate, the run's warnings and errors, failed requests), read from Revyl when opened and never stored, and a Copy link button.
- Minutes: your plan and iOS minutes left show in Settings, on the Revyl page, and in every confirmation that spends minutes.
- Device pane: pick the model and OS when starting a device (only devices for the project's platforms, named in the confirmation); press Enter or Delete, paste a link or deep link to open it, or relaunch the app; the controls wrap in a narrow side panel; the long worktree branch moved from the header to the details.
- Fix: Stop now waits until Revyl confirms the device is off (`revyl device stop` can answer `stopped: false`), in the pane and when a thread is archived. A device Revyl already ended counts as stopped, and any other stop error shows Revyl's message.
- Fix: text typed from the pane went to the CLI as an argument, visible in the server's process list, and replaced the field's contents. It now goes through the environment and adds to the field.
- Fix: a current `.revyl/config.yaml` (`build.profiles`) now links a project to its app, and Revyl MCP runs through `manage_tests` and `manage_workflows` get cards.
- The proxy refuses public links (report and workflow share links, `revyl session publish`, Atlas share links), Revyl explorations and cloud Macs in Test on Revyl threads.
- Fix: the proxy passed percent-escaped paths such as `/api/v1/%65xecution/...` or a trailing `%0A`, which Revyl routes like the plain path, so an agent could get past its rules and reach another thread's device. It now refuses escaped letters, digits, `-._~` and control characters, and `//`.
- Fix: the device pane's input and Stop act only on a device the thread started.

## 0.2.6

- Revyl's app icon is the plugin's logo where bb has room for one, beside the theme-colored mark on small surfaces.
- A new README with real screenshots of each main surface in light and dark, and PLUGIN_OVERVIEW.md for the BB Community marketplace listing.

## 0.2.5

- Every surface follows bb's own design language: settings in bb's settings card, the Revyl page in bordered lists with compact run history and a real empty state, bb's heading style in the report and device pane, and a run card whose rows line up with its header.
- Cloud builds are named by their profile ("unit-tests build") with the app beside them. `bb revyl runs` prints each build's job id and profile and, when it failed, the step that failed and Revyl's error line, instead of "(no build id yet)".
- A device says how it ended (stopped by the agent, from bb, after sitting idle, or with the thread) in `bb revyl runs` and in the device pane's header.
- Fix: the proxy read a cloud build's app from the wrong place in revyl v0.2.12's request, so a build's app name showed only after the first status poll.

## 0.2.4

- The Revyl device pane follows the thread's cloud device. It opens by itself when the agent starts a device, once per device, and shows it live with the app, build and branch, how long it has run, the agent's last actions (never the text it types) and a Stop button. After the device stops it keeps the last screen and says how it ended: stopped by the agent, from bb, after sitting idle, or with the thread. With no device it shows a quiet empty state and the list to start one.
- `::revyl{device="<session_id>" shot="<n>"}` in a reply pins one screenshot the agent took of its device, with the app, build and whether the device still runs. `bb revyl runs` prints the line for the latest screenshot.
- The proxy records each action an agent takes on its device (never typed or instruction text) and keeps its screenshots in the plugin's database: the latest 12 of each recent device plus up to 24 a reply shows, only the latter after archiving, none after deleting.
- Fix: a thread could read another thread's device session record and, through `device/status/cancel`, possibly stop its device. Those paths now take only the thread's own sessions, and the org's device lists reach an agent cut down to its own.
- Fix: a device started from bb now counts against the thread's one-device limit, and one failed status check no longer shows a running device as ended.

## 0.2.3

- Fix: every cloud build from a Test on Revyl thread was refused before it started. `revyl build` first asks for an upload URL (`POST /api/v1/apps/remote/upload-url`), and the proxy took `upload-url` for a build id the thread did not own.
- Agents and the skill now know Revyl refuses a source archive over 500 MB, and how to build a repo with large tracked files from a slim copy.

## 0.2.2

- Fix: when bb moves the Test on Revyl button into its More plugin actions menu (bb shows three plugins' composer buttons inline, the most clicked first), the button there was a bare icon. It now reads "Test on Revyl" with its On or Off state, "Connect Revyl" before you connect, and "Retry" when its state could not be read.
- The plugin, its sidebar page and the composer button use the Revyl mark instead of a generic phone.

## 0.2.1

- Fix: a thread-event read that failed while another was running (for example a bb request timeout) escaped as an uncaught error and marked the plugin as failing.

## 0.2.0

- Test on Revyl, per thread: a composer button (and the next new thread of a project, or `bb revyl mode`). With it on, the thread's agent builds, tests and runs iOS and Android apps only on Revyl: cloud builds with `revyl build`, tests that cover the change (written and pushed when none does), Revyl set up in a repo without it, build secrets only through bb's secure input.
- The Revyl key now lives in the plugin's secret settings (Revyl page, or `bb revyl connect --key-file`). Agents get a per-thread token through a proxy on the bb server that adds the key, scrubs it from every reply, lets a thread act only on devices, runs and builds it started, and allows 1 device and 1 cloud build at a time. Threads without the mode cannot reach Revyl.
- Run cards follow Revyl cloud builds. Archiving or deleting a thread stops its devices and cancels its runs.
- A warning when the bb server's machine has its own `revyl auth` sign-in, which agents there could use to skip the per-thread limits.
- `bb revyl runs --json` now prints `{ runs, devices }` instead of an array.

## 0.1.1

- Fix: installing from git failed with `Could not resolve "@get-bb/plugin-sdk"`. The app bundle no longer imports the server's RPC contract at runtime.

## 0.1.0

First release.

- Run card above the composer for every Revyl test or workflow run started in the thread, from the CLI (blocking or `--no-wait`), Revyl's MCP tools, or any output with a Revyl report link. Open the report, run again on the same build, or cancel.
- `::revyl{task="<task_id>"}` renders a live result card in a reply; `bb revyl runs` lists a thread's runs with their directives.
- Side panel report: video with a step timeline, step screenshots and reasoning, Revyl's AI summary; workflows list their tests.
- Side panel device: a live cloud device over WebRTC with tap, swipe and type, locked while the thread's agent is working; start and stop devices; an idle timeout.
- Sidebar page: tests and workflows for a project linked by its `.revyl/` files or for the whole org, with history, reports and Run.
- Settings section and setup card for the Revyl CLI and its sign-in. The plugin never stores an API key.
