/**
 * Calibre access layer.
 *
 * Every operation runs the official `calibredb` command (and `ebook-convert` /
 * `fetch-ebook-metadata`) through execFile. This is the supported, safe way to
 * read and write the library: it never touches metadata.db directly, which
 * avoids corruption and conflicts with a running Calibre app.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

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

/** Runs a binary and returns its stdout. Throws an Error with a clear message on failure. */
export async function run(file: string, args: string[], opts: RunOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      timeout: opts.timeout ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
    return stdout;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(
        `Executable '${file}' not found. Check CALIBREDB_PATH / EBOOK_CONVERT_PATH / ` +
          `FETCH_EBOOK_METADATA_PATH. On Windows they are usually in ` +
          `'C:\\Program Files\\Calibre2\\'.`,
      );
    }
    if (err?.killed) {
      throw new Error(
        "The Calibre operation timed out. If the Calibre app is open it may be locking " +
          "the library: close it or use the Content Server.",
      );
    }
    const msg = String(err?.stderr || err?.stdout || err?.message || err).trim();
    if (/is running|another calibre/i.test(msg)) {
      throw new Error(
        msg +
          "\n\nHINT: close the Calibre app before writing, or start the Content Server " +
          "and put its URL in CALIBRE_LIBRARY_PATH.",
      );
    }
    throw new Error(`calibredb error: ${msg}`);
  }
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
