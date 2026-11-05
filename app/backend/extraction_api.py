"""REST endpoints for the data-extraction stage (mounted under /api/extraction)."""
from __future__ import annotations

import json
from typing import Any, Literal

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .config import APP_DIR
from .db import now_iso
from .extraction_export import build_json, build_zip
from .extraction_service import ExtractionService
from .extraction_templates import parse_template_file, template_to_xlsx, validate_template

ValueAction = Literal["accept", "reject", "edit", "note", "reset", "use_conflict", "dismiss_conflict"]


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except LookupError as e:
        raise HTTPException(404, str(e)) from None
    except ValueError as e:
        raise HTTPException(422, str(e)) from None


def _stamp() -> str:
    return now_iso().replace(":", "").replace("-", "")[:15]


class TemplateBody(BaseModel):
    template: dict[str, Any]
    source_filename: str | None = None


class ValueBody(BaseModel):
    action: ValueAction = "edit"
    status: Literal["reported", "not_reported", "unclear", "not_applicable"] | None = None
    value: Any = None
    unit: str | None = None
    context: str | None = None
    note: str | None = None


class UpsertValueBody(ValueBody):
    group_id: str
    field_id: str
    record_id: str | None = None


class RecordBody(BaseModel):
    group_id: str
    label: str = ""


class RecordPatch(BaseModel):
    label: str | None = None
    deleted: bool | None = None
    sort_order: int | None = None


class EvidenceBody(BaseModel):
    quote: str = Field(min_length=1, max_length=5000)
    page: int
    selection_rects: list[list[float]] | None = None


class FieldEvidenceBody(EvidenceBody):
    group_id: str
    field_id: str
    record_id: str | None = None


class NotesBody(BaseModel):
    body: str = Field(default="", max_length=100_000)


class UndoAcceptBody(BaseModel):
    value_ids: list[str] = Field(default_factory=list, max_length=10_000)


class CompleteBody(BaseModel):
    completed: bool = True
    force: bool = False


def _value_data(body: ValueBody) -> dict[str, Any]:
    # Only forward attributes the client actually sent, so partial edits keep the rest.
    return {k: getattr(body, k) for k in body.model_fields_set if k in ("status", "value", "unit", "context", "note")}


def build_router(svc, xsvc: ExtractionService) -> APIRouter:
    r = APIRouter(prefix="/api/extraction")

    def paper_or_404(pid: str) -> dict[str, Any]:
        p = svc.paper(pid)
        if not p:
            raise HTTPException(404, f"Unknown paper {pid}")
        return p

    # ---------------------------------------------------------------- template

    @r.get("/template")
    def get_template() -> dict[str, Any]:
        return {"active": xsvc.active_template(), "versions": xsvc.template_versions()}

    @r.get("/template/example")
    def example_template() -> dict[str, Any]:
        path = APP_DIR.parent / "examples" / "extraction_template.example.json"
        if not path.exists():
            raise HTTPException(404, "Example template not found")
        return validate_template(json.loads(path.read_text(encoding="utf-8")))

    @r.post("/template/import")
    async def import_template(file: UploadFile = File(...)) -> dict[str, Any]:
        content = await file.read()
        template, warnings = _guard(parse_template_file, file.filename or "", content)
        return {"template": template, "warnings": warnings, "source_filename": file.filename}

    @r.post("/template/preview")
    def preview_template(body: TemplateBody) -> dict[str, Any]:
        return _guard(xsvc.template_impact, body.template)

    @r.put("/template")
    def save_template(body: TemplateBody) -> dict[str, Any]:
        return _guard(xsvc.save_template, body.template, body.source_filename)

    @r.get("/template/download")
    def download_template(format: Literal["json", "xlsx"] = "json") -> Response:
        tpl = xsvc.active_template()
        if not tpl:
            raise HTTPException(404, "No extraction template has been defined")
        name = f"extraction_template_v{tpl['version']}"
        if format == "xlsx":
            return Response(template_to_xlsx(tpl["template"]),
                            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                            headers={"Content-Disposition": f'attachment; filename="{name}.xlsx"'})
        return Response(json.dumps(tpl["template"], ensure_ascii=False, indent=2), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{name}.json"'})

    # ---------------------------------------------------------------- papers & runs

    @r.get("/papers")
    def list_papers() -> dict[str, Any]:
        return xsvc.list_papers()

    @r.get("/papers/{pid}")
    def paper_detail(pid: str) -> dict[str, Any]:
        d = xsvc.paper_detail(pid)
        if not d:
            raise HTTPException(404, f"Unknown paper {pid}")
        return d

    @r.post("/papers/{pid}/run")
    def run(pid: str) -> dict[str, Any]:
        paper_or_404(pid)
        ok, msg = xsvc.submit(pid)
        if not ok:
            raise HTTPException(409, msg)
        return {"queued": True, "message": msg}

    @r.post("/run-all")
    def run_all() -> dict[str, Any]:
        if not svc.provider:
            raise HTTPException(409, svc.provider_status)
        queued = []
        for p in xsvc.list_papers()["papers"]:
            if p["eligible"] and p["pdf_available"] and p["status"] == "not_started":
                ok, _ = xsvc.submit(p["paper_id"])
                if ok:
                    queued.append(p["paper_id"])
        return {"queued": queued}

    # ---------------------------------------------------------------- values

    @r.put("/papers/{pid}/values")
    def upsert_value(pid: str, body: UpsertValueBody) -> dict[str, Any]:
        paper_or_404(pid)
        vid = _guard(xsvc.upsert_value, pid, body.group_id, body.record_id, body.field_id, body.action, _value_data(body))
        return {"value_id": vid}

    @r.patch("/values/{vid}")
    def patch_value(vid: str, body: ValueBody) -> dict[str, Any]:
        _guard(xsvc.update_value, vid, body.action, _value_data(body))
        return {"value_id": vid}

    @r.post("/papers/{pid}/accept-verified")
    def accept_verified(pid: str) -> dict[str, Any]:
        paper_or_404(pid)
        return {"accepted": xsvc.accept_verified(pid)}

    @r.post("/papers/{pid}/accept-all")
    def accept_all(pid: str) -> dict[str, Any]:
        paper_or_404(pid)
        ids = xsvc.accept_all(pid)
        return {"accepted": len(ids), "value_ids": ids}

    @r.post("/papers/{pid}/undo-accept")
    def undo_accept(pid: str, body: UndoAcceptBody) -> dict[str, Any]:
        paper_or_404(pid)
        return {"reverted": xsvc.undo_accept(pid, body.value_ids)}

    # ---------------------------------------------------------------- records

    @r.post("/papers/{pid}/records")
    def add_record(pid: str, body: RecordBody) -> dict[str, Any]:
        paper_or_404(pid)
        return _guard(xsvc.add_record, pid, body.group_id, body.label)

    @r.patch("/records/{rid}")
    def patch_record(rid: str, body: RecordPatch) -> dict[str, Any]:
        return _guard(xsvc.update_record, rid, body.label, body.deleted, body.sort_order)

    # ---------------------------------------------------------------- evidence

    @r.post("/values/{vid}/evidence")
    def add_evidence(vid: str, body: EvidenceBody) -> dict[str, Any]:
        return _guard(xsvc.add_evidence, vid, body.quote, body.page, body.selection_rects)

    @r.post("/papers/{pid}/evidence")
    def add_field_evidence(pid: str, body: FieldEvidenceBody) -> dict[str, Any]:
        paper_or_404(pid)

        def attach():
            record_id = body.record_id or xsvc.add_record(pid, body.group_id)["id"]
            row = xsvc.ensure_value(pid, record_id, body.field_id)
            return xsvc.add_evidence(row["id"], body.quote, body.page, body.selection_rects)

        return _guard(attach)

    @r.patch("/evidence/{eid}")
    def patch_evidence(eid: str, removed: bool = Query(...)) -> dict[str, Any]:
        return _guard(xsvc.update_evidence, eid, removed)

    @r.delete("/evidence/{eid}")
    def delete_evidence(eid: str) -> dict[str, Any]:
        _guard(xsvc.delete_evidence, eid)
        return {"deleted": True}

    @r.post("/papers/{pid}/reverify")
    def reverify(pid: str) -> dict[str, Any]:
        paper_or_404(pid)
        return _guard(xsvc.reverify_evidence, pid)

    # ---------------------------------------------------------------- paper-level

    @r.put("/papers/{pid}/notes")
    def set_notes(pid: str, body: NotesBody) -> dict[str, Any]:
        paper_or_404(pid)
        return {"body": body.body, "updated_at": xsvc.set_notes(pid, body.body)}

    @r.post("/papers/{pid}/complete")
    def complete(pid: str, body: CompleteBody) -> dict[str, Any]:
        paper_or_404(pid)
        return xsvc.set_completed(pid, body.completed, body.force)

    # ---------------------------------------------------------------- export

    @r.get("/export.zip")
    def export_zip(reviewed_only: bool = False, include_ineligible: bool = False) -> Response:
        data = _guard(build_zip, xsvc, reviewed_only, include_ineligible)
        return Response(data, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="extraction_export_{_stamp()}.zip"'})

    @r.get("/export.json")
    def export_json(reviewed_only: bool = False, include_ineligible: bool = False) -> Response:
        data = _guard(build_json, xsvc, reviewed_only, include_ineligible)
        return Response(data.encode("utf-8"), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="extraction_export_{_stamp()}.json"'})

    return r

