"""PDF text extraction with word geometry, and verified quote anchoring.

Every highlight in the application is produced here: a quotation (from the model or from a
reviewer's text selection) is located in the words actually extracted from the PDF, and the
highlight geometry is derived from those words' bounding boxes. Nothing is highlighted unless
it can be found in the document text.

Matching is done on an alphanumeric-only, NFKC-normalised, case-folded character stream, which
makes it robust to line breaks, hyphenation at line ends, ligatures, curly quotes, dashes and
whitespace differences, while still requiring the same sequence of letters and digits.
Small deviations (a dropped or changed word) are tolerated by a bounded fuzzy match
(>= 90 % similarity); anything looser is rejected.

Coordinates are stored in PDF user space (origin bottom-left, y up, unrotated), which the
frontend converts with PDF.js `viewport.convertToViewportRectangle`, so highlights remain
anchored at any zoom level, rotation or window size.
"""
from __future__ import annotations

import bisect
import logging
import re
import threading
import unicodedata
import zlib
from collections import OrderedDict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import pymupdf

from .db import Database, dumps, loads, now_iso

log = logging.getLogger(__name__)

EXTRACTOR_VERSION = "1"
MIN_CHARS_PER_PAGE = 25  # below this a page is treated as having no extractable text
FUZZY_THRESHOLD = 0.90


# ---------------------------------------------------------------- normalisation

def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).casefold()
    return "".join(ch for ch in s if ch.isalnum())


def clean_display(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).replace("­", "")
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- extraction

def _ocr_available() -> bool:
    try:
        return bool(pymupdf.get_tessdata())
    except Exception:
        return False


def extract_pdf(path: Path) -> dict[str, Any]:
    """Extract words with geometry for every page."""
    doc = pymupdf.open(str(path))
    pages: list[dict[str, Any]] = []
    empty_pages: list[int] = []
    ocr_pages: list[int] = []
    ocr_ok = None
    try:
        for page in doc:
            words = page.get_text("words")
            chars = sum(len(w[4]) for w in words)
            if chars < MIN_CHARS_PER_PAGE and page.get_images():
                if ocr_ok is None:
                    ocr_ok = _ocr_available()
                if ocr_ok:
                    try:
                        tp = page.get_textpage_ocr(dpi=200, full=True)
                        words = page.get_text("words", textpage=tp)
                        ocr_pages.append(page.number + 1)
                    except Exception as e:  # pragma: no cover - depends on local tesseract
                        log.warning("OCR failed on %s p%d: %s", path.name, page.number + 1, e)
            if sum(len(w[4]) for w in words) < MIN_CHARS_PER_PAGE:
                empty_pages.append(page.number + 1)
            inv = ~page.transformation_matrix  # MuPDF space -> PDF user space
            pages.append({
                "n": page.number + 1,
                "w": round(page.mediabox.width, 2),
                "h": round(page.mediabox.height, 2),
                "m": [round(v, 4) for v in (inv.a, inv.b, inv.c, inv.d, inv.e, inv.f)],
                "words": [[round(w[0], 2), round(w[1], 2), round(w[2], 2), round(w[3], 2), w[4], w[5], w[6]] for w in words],
            })
    finally:
        doc.close()
    char_count = sum(len(w[4]) for p in pages for w in p["words"])
    n = len(pages)
    if n and len(empty_pages) == n:
        status = "no_text"
        message = ("No extractable text: this appears to be a scanned/image-only PDF. "
                   + ("OCR was attempted but produced no text." if ocr_ok else
                      "OCR is unavailable (install Tesseract and set TESSDATA_PREFIX to enable it)."))
    elif empty_pages:
        status = "partial"
        message = f"No extractable text on page(s) {_fmt_pages(empty_pages)}."
    else:
        status = "ok"
        message = None
    if ocr_pages:
        message = (message + " " if message else "") + f"OCR used on page(s) {_fmt_pages(ocr_pages)}."
    return {"status": status, "message": message, "page_count": n, "char_count": char_count, "pages": pages}


def _fmt_pages(pages: list[int]) -> str:
    if len(pages) > 12:
        return ", ".join(map(str, pages[:12])) + f" … (+{len(pages) - 12})"
    return ", ".join(map(str, pages))


def page_text(page: dict[str, Any]) -> str:
    """Readable text of a page reconstructed from words (lines/blocks preserved)."""
    out: list[str] = []
    prev_key = None
    line: list[str] = []
    for w in page["words"]:
        key = (w[5], w[6])
        if prev_key is not None and key != prev_key:
            out.append(" ".join(line))
            if key[0] != prev_key[0]:
                out.append("")
            line = []
        line.append(w[4])
        prev_key = key
    if line:
        out.append(" ".join(line))
    text = unicodedata.normalize("NFKC", "\n".join(out))
    # join words hyphenated across line ends ("electro-\ncardiogram") for readability
    text = re.sub(r"(\w)-\n(?=[a-z])", r"\1", text)
    return text


def document_text_with_markers(pages: list[dict[str, Any]], first: int = 1, last: int | None = None) -> str:
    last = last or len(pages)
    parts = []
    for p in pages[first - 1:last]:
        parts.append(f"[[PAGE {p['n']}]]\n{page_text(p)}")
    return "\n\n".join(parts)


# ---------------------------------------------------------------- cache

_index_cache: "OrderedDict[str, DocIndex]" = OrderedDict()
_cache_lock = threading.Lock()
_extract_locks: dict[str, threading.Lock] = {}


def get_document(db: Database, sha256: str, path: Path) -> dict[str, Any]:
    """Return extracted document (cached in SQLite by content hash)."""
    row = db.one("SELECT * FROM pdf_text WHERE sha256=?", (sha256,))
    if row and row["extractor_version"] == EXTRACTOR_VERSION:
        pages = loads(zlib.decompress(row["pages_json"]).decode("utf-8"))
        return {"status": row["status"], "message": row["message"], "page_count": row["page_count"],
                "char_count": row["char_count"], "pages": pages}
    with _cache_lock:
        lock = _extract_locks.setdefault(sha256, threading.Lock())
    with lock:
        row = db.one("SELECT extractor_version FROM pdf_text WHERE sha256=?", (sha256,))
        if row and row["extractor_version"] == EXTRACTOR_VERSION:
            return get_document(db, sha256, path)
        try:
            doc = extract_pdf(path)
        except Exception as e:
            log.exception("Extraction failed for %s", path)
            doc = {"status": "error", "message": f"Text extraction failed: {e}", "page_count": 0, "char_count": 0, "pages": []}
        blob = zlib.compress(dumps(doc["pages"]).encode("utf-8"), 6)
        db.execute(
            "INSERT INTO pdf_text(sha256, extractor_version, page_count, status, message, char_count, pages_json, extracted_at) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(sha256) DO UPDATE SET extractor_version=excluded.extractor_version, "
            "page_count=excluded.page_count, status=excluded.status, message=excluded.message, char_count=excluded.char_count, "
            "pages_json=excluded.pages_json, extracted_at=excluded.extracted_at",
            (sha256, EXTRACTOR_VERSION, doc["page_count"], doc["status"], doc["message"], doc["char_count"], blob, now_iso()),
        )
        return doc


def get_index(db: Database, sha256: str, path: Path) -> "DocIndex":
    with _cache_lock:
        idx = _index_cache.get(sha256)
        if idx is not None:
            _index_cache.move_to_end(sha256)
            return idx
    idx = DocIndex(get_document(db, sha256, path)["pages"])
    with _cache_lock:
        _index_cache[sha256] = idx
        while len(_index_cache) > 12:
            _index_cache.popitem(last=False)
    return idx


# ---------------------------------------------------------------- anchoring

_ELLIPSIS = re.compile(r"\s*(?:\[\s*(?:\.\s*){3}\]|\.\s*\.\s*\.|…)\s*")


def _overlap(a: list[float], b: list[float]) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return max(0.0, w) * max(0.0, h)


class DocIndex:
    def __init__(self, pages: list[dict[str, Any]]):
        self.pages = pages
        parts: list[str] = []
        owner: list[int] = []
        self.words: list[tuple[int, int]] = []
        self.page_start: list[int] = []
        pos = 0
        for pi, pg in enumerate(pages):
            self.page_start.append(pos)
            for wi, w in enumerate(pg["words"]):
                n = norm(w[4])
                gid = len(self.words)
                self.words.append((pi, wi))
                parts.append(n)
                owner.extend([gid] * len(n))
                pos += len(n)
        self.page_start.append(pos)
        self.stream = "".join(parts)
        self.owner = owner

    @property
    def page_count(self) -> int:
        return len(self.pages)

    def page_of(self, pos: int) -> int:
        """1-based page number for a stream position."""
        return bisect.bisect_right(self.page_start, pos) - 1 + 1

    def _find_all(self, q: str, limit: int = 200) -> list[int]:
        out, start = [], 0
        while len(out) < limit:
            i = self.stream.find(q, start)
            if i < 0:
                break
            out.append(i)
            start = i + 1
        return out

    # -- geometry

    def span_geometry(self, s: int, e: int) -> tuple[list[list[float]], str]:
        owned = self.owner[s:e]
        # every word between the first and last matched word, including punctuation-only words such as
        # "±" or "+" that contribute no letters/digits to the matching stream but matter for meaning
        gids = list(range(min(owned), max(owned) + 1)) if owned else []
        lines: "OrderedDict[tuple[int, int, int], list[float]]" = OrderedDict()
        texts: list[str] = []
        prev = None
        for gid in gids:
            pi, wi = self.words[gid]
            w = self.pages[pi]["words"][wi]
            key = (pi, w[5], w[6])
            box = lines.get(key)
            if box is None:
                lines[key] = [w[0], w[1], w[2], w[3]]
            else:
                box[0], box[1] = min(box[0], w[0]), min(box[1], w[1])
                box[2], box[3] = max(box[2], w[2]), max(box[3], w[3])
            if prev is not None and texts and texts[-1].endswith("-") and key != prev and w[4][:1].islower():
                texts[-1] = texts[-1][:-1] + w[4]  # word hyphenated across a line break
            else:
                texts.append(w[4])
            prev = key
        rects = []
        for (pi, _, _), (x0, y0, x1, y1) in lines.items():
            a, b, c, d, ee, f = self.pages[pi]["m"]
            pts = [(x * a + y * c + ee, x * b + y * d + f) for x, y in ((x0, y0), (x1, y1))]
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            rects.append([self.pages[pi]["n"], round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)])
        return rects, clean_display(" ".join(texts))

    # -- matching

    def _pick(self, starts: list[int], length: int, page_hint: int | None, hint_rects: list[list[float]] | None) -> int:
        if len(starts) == 1:
            return starts[0]
        if hint_rects:
            def score(st: int) -> float:
                rects, _ = self.span_geometry(st, st + length)
                return sum(_overlap(r[1:], h[1:]) for r in rects for h in hint_rects if r[0] == h[0])
            best = max(starts, key=score)
            if score(best) > 0:
                return best
        if page_hint:
            return min(starts, key=lambda st: abs(self.page_of(st) - page_hint))
        return starts[0]

    def _fuzzy(self, q: str, page_hint: int | None) -> tuple[int, int, float] | None:
        L = len(q)
        k = min(24, max(10, L // 5))
        offsets = sorted({0, L // 4, L // 2, (3 * L) // 4, max(0, L - k)})
        candidates: set[int] = set()
        for off in offsets:
            anchor = q[off:off + k]
            if len(anchor) < 10:
                continue
            for pos in self._find_all(anchor, limit=40):
                candidates.add(pos - off)
        best: tuple[float, int, int] | None = None
        slack = max(20, L // 8)
        for start in candidates:
            ws, we = max(0, start - slack), min(len(self.stream), start + L + slack)
            window = self.stream[ws:we]
            sm = SequenceMatcher(None, q, window, autojunk=False)
            blocks = [b for b in sm.get_matching_blocks() if b.size >= 3]
            if not blocks:
                continue
            matched = sum(b.size for b in blocks)
            s0, e0 = ws + blocks[0].b, ws + blocks[-1].b + blocks[-1].size
            score = 2 * matched / (L + (e0 - s0))
            if matched / L < FUZZY_THRESHOLD:
                continue
            tie = abs(self.page_of(s0) - page_hint) if page_hint else 0
            if best is None or (score, -tie) > (best[0], -(abs(self.page_of(best[1]) - page_hint) if page_hint else 0)):
                best = (score, s0, e0)
        if best and best[0] >= FUZZY_THRESHOLD:
            return best[1], best[2], round(best[0], 3)
        return None

    def _locate_part(self, quote: str, page_hint: int | None, hint_rects, min_len: int, fuzzy: bool):
        q = norm(quote)
        if len(q) < min_len:
            return None
        starts = self._find_all(q)
        if starts:
            st = self._pick(starts, len(q), page_hint, hint_rects)
            return st, st + len(q), 1.0, "exact"
        if fuzzy and len(q) >= 30:
            r = self._fuzzy(q, page_hint)
            if r:
                return r[0], r[1], r[2], "fuzzy"
        return None

    def locate(self, quote: str, page_hint: int | None = None, hint_rects: list[list[float]] | None = None,
               min_len: int = 12, fuzzy: bool = True) -> dict[str, Any] | None:
        """Find `quote` in the document. Returns geometry + exact PDF text, or None if unverifiable."""
        if not quote or not self.stream:
            return None
        parts = [p for p in _ELLIPSIS.split(quote) if norm(p)]
        if not parts:
            return None
        if len(parts) == 1:
            r = self._locate_part(parts[0], page_hint, hint_rects, min_len, fuzzy)
            if not r:
                return None
            s, e, score, method = r
            rects, text = self.span_geometry(s, e)
            return {"page": self.page_of(s), "rects": rects, "text": text, "score": score, "method": method}
        # Quotes elided with an ellipsis: every fragment must verify, in order, close together.
        found = []
        cursor_hint = page_hint
        for p in parts:
            r = self._locate_part(p, cursor_hint, None, max(8, min_len // 2), fuzzy)
            if not r:
                return None
            found.append(r)
            cursor_hint = self.page_of(r[0])
        for a, b in zip(found, found[1:]):
            if not (0 <= b[0] - a[1] <= 3000):
                return None
        rects, texts = [], []
        for s, e, _, _ in found:
            rr, t = self.span_geometry(s, e)
            rects.extend(rr)
            texts.append(t)
        return {"page": self.page_of(found[0][0]), "rects": rects, "text": " … ".join(texts),
                "score": round(min(f[2] for f in found), 3), "method": "fragments"}
