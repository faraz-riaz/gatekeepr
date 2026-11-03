"""Self-contained backend tests with temporary review inputs and no network calls."""
from __future__ import annotations

import csv
import io
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import pymupdf
import pytest

APP = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(APP))

FIXTURE_ROOT = Path(tempfile.mkdtemp(prefix="screening-test-"))
PDF_DIR = FIXTURE_ROOT / "pdfs"
PDF_DIR.mkdir()
CRITERIA_PATH = FIXTURE_ROOT / "criteria.json"
PAPERS_PATH = FIXTURE_ROOT / "papers.csv"
MANIFEST_PATH = FIXTURE_ROOT / "data" / "papers_manifest.json"
MANIFEST_PATH.parent.mkdir()

CRITERIA_PAYLOAD = {
    "schema_version": 1,
    "title": "Portable test review",
    "core_rule": "All inclusion criteria must be met and no exclusion may be triggered.",
    "inclusion": [
        {
            "id": "I1",
            "name": "Target population",
            "definition": "The study includes adults with hypertension.",
            "exclusion_code": "E1",
        },
        {
            "id": "I2",
            "name": "Complete primary research",
            "definition": "The report contains both primary research and usable results.",
            "sub_requirements": [
                {"id": "I2.1", "text": "Original data are analysed.", "kind": "all_required"},
                {"id": "I2.2", "text": "Methods and results are reported.", "kind": "all_required"},
            ],
            "exclusion_code": "E2",
        },
        {
            "id": "I3",
            "name": "Eligible intervention route",
            "definition": "The study uses at least one eligible intervention route.",
            "sub_requirements": [
                {"id": "I3A", "text": "Drug intervention route.", "kind": "route"},
                {"id": "I3B", "text": "Behavioural intervention route.", "kind": "route"},
            ],
        },
    ],
    "exclusion": [
        {
            "id": "E1",
            "name": "Wrong population",
            "definition": "The population is entirely outside the protocol.",
            "paired_inclusion": "I1",
        },
        {
            "id": "E2",
            "name": "No primary results",
            "definition": "The publication contains no eligible primary results.",
            "paired_inclusion": "I2",
        },
        {
            "id": "E3",
            "name": "Requires discussion",
            "definition": "An unusual design requires reviewer judgement.",
            "advisory": True,
        },
    ],
    "unretrieved": [{"id": "U1", "name": "Not retrieved", "definition": "Full text was unavailable."}],
}
CRITERIA_PATH.write_text(json.dumps(CRITERIA_PAYLOAD), encoding="utf-8")

PAPERS_PATH.write_text(
    "Paper_ID,Paper_Title,Authors,Year,DOI,Link\n"
    "P001,Mobile coaching trial,Example Author,2025,10.0000/example,https://example.test/P001\n"
    "P002,Paper without full text,Second Author,2024,,\n",
    encoding="utf-8",
)
MANIFEST_PATH.write_text(json.dumps({
    "schema_version": 1,
    "papers": [
        {"paper_id": "P001", "pdf_path": "pdfs/P001.pdf", "access_status": "downloaded"},
        {"paper_id": "P002", "access_status": "not_retrieved"},
    ],
}), encoding="utf-8")


def _make_pdf(path: Path) -> None:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "This randomized trial enrolled adults with hypertension.")
    page.insert_text((72, 100), "Participants received a mobile coaching intervention.")
    page = doc.new_page()
    page.insert_text((72, 72), "Methods and numerical outcome results are reported.")
    page.insert_text((72, 100), "The trial analysed original participant data.")
    doc.save(path)
    doc.close()


_make_pdf(PDF_DIR / "P001.pdf")

os.environ["SCREENING_ROOT"] = str(FIXTURE_ROOT)
os.environ["SCREENING_DB_PATH"] = str(FIXTURE_ROOT / "storage" / "test.db")
os.environ["SCREENING_PAPERS_CSV"] = str(PAPERS_PATH)
os.environ["SCREENING_MANIFEST"] = str(MANIFEST_PATH)
os.environ["SCREENING_PDF_DIR"] = str(PDF_DIR)
os.environ["SCREENING_CRITERIA_FILE"] = str(CRITERIA_PATH)
os.environ["SCREENING_AI_PROVIDER"] = "none"

from fastapi.testclient import TestClient  # noqa: E402

from backend import server  # noqa: E402
from backend.ai.base import LLMProvider  # noqa: E402
from backend.analysis import AnalysisOut, analyze_document, apply_rules, page_chunks, recommend  # noqa: E402
from backend.criteria import parse_criteria  # noqa: E402
from backend.pdftext import DocIndex, extract_pdf  # noqa: E402

CRITERIA = parse_criteria(CRITERIA_PATH)

FAKE_ANALYSIS = {
    "study_summary": "A randomized trial of mobile coaching for adults with hypertension.",
    "assessments": [
        {"criterion_id": "I1", "status": "met", "justification": "The target population is explicit."},
        {"criterion_id": "I2", "status": "met", "justification": "Both required parts are present."},
        {"criterion_id": "I2.1", "status": "met", "justification": "Original participant data are analysed."},
        {"criterion_id": "I2.2", "status": "met", "justification": "Methods and results are reported."},
        {"criterion_id": "I3", "status": "met", "justification": "The behavioural route is met."},
        {"criterion_id": "I3A", "status": "not_applicable", "justification": "This is not a drug intervention."},
        {"criterion_id": "I3B", "status": "met", "justification": "Mobile coaching is behavioural."},
        {"criterion_id": "E1", "status": "not_triggered", "justification": "The target population is present."},
        {"criterion_id": "E2", "status": "not_triggered", "justification": "Primary results are present."},
        {"criterion_id": "E3", "status": "not_found", "justification": "No unusual design is reported."},
    ],
    "evidence": [
        {
            "criterion_id": "I1",
            "stance": "supports",
            "page": 1,
            "quote": "This randomized trial enrolled adults with hypertension.",
            "explanation": "Target population.",
        },
        {
            "criterion_id": "I2.1",
            "stance": "supports",
            "page": 2,
            "quote": "The trial analysed original participant data.",
            "explanation": "Original data.",
        },
        {
            "criterion_id": "I2.2",
            "stance": "supports",
            "page": 2,
            "quote": "Methods and numerical outcome results are reported.",
            "explanation": "Complete report.",
        },
        {
            "criterion_id": "I3B",
            "stance": "supports",
            "page": 1,
            "quote": "Participants received a mobile coaching intervention.",
            "explanation": "Behavioural route.",
        },
        {
            "criterion_id": "UNKNOWN",
            "stance": "supports",
            "page": 1,
            "quote": "Participants received a mobile coaching intervention.",
            "explanation": "Unknown ID should be rejected.",
        },
        {
            "criterion_id": "I1",
            "stance": "supports",
            "page": 1,
            "quote": "This fabricated sentence is not in the paper.",
            "explanation": "Fabricated quote should be rejected.",
        },
    ],
    "study_characteristics": [
        {"label": "Design", "value": "Randomized trial"},
        {"label": "Intervention", "value": "Mobile coaching"},
    ],
    "suggested_decision": "include",
    "suggested_code": "",
    "rationale": "All inclusion criteria are met and no exclusion is triggered.",
}


class FakeProvider(LLMProvider):
    name = "fake"
    model = "fake-1"

    def __init__(self, payload: dict):
        self.payload = payload
        self.calls = 0

    def generate_json(self, *, system, prompt, schema, max_output_tokens=32768):
        self.calls += 1
        assert "ELIGIBILITY CRITERIA DOCUMENT" in prompt
        assert "[[PAGE " in prompt or "VERIFIED EVIDENCE" in prompt
        return json.loads(json.dumps(self.payload))


@pytest.fixture(scope="module")
def client():
    with TestClient(server.app) as test_client:
        yield test_client


def test_json_criteria_are_review_agnostic(tmp_path: Path):
    assert [c["id"] for c in CRITERIA["inclusion"]] == ["I1", "I2", "I3"]
    assert CRITERIA["exclusion"][2]["advisory"] is True
    assert "Mobile" not in CRITERIA["full_text"]
    duplicate = dict(CRITERIA_PAYLOAD)
    duplicate["exclusion"] = [{"id": "I1", "name": "Duplicate", "definition": "Invalid duplicate ID."}]
    path = tmp_path / "bad.json"
    path.write_text(json.dumps(duplicate), encoding="utf-8")
    with pytest.raises(ValueError, match="unique"):
        parse_criteria(path)


def test_quote_matching_and_page_chunks():
    pages = extract_pdf(PDF_DIR / "P001.pdf")["pages"]
    idx = DocIndex(pages)
    match = idx.locate("adults with hypertension", 1)
    assert match and match["page"] == 1 and match["rects"]
    assert idx.locate("This sentence does not exist") is None
    chunks = page_chunks(pages, 20)
    assert chunks == [(1, 1), (2, 2)]


def test_rules_require_verified_evidence():
    out = AnalysisOut.model_validate({**FAKE_ANALYSIS, "evidence": []})
    statuses = apply_rules(out, [], CRITERIA)
    assert statuses["I1"]["status"] == "unclear"
    assert statuses["I2"]["status"] == "unclear"
    assert statuses["E1"]["status"] == "not_found"
    result = recommend(statuses, CRITERIA, "include", "")
    assert result["decision"] == "maybe"


def test_papers_sync_and_pdf_serving(client: TestClient):
    papers = client.get("/api/papers").json()
    assert [paper["paper_id"] for paper in papers] == ["P001", "P002"]
    assert papers[0]["pdf_available"] is True
    assert papers[1]["analysis_state"] == "no_pdf"
    response = client.get("/api/papers/P001/pdf")
    assert response.status_code == 200 and response.content[:4] == b"%PDF"
    assert client.get("/api/papers/P002/pdf").status_code == 404

    # Reviewers can add a conventionally named PDF after acquisition, even when
    # the existing manifest entry has no pdf_path and still says not retrieved.
    manual_pdf = PDF_DIR / "P002.pdf"
    _make_pdf(manual_pdf)
    try:
        sync = client.post("/api/sync")
        assert sync.status_code == 200
        assert sync.json()["with_pdf"] == 2
        papers = client.get("/api/papers").json()
        assert papers[1]["pdf_available"] is True
        response = client.get("/api/papers/P002/pdf")
        assert response.status_code == 200 and response.content[:4] == b"%PDF"
    finally:
        manual_pdf.unlink(missing_ok=True)
        client.post("/api/sync")


def test_analysis_pipeline_rejects_unverified_output(client: TestClient):
    fake = FakeProvider(FAKE_ANALYSIS)
    server.svc.provider, server.svc.provider_status = fake, "fake"
    try:
        response = client.post("/api/papers/P001/analyze", json={"force": True})
        assert response.status_code == 200, response.text
        for _ in range(100):
            if "P001" not in server.svc.job_snapshot():
                break
            time.sleep(0.05)
        detail = client.get("/api/papers/P001").json()
        assert detail["analysis_failed"] is None
        analysis = detail["analysis"]
        assert analysis["stats"]["quotes_verified"] == 4
        assert analysis["stats"]["quotes_rejected"] == 2
        assert analysis["result"]["assessments"]["I2"]["status"] == "met"
        assert analysis["result"]["assessments"]["I3"]["route"] == "I3B"
        assert analysis["recommendation"]["decision"] == "include"
        assert analysis["result"]["study_characteristics"][0]["label"] == "Design"

        replacement = FakeProvider(FAKE_ANALYSIS)
        replacement.model = "fake-2"
        server.svc.provider = replacement
        papers = client.get("/api/papers").json()
        assert papers[0]["analysis_state"] == "outdated"
        detail = client.get("/api/papers/P001").json()
        assert "provider or model has changed" in detail["analysis"]["outdated_reason"]
    finally:
        server.svc.provider, server.svc.provider_status = None, "disabled"


def test_chunked_analysis_deduplicates_evidence():
    pages = extract_pdf(PDF_DIR / "P001.pdf")["pages"]
    fake = FakeProvider(FAKE_ANALYSIS)
    result = analyze_document(
        fake,
        CRITERIA,
        {"paper_id": "P001", "title": "Mobile coaching trial"},
        pages,
        DocIndex(pages),
        max_single_pass_chars=10,
        chunk_chars=20,
    )
    assert fake.calls == result["stats"]["chunks"] + 1
    keys = [(item["criterion_id"], item["quote"]) for item in result["evidence"]]
    assert len(keys) == len(set(keys)) == 4


def test_manual_evidence_decisions_export_and_backup(client: TestClient):
    response = client.post("/api/papers/P001/evidence", json={
        "criterion_id": "I1",
        "stance": "supports",
        "page": 1,
        "quote": "adults with hypertension",
        "explanation": "Reviewer-selected evidence",
    })
    assert response.status_code == 200
    evidence = response.json()
    assert evidence["origin"] == "manual" and evidence["rects"]

    assert client.put("/api/papers/P001/notes", json={"body": "Checked independently."}).status_code == 200
    decision = client.put("/api/papers/P001/decision", json={
        "decision": "include",
        "reason": "All criteria met",
    })
    assert decision.status_code == 200

    exported = client.get("/api/export.csv").content.decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(exported)))
    assert len(rows) == 2
    assert rows[0]["Human_Decision"] == "INCLUDE"
    assert "Design: Randomized trial" in rows[0]["Study_Characteristics"]

    backup = client.get("/api/backup").content
    client.put("/api/papers/P001/notes", json={"body": "Changed"})
    restored = client.post("/api/restore?mode=replace", files={"file": ("backup.json", backup, "application/json")})
    assert restored.status_code == 200
    assert client.get("/api/papers/P001").json()["notes"]["body"] == "Checked independently."
    assert client.delete(f"/api/evidence/{evidence['id']}").json()["deleted"]
