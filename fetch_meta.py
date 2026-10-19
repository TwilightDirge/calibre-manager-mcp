"""
fetch_meta.py - metadata + cover lookup for calibre-manager, restricted to the
sources you ask for.

Why this exists: calibre's fetch-ebook-metadata applies --allowed-plugin only to
the metadata (identify) step. Its -c cover step asks every enabled cover source
and keeps the best one, so a cover can come from a source you never asked for
and belong to a different book. This script does both steps with the same
source list.

Run with calibre's bundled Python:
    calibre-debug.exe -e fetch_meta.py -- --sources "Hardcover,FictionDB"
        --title "The Smoke Ring" --authors "Larry Niven" --cover-out C:\\path\\cover.jpg

Output: one line on stdout that starts with the marker below, followed by JSON:
    ok, opf, cover_path, cover_source, cover_width, cover_height,
    cover_error, error, log
"""
import argparse
import json
import sys
from io import BytesIO
from queue import Empty, Queue
from threading import Event, Timer

from calibre.customize.ui import metadata_plugins
from calibre.ebooks.metadata import string_to_authors
from calibre.ebooks.metadata.opf2 import metadata_to_opf
from calibre.ebooks.metadata.sources.base import create_log
from calibre.ebooks.metadata.sources.identify import identify
from calibre.utils.imghdr import identify as image_info

MARKER = '@@CALIBRE_MANAGER_RESULT@@'


def log_tail(buf, limit=4000):
    return buf.getvalue().decode('utf-8', 'replace')[-limit:]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--sources', required=True,
                   help='Comma-separated source names, most preferred first')
    p.add_argument('--title', default=None)
    p.add_argument('--authors', default=None)
    p.add_argument('--isbn', default=None)
    p.add_argument('--cover-out', default=None,
                   help='Full path to save the cover to; omit to skip the cover')
    p.add_argument('--timeout', type=int, default=30)
    p.add_argument('--deadline', type=int, default=150,
                   help='Seconds before the whole lookup is aborted')
    args = p.parse_args(sys.argv[1:])

    sources = [s.strip() for s in args.sources.split(',') if s.strip()]
    rank = {name: i for i, name in enumerate(sources)}
    authors = string_to_authors(args.authors) if args.authors else []
    identifiers = {'isbn': args.isbn} if args.isbn else {}

    buf = BytesIO()
    log = create_log(buf)
    abort = Event()
    out = {'ok': False}

    # Overall deadline. The per-source timeout only limits each network
    # request, so a slow source (or several) could still keep the whole lookup
    # running. When the deadline passes, abort tells every source to stop and
    # the script returns whatever it has. It stays under the 180-second limit
    # that index.ts allows for this script.
    deadline = Timer(args.deadline, abort.set)
    deadline.daemon = True
    deadline.start()

    results = identify(log, abort, title=args.title, authors=authors,
                       identifiers=identifiers, timeout=args.timeout,
                       allowed_plugins=frozenset(sources))
    if not results:
        out['error'] = ('Lookup aborted: deadline reached' if abort.is_set()
                        else 'No results found')
        out['log'] = log_tail(buf)
        deadline.cancel()
        print(MARKER + json.dumps(out), flush=True)
        return

    mi = results[0]
    out['ok'] = True

    if args.cover_out:
        # Only the requested sources, and only ones that can supply covers.
        plugins = [pl for pl in metadata_plugins(['cover'])
                   if pl.name in rank and pl.is_configured()]
        candidates = []
        for pl in plugins:
            if abort.is_set():
                log.error('Deadline reached; skipping cover from', pl.name)
                break
            rq = Queue()
            try:
                # identify() above ran in this process, so each source has
                # already cached the cover URL for the book it matched.
                pl.download_cover(log, rq, abort,
                                  title=args.title or mi.title,
                                  authors=authors or mi.authors,
                                  identifiers=mi.identifiers,
                                  timeout=args.timeout, get_best_cover=True)
            except Exception:
                log.exception('Cover download failed for', pl.name)
            while True:
                try:
                    item = rq.get_nowait()
                except Empty:
                    break
                data = item[-1]
                if not data:
                    continue
                fmt, width, height = image_info(data)
                if fmt and width > 0 and height > 0:
                    # Preferred source first, then the larger image.
                    candidates.append((rank[pl.name], -(width * height),
                                       pl.name, width, height, data))
        if candidates:
            candidates.sort(key=lambda c: (c[0], c[1]))
            _, _, name, width, height, data = candidates[0]
            with open(args.cover_out, 'wb') as f:
                f.write(data)
            mi.cover = args.cover_out
            out.update(cover_path=args.cover_out, cover_source=name,
                       cover_width=width, cover_height=height)
        else:
            out['cover_error'] = 'No cover from: ' + ', '.join(sources)
            out['log'] = log_tail(buf)

    deadline.cancel()
    out['opf'] = metadata_to_opf(mi).decode('utf-8')
    print(MARKER + json.dumps(out), flush=True)


main()