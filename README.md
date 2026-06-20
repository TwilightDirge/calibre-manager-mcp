# Calibre Manager MCP

An [MCP](https://modelcontextprotocol.io) server to **manage and organize** a [Calibre](https://calibre-ebook.com/) library from an AI assistant (Claude Desktop, Cursor, etc.).

Unlike other Calibre MCPs —which are read-only— this one is built to **write and inject metadata** and keep your library spotless: tags, authors, series, covers, duplicates, conversion to AZW3 for Kindle, and more.

All writing goes through the official **`calibredb`** command, which is the supported, safe way to modify the library: it **never touches `metadata.db` directly**, avoiding corruption and conflicts.

## Tools

| Tool | What it does |
| --- | --- |
| `health_check` | Verifies that calibredb and the library respond. |
| `search_books` | Searches using Calibre syntax (`tag:`, `author:`, `series:`...). |
| `get_book_metadata` | Returns all metadata for a book. |
| `list_categories` | Lists a category's values with counts (tags, authors...). |
| `library_stats` | Total books and breakdown by category. |
| `set_metadata` | Sets (replaces) a book's fields. |
| `add_tags` | Adds tags without removing the existing ones. |
| `remove_tags` | Removes specific tags, keeping the rest. |
| `rename_tag` | Renames a tag across the whole library. |
| `bulk_set_metadata` | Applies metadata to every book matching a search. |
| `add_book` | Adds a file (EPUB/PDF/MOBI/AZW3...) to the library. |
| `remove_books` | Removes books by id (requires confirmation). |
| `convert_book` | Converts to another format (e.g. AZW3) and adds it to the book. |
| `export_books` | Exports books to a folder (e.g. for your Kindle). |
| `find_duplicates` | Detects duplicates by (title, author). |
| `find_books_missing_metadata` | Lists books without tags/cover/series/etc. |
| `fetch_online_metadata` | Fetches online metadata (Google Books...) and applies it. |

## Requirements

- [Calibre](https://calibre-ebook.com/download) installed (includes `calibredb`, `ebook-convert` and `fetch-ebook-metadata`).
- [Node.js](https://nodejs.org/) 18 or newer.

## Installation

```bash
git clone https://github.com/ericknavarro/calibre-manager-mcp.git
cd calibre-manager-mcp
npm install      # installs dependencies and builds (the "prepare" script)
```

To rebuild after a change:

```bash
npm run build
```

The compiled server lives at `dist/index.js`.

## Configuration in Claude Desktop

Edit `claude_desktop_config.json` (on Windows: `%APPDATA%\Claude\claude_desktop_config.json`) and add:

```json
{
  "mcpServers": {
    "calibre-manager": {
      "command": "node",
      "args": ["C:\\Users\\<your-username>\\repos\\calibre-manager-mcp\\dist\\index.js"],
      "env": {
        "CALIBRE_LIBRARY_PATH": "C:\\Users\\<your-username>\\calibre",
        "CALIBREDB_PATH": "C:\\Program Files\\Calibre2\\calibredb.exe",
        "EBOOK_CONVERT_PATH": "C:\\Program Files\\Calibre2\\ebook-convert.exe",
        "FETCH_EBOOK_METADATA_PATH": "C:\\Program Files\\Calibre2\\fetch-ebook-metadata.exe"
      }
    }
  }
}
```

Restart Claude Desktop. To check it works, ask it: _"Run a health_check on Calibre"_.

### Where is my library?

It's the folder that contains `metadata.db` (in Calibre: top-right, over the library name → _"Switch/create library"_ shows the path). If you omit it, Calibre's default library is used.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `CALIBRE_LIBRARY_PATH` | No | Path to the library, or Content Server URL. If omitted, the default. |
| `CALIBREDB_PATH` | No | Path to `calibredb` (defaults to looking it up on PATH). |
| `EBOOK_CONVERT_PATH` | No | Path to `ebook-convert`. |
| `FETCH_EBOOK_METADATA_PATH` | No | Path to `fetch-ebook-metadata`. |
| `CALIBRE_USERNAME` / `CALIBRE_PASSWORD` | No | Only if you use the Content Server via URL. |

## Important note: library locking

While the **Calibre app is open** using that same library, `calibredb` cannot open it — for **reading or writing** — because the app holds a lock (you get an error like _"Another calibre program is running"_). You have two options:

1. **Close Calibre** before write operations. _(simplest)_
2. Start Calibre's **Content Server** and point `CALIBRE_LIBRARY_PATH` at its URL (`http://localhost:8080#library`) with a username/password.

In short: keep Calibre closed while you use this MCP, or run the Content Server (which lets multiple programs share the library safely).

## Usage examples

Once configured, you can ask Claude things like:

- _"Tag book 5 with Philosophy and Stoicism without removing its tags."_
- _"Set the series 'Greek Classics' on all books by Plato and Aristotle."_
- _"Find duplicates in my library."_
- _"Which books have no cover?"_
- _"Convert book 12 to AZW3 for my Kindle."_
- _"Fetch the online metadata for 'The Name of the Rose' by Umberto Eco and apply it to book 8."_

## License

MIT © Erick Navarro
