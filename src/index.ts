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
import { writeFileSync, existsSync } from "node:fs";

import {
  CONFIG,
  calibredb,
  run,
  booksFrom,
  toArray,
  dedupe,
} from "./calibre.js";

const server = new McpServer({ name: "calibre-manager", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

/** Wraps a handler: returns text or a readable error (isError) without crashing the server. */
async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await fn());
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
server.tool(
  "fetch_online_metadata",
  "Looks up metadata from online sources (Google Books, etc.) by title/author or ISBN and returns an OPF. If you pass apply_to_book_id, it applies that metadata (and optionally the cover) to that book in your library.",
  {
    title: z.string().optional(),
    authors: z.string().optional(),
    isbn: z.string().optional(),
    apply_to_book_id: z.number().int().optional().describe("If set, applies the metadata to that book."),
    fetch_cover: z.boolean().optional().describe("true to also download the cover."),
  },
  async ({ title, authors, isbn, apply_to_book_id, fetch_cover }) =>
    guard(async () => {
      if (!title && !isbn) throw new Error("Provide at least a title or an ISBN.");
      const args = ["--opf"];
      if (title) args.push("--title", title);
      if (authors) args.push("--authors", authors);
      if (isbn) args.push("--isbn", isbn);
      let coverPath = "";
      if (fetch_cover) {
        coverPath = join(tmpdir(), "calibre_fetch_cover.jpg");
        args.push("--cover", coverPath);
      }
      const opf = await run(CONFIG.fetchMeta, args, { timeout: 180_000 });
      if (!apply_to_book_id) return opf;

      const opfPath = join(tmpdir(), `calibre_meta_${apply_to_book_id}.opf`);
      writeFileSync(opfPath, opf, "utf8");
      await calibredb(["set_metadata", String(apply_to_book_id), opfPath]);

      const result: Record<string, unknown> = { applied_to: apply_to_book_id };
      if (coverPath && existsSync(coverPath)) {
        await calibredb(["set_metadata", String(apply_to_book_id), "--field", `cover:${coverPath}`]);
        result.cover_set = true;
      }
      const books = await booksFrom(`id:${apply_to_book_id}`, "all");
      result.metadata = books[0] ?? null;
      return J(result);
    }),
);

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
