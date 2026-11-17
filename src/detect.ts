/**
 * Recognize Revyl work in a thread's events.
 *
 * Pure functions over strings, so every rule here is unit-tested without bb or
 * the CLI. Two inputs matter:
 *
 *  - the command text of an agent's shell call, which bb records the moment
 *    the call starts (`item/started`), so a card can appear before the run
 *    prints anything;
 *  - the output or result text when the call ends (`item/completed`), which
 *    carries task and session ids for runs started with `--no-wait`, by the
 *    MCP server, or by anything else that prints a Revyl report link.
 */

export type DetectedKind = "test" | "workflow";

export interface DetectedRun {
  kind: DetectedKind;
  name: string;
  /** `-C <dir>` / `--chdir <dir>` given on the command, if any. */
  chdir: string | null;
}

export interface CommandDetection {
  runs: DetectedRun[];
}

/** Flags of `revyl test run` / `workflow run` / globals that take a value. */
const FLAGS_WITH_VALUE = new Set([
  "-C",
  "--chdir",
  "--intent",
  "-b",
  "--build-id",
  "--build-selection",
  "--branch",
  "-t",
  "--timeout",
  "--platform",
  "--profile",
  "--location",
  "--concurrency",
  "--ios-app",
  "--android-app",
  "--ios-build-id",
  "--android-build-id",
  "--launch-var",
  "--launch-env",
  "--launch-arg",
  "--launch-arg-set",
  "--device-model",
  "--os-version",
  "--device-name",
  "--retries",
  "--var",
  "--orientation",
  "--ios-build",
  "--android-build",
]);

/** Split shell text into simple command segments. Quotes are respected. */
export function splitSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | '"' | null = null;
  const pushToken = () => {
    if (hasToken) tokens.push(current);
    current = "";
    hasToken = false;
  };
  const pushSegment = () => {
    pushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[++i];
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      const next = command[++i]!;
      if (next !== "\n") {
        current += next;
        hasToken = true;
      }
      continue;
    }
    if (char === ";" || char === "\n" || char === "|" || char === "&" || char === "(" || char === ")" || char === "`") {
      pushSegment();
      continue;
    }
    if (char === " " || char === "\t") {
      pushToken();
      continue;
    }
    current += char;
    hasToken = true;
  }
  pushSegment();
  return segments;
}

function isRevylToken(token: string): boolean {
  return token === "revyl" || token.endsWith("/revyl");
}

/** Words that run the next word as the command. */
const COMMAND_PREFIXES = new Set(["sudo", "exec", "time", "nohup", "env", "command", "npx", "bunx", "pnpx", "then", "do", "else", "!"]);

/**
 * The index of the segment's command word, when it is `revyl`. `echo revyl
 * test run x` mentions revyl as an argument and is not a run.
 */
function revylCommandIndex(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || COMMAND_PREFIXES.has(token)) {
      index++;
      continue;
    }
    return isRevylToken(token) ? index : -1;
  }
  return -1;
}

const SHELLS = /(^|\/)(sh|bash|zsh|dash)$/;

/**
 * The script of `zsh -lc "<script>"`, as some providers record every command
 * (Codex does), else null.
 */
function wrappedScript(tokens: string[]): string | null {
  if (tokens.length < 3 || !SHELLS.test(tokens[0]!)) return null;
  const flag = tokens.findIndex((token, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(token));
  return flag === -1 ? null : (tokens[flag + 1] ?? null);
}

/** Read the revyl invocation in one segment, if there is one. */
function parseSegment(tokens: string[]): DetectedRun | null {
  const start = revylCommandIndex(tokens);
  if (start === -1) return null;
  const rest = tokens.slice(start + 1);
  let chdir: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("-")) {
      const [flag, inline] = token.split("=", 2) as [string, string | undefined];
      if (FLAGS_WITH_VALUE.has(flag)) {
        const value = inline ?? rest[++i] ?? null;
        if ((flag === "-C" || flag === "--chdir") && value !== null) chdir = value;
      }
      continue;
    }
    positional.push(token);
  }
  const [group, verb, name] = positional;
  if ((group === "test" || group === "workflow") && verb === "run" && name !== undefined && isPlausibleName(name)) {
    return { kind: group, name, chdir };
  }
  return null;
}

/** Names come from shell text; refuse anything that is clearly not a name. */
export function isPlausibleName(name: string): boolean {
  // A leading dash would reach the CLI as a flag.
  return name.length > 0 && name.length <= 200 && !name.startsWith("-") && !/[\s$`<>{}]/.test(name);
}

export function detectCommand(command: string, depth = 0): CommandDetection {
  const detection: CommandDetection = { runs: [] };
  if (!/\brevyl\b/.test(command)) return detection;
  for (const segment of splitSegments(command)) {
    const script = depth === 0 ? wrappedScript(segment) : null;
    if (script !== null) {
      detection.runs.push(...detectCommand(script, depth + 1).runs);
      continue;
    }
    const run = parseSegment(segment);
    if (run !== null) detection.runs.push(run);
  }
  return detection;
}

export interface DetectedTaskId {
  kind: DetectedKind;
  taskId: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REPORT_LINK = new RegExp(`app\\.revyl\\.ai/(tests|workflows)/report\\?taskId=(${UUID})`, "gi");
const SESSION_LINK = new RegExp(`app\\.revyl\\.ai/sessions/(${UUID})`, "gi");
const SESSION_JSON = new RegExp(`"session_id"\\s*:\\s*"(${UUID})"`, "gi");

/** Task ids in output or tool results, from Revyl report links. */
export function detectTaskIds(text: string): DetectedTaskId[] {
  const found = new Map<string, DetectedTaskId>();
  for (const match of text.matchAll(REPORT_LINK)) {
    const kind: DetectedKind = match[1]!.toLowerCase() === "workflows" ? "workflow" : "test";
    const taskId = match[2]!.toLowerCase();
    if (!found.has(taskId)) found.set(taskId, { kind, taskId });
  }
  return [...found.values()];
}

/**
 * Session ids from `revyl device start` output: its viewer link, or a
 * `session_id` next to a `viewer_url` in JSON. A bare `session_id` elsewhere
 * (a test report has one) is not a session the agent started.
 */
export function detectSessionIds(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(SESSION_LINK)) found.add(match[1]!.toLowerCase());
  if (/"viewer_url"/.test(text)) {
    for (const match of text.matchAll(SESSION_JSON)) found.add(match[1]!.toLowerCase());
  }
  return [...found];
}

/**
 * A Revyl MCP tool call, read from a provider item that is not a shell
 * command. The item shapes differ per provider, so this looks only for a
 * tool name and its arguments anywhere in the item.
 */
export function detectMcpRun(item: unknown): DetectedRun | null {
  if (item === null || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const tool = String(record.tool ?? record.name ?? record.toolName ?? "");
  const server = String(record.server ?? record.serverName ?? "");
  const looksRevyl = /revyl/i.test(server) || /^mcp__revyl/i.test(tool);
  if (!looksRevyl) return null;
  const toolName = tool.replace(/^mcp__[^_]+__/, "");
  const args = (record.arguments ?? record.input ?? record.args ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && isPlausibleName(value)) return value;
    }
    return null;
  };
  if (toolName === "run_test") {
    const name = pick("test_name", "name", "test", "test_id");
    return name === null ? null : { kind: "test", name, chdir: pick("project_dir") };
  }
  if (toolName === "run_workflow") {
    const name = pick("workflow_name", "name", "workflow", "workflow_id");
    return name === null ? null : { kind: "workflow", name, chdir: pick("project_dir") };
  }
  return null;
}
