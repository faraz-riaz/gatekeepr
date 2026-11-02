"""Runtime configuration.

All paths are configurable through environment variables (or the project `.env`)
so the application can be moved to another machine. Relative paths are resolved
against SCREENING_ROOT, which defaults to the repository root (the parent of `app/`).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

APP_DIR = Path(__file__).resolve().parent.parent
_DEFAULT_ROOT = APP_DIR.parent

# Load the project .env first (AI provider settings live there), then an optional app-level .env.
load_dotenv(Path(os.environ.get("SCREENING_ROOT", _DEFAULT_ROOT)) / ".env", override=False)
load_dotenv(APP_DIR / ".env", override=False)


def _path(env: str, default: str | Path, root: Path) -> Path:
    value = os.environ.get(env)
    p = Path(value) if value else Path(default)
    return p if p.is_absolute() else (root / p)


@dataclass(frozen=True)
class Settings:
    root: Path
    papers_csv: Path
    manifest: Path
    pdf_dir: Path
    criteria_file: Path
    storage_dir: Path
    db_path: Path
    frontend_dist: Path
    ai_provider: str
    gemini_model: str
    openai_model: str
    ai_concurrency: int
    max_single_pass_chars: int
    chunk_chars: int
    host: str
    port: int


def load_settings() -> Settings:
    root = Path(os.environ.get("SCREENING_ROOT", _DEFAULT_ROOT)).resolve()
    storage = _path("SCREENING_STORAGE_DIR", APP_DIR / "storage", root)
    criteria_setting = os.environ.get("SCREENING_CRITERIA_FILE") or os.environ.get("SCREENING_CRITERIA_PDF")
    criteria_file = Path(criteria_setting) if criteria_setting else Path("criteria.json")
    if not criteria_file.is_absolute():
        criteria_file = root / criteria_file
    return Settings(
        root=root,
        papers_csv=_path("SCREENING_PAPERS_CSV", "papers.csv", root),
        manifest=_path("SCREENING_MANIFEST", "data/papers_manifest.json", root),
        pdf_dir=_path("SCREENING_PDF_DIR", "pdfs", root),
        criteria_file=criteria_file,
        storage_dir=storage,
        db_path=_path("SCREENING_DB_PATH", storage / "screening.db", root),
        frontend_dist=_path("SCREENING_FRONTEND_DIST", APP_DIR / "frontend" / "dist", root),
        ai_provider=os.environ.get("SCREENING_AI_PROVIDER", "auto").strip().lower(),
        gemini_model=os.environ.get("GEMINI_MODEL", "gemini-3.8-flash").strip(),
        openai_model=os.environ.get("OPENAI_MODEL", "gpt-4.1").strip(),
        ai_concurrency=max(1, int(os.environ.get("SCREENING_AI_CONCURRENCY", "2"))),
        max_single_pass_chars=int(os.environ.get("SCREENING_MAX_SINGLE_PASS_CHARS", "350000")),
        chunk_chars=int(os.environ.get("SCREENING_CHUNK_CHARS", "180000")),
        host=os.environ.get("SCREENING_HOST", "127.0.0.1"),
        port=int(os.environ.get("SCREENING_PORT", "8765")),
    )


settings = load_settings()
