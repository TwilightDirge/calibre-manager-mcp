#!/usr/bin/env node
/**
 * Calibre Manager MCP
 * ===================
 *
 * MCP server to MANAGE and ORGANIZE a Calibre e-book library: safe reading and
 * writing of metadata through the official `calibredb` command.
 *
 * Tools (17): diagnostics, search/browse, tag and metadata editing (single and
 * bulk), add/remove/convert/export books, duplicate and missing-metadata
 * detection, and fetching metadata from online sources.
 *
 * Every tool carries a detailed description: in MCP that description is what the
 * model reads to decide how to use it, so it is functional, not decorative.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { writeFileSync, existsSync, mkdtempSync, readFileSync, statSync} from "node:fs";

import {
  CONFIG,
  calibredb,
  run,
  booksFrom,
  toArray,
  dedupe,
} from "./calibre.js";

const server = new McpServer({ name: "calibre-manager", version: "0.1.0" });

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolResult = { content: (TextContent | ImageContent)[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

/**
 * Wraps a handler: returns text (or a ready-made result, e.g. text plus an
 * image) or a readable error (isError) without crashing the server.
 */
async function guard(fn: () => Promise<string | ToolResult>): Promise<ToolResult> {
  try {
    const out = await fn();
    return typeof out === "string" ? ok(out) : out;
  } catch (err: any) {
    return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
  }
}

const J = (obj: unknown): string => JSON.stringify(obj, null, 2);

const DEFAULT_FIELDS = "id,title,authors,series,series_index,tags,formats";

// --------------------------------------------------------------------------- //
// Diagnostics
// --------------------------------------------------------------------------- //
server.tool(
  "health_check",
  "Checks that calibredb is reachable and the library responds. Use it first to diagnose the configuration (calibredb path, library, etc.).",
  async () =>
    guard(async () => {
      const version = (await run(CONFIG.calibredb, ["--version"])).trim();
      const books = await booksFrom("", "id", 1);
      return J({
        calibredb: version,
        library_path: CONFIG.library || "(Calibre default)",
        library_responds: true,
        sample_book_id: books[0]?.id ?? null,
      });
    }),
);

// --------------------------------------------------------------------------- //
// Search and browse
// --------------------------------------------------------------------------- //
server.tool(
  "search_books",
  "Searches books using Calibre's search syntax and returns JSON. Example queries: 'tag:Philosophy and author:Plato', 'series:\"Classics\"', 'title:Republic', 'pubdate:>2010'. Leave query empty to list (use limit).",
  {
    query: z.string().optional().describe("Query in Calibre syntax. Empty = list everything."),
    limit: z.number().int().positive().optional().describe("Maximum number of results (default 50)."),
    fields: z
      .string()
      .optional()
      .describe(`Comma-separated fields. 'all' for everything. Default: ${DEFAULT_FIELDS}.`),
  },
  async ({ query, limit, fields }) =>
    guard(async () => J(await booksFrom(query ?? "", fields ?? DEFAULT_FIELDS, limit ?? 50))),
);

server.tool(
  "get_book_metadata",
  "Returns ALL metadata for a book by its id (JSON).",
  { book_id: z.number().int().describe("The book's id in Calibre.") },
  async ({ book_id }) =>
    guard(async () => {
      const books = await booksFrom(`id:${book_id}`, "all");
      if (!books.length) throw new Error(`No book found with id ${book_id}.`);
      return J(books[0]);
    }),
);

// Returns the cover image currently stored in the library for each book, so
// covers can be checked visually (e.g. to spot covers generated from a
// file's first page). Read-only: nothing in the library is changed.
const MAX_COVERS_PER_CALL = 8;
const MAX_LIBRARY_COVER_BYTES = 3_000_000;

server.tool(
  "get_covers",
  `Returns the current library cover image for up to ${MAX_COVERS_PER_CALL} books, each labelled with its id and title. Read-only. Pass ids comma-separated, e.g. '6,8,9'.`,
  {
    book_ids: z.string().describe(`Comma-separated book ids (max ${MAX_COVERS_PER_CALL}).`),
  },
  async ({ book_ids }) =>
    guard(async () => {
      const ids = book_ids
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (!ids.length) throw new Error("Provide at least one book id.");
      if (ids.length > MAX_COVERS_PER_CALL)
        throw new Error(`At most ${MAX_COVERS_PER_CALL} ids per call.`);
      if (ids.some((s: string) => !/^\d+$/.test(s)))
        throw new Error("Book ids must be whole numbers.");

      const content: ToolResult["content"] = [];
      for (const id of ids) {
        const books = await booksFrom(`id:${id}`, "id,title,cover");
        const book = books[0];
        if (!book) {
          content.push({ type: "text", text: `#${id}: no book with this id` });
          continue;
        }
        const label = `#${id}: ${book.title ?? "(no title)"}`;
        const coverPath = typeof book.cover === "string" ? book.cover : "";
        if (!coverPath || !existsSync(coverPath)) {
          content.push({ type: "text", text: `${label}: no cover` });
          continue;
        }
        const buf = readFileSync(coverPath);
        const mimeType = imageMimeType(buf);
        if (!mimeType || buf.length > MAX_LIBRARY_COVER_BYTES) {
          content.push({ type: "text", text: `${label}: cover not attached (unrecognised format or too large)` });
          continue;
        }
        content.push({ type: "text", text: label });
        content.push({ type: "image", data: buf.toString("base64"), mimeType });
      }
      return { content };
    }),
);

// Reads an image's width and height from its header (JPEG, PNG, GIF, WebP)
// without decoding it. Returns null if the format isn't recognised.
function imageSize(buf: Buffer): { width: number; height: number } | null {
  try {
    const type = imageMimeType(buf);
    if (type === "image/png" && buf.length >= 24)
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === "image/gif" && buf.length >= 10)
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === "image/webp" && buf.length >= 30) {
      const chunk = buf.toString("ascii", 12, 16);
      if (chunk === "VP8 ")
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X")
        return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
      return null;
    }
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const segLength = buf.readUInt16BE(i + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + segLength;
      }
    }
  } catch {
    // Truncated or malformed header: treat as unknown.
  }
  return null;
}

// Scans library covers in one pass. Groups books whose cover files are
// byte-for-byte identical (e.g. a "Microsoft Word" splash used on many books)
// and lists covers with page-like proportions (e.g. a PDF page used as a
// cover). Read-only: nothing in the library is changed.
server.tool(
  "scan_covers",
  "Scans library covers (read-only). Returns groups of books sharing an identical cover image, with one sample image per group, and a list of covers whose width/height ratio looks like a printed page rather than a book cover. Optionally limit the scan with a Calibre query.",
  {
    query: z.string().optional().describe("Calibre query to limit the scan, e.g. 'formats:pdf'. Default: whole library."),
    min_group: z.number().int().min(2).optional().describe("Smallest number of books sharing a cover to report as a group (default 2)."),
    max_samples: z.number().int().min(0).max(20).optional().describe("How many groups get a sample image, largest groups first (default 12)."),
    page_ratio: z.number().optional().describe("Width/height ratio at or above which a cover counts as page-shaped (default 0.72; book covers are usually 0.60-0.70, a US Letter page is 0.77)."),
  },
  async ({ query, min_group, max_samples, page_ratio }) =>
    guard(async () => {
      const minGroup = min_group ?? 2;
      const maxSamples = max_samples ?? 12;
      const ratioLimit = page_ratio ?? 0.72;

      const books = await booksFrom(query ?? "", "id,title,cover");
      const byHash = new Map<string, { ids: number[]; titles: string[]; path: string }>();
      const pageShaped: { id: number; title: string; width: number; height: number; ratio: number }[] = [];
      let scanned = 0;
      let unreadable = 0;

      for (const book of books) {
        const coverPath = typeof book.cover === "string" ? book.cover : "";
        if (!coverPath || !existsSync(coverPath)) continue;
        let buf: Buffer;
        try {
          buf = readFileSync(coverPath);
        } catch {
          unreadable++;
          continue;
        }
        scanned++;

        const hash = createHash("sha256").update(buf).digest("hex");
        const entry: { ids: number[]; titles: string[]; path: string } =
          byHash.get(hash) ?? { ids: [], titles: [], path: coverPath };
        entry.ids.push(Number(book.id));
        entry.titles.push(String(book.title ?? ""));
        byHash.set(hash, entry);

        const size = imageSize(buf);
        if (size && size.height > 0) {
          const ratio = size.width / size.height;
          if (ratio >= ratioLimit)
            pageShaped.push({ id: Number(book.id), title: String(book.title ?? ""), width: size.width, height: size.height, ratio: Math.round(ratio * 1000) / 1000 });
        }
      }

      const groups = [...byHash.values()]
        .filter((g) => g.ids.length >= minGroup)
        .sort((a, b) => b.ids.length - a.ids.length);

      const content: ToolResult["content"] = [];
      content.push({
        type: "text",
        text: J({
          books_checked: books.length,
          covers_scanned: scanned,
          unreadable_covers: unreadable,
          identical_cover_groups: groups.map((g, n) => ({
            group: n + 1,
            count: g.ids.length,
            ids: g.ids,
            sample_titles: g.titles.slice(0, 3),
          })),
          page_shaped_covers: pageShaped.sort((a, b) => b.ratio - a.ratio),
        }),
      });

      groups.slice(0, maxSamples).forEach((g, n) => {
        const buf = readFileSync(g.path);
        const mimeType = imageMimeType(buf);
        if (!mimeType || buf.length > MAX_LIBRARY_COVER_BYTES) {
          content.push({ type: "text", text: `Group ${n + 1} (${g.ids.length} books): sample not attached` });
          return;
        }
        content.push({ type: "text", text: `Group ${n + 1} (${g.ids.length} books), sample from #${g.ids[0]}:` });
        content.push({ type: "image", data: buf.toString("base64"), mimeType });
      });

      return { content };
    }),
);
// ---------------------------------------------------------------------------
// contact_sheet: tiles many library covers into ONE labelled JPEG so they can
// be checked by eye in a single call. Read-only: nothing in the library changes.
// Needs:  npm install sharp      and the import line:  import sharp from "sharp";
// ---------------------------------------------------------------------------

const MAX_SHEET_COVERS = 48;
const MAX_SHEET_BYTES = 900_000; // stays under the 1 MB tool-result limit

// 5x7 bitmap digits for the tile labels, so labels never depend on fonts.
const SHEET_GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "#": ["01010", "01010", "11111", "01010", "11111", "01010", "01010"],
};

type Rgb = { r: number; g: number; b: number };
const SHEET_BG: Rgb = { r: 40, g: 40, b: 40 };      // gaps between tiles
const SHEET_BOX: Rgb = { r: 128, g: 128, b: 128 };  // letterbox around each cover
const SHEET_MISSING: Rgb = { r: 150, g: 40, b: 40 }; // no cover / unreadable
const SHEET_TEXT: Rgb = { r: 255, g: 255, b: 255 };

// Draws "#1234" into a raw RGB strip of the given size, centred.
function sheetLabel(text: string, width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = SHEET_BG.r; buf[i * 3 + 1] = SHEET_BG.g; buf[i * 3 + 2] = SHEET_BG.b;
  }
  const chars = [...text].filter((c) => SHEET_GLYPHS[c]);
  if (!chars.length) return buf;
  const scale = Math.max(1, Math.min(Math.floor((height - 4) / 7), Math.floor((width - 4) / (chars.length * 6))));
  const textW = chars.length * 6 * scale - scale;
  const x0 = Math.max(0, Math.floor((width - textW) / 2));
  const y0 = Math.max(0, Math.floor((height - 7 * scale) / 2));
  chars.forEach((c, n) => {
    SHEET_GLYPHS[c].forEach((row, gy) => {
      for (let gx = 0; gx < 5; gx++) {
        if (row[gx] !== "1") continue;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const x = x0 + (n * 6 + gx) * scale + dx;
            const y = y0 + gy * scale + dy;
            if (x >= width || y >= height) continue;
            const p = (y * width + x) * 3;
            buf[p] = SHEET_TEXT.r; buf[p + 1] = SHEET_TEXT.g; buf[p + 2] = SHEET_TEXT.b;
          }
      }
    });
  });
  return buf;
}

type SheetItem = { id: number; title: string; cover: string };
type SheetEntry = { pos: string; id: number; title: string; size?: string; ratio?: number; note?: string };

// Builds the sheet image and the matching tile list.
async function buildContactSheet(
  items: SheetItem[],
  columns: number,
  thumbW: number,
): Promise<{ jpeg: Buffer; entries: SheetEntry[]; quality: number }> {
  const thumbH = Math.round(thumbW * 1.5);
  const labelH = Math.max(18, Math.round(thumbW / 6));
  const gap = 6;
  const cols = Math.min(columns, Math.max(1, items.length));
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const sheetW = gap + cols * (thumbW + gap);
  const sheetH = gap + rows * (thumbH + labelH + gap);

  const entries: SheetEntry[] = [];
  // Element type of sharp().composite()'s argument, without naming sharp's namespace.
  const layers: Exclude<Parameters<ReturnType<typeof sharp>["composite"]>[0], undefined> = [];

  const tiles = await Promise.all(
    items.map(async (item) => {
      if (!item.cover || !existsSync(item.cover)) return { item, note: "no cover" as string, png: null as Buffer | null };
      try {
        const meta = await sharp(item.cover, { failOn: "none" }).metadata();
        const png = await sharp(item.cover, { failOn: "none" })
          .resize(thumbW, thumbH, { fit: "contain", background: SHEET_BOX })
          .flatten({ background: SHEET_BOX })
          .png()
          .toBuffer();
        return { item, png, width: meta.width, height: meta.height, note: "" };
      } catch {
        return { item, note: "unreadable cover", png: null as Buffer | null };
      }
    }),
  );

  tiles.forEach((t, n) => {
    const r = Math.floor(n / cols);
    const c = n % cols;
    const left = gap + c * (thumbW + gap);
    const top = gap + r * (thumbH + labelH + gap);
    if (t.png) {
      layers.push({ input: t.png, left, top });
    } else {
      layers.push({
        input: { create: { width: thumbW, height: thumbH, channels: 3, background: SHEET_MISSING } },
        left,
        top,
      });
    }
    layers.push({
      input: sheetLabel(`#${t.item.id}`, thumbW, labelH),
      raw: { width: thumbW, height: labelH, channels: 3 },
      left,
      top: top + thumbH,
    });
    const w = "width" in t ? t.width : undefined;
    const h = "height" in t ? t.height : undefined;
    entries.push({
      pos: `r${r + 1}c${c + 1}`,
      id: t.item.id,
      title: t.item.title,
      ...(w && h ? { size: `${w}x${h}`, ratio: Math.round((w / h) * 1000) / 1000 } : {}),
      ...(t.note ? { note: t.note } : {}),
    });
  });

  const base = await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: SHEET_BG } })
    .composite(layers)
    .png()
    .toBuffer();

  let jpeg: Buffer = Buffer.alloc(0);
  let quality = 82;
  for (const q of [82, 70, 58, 46, 34]) {
    quality = q;
    jpeg = await sharp(base).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (jpeg.length <= MAX_SHEET_BYTES) break;
  }
  return { jpeg, entries, quality };
}

server.tool(
  "contact_sheet",
  `Returns ONE image tiling up to ${MAX_SHEET_COVERS} library covers as labelled thumbnails (read-only), plus a text list of each tile's position, id, title and original size. Covers are letterboxed on grey so their proportions stay visible; a red tile means no cover or an unreadable one. Give book_ids, or a Calibre query (paged with offset). With a query, page_ratio keeps only covers at or above that width/height ratio.`,
  {
    book_ids: z.string().optional().describe(`Comma-separated book ids (max ${MAX_SHEET_COVERS}), shown in the order given.`),
    query: z.string().optional().describe("Calibre query instead of ids, e.g. 'id:>=600 and id:<1000'. Results are sorted by id."),
    offset: z.number().int().min(0).optional().describe("With query: skip this many matching books first (for paging; default 0)."),
    page_ratio: z.number().optional().describe("With query: only include covers whose width/height ratio is at least this, e.g. 0.70."),
    count: z.number().int().min(1).max(MAX_SHEET_COVERS).optional().describe(`How many covers to show (default and max ${MAX_SHEET_COVERS}).`),
    columns: z.number().int().min(2).max(12).optional().describe("Tiles per row (default 8)."),
    thumb_width: z.number().int().min(80).max(300).optional().describe("Width of each thumbnail in pixels (default 140)."),
  },
  async ({ book_ids, query, offset, page_ratio, count, columns, thumb_width }) =>
    guard(async () => {
      if (!book_ids && query === undefined) throw new Error("Provide book_ids or a query.");
      if (book_ids && query !== undefined) throw new Error("Provide book_ids or a query, not both.");
      const limit = count ?? MAX_SHEET_COVERS;
      let items: SheetItem[] = [];
      let paging: Record<string, unknown> = {};

      if (book_ids) {
        const ids = book_ids.split(",").map((s: string) => s.trim()).filter(Boolean);
        if (!ids.length) throw new Error("Provide at least one book id.");
        if (ids.some((s: string) => !/^\d+$/.test(s))) throw new Error("Book ids must be whole numbers.");
        if (ids.length > MAX_SHEET_COVERS) throw new Error(`At most ${MAX_SHEET_COVERS} ids per call.`);
        const books = await booksFrom(ids.map((i: string) => `id:${i}`).join(" or "), "id,title,cover");
        const byId = new Map<number, any>(books.map((b: any) => [Number(b.id), b]));
        items = ids.map((s: string) => {
          const b = byId.get(Number(s));
          return { id: Number(s), title: b ? String(b.title ?? "") : "(no book with this id)", cover: b && typeof b.cover === "string" ? b.cover : "" };
        });
      } else {
        const start = offset ?? 0;
        const books = (await booksFrom(query ?? "", "id,title,cover")).sort((a: any, b: any) => Number(a.id) - Number(b.id));
        let pool: SheetItem[] = books.map((b: any) => ({ id: Number(b.id), title: String(b.title ?? ""), cover: typeof b.cover === "string" ? b.cover : "" }));
        if (page_ratio !== undefined) {
          pool = pool.filter((it) => {
            if (!it.cover || !existsSync(it.cover)) return false;
            try {
              const size = imageSize(readFileSync(it.cover));
              return !!size && size.height > 0 && size.width / size.height >= page_ratio;
            } catch {
              return false;
            }
          });
        }
        items = pool.slice(start, start + limit);
        const next = start + items.length;
        paging = { matching: pool.length, offset: start, shown: items.length, next_offset: next < pool.length ? next : null };
      }

      if (!items.length) return { content: [{ type: "text", text: `${JSON.stringify(paging)}; nothing to show` }] };

      const { jpeg, entries, quality } = await buildContactSheet(items, columns ?? 8, thumb_width ?? 140);
      const lines = entries.map(
        (e) => `${e.pos} #${e.id} ${e.size ? `${e.size} (${e.ratio})` : `[${e.note}]`} ${e.title}`,
      );
      const header = book_ids ? `${entries.length} covers` : `${JSON.stringify(paging)}`;
      const content: ToolResult["content"] = [
        { type: "text", text: `${header}; jpeg quality ${quality}\n${lines.join("\n")}` },
        { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
      ];
      return { content };
    }),
);

server.tool(
  "list_categories",
  "Lists the values of a category with their book counts, as CSV. category accepts: tags, authors, series, publisher, languages, formats, rating, identifiers.",
  { category: z.string().optional().describe("Category to list (default 'tags').") },
  async ({ category }) =>
    guard(async () => await calibredb(["list_categories", "-r", category ?? "tags", "--csv"])),
);

server.tool(
  "library_stats",
  "Library summary: total number of books and a breakdown by category (tags, authors, series, formats).",
  async () =>
    guard(async () => {
      const total = (await booksFrom("", "id")).length;
      const cats = await calibredb([
        "list_categories",
        "-r",
        "tags,authors,series,formats",
        "--csv",
      ]);
      return J({ total_books: total }) + "\n\nCategories (category,value,count):\n" + cats;
    }),
);

// --------------------------------------------------------------------------- //
// Metadata writing
// --------------------------------------------------------------------------- //
server.tool(
  "set_metadata",
  "Sets (REPLACES) a book's metadata. 'fields' is an object of field:value pairs. Fields: title, title_sort, authors (multiple with ' & '), author_sort ('Last, First'), tags (comma-separated), series, series_index, publisher, pubdate ('2020-01-01'), languages ('eng'/'spa'), rating (0–10, where 10 = 5 stars), comments (HTML allowed), identifiers ('isbn:9788491050000'), cover (path to an image). NOTE: it replaces the whole field value; to keep the other tags use add_tags/remove_tags.",
  {
    book_id: z.number().int().describe("The book's id."),
    fields: z.record(z.string(), z.string()).describe("Object with field:value pairs to set."),
  },
  async ({ book_id, fields }) =>
    guard(async () => {
      const entries = Object.entries(fields);
      if (!entries.length) throw new Error("No fields provided to change.");
      const args = ["set_metadata", String(book_id)];
      for (const [key, value] of entries) args.push("--field", `${key}:${value}`);
      await calibredb(args);
      const books = await booksFrom(`id:${book_id}`, "all");
      return J(books[0] ?? { book_id, updated: true });
    }),
);

server.tool(
  "add_tags",
  "Adds tags to a book WITHOUT removing the existing ones. Multiple tags comma-separated.",
  {
    book_id: z.number().int(),
    tags: z.string().describe("Tags to add, comma-separated."),
  },
  async ({ book_id, tags }) =>
    guard(async () => {
      const books = await booksFrom(`id:${book_id}`, "id,tags");
      if (!books.length) throw new Error(`No book found with id ${book_id}.`);
      const incoming = tags.split(",").map((t) => t.trim()).filter(Boolean);
      const merged = dedupe([...toArray(books[0].tags), ...incoming]);
      await calibredb(["set_metadata", String(book_id), "--field", `tags:${merged.join(", ")}`]);
      return J({ book_id, tags: merged });
    }),
);

server.tool(
  "remove_tags",
  "Removes specific tags from a book, keeping the rest.",
  {
    book_id: z.number().int(),
    tags: z.string().describe("Tags to remove, comma-separated."),
  },
  async ({ book_id, tags }) =>
    guard(async () => {
      const books = await booksFrom(`id:${book_id}`, "id,tags");
      if (!books.length) throw new Error(`No book found with id ${book_id}.`);
      const remove = new Set(tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean));
      const kept = toArray(books[0].tags).filter((t) => !remove.has(t.toLowerCase()));
      await calibredb(["set_metadata", String(book_id), "--field", `tags:${kept.join(", ")}`]);
      return J({ book_id, tags: kept });
    }),
);

server.tool(
  "rename_tag",
  "Renames a tag across the WHOLE library (on every book that has it).",
  {
    old: z.string().describe("Current tag."),
    new: z.string().describe("New tag."),
  },
  async ({ old, new: nw }) =>
    guard(async () => {
      const books = await booksFrom(`tags:"=${old}"`, "id,tags");
      let updated = 0;
      for (const book of books) {
        const newTags = dedupe(toArray(book.tags).map((t) => (t === old ? nw : t)));
        await calibredb(["set_metadata", String(book.id), "--field", `tags:${newTags.join(", ")}`]);
        updated++;
      }
      return J({ renamed_from: old, to: nw, books_updated: updated });
    }),
);

server.tool(
  "bulk_set_metadata",
  "Applies the same metadata to ALL books matching a search. Useful for organizing in bulk (e.g. setting a series or publisher on a group). 'query' uses Calibre syntax; 'fields' works like set_metadata (replaces the field). To add tags in bulk without removing, call add_tags per book.",
  {
    query: z.string().describe("Calibre-syntax search that selects the books."),
    fields: z.record(z.string(), z.string()).describe("Fields to set on every match."),
  },
  async ({ query, fields }) =>
    guard(async () => {
      const entries = Object.entries(fields);
      if (!entries.length) throw new Error("No fields provided to change.");
      const books = await booksFrom(query, "id");
      const fieldArgs: string[] = [];
      for (const [key, value] of entries) fieldArgs.push("--field", `${key}:${value}`);
      for (const book of books) await calibredb(["set_metadata", String(book.id), ...fieldArgs]);
      return J({ matched: books.length, updated_ids: books.map((b) => b.id) });
    }),
);

// --------------------------------------------------------------------------- //
// Add / remove / convert / export
// --------------------------------------------------------------------------- //
server.tool(
  "add_book",
  "Adds a file (EPUB/PDF/MOBI/AZW3...) to the library. Returns the new id. automerge (optional): 'ignore' | 'overwrite' | 'new_record' to handle duplicates. identifiers e.g. 'isbn:9788491050000'.",
  {
    file_path: z.string().describe("Path of the file to add."),
    authors: z.string().optional(),
    title: z.string().optional(),
    tags: z.string().optional().describe("Initial tags, comma-separated."),
    series: z.string().optional(),
    series_index: z.string().optional(),
    languages: z.string().optional().describe("Language code, e.g. 'eng'."),
    identifiers: z.string().optional().describe("e.g. 'isbn:9788491050000'."),
    automerge: z.string().optional().describe("ignore | overwrite | new_record"),
  },
  async (a) =>
    guard(async () => {
      const args = ["add", a.file_path];
      if (a.authors) args.push("--authors", a.authors);
      if (a.title) args.push("--title", a.title);
      if (a.tags) args.push("--tags", a.tags);
      if (a.series) args.push("--series", a.series);
      if (a.series_index) args.push("--series-index", a.series_index);
      if (a.languages) args.push("--languages", a.languages);
      if (a.identifiers) args.push("--identifier", a.identifiers);
      if (a.automerge) args.push("--automerge", a.automerge);
      return (await calibredb(args, { timeout: 300_000 })).trim();
    }),
);

server.tool(
  "remove_books",
  "Removes books from the library by id (comma-separated). DESTRUCTIVE: requires confirm=true. permanent=true skips Calibre's recycle bin.",
  {
    book_ids: z.string().describe("Ids to remove, comma-separated."),
    confirm: z.boolean().optional().describe("Must be true to actually delete."),
    permanent: z.boolean().optional().describe("true = do not use the recycle bin."),
  },
  async ({ book_ids, confirm, permanent }) =>
    guard(async () => {
      if (!confirm) {
        return `Nothing was deleted. Call again with confirm=true to delete ids: ${book_ids}.`;
      }
      const args = ["remove", book_ids];
      if (permanent) args.push("--permanent");
      await calibredb(args);
      return J({ removed_ids: book_ids, permanent: !!permanent });
    }),
);

server.tool(
  "convert_book",
  "Converts a book to another format and ADDS that format to the same library book (does not create a new book). Ideal for generating AZW3 for Kindle. If you don't pass source_format, it picks the best available (epub > azw3 > mobi > fb2 > pdf).",
  {
    book_id: z.number().int(),
    to_format: z.string().optional().describe("Target format (azw3, epub, mobi, pdf...). Default azw3."),
    source_format: z.string().optional().describe("Source format to use (optional)."),
  },
  async ({ book_id, to_format, source_format }) =>
    guard(async () => {
      const fmt = (to_format ?? "azw3").toLowerCase();
      const books = await booksFrom(`id:${book_id}`, "formats");
      if (!books.length) throw new Error(`No book found with id ${book_id}.`);
      const formats = toArray(books[0].formats);
      if (!formats.length) throw new Error("The book has no files to convert.");
      const preference = source_format
        ? [source_format.toLowerCase()]
        : ["epub", "azw3", "mobi", "fb2", "pdf"];
      let source = "";
      for (const want of preference) {
        const found = formats.find((p) => p.toLowerCase().endsWith("." + want));
        if (found) {
          source = found;
          break;
        }
      }
      if (!source) source = formats[0];
      const outPath = join(tmpdir(), `calibre_convert_${book_id}.${fmt}`);
      await run(CONFIG.ebookConvert, [source, outPath], { timeout: 900_000 });
      await calibredb(["add_format", String(book_id), outPath]);
      return J({ book_id, converted_to: fmt, from_source: source });
    }),
);

server.tool(
  "export_books",
  "Exports books to a folder on disk (e.g. to copy them to a Kindle). book_ids comma-separated or 'all'. formats optional, e.g. 'azw3,epub'.",
  {
    book_ids: z.string().describe("Ids comma-separated, or 'all'."),
    to_dir: z.string().describe("Destination folder."),
    formats: z.string().optional().describe("Formats to export, e.g. 'azw3,epub'."),
  },
  async ({ book_ids, to_dir, formats }) =>
    guard(async () => {
      const args = ["export", "--to-dir", to_dir, "--single-dir"];
      if (formats) args.push("--formats", formats);
      if (book_ids.trim().toLowerCase() === "all") args.push("--all");
      else args.push(book_ids);
      await calibredb(args, { timeout: 900_000 });
      return J({ exported: book_ids, to_dir });
    }),
);

// --------------------------------------------------------------------------- //
// Cleanup / library quality
// --------------------------------------------------------------------------- //
server.tool(
  "find_duplicates",
  "Detects likely duplicates by grouping on normalized (title, author). Returns the groups with more than one book.",
  async () =>
    guard(async () => {
      const books = await booksFrom("", "id,title,authors");
      const groups = new Map<string, number[]>();
      for (const book of books) {
        const authors = Array.isArray(book.authors) ? book.authors.join(" & ") : book.authors ?? "";
        const key = `${String(book.title ?? "").trim().toLowerCase()}|${String(authors).trim().toLowerCase()}`;
        const arr = groups.get(key) ?? [];
        arr.push(book.id);
        groups.set(key, arr);
      }
      const dups = [...groups.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([key, ids]) => {
          const [title, authors] = key.split("|");
          return { title, authors, ids };
        });
      return J({ duplicate_groups: dups, count: dups.length });
    }),
);

server.tool(
  "find_books_missing_metadata",
  "Lists books that are missing a specific metadata field. missing accepts: tags, comments, series, publisher, cover, identifiers, languages, pubdate.",
  { missing: z.string().optional().describe("Missing metadata to look for (default 'tags').") },
  async ({ missing }) =>
    guard(async () => {
      const field = (missing ?? "tags").trim().toLowerCase();
      const books = await booksFrom(`${field}:false`, "id,title,authors");
      return J({ missing: field, count: books.length, books });
    }),
);

// --------------------------------------------------------------------------- //
// Online metadata
// --------------------------------------------------------------------------- //
//
// fetch_online_metadata saves each cover to its own new temp folder (so an old
// image can never be reused by a later lookup), returns the cover image with the
// OPF so it can be checked before use, and says so when no cover was found.
// "sources" limits which metadata sources are used (fetch-ebook-metadata
// --allowed-plugin).

const MAX_IMAGE_BYTES = 3_000_000; // don't attach unusually large images

// Work out the real image type from the file's first bytes; the file is always
// named cover.jpg, but some sources supply PNG or WebP.
function imageMimeType(buf: Buffer): string | null {
    if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        return "image/png";
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        return "image/jpeg";
    if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
        return "image/webp";
    if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "GIF")
        return "image/gif";
    return null;
}

server.tool("fetch_online_metadata", "Looks up metadata from online sources by title/author or ISBN and returns an OPF. With fetch_cover=true, also returns a small preview of the downloaded cover (its full size is reported), and a unique cover_path to the full-size file that can be passed to set_metadata's cover field. If you pass apply_to_book_id, it applies that metadata (and optionally the cover) to that book in your library.", {
    title: z.string().optional(),
    authors: z.string().optional(),
    isbn: z.string().optional(),
    apply_to_book_id: z.number().int().optional().describe("If set, applies the metadata to that book."),
    fetch_cover: z.boolean().optional().describe("true to also download the cover."),
    sources: z.string().optional().describe("Comma-separated metadata source names to use, e.g. 'Goodreads,FictionDB'. Default: all enabled sources."),
    preview_width: z.number().int().min(0).max(1000).optional().describe("Width in pixels of the cover preview returned with fetch_cover (default 300). 0 returns the full-size image. The saved cover_path file is always full size."),
}, async ({ title, authors, isbn, apply_to_book_id, fetch_cover, sources, preview_width }) => guard(async () => {
    if (!title && !isbn)
        throw new Error("Provide at least a title or an ISBN.");
    const args: string[] = ["--opf"];
    if (title)
        args.push("--title", title);
    if (authors)
        args.push("--authors", authors);
    if (isbn)
        args.push("--isbn", isbn);
    if (sources) {
        for (const s of sources.split(",").map((x: string) => x.trim()).filter(Boolean))
            args.push("--allowed-plugin", s);
    }

    let coverPath = "";
    if (fetch_cover) {
        const dir = mkdtempSync(join(tmpdir(), "calibre-cover-"));
        coverPath = join(dir, "cover.jpg");
        args.push("--cover", coverPath);
    }

    const opf = await run(CONFIG.fetchMeta, args, { timeout: 180_000 });
    const haveCover = coverPath !== "" && existsSync(coverPath) && statSync(coverPath).size > 0;

    // Lookup only: return the OPF plus (optionally) the cover image.
    if (!apply_to_book_id) {
        const content: ToolResult["content"] = [{ type: "text", text: opf }];
        if (fetch_cover) {
            if (!haveCover) {
                content.push({ type: "text", text: "cover: none found" });
            } else {
                const buf = readFileSync(coverPath);
                const mimeType = imageMimeType(buf);
                const size = imageSize(buf);
                const sizeText = size ? `${size.width}x${size.height}` : "unknown size";
                content.push({ type: "text", text: `cover_path: ${coverPath}\ncover_size: ${sizeText}, ${Math.round(buf.length / 1024)} KB` });
                const width = preview_width ?? 300;
                let preview: Buffer | null = null;
                if (width > 0) {
                    try {
                        // Small preview for checking the cover; the full-size file stays at cover_path.
                        preview = await sharp(buf, { failOn: "none" })
                            .resize({ width, height: width * 2, fit: "inside", withoutEnlargement: true })
                            .flatten({ background: { r: 255, g: 255, b: 255 } })
                            .jpeg({ quality: 80 })
                            .toBuffer();
                    } catch {
                        preview = null;
                    }
                }
                if (preview)
                    content.push({ type: "image", data: preview.toString("base64"), mimeType: "image/jpeg" });
                else if (mimeType && buf.length <= MAX_IMAGE_BYTES)
                    content.push({ type: "image", data: buf.toString("base64"), mimeType });
                else
                    content.push({ type: "text", text: "cover image not attached (unrecognised format or too large)" });
            }
        }
        return { content };
    }

    // Apply to a book (unchanged behaviour, but uses this call's own cover file).
    const opfPath = join(tmpdir(), `calibre_meta_${apply_to_book_id}.opf`);
    writeFileSync(opfPath, opf, "utf8");
    await calibredb(["set_metadata", String(apply_to_book_id), opfPath]);
    const result: Record<string, unknown> = { applied_to: apply_to_book_id };
    if (haveCover) {
        await calibredb(["set_metadata", String(apply_to_book_id), "--field", `cover:${coverPath}`]);
        result.cover_set = true;
    }
    const books = await booksFrom(`id:${apply_to_book_id}`, "all");
    result.metadata = books[0] ?? null;
    return J(result);
}));

// --------------------------------------------------------------------------- //
// Startup
// --------------------------------------------------------------------------- //
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("calibre-manager MCP running (stdio).");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});