/**
 * Plain values the app and server both use. Imports nothing, so the app
 * bundle never pulls in the SDK runtime, zod or server code.
 */

export const REALTIME_RUNS = "runs";
export const REALTIME_THREAD_STATE = "thread-state";

const ACTIVE = new Set<string>(["starting", "queued", "running"]);

/** A run (or workflow test) that has not finished yet. */
export const isActive = (status: string): boolean => ACTIVE.has(status);

/** How a device session ended, as a phrase: "stopped by the agent". */
export function endedLabel(by: string | null | undefined): string {
  switch (by) {
    case "agent":
      return "stopped by the agent";
    case "person":
      return "stopped from bb";
    case "timeout":
      return "stopped after sitting idle";
    case "archived":
      return "stopped when the thread was archived";
    case "revyl":
      return "ended on Revyl";
    default:
      return "ended";
  }
}
