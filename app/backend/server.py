"""FastAPI application: REST API + static frontend.

Run with:  python -m backend.server   (from the app/ directory)
"""
from __future__ import annotations

import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .analysis import ANALYSIS_VERSION, polarity_for
from .config import settings
from .criteria import criterion_ids
from .db import Database, dumps, now_iso
from .export import backup, export_csv, restore
from .extraction_api import build_router
from .extraction_service import ExtractionService
from .papers import pdf_file_path, sync_papers
from .pdftext import get_index
from .service import Services

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("screening")

db = Database(settings.db_path)
svc = Services(db, settings)
xsvc = ExtractionService(svc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        sync_papers(db, settings)
    except Exception:
        log.exception("Initial paper sync failed")
    svc.criteria.get()
    svc.prefetch_text()
    log.info("AI provider: %s", svc.provider_status)
    svc.check_provider_async()
    yield


app = FastAPI(title="GateKeepr", lifespan=lifespan)
app.include_router(build_router(svc, xsvc))


def _paper_or_404(paper_id: str) -> dict[str, Any]:
    p = svc.paper(paper_id)
    if not p:
        raise HTTPException(404, f"Unknown paper {paper_id}")
    return p


# ------------------------------------------------------------------ status & criteria

@app.get("/api/status")
def status() -> dict[str, Any]:
    c = svc.criteria.get()
    return {
        "ai": {
            "available": svc.provider is not None,
            "provider": svc.provider.name if svc.provider else None,
            "model": svc.provider.model if svc.provider else None,
            "status": svc.provider_status,
            "check": svc.provider_check,
            "concurrency": settings.ai_concurrency,
        },
        "criteria": {
            "ok": c is not None,
            "error": svc.criteria.error,
            "hash": c["content_hash"] if c else None,
            "file": settings.criteria_file.name,
        },
        "analysis_version": ANALYSIS_VERSION,
        "paths": {
            "root": str(settings.root),
            "papers_csv": str(settings.papers_csv),
            "manifest": str(settings.manifest),
            "pdf_dir": str(settings.pdf_dir),
            "criteria": str(settings.criteria_file),
            "database": str(settings.db_path),
        },
        "last_sync": db.get_meta("last_sync"),
        "jobs": svc.job_snapshot(),
    }


@app.post("/api/ai/test")
def ai_test() -> dict[str, Any]:
    return svc.check_provider()


@app.get("/api/criteria")
def get_criteria() -> dict[str, Any]:
    c = svc.criteria.get()
    if not c:
        raise HTTPException(503, svc.criteria.error or "Criteria unavailable")
    return c


@app.get("/api/criteria/source")
def criteria_source():
    if not settings.criteria_file.exists():
        raise HTTPException(404, "Criteria source file not found")
    media_type = "application/pdf" if settings.criteria_file.suffix.lower() == ".pdf" else "application/json"
    return FileResponse(settings.criteria_file, media_type=media_type,
                        headers={"Content-Disposition": f'inline; filename="{settings.criteria_file.name}"'})


@app.get("/api/criteria/pdf")
def criteria_pdf_legacy():
    """Backward-compatible route retained for old frontend builds and bookmarks."""
    if settings.criteria_file.suffix.lower() != ".pdf":
        raise HTTPException(404, "The configured criteria source is not a PDF")
    return criteria_source()


@app.post("/api/sync")
def resync() -> dict[str, Any]:
    counts = sync_papers(db, settings)
    svc.prefetch_text()
    return counts


# ------------------------------------------------------------------ papers

@app.get("/api/papers")
def list_papers() -> list[dict[str, Any]]:
    return svc.list_papers()


@app.get("/api/papers/{paper_id}")
def paper_detail(paper_id: str) -> dict[str, Any]:
    d = svc.paper_detail(paper_id)
    if not d:
        raise HTTPException(404, f"Unknown paper {paper_id}")
    return d


@app.get("/api/papers/{paper_id}/pdf")
def paper_pdf(paper_id: str, download: bool = False):
    p = _paper_or_404(paper_id)
    path = pdf_file_path(p)
    if not path or not path.exists():
        raise HTTPException(404, "No local PDF for this paper")
    disp = "attachment" if download else "inline"
    return FileResponse(path, media_type="application/pdf",
                        headers={"Content-Disposition": f'{disp}; filename="{paper_id}.pdf"', "Cache-Control": "no-cache"})


class AnalyzeBody(BaseModel):
    force: bool = False


@app.post("/api/papers/{paper_id}/analyze")
def analyze(paper_id: str, body: AnalyzeBody | None = None) -> dict[str, Any]:
    _paper_or_404(paper_id)
    ok, msg = svc.submit_analysis(paper_id, force=bool(body and body.force))
    if not ok:
        raise HTTPException(409, msg)
    return {"queued": True, "message": msg}


class AnalyzeAllBody(BaseModel):
    include_outdated: bool = True
    include_failed: bool = True


@app.post("/api/analyze-all")
def analyze_all(body: AnalyzeAllBody | None = None) -> dict[str, Any]:
    body = body or AnalyzeAllBody()
    if not svc.provider:
        raise HTTPException(409, svc.provider_status)
    wanted = {"pending"} | ({"outdated"} if body.include_outdated else set()) | ({"failed"} if body.include_failed else set())
    queued = []
    for p in svc.list_papers():
        if p["analysis_state"] in wanted:
            ok, _ = svc.submit_analysis(p["paper_id"], force=True)
            if ok:
                queued.append(p["paper_id"])
    return {"queued": queued}


@app.get("/api/jobs")
def jobs() -> dict[str, Any]:
    return svc.job_snapshot()


# ------------------------------------------------------------------ decisions & notes

class DecisionBody(BaseModel):
    decision: Literal["include", "exclude", "maybe"]
    code: str | None = None
    reason: str | None = None


@app.put("/api/papers/{paper_id}/decision")
def set_decision(paper_id: str, body: DecisionBody) -> dict[str, Any]:
    _paper_or_404(paper_id)
    cur = svc.current_analysis(paper_id)
    rec = json.loads(cur["recommendation_json"]) if cur and cur["recommendation_json"] else {}
    ts = now_iso()
    vals = (paper_id, body.decision, (body.code or "").strip() or None, (body.reason or "").strip() or None, ts,
            rec.get("decision"), rec.get("code"))
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO decisions(paper_id, decision, code, reason, decided_at, ai_decision, ai_code, analysis_id) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(paper_id) DO UPDATE SET decision=excluded.decision, code=excluded.code, "
            "reason=excluded.reason, decided_at=excluded.decided_at, ai_decision=excluded.ai_decision, "
            "ai_code=excluded.ai_code, analysis_id=excluded.analysis_id",
            vals + (cur["id"] if cur else None,),
        )
        conn.execute("INSERT INTO decision_log(paper_id, decision, code, reason, decided_at, ai_decision, ai_code) VALUES(?,?,?,?,?,?,?)", vals)
    return db.one("SELECT * FROM decisions WHERE paper_id=?", (paper_id,))


@app.delete("/api/papers/{paper_id}/decision")
def clear_decision(paper_id: str) -> dict[str, Any]:
    _paper_or_404(paper_id)
    with db.tx() as conn:
        conn.execute("DELETE FROM decisions WHERE paper_id=?", (paper_id,))
        conn.execute("INSERT INTO decision_log(paper_id, decision, decided_at) VALUES(?,?,?)", (paper_id, "cleared", now_iso()))
    return {"cleared": True}


class NotesBody(BaseModel):
    body: str = Field(default="", max_length=100_000)


@app.put("/api/papers/{paper_id}/notes")
def set_notes(paper_id: str, body: NotesBody) -> dict[str, Any]:
    _paper_or_404(paper_id)
    ts = now_iso()
    db.execute("INSERT INTO notes(paper_id, body, updated_at) VALUES(?,?,?) ON CONFLICT(paper_id) DO UPDATE SET "
               "body=excluded.body, updated_at=excluded.updated_at", (paper_id, body.body, ts))
    return {"body": body.body, "updated_at": ts}


# ------------------------------------------------------------------ evidence

class NewEvidence(BaseModel):
    criterion_id: str
    stance: Literal["supports", "contradicts", "ambiguous"] = "supports"
    quote: str = Field(min_length=1, max_length=5000)
    page: int
    explanation: str | None = ""
    # Optional geometry of the reviewer's text selection (PDF user space) for disambiguation/fallback
    selection_rects: list[list[float]] | None = None


@app.post("/api/papers/{paper_id}/evidence")
def add_evidence(paper_id: str, body: NewEvidence) -> dict[str, Any]:
    p = _paper_or_404(paper_id)
    c = svc.criteria.get()
    if not c:
        raise HTTPException(503, "Criteria unavailable")
    ids = criterion_ids(c)
    if body.criterion_id not in ids:
        raise HTTPException(422, f"Unknown criterion {body.criterion_id}")
    path = pdf_file_path(p)
    if not path:
        raise HTTPException(409, "No local PDF")
    idx = get_index(db, p["pdf_sha256"], path)
    m = idx.locate(body.quote, page_hint=body.page, hint_rects=body.selection_rects, min_len=3, fuzzy=True)
    if m:
        quote, page, rects, method, score = m["text"], m["page"], m["rects"], m["method"], m["score"]
    elif body.selection_rects:
        # Text came from the PDF.js text layer of this PDF; keep its own geometry.
        rects = [r for r in body.selection_rects if len(r) == 5]
        if not rects:
            raise HTTPException(422, "Invalid selection geometry")
        quote, page, method, score = " ".join(body.quote.split()), body.page, "selection", None
    else:
        raise HTTPException(422, "The selected text could not be located in the PDF text layer.")
    ts = now_iso()
    eid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO evidence(id, paper_id, analysis_id, origin, criterion_id, stance, polarity, quote, model_quote, page, rects_json, "
        "explanation, match_method, match_score, dismissed, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
        (eid, paper_id, None, "manual", body.criterion_id, body.stance, polarity_for(ids[body.criterion_id]["kind"], body.stance),
         quote, None, page, dumps(rects), (body.explanation or "").strip(), method, score, ts, ts),
    )
    return next(e for e in svc.evidence_for(paper_id) if e["id"] == eid)


class EvidencePatch(BaseModel):
    dismissed: bool | None = None
    explanation: str | None = None
    criterion_id: str | None = None
    stance: Literal["supports", "contradicts", "ambiguous"] | None = None


@app.patch("/api/evidence/{evidence_id}")
def patch_evidence(evidence_id: str, body: EvidencePatch) -> dict[str, Any]:
    e = db.one("SELECT * FROM evidence WHERE id=?", (evidence_id,))
    if not e:
        raise HTTPException(404, "Unknown evidence")
    c = svc.criteria.get()
    ids = criterion_ids(c) if c else {}
    fields: dict[str, Any] = {}
    if body.dismissed is not None:
        fields["dismissed"] = int(body.dismissed)
    if body.explanation is not None:
        fields["explanation"] = body.explanation.strip()
    cid = body.criterion_id or e["criterion_id"]
    stance = body.stance or e["stance"]
    if body.criterion_id or body.stance:
        if cid not in ids:
            raise HTTPException(422, f"Unknown criterion {cid}")
        fields.update(criterion_id=cid, stance=stance, polarity=polarity_for(ids[cid]["kind"], stance))
    if fields:
        fields["updated_at"] = now_iso()
        sets = ", ".join(f"{k}=?" for k in fields)
        db.execute(f"UPDATE evidence SET {sets} WHERE id=?", tuple(fields.values()) + (evidence_id,))
    return next(x for x in svc.evidence_for(e["paper_id"]) if x["id"] == evidence_id)


@app.delete("/api/evidence/{evidence_id}")
def delete_evidence(evidence_id: str) -> dict[str, Any]:
    e = db.one("SELECT origin FROM evidence WHERE id=?", (evidence_id,))
    if not e:
        raise HTTPException(404, "Unknown evidence")
    if e["origin"] != "manual":
        raise HTTPException(409, "AI evidence can be dismissed but not deleted")
    db.execute("DELETE FROM evidence WHERE id=?", (evidence_id,))
    return {"deleted": True}


# ------------------------------------------------------------------ export & backup

@app.get("/api/export.csv")
def export() -> Response:
    data = export_csv(svc)
    stamp = now_iso().replace(":", "").replace("-", "")[:15]
    return Response(content=data.encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="screening_results_{stamp}.csv"'})


@app.get("/api/backup")
def get_backup() -> Response:
    stamp = now_iso().replace(":", "").replace("-", "")[:15]
    return Response(content=dumps(backup(db)).encode("utf-8"), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="screening_backup_{stamp}.json"'})


@app.post("/api/restore")
async def post_restore(file: UploadFile = File(...), mode: Literal["merge", "replace"] = Query("merge")) -> dict[str, Any]:
    try:
        data = json.loads((await file.read()).decode("utf-8-sig"))
        counts = restore(db, data, mode)
    except (ValueError, json.JSONDecodeError) as e:
        raise HTTPException(422, f"Invalid backup: {e}")
    return {"restored": counts, "mode": mode}


# ------------------------------------------------------------------ frontend

if settings.frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=settings.frontend_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        target = settings.frontend_dist / full_path
        if full_path and target.is_file():
            return FileResponse(target)
        return FileResponse(settings.frontend_dist / "index.html", headers={"Cache-Control": "no-cache"})
else:
    @app.get("/", include_in_schema=False)
    def no_frontend():
        return JSONResponse({"message": "Frontend not built. Run `npm install && npm run build` in app/frontend, "
                                        "or use the Vite dev server (npm run dev)."})


def main() -> None:
    import uvicorn
    uvicorn.run("backend.server:app", host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
