/**
 * The only module that runs the Revyl CLI.
 *
 * The CLI is the plugin's whole engine: the docs publish no REST reference for
 * tests, runs or reports, while `revyl ... --json` is documented and stable
 * enough to parse. It runs with the key from the plugin's secret settings in
 * its environment and a private auth folder, never the machine's own sign-in.
 *
 * Every call has a timeout and a concurrency cap so a slow Revyl backend can
 * never pile up processes on the bb server.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type CliFailureKind =
  | "missing" // the binary was not found
  | "signed-out" // the CLI says it has no usable credentials
  | "timeout"
  | "failed"; // any other non-zero exit or unparseable output

export class RevylCliError extends Error {
  constructor(
    readonly kind: CliFailureKind,
    message: string,
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "RevylCliError";
  }
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra environment for this call, such as text passed with `--text-env` so it never shows in `ps`. */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Where `revyl` lands with each documented installer, checked after PATH. */
export function candidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromPath = (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, "revyl"));
  const home = homedir();
  return [
    ...fromPath,
    join(home, ".revyl", "bin", "revyl"),
    "/opt/homebrew/bin/revyl",
    "/usr/local/bin/revyl",
    join(home, ".local", "bin", "revyl"),
  ];
}

export function locateRevyl(configured: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (configured !== null && configured.trim() !== "") {
    return existsSync(configured) ? configured : null;
  }
  for (const candidate of candidatePaths(env)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Pull the JSON value out of CLI stdout.
 *
 * Some `--json` commands print human lines before or after the object, and a
 * blocking `test run --json` prints progress lines first. The last balanced
 * top-level object or array in the stream is the result.
 */
export function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") throw new SyntaxError("empty output");
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to scanning.
  }
  const lines = trimmed.split("\n");
  for (let start = lines.length - 1; start >= 0; start--) {
    const head = lines[start]!.trimStart();
    if (!head.startsWith("{") && !head.startsWith("[")) continue;
    const candidate = lines.slice(start).join("\n");
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning upward: this line opened a nested value.
    }
  }
  throw new SyntaxError("no JSON value in output");
}

const SIGNED_OUT = /not authenticated|not logged in|revyl auth login|REVYL_API_KEY not found|unauthorized/i;

/**
 * The environment the plugin's own CLI calls run with: the key from the
 * plugin's secret settings and a private auth folder, so the machine's own
 * `revyl auth` sign-in is never used. Null when no key is set.
 */
export type CliEnvironment = () => Promise<Record<string, string> | null>;

export class RevylCli {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly resolveBinary: () => string | null,
    private readonly environment: CliEnvironment = async () => ({}),
    private readonly maxConcurrent = 3,
  ) {}

  binary(): string | null {
    return this.resolveBinary();
  }

  /** Run `revyl <args>` and return raw output. Never throws for a non-zero exit. */
  async exec(args: readonly string[], options: RunOptions = {}): Promise<CliResult> {
    const binary = this.resolveBinary();
    if (binary === null) {
      throw new RevylCliError("missing", "The Revyl CLI is not installed or not on PATH.");
    }
    const extra = await this.environment();
    if (extra === null) {
      throw new RevylCliError("signed-out", "The Revyl plugin has no API key. Add one on bb's Revyl page.");
    }
    await this.acquire();
    try {
      return await new Promise<CliResult>((resolve, reject) => {
        const child = execFile(
          binary,
          [...args],
          {
            cwd: options.cwd && existsSync(options.cwd) ? options.cwd : homedir(),
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            signal: options.signal,
            env: {
              ...process.env,
              REVYL_NO_UPDATE_NOTIFIER: "1",
              NO_COLOR: "1",
              // Tells Revyl's analytics which agent surface ran the command.
              REVYL_AGENT: "bb-plugin-revyl",
              ...extra,
              ...options.env,
            },
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ exitCode: 0, stdout, stderr });
              return;
            }
            const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
            if (err.code === "ENOENT") {
              reject(new RevylCliError("missing", "The Revyl CLI is not installed or not on PATH."));
              return;
            }
            if (err.killed === true || err.name === "AbortError") {
              reject(new RevylCliError("timeout", `revyl ${args.slice(0, 2).join(" ")} timed out.`));
              return;
            }
            resolve({
              exitCode: typeof err.code === "number" ? err.code : 1,
              stdout,
              stderr,
            });
          },
        );
        child.stdin?.end();
      });
    } finally {
      this.release();
    }
  }

  /**
   * Run with `--json` and parse the result. Exit code 1 with a JSON body is
   * still a result: a failed test run answers that way.
   */
  async json<T = unknown>(args: readonly string[], options: RunOptions = {}): Promise<T> {
    const result = await this.exec([...args, "--json"], options);
    try {
      return parseJsonOutput(result.stdout) as T;
    } catch {
      const text = `${result.stderr}\n${result.stdout}`.trim();
      if (SIGNED_OUT.test(text)) {
        throw new RevylCliError("signed-out", "The Revyl CLI is not signed in.", result.exitCode);
      }
      throw new RevylCliError("failed", firstLine(text) || `revyl ${args.slice(0, 2).join(" ")} failed.`, result.exitCode);
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next !== undefined) next();
  }
}

export function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return (line ?? "").trim().slice(0, 300);
}
