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
  const layers: sharp.OverlayOptions[] = [];

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