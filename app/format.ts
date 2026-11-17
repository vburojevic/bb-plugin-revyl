import type { Run, RunStatus } from "../src/model";

export const STATUS_LABEL: Record<RunStatus, string> = {
  starting: "Starting",
  queued: "Queued",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  cancelled: "Canceled",
  timeout: "Timed out",
  lost: "Not found",
};

/** Icon and tone for a status. Color marks state only, from theme tokens. */
export function statusGlyph(status: RunStatus): { icon: string; fallback: string; tone: string; spin: boolean } {
  switch (status) {
    case "passed":
      return { icon: "CircleCheck", fallback: "CircleCheck", tone: "text-success", spin: false };
    case "failed":
    case "timeout":
      return { icon: "CircleX", fallback: "CircleX", tone: "text-destructive-text", spin: false };
    case "cancelled":
      return { icon: "CircleSlash", fallback: "CircleX", tone: "text-muted-foreground", spin: false };
    case "lost":
      return { icon: "CircleHelp", fallback: "Info", tone: "text-muted-foreground", spin: false };
    case "queued":
      return { icon: "Clock", fallback: "Loading", tone: "text-muted-foreground", spin: false };
    default:
      return { icon: "Loading", fallback: "Loading", tone: "text-primary", spin: true };
  }
}

export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatAgo(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** When something happened, compact for lists: "Today 10:33 AM", "Yesterday 10:07 PM", "Nov 15, 9:20 PM" (in the reader's locale). */
export function formatWhen(value: string | number, now = Date.now()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (offset: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offset);
    return d.getTime();
  };
  const tomorrow = day(-1);
  if (date.getTime() >= day(0) && date.getTime() < tomorrow) return `Today ${time}`;
  if (date.getTime() >= day(1) && date.getTime() < day(0)) return `Yesterday ${time}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })}, ${time}`;
}

/** A span of time in whole minutes, rounded down: "under a minute", "12 min", "1 h 5 min". */
export function formatMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

export function platformLabel(platform: string | null): string | null {
  if (platform === null) return null;
  const lower = platform.toLowerCase();
  return lower === "ios" ? "iOS" : lower === "android" ? "Android" : platform;
}

export { endedLabel } from "../src/shared";

/** bb's own settings card (Settings, Configuration): recessed, a hairline border, 12px in. */
export const SETTINGS_CARD = "overflow-hidden rounded-md border border-border bg-surface-recessed/70 px-3 py-3";

/** "Step 2 of 5", "1 of 2 tests", or null when Revyl has not said. */
export function progressLabel(run: Run): string | null {
  if (run.done === null || run.total === null || run.total === 0) return null;
  // While the device is set up Revyl reports a single placeholder step.
  if (run.kind === "test" && run.total === 1 && run.done === 0) return null;
  return run.kind === "workflow" ? `${run.done} of ${run.total} tests` : `Step ${Math.min(run.done + 1, run.total)} of ${run.total}`;
}

/** One line that says where a run stands, for the card and the directive. */
export function runSummary(run: Run): string {
  const name =
    run.kind === "build"
      ? `${run.profile ? `The ${run.profile} build` : "Cloud build"}${run.name === null ? "" : ` of ${run.name}`}`
      : (run.name ?? (run.kind === "workflow" ? "Workflow" : "Test"));
  switch (run.status) {
    case "starting":
      return `${name} is starting`;
    case "queued":
      return run.kind === "build" ? `${name} is waiting for a runner` : `${name} is waiting for a device`;
    case "running": {
      const progress = progressLabel(run);
      return progress === null ? `${name} is running` : `${name}: ${progress.toLowerCase()}`;
    }
    case "passed":
      return run.kind === "workflow" && run.total !== null ? `${name} passed, ${run.total} of ${run.total} tests` : `${name} passed`;
    case "failed":
      return run.kind === "workflow" && run.failed !== null && run.total !== null
        ? `${name} failed, ${run.failed} of ${run.total} tests`
        : `${name} failed`;
    case "cancelled":
      return `${name} was canceled`;
    case "timeout":
      return `${name} timed out`;
    case "lost":
      return `${name}: Revyl never reported this run`;
  }
}

export const REPORT_TAB = { id: "report", context: { kind: "thread" as const }, availability: "action" as const };
export const DEVICE_TAB = { id: "device", context: { kind: "thread" as const }, availability: "action" as const };

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
