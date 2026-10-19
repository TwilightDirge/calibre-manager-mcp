/**
 * Calibre access layer.
 *
 * Every operation runs the official `calibredb` command (and `ebook-convert` /
 * `calibre-debug`) as a child process. This is the supported, safe way to
 * read and write the library: it never touches metadata.db directly, which
 * avoids corruption and conflicts with a running Calibre app.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

/** Loads a simple .env (KEY=VALUE) from the working directory without overriding
 *  variables already present in the environment. A convenience for local use. */
function loadEnvFile(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile();

/** Configuration resolved from environment variables. */
export const CONFIG = {
  /** Path to the library, or Content Server URL. Empty = Calibre's default library. */
  library: (process.env.CALIBRE_LIBRARY_PATH ?? "").trim(),
  calibredb: (process.env.CALIBREDB_PATH ?? "calibredb").trim() || "calibredb",
  ebookConvert: (process.env.EBOOK_CONVERT_PATH ?? "ebook-convert").trim() || "ebook-convert",
  fetchMeta: (process.env.FETCH_EBOOK_METADATA_PATH ?? "fetch-ebook-metadata").trim() || "fetch-ebook-metadata",
  username: (process.env.CALIBRE_USERNAME ?? "").trim(),
  password: (process.env.CALIBRE_PASSWORD ?? "").trim(),
};

/** Common calibredb arguments (library + Content Server credentials). */
export function baseArgs(): string[] {
  const args: string[] = [];
  if (CONFIG.library) {
    args.push("--with-library", CONFIG.library);
    if (CONFIG.username) args.push("--username", CONFIG.username);
    if (CONFIG.password) args.push("--password", CONFIG.password);
  }
  return args;
}

export interface RunOptions {
  /** Timeout in milliseconds. */
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** After a kill, how long to wait for the process to exit before giving up on it. */
const KILL_GRACE_MS = 10_000;
/** Longest piece of a single argument written to the log. */
const LOG_ARG_CHARS = 120;

function logLine(text: string): void {
  console.error(`${new Date().toISOString()} [calibre-manager] ${text}`);
}

/** A readable, log-safe version of a command line: the password is masked and
 *  long arguments (descriptions, OPF paths) are shortened. */
function describeCommand(file: string, args: string[]): string {
  const parts = args.map((arg, i) => {
    if (i > 0 && args[i - 1] === "--password") return "***";
    const short = arg.length > LOG_ARG_CHARS ? `${arg.slice(0, LOG_ARG_CHARS)}...` : arg;
    return /[\s"]/.test(short) ? JSON.stringify(short) : short;
  });
  return [basename(file), ...parts].join(" ");
}

/** Ends the process and anything it started. On Windows, killing calibredb.exe
 *  alone can leave helper processes behind that keep the library locked. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => child.kill());
  } else {
    child.kill("SIGKILL");
  }
}

type RunOutcome = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
  abandoned: boolean;
  spawnError?: NodeJS.ErrnoException;
};

function execute(file: string, args: string[], timeoutMs: number): Promise<RunOutcome> {
  return new Promise((settle) => {
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let overflow = false;
    let done = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (outcome: Omit<RunOutcome, "stdout" | "stderr" | "timedOut" | "overflow">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      settle({
        ...outcome,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut,
        overflow,
      });
    };

    let child: ChildProcess;
    try {
      // stdin is "ignore": a child can never wait for input, and can never read
      // from this server's own stdin, which carries the MCP messages.
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch (err: any) {
      done = true;
      settle({ code: null, stdout: "", stderr: "", timedOut, overflow, abandoned: false, spawnError: err });
      return;
    }

    // Kill the process, then stop waiting for it if it still hasn't exited, so
    // a stuck child can never leave a tool call hanging.
    const stop = () => {
      killTree(child);
      graceTimer = setTimeout(() => finish({ code: null, abandoned: true }), KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        overflow = true;
        stop();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on("data", collect(outChunks));
    child.stderr?.on("data", collect(errChunks));
    child.on("error", (err) => finish({ code: null, abandoned: false, spawnError: err }));
    child.on("close", (code) => finish({ code, abandoned: false }));
    // After a kill, return as soon as the process itself has exited, even if
    // a leftover helper process still holds its output pipes open.
    child.on("exit", (code) => {
      if (timedOut || overflow) finish({ code, abandoned: false });
    });
  });
}

/** Runs a binary and returns its stdout. Throws an Error with a clear message on failure. */
export async function run(file: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const command = describeCommand(file, args);
  const started = Date.now();
  logLine(`exec start: ${command}`);
  const r = await execute(file, args, timeoutMs);
  const elapsed = Date.now() - started;
  const status = r.spawnError ? `spawn error ${r.spawnError.code ?? ""}`.trim()
    : r.timedOut ? "timed out"
    : r.overflow ? "output too large"
    : `exit ${r.code}`;
  logLine(`exec end: ${basename(file)} ${status}${r.abandoned ? " (process did not exit after kill)" : ""} in ${elapsed} ms`);

  if (r.spawnError) {
    if (r.spawnError.code === "ENOENT") {
      throw new Error(
        `Executable '${file}' not found. Check CALIBREDB_PATH / EBOOK_CONVERT_PATH / ` +
          `FETCH_EBOOK_METADATA_PATH. On Windows they are usually in ` +
          `'C:\\Program Files\\Calibre2\\'.`,
      );
    }
    throw new Error(`Could not start '${basename(file)}': ${r.spawnError.message}`);
  }
  if (r.timedOut) {
    throw new Error(
      `The Calibre operation timed out after ${Math.round(timeoutMs / 1000)} s and was stopped. ` +
        "If the Calibre app is open it may be locking the library: close it or use the Content Server.",
    );
  }
  if (r.overflow) {
    throw new Error(`'${basename(file)}' produced more than ${MAX_OUTPUT_BYTES / (1024 * 1024)} MB of output and was stopped.`);
  }
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || `exit code ${r.code}`).trim();
    if (/is running|another calibre/i.test(msg)) {
      throw new Error(
        msg +
          "\n\nHINT: close the Calibre app before writing, or start the Content Server " +
          "and put its URL in CALIBRE_LIBRARY_PATH.",
      );
    }
    throw new Error(`calibredb error: ${msg}`);
  }
  return r.stdout;
}

/** Runs calibredb with the base arguments plus the given ones. */
export async function calibredb(args: string[], opts: RunOptions = {}): Promise<string> {
  return run(CONFIG.calibredb, [...baseArgs(), ...args], opts);
}

/** Returns the list of books (array of objects) that match `query`. */
export async function booksFrom(query: string, fields: string, limit = 0): Promise<any[]> {
  const args = ["list", "--for-machine", "--fields", fields];
  if (limit) args.push("--limit", String(limit));
  if (query) args.push("--search", query);
  const out = await calibredb(args);
  if (!out.trim()) return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Normalizes a tags/formats value to an array of strings (Calibre may return a list or a string). */
export function toArray(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Removes duplicates while preserving order. */
export function dedupe(seq: string[]): string[] {
  const seen: string[] = [];
  for (const item of seq) if (!seen.includes(item)) seen.push(item);
  return seen;
}