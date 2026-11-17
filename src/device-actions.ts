/**
 * What the agent did on a cloud device, in words a person reads in the device
 * pane. The proxy sees every action as `/api/v1/execution/device-proxy/<run>/<action>`
 * (verified with revyl v0.2.12: tap, swipe, input, go_home, screenshot; the
 * CLI also polls `health`, which is not an action).
 *
 * No free text is kept: typed text and its length can give away a password,
 * and an instruction step can carry a login. Links keep their host only.
 */

export const DEVICE_ACTION = /^\/api\/v1\/execution\/device-proxy\/([^/]+)\/([A-Za-z0-9_-]+)$/;

/** Polls and reads that are not something the agent did. */
const NOT_ACTIONS = new Set(["health", "hierarchy", "perf", "requests", "logs", "state", "metrics", "network", "status", "info"]);
const DIRECTIONS = new Set(["up", "down", "left", "right"]);

export interface DescribedAction {
  kind: string;
  label: string;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

function at(body: Record<string, unknown> | null): string {
  const x = num(body?.x);
  const y = num(body?.y);
  return x === null || y === null ? "" : ` at ${x}, ${y}`;
}

function clip(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function host(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : `${url.protocol.replace(/:$/, "")} link`;
  } catch {
    return null;
  }
}

/**
 * A device call as the person should read it, or null for calls that are
 * not actions. `ok` false marks an action Revyl reported as failed.
 */
export function describeDeviceAction(action: string, body: Record<string, unknown> | null, ok = true): DescribedAction | null {
  const kind = action.toLowerCase();
  if (NOT_ACTIONS.has(kind)) return null;
  const label = (() => {
    switch (kind) {
      case "tap":
        return `Tapped${at(body)}`;
      case "double_tap":
        return `Double-tapped${at(body)}`;
      case "long_press":
        return `Long-pressed${at(body)}`;
      case "swipe": {
        const direction = text(body?.direction)?.toLowerCase() ?? null;
        return `Swiped${direction !== null && DIRECTIONS.has(direction) ? ` ${direction}` : ""}${at(body).replace(" at", " from")}`;
      }
      case "drag":
        return "Dragged";
      case "pinch":
        return `Pinched${at(body)}`;
      case "input":
      case "type":
        return "Typed text";
      case "clear_text":
        return "Cleared a field";
      case "go_home":
      case "home":
        return "Went to the home screen";
      case "back":
        return "Pressed Back";
      case "key": {
        const key = text(body?.key);
        return key === null ? "Pressed a key" : `Pressed ${clip(key, 24)}`;
      }
      case "shake":
        return "Shook the device";
      case "screenshot":
        return "Took a screenshot";
      case "install":
        return "Installed a build";
      case "launch":
      case "launch_app":
        return "Launched the app";
      case "kill_app":
        return "Closed the app";
      case "open_app": {
        const name = text(body?.app_name) ?? text(body?.app) ?? text(body?.name);
        return name === null ? "Opened an app" : `Opened ${clip(name, 40)}`;
      }
      case "open_url":
      case "navigate": {
        const where = host(text(body?.url) ?? text(body?.link));
        return where === null ? "Opened a link" : `Opened a link to ${where}`;
      }
      case "set_location":
        return "Set the location";
      case "download_file":
        return "Downloaded a file to the device";
      case "wait":
        return "Waited";
      case "instruction":
        return "Ran an instruction step";
      case "validation":
        return "Ran a validation step";
      case "extract":
        return "Read something off the screen";
      default:
        return kind.replace(/[_-]+/g, " ").replace(/^./, (first) => first.toUpperCase());
    }
  })();
  return { kind, label: ok ? label : `${label} (failed)` };
}
