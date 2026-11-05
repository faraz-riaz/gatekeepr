"""Data-extraction tests: templates, AI extraction with verification, review, re-runs, eligibility,
evidence, export and backup. Reuses the temporary review inputs from test_backend (no network)."""
from __future__ import annotations

import copy
import csv
import io
import json
import time
import zipfile
from pathlib import Path

import pymupdf
import pytest
from fastapi.testclient import TestClient

from test_backend import FIXTURE_ROOT, MANIFEST_PATH, PAPERS_PATH, PDF_DIR  # noqa: F401  (sets up the environment)

from backend import server
from backend.ai.base import LLMProvider
from backend.extraction import coerce_value, value_in_passage
from backend.extraction_templates import diff_templates, normalise_template, parse_template_file, template_to_xlsx, validate_template

EXAMPLE = json.loads((Path(__file__).resolve().parents[2] / "examples" / "extraction_template.example.json").read_text(encoding="utf-8"))
TEMPLATE, _ = normalise_template(EXAMPLE)


def _make_results_pdf(path: Path) -> None:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "We enrolled 450 adults with hypertension across three hospitals in Norway.")
    page.insert_text((72, 96), "Mean age was 61.2 years and 52% were female.")
    page.insert_text((72, 120), "Two datasets were used: the CardioNet cohort and the external HeartBank registry.")
    page = doc.new_page()
    page.insert_text((72, 72), "Table 2. Model performance (AUROC) on each dataset.")
    page.insert_text((72, 96), "Model CardioNet HeartBank")
    page.insert_text((72, 120), "TabFormer 0.912 0.874")
    page.insert_text((72, 144), "ResNet-34 0.881 0.842")
    doc.save(path)
    doc.close()


def V(field_id, status="reported", values=(), quotes=(), unit="", context="", note=""):
    return {"field_id": field_id, "status": status, "values": list(values), "unit": unit, "context": context, "note": note,
            "quotes": [{"quote": q, "page": p} for q, p in quotes]}


ROW1 = ("TabFormer 0.912 0.874", 2)
FAKE_EXTRACTION = {
    "summary": "One cohort study with two datasets, two models and four results.",
    "records": [
        {"group_id": "study", "record_key": "study", "label": "Study", "values": [
            V("aim", values=["Develop Prediction models for hypertension"], quotes=[("We enrolled 450 adults with hypertension", 1)]),
            V("study_design", values=["model development"], quotes=[("Model performance (AUROC) on each dataset", 2)]),
            V("country", values=["Norway"], quotes=[("across three hospitals in Norway", 1)]),
            V("publication_type", status="unclear", values=["Journal article"]),
            V("code_available", status="not_reported"),
            V("made_up_field", values=["x"]),
        ]},
        {"group_id": "population", "record_key": "population", "label": "Population", "values": [
            V("population_description", values=["Adults with hypertension"], quotes=[("All participants were elderly smokers.", 1)]),
            V("n_participants", values=["450"], quotes=[("We enrolled 450 adults with hypertension", 1)]),
            V("n_samples", status="not_reported"),
            V("age", values=["61.2"], unit="years", context="mean", quotes=[("Mean age was 61.2 years", 1)]),
            V("female_percent", values=["52%"], quotes=[("52% were female", 1)]),
        ]},
        {"group_id": "datasets", "record_key": "datasets_1", "label": "CardioNet", "values": [
            V("name", values=["CardioNet"], quotes=[("the CardioNet cohort", 1)])]},
        {"group_id": "datasets", "record_key": "datasets_2", "label": "HeartBank", "values": [
            V("name", values=["HeartBank"], quotes=[("the external HeartBank registry", 1)])]},
        {"group_id": "models", "record_key": "models_1", "label": "TabFormer", "values": [V("name", values=["TabFormer"], quotes=[ROW1])]},
        {"group_id": "models", "record_key": "models_2", "label": "ResNet-34", "values": [
            V("name", values=["ResNet-34"], quotes=[("ResNet-34 0.881 0.842", 2)])]},
        {"group_id": "results", "record_key": "results_1", "label": "TabFormer on CardioNet", "values": [
            V("model", values=["models_1"]), V("dataset", values=["datasets_1"]), V("metric", values=["AUROC"]),
            V("value", values=["0.912"], quotes=[ROW1], context="Table 2, row TabFormer, column CardioNet")]},
        {"group_id": "results", "record_key": "results_2", "label": "TabFormer on HeartBank", "values": [
            V("model", values=["models_1"]), V("dataset", values=["datasets_2"]), V("metric", values=["AUROC"]),
            V("value", values=["0.874"], quotes=[ROW1], context="Table 2, row TabFormer, column HeartBank")]},
        {"group_id": "results", "record_key": "results_3", "label": "ResNet-34 on CardioNet", "values": [
            V("model", values=["models_2"]), V("dataset", values=["datasets_1"]), V("metric", values=["AUROC"]),
            # wrong table row: 0.881 is not in the TabFormer row
            V("value", values=["0.881"], quotes=[ROW1])]},
        {"group_id": "results", "record_key": "results_4", "label": "Dangling", "values": [V("model", values=["models_9"])]},
        {"group_id": "not_a_group", "record_key": "x", "label": "x", "values": []},
    ],
}


class FakeExtractor(LLMProvider):
    name = "fake"
    model = "fake-extract"

    def __init__(self, payload):
        self.payload = payload
        self.calls = 0

    def generate_json(self, *, system, prompt, schema, max_output_tokens=32768):
        self.calls += 1
        assert schema.__name__ == "ExtractionOut"
        assert "EXTRACTION TEMPLATE" in prompt and "GROUP results" in prompt
        return copy.deepcopy(self.payload)


@pytest.fixture(scope="module")
def client():
    original_csv = PAPERS_PATH.read_text(encoding="utf-8")
    original_manifest = MANIFEST_PATH.read_text(encoding="utf-8")
    _make_results_pdf(PDF_DIR / "P003.pdf")
    PAPERS_PATH.write_text(original_csv + "P003,Prediction models for hypertension,Third Author,2026,10.0000/p3,\n", encoding="utf-8")
    manifest = json.loads(original_manifest)
    manifest["papers"].append({"paper_id": "P003", "pdf_path": "pdfs/P003.pdf", "access_status": "downloaded"})
    MANIFEST_PATH.write_text(json.dumps(manifest), encoding="utf-8")
    with TestClient(server.app) as c:
        c.post("/api/sync")
        yield c
        PAPERS_PATH.write_text(original_csv, encoding="utf-8")
        MANIFEST_PATH.write_text(original_manifest, encoding="utf-8")
        c.post("/api/sync")
    (PDF_DIR / "P003.pdf").unlink(missing_ok=True)


def _wait(pid: str):
    for _ in range(200):
        if pid not in server.xsvc.jobs:
            return
        time.sleep(0.02)


def _run(client, payload) -> dict:
    fake = FakeExtractor(payload)
    server.svc.provider, server.svc.provider_status = fake, "fake"
    try:
        r = client.post("/api/extraction/papers/P003/run")
        assert r.status_code == 200, r.text
        _wait("P003")
    finally:
        server.svc.provider, server.svc.provider_status = None, "disabled"
    return client.get("/api/extraction/papers/P003").json()


def _value(detail, group, field, label=None):
    recs = {r["id"]: r for r in detail["records"] if r["group_id"] == group and not r["deleted"]}
    for v in detail["values"]:
        if v["group_id"] == group and v["field_id"] == field and v["record_id"] in recs:
            if label is None or recs[v["record_id"]]["label"] == label:
                return v
    raise AssertionError(f"no value {group}.{field} {label}")


# ---------------------------------------------------------------- templates (unit)

def test_template_import_formats_and_validation(tmp_path):
    loose = {"title": "Loose", "fields": [
        {"name": "Sample size", "type": "int", "required": "yes"},
        {"name": "Design", "type": "dropdown", "options": "RCT; Cohort; Case-control"},
        {"name": "Notes", "type": "paragraph"},
    ]}
    t, warnings = normalise_template(loose)
    assert [f["type"] for f in t["groups"][0]["fields"]] == ["integer", "categorical", "long_text"]
    assert t["groups"][0]["fields"][0]["required"] is True and t["groups"][0]["fields"][1]["options"] == ["RCT", "Cohort", "Case-control"]
    assert any("single group" in w for w in warnings)

    t2, _ = parse_template_file("form.xlsx", template_to_xlsx(TEMPLATE))
    assert t2 == TEMPLATE  # Excel round-trip is lossless

    rows = "Section,Field,Type,Options,Repeatable,References\nArms,Arm name,text,,yes,\nOutcomes,Arm,reference,,yes,Arms\nOutcomes,Effect,number,,yes,\n"
    t3, _ = parse_template_file("form.csv", rows.encode())
    out = {g["id"]: g for g in t3["groups"]}
    assert out["arms"]["repeatable"] and out["outcomes"]["fields"][0]["target_group"] == "arms"

    wide, w = parse_template_file("sheet.csv", b"Study ID,Country,Sample size,Primary outcome\n")
    assert [f["label"] for f in wide["groups"][0]["fields"]] == ["Country", "Sample size", "Primary outcome"] and w

    bad = copy.deepcopy(TEMPLATE)
    bad["groups"][4]["fields"][0]["target_group"] = "study"  # references must point to repeatable groups
    with pytest.raises(ValueError, match="repeatable"):
        validate_template(bad)
    dup = copy.deepcopy(TEMPLATE)
    dup["groups"][0]["fields"].append(dict(dup["groups"][0]["fields"][0]))
    with pytest.raises(ValueError, match="duplicate"):
        validate_template(dup)


def test_coercion_and_value_in_passage():
    num = {"type": "number", "options": [], "allow_other": False, "multiple": False}
    assert coerce_value(num, ["1,234.5"])[0] == 1234.5
    assert coerce_value(num, ["52%"])[2] == "%"
    assert coerce_value({**num, "type": "integer"}, ["12.5"])[1]
    cat = {"type": "categorical", "options": ["Model development", "Benchmark"], "allow_other": False, "multiple": False}
    assert coerce_value(cat, ["MODEL DEVELOPMENT"])[0] == "Model development"
    assert coerce_value(cat, ["Survey"])[1]
    assert value_in_passage(num, ["450"], "We enrolled 450 adults") == "ok"
    assert value_in_passage(num, ["45"], "We enrolled 450 adults") == "mismatch"  # no partial-number matches
    assert value_in_passage({"type": "text"}, ["x"], "y") == "n/a"
    # table cells: leading-dot decimals next to other numbers, thousands separators, decimal commas
    row = "Ours + PT .780 ± .013 .538 ± .019 .954 ± .001"
    assert value_in_passage(num, ["0.954"], row) == "ok" and value_in_passage(num, ["0.95"], row) == "mismatch"
    assert value_in_passage(num, ["2322513"], "The registry contains 2,322,513 records") == "ok"
    assert value_in_passage(num, ["0.954"], "AUROC 0,954 (95% CI 0,94-0,96)") == "ok"


# ---------------------------------------------------------------- workflow (API)

def test_template_setup_and_eligibility_gate(client: TestClient):
    assert client.get("/api/extraction/template").json()["active"] is None
    example = client.get("/api/extraction/template/example").json()
    assert example == TEMPLATE
    saved = client.put("/api/extraction/template", json={"template": example, "source_filename": "example.json"}).json()
    assert saved["version"] == 1
    # saving an identical template does not create a new version
    assert client.put("/api/extraction/template", json={"template": example}).json()["version"] == 1

    ids = [p["paper_id"] for p in client.get("/api/extraction/papers").json()["papers"]]
    assert "P003" not in ids  # not included in screening yet
    server.svc.provider = FakeExtractor(FAKE_EXTRACTION)
    try:
        assert client.post("/api/extraction/papers/P003/run").status_code == 409
    finally:
        server.svc.provider = None
    assert client.put("/api/papers/P003/decision", json={"decision": "include"}).status_code == 200
    listing = {p["paper_id"]: p for p in client.get("/api/extraction/papers").json()["papers"]}
    assert listing["P003"]["eligible"] and listing["P003"]["status"] == "not_started"


def test_ai_extraction_keeps_entities_and_verifies_evidence(client: TestClient):
    d = _run(client, FAKE_EXTRACTION)
    assert d["last_run"]["status"] == "complete", d["last_run"]
    groups = lambda g: [r for r in d["records"] if r["group_id"] == g and not r["deleted"]]  # noqa: E731
    assert [r["label"] for r in groups("datasets")] == ["CardioNet", "HeartBank"]
    assert [r["label"] for r in groups("models")] == ["TabFormer", "ResNet-34"]
    assert len(groups("results")) == 4

    n = _value(d, "population", "n_participants")
    assert n["value"] == 450 and n["review_state"] == "pending" and n["origin"] == "ai"
    ev = n["evidence"][0]
    assert ev["verified"] and ev["rects"] and ev["page"] == 1 and ev["value_check"] == "ok"
    assert _value(d, "study", "study_design")["value"] == "Model development"  # matched to the allowed option
    assert _value(d, "population", "female_percent")["unit"] == "%"
    assert _value(d, "population", "age")["context"] == "mean"

    fabricated = _value(d, "population", "population_description")
    assert not fabricated["evidence"][0]["verified"] and fabricated["evidence"][0]["rects"] == []
    assert any("could not be found" in i for i in fabricated["issues"])
    assert any("No source passage" in i for i in _value(d, "study", "publication_type")["issues"])
    assert _value(d, "study", "code_available")["status"] == "not_reported"

    model_ids = {r["label"]: r["id"] for r in groups("models")}
    data_ids = {r["label"]: r["id"] for r in groups("datasets")}
    r2 = _value(d, "results", "dataset", "TabFormer on HeartBank")
    assert r2["value"] == [data_ids["HeartBank"]]
    assert _value(d, "results", "model", "ResNet-34 on CardioNet")["value"] == [model_ids["ResNet-34"]]
    wrong_row = _value(d, "results", "value", "ResNet-34 on CardioNet")
    assert wrong_row["evidence"][0]["verified"] and wrong_row["evidence"][0]["value_check"] == "mismatch"
    assert any("does not appear" in i for i in wrong_row["issues"])
    assert any("unknown models" in i for i in _value(d, "results", "model", "Dangling")["issues"])

    rejected = {(x["group_id"], x.get("field_id")) for x in d["last_run"]["stats"]["rejected"]}
    assert ("not_a_group", None) in rejected and ("study", "made_up_field") in rejected
    assert d["status"] == "awaiting_review" and d["counts"]["unverified"] >= 2


def test_review_actions_and_rerun_never_overwrite_human_work(client: TestClient):
    d = client.get("/api/extraction/papers/P003").json()
    n = _value(d, "population", "n_participants")
    country = _value(d, "study", "country")
    pub = _value(d, "study", "publication_type")
    code = _value(d, "study", "code_available")
    assert client.patch(f"/api/extraction/values/{n['id']}", json={"action": "accept"}).status_code == 200
    assert client.patch(f"/api/extraction/values/{country['id']}", json={"action": "edit", "value": "Norway (3 hospitals)"}).status_code == 200
    assert client.patch(f"/api/extraction/values/{pub['id']}", json={"action": "reject"}).status_code == 200
    assert client.patch(f"/api/extraction/values/{code['id']}", json={"action": "edit", "status": "not_applicable"}).status_code == 200
    bad = client.patch(f"/api/extraction/values/{n['id']}", json={"action": "edit", "value": "four hundred"})
    assert bad.status_code == 422  # typed validation
    manual = client.post("/api/extraction/papers/P003/records", json={"group_id": "datasets", "label": "Manual set"}).json()
    dangling = next(r for r in d["records"] if r["label"] == "Dangling")
    client.patch(f"/api/extraction/records/{dangling['id']}", json={"deleted": True})

    accepted = client.post("/api/extraction/papers/P003/accept-verified").json()["accepted"]
    assert accepted >= 3
    after = client.get("/api/extraction/papers/P003").json()
    assert _value(after, "results", "value", "ResNet-34 on CardioNet")["review_state"] == "pending"  # mismatched evidence is not bulk-accepted
    assert _value(after, "population", "population_description")["review_state"] == "pending"  # unverified is not bulk-accepted

    second = copy.deepcopy(FAKE_EXTRACTION)
    for rec in second["records"]:
        for v in rec["values"]:
            if v["field_id"] == "n_participants":
                v["values"] = ["455"]  # disagrees with the accepted value
            if v["field_id"] == "aim":
                v["values"] = ["Revised aim"]
            if v["field_id"] == "population_description":
                v["values"] = ["Adults with treated hypertension"]
    d2 = _run(client, second)
    n2 = _value(d2, "population", "n_participants")
    assert n2["value"] == 450 and n2["review_state"] == "accepted" and n2["conflict"]["value"] == 455
    assert _value(d2, "study", "country")["value"] == "Norway (3 hospitals)"
    assert _value(d2, "study", "country")["conflict"]  # still differs from the AI suggestion
    assert _value(d2, "study", "publication_type")["review_state"] == "rejected"  # same suggestion stays rejected
    assert _value(d2, "study", "code_available")["status"] == "not_applicable"
    aim = _value(d2, "study", "aim")  # accepted by "accept verified", so the new text is only a conflict
    assert aim["review_state"] == "accepted" and aim["value"] != "Revised aim" and aim["conflict"]["value"] == "Revised aim"
    desc = _value(d2, "population", "population_description")  # still pending, so it is simply replaced
    assert desc["value"] == "Adults with treated hypertension" and desc["review_state"] == "pending" and not desc["conflict"]
    assert all(r["deleted"] for r in d2["records"] if r["label"] == "Dangling")  # reviewer deletion is respected
    labels = [r["label"] for r in d2["records"] if r["group_id"] == "datasets" and not r["deleted"]]
    assert labels.count("CardioNet") == 1 and "Manual set" in labels  # matched by label; manual record kept
    assert next(r for r in d2["records"] if r["id"] == manual["id"])["deleted"] == 0

    client.patch(f"/api/extraction/values/{n2['id']}", json={"action": "use_conflict"})
    n3 = _value(client.get("/api/extraction/papers/P003").json(), "population", "n_participants")
    assert n3["value"] == 455 and n3["review_state"] == "pending" and n3["conflict"] is None and n3["evidence"]
    client.patch(f"/api/extraction/values/{n3['id']}", json={"action": "edit", "value": 450, "note": "455 includes withdrawals"})
    n4 = _value(client.get("/api/extraction/papers/P003").json(), "population", "n_participants")
    assert n4["value"] == 450 and n4["review_state"] == "edited" and n4["ai"]["value"] == 455 and n4["note"]


def test_manual_extraction_and_evidence(client: TestClient):
    # a field with no record or value yet (manual extraction without AI)
    r = client.put("/api/extraction/papers/P003/values", json={
        "group_id": "population", "field_id": "n_samples", "action": "edit", "status": "reported", "value": "3"})
    assert r.status_code == 200
    d = client.get("/api/extraction/papers/P003").json()
    v = _value(d, "population", "n_samples")
    assert v["value"] == 3 and v["review_state"] == "edited"

    # attaching a passage that does not contain the number flags the link
    ev = client.post(f"/api/extraction/values/{v['id']}/evidence", json={"quote": "Mean age was 61.2 years", "page": 1}).json()
    assert ev["verified"] and ev["value_check"] == "mismatch" and ev["origin"] == "manual"
    assert client.post(f"/api/extraction/values/{v['id']}/evidence", json={"quote": "never written anywhere", "page": 1}).status_code == 422
    assert client.patch(f"/api/extraction/evidence/{ev['id']}?removed=true").json()["removed"] is True
    assert client.delete(f"/api/extraction/evidence/{ev['id']}").json()["deleted"]

    # evidence on an empty field creates the value row
    res = client.post("/api/extraction/papers/P003/evidence", json={
        "group_id": "study", "field_id": "publication_type", "quote": "Table 2. Model performance", "page": 2})
    assert res.status_code == 200
    counts = client.post("/api/extraction/papers/P003/reverify").json()
    assert counts["verified"] >= 1 and counts["unverified"] >= 1  # the fabricated AI quote stays unverified


def test_eligibility_changes_keep_data(client: TestClient):
    client.put("/api/papers/P003/decision", json={"decision": "exclude", "code": "E1"})
    listing = {p["paper_id"]: p for p in client.get("/api/extraction/papers").json()["papers"]}
    assert not listing["P003"]["eligible"] and "not_eligible" in listing["P003"]["flags"]
    assert listing["P003"]["counts"]["resolved"] > 0  # nothing was deleted
    server.svc.provider = FakeExtractor(FAKE_EXTRACTION)
    try:
        assert client.post("/api/extraction/papers/P003/run").status_code == 409
    finally:
        server.svc.provider = None
    zipped = zipfile.ZipFile(io.BytesIO(client.get("/api/extraction/export.zip").content))
    assert "P003" not in zipped.read("study_level.csv").decode("utf-8-sig")
    zipped = zipfile.ZipFile(io.BytesIO(client.get("/api/extraction/export.zip?include_ineligible=true").content))
    assert "P003" in zipped.read("study_level.csv").decode("utf-8-sig")
    client.put("/api/papers/P003/decision", json={"decision": "include"})
    assert client.get("/api/extraction/papers/P003").json()["eligible"]


def test_completion_template_changes_and_export(client: TestClient):
    res = client.post("/api/extraction/papers/P003/complete", json={"completed": True}).json()
    assert not res["completed"] and res["warnings"]
    assert client.post("/api/extraction/papers/P003/complete", json={"completed": True, "force": True}).json()["completed"]
    assert client.get("/api/extraction/papers/P003").json()["status"] == "completed"

    t2 = copy.deepcopy(TEMPLATE)
    t2["groups"][1]["fields"] = [f for f in t2["groups"][1]["fields"] if f["id"] != "age"]  # remove a field with data
    t2["groups"][0]["fields"].append({"id": "funding", "label": "Funding", "type": "text", "required": True})
    preview = client.post("/api/extraction/template/preview", json={"template": t2}).json()
    assert preview["diff"]["removed_fields"] == ["population.age"] and preview["diff"]["added_fields"] == ["study.funding"]
    assert preview["impact"]["values_in_removed_fields"] == 1 and preview["impact"]["completed_papers"] == 1
    assert diff_templates(TEMPLATE, TEMPLATE)["changed_fields"] == []
    assert client.put("/api/extraction/template", json={"template": t2}).json()["version"] == 2
    d = client.get("/api/extraction/papers/P003").json()
    assert "template_changed" in d["flags"]
    assert not _value(d, "population", "age")["in_template"]  # archived, not deleted

    z = zipfile.ZipFile(io.BytesIO(client.get("/api/extraction/export.zip").content))
    names = set(z.namelist())
    assert {"study_level.csv", "datasets.csv", "models.csv", "results.csv", "values_long.csv", "evidence.csv",
            "data_dictionary.csv", "extraction.json", "template.json", "README.txt"} <= names
    read = lambda n: list(csv.DictReader(io.StringIO(z.read(n).decode("utf-8-sig"))))  # noqa: E731
    study = read("study_level.csv")
    p3 = next(r for r in study if r["paper_id"] == "P003")
    assert p3["population__n_participants"] == "450" and p3["n_results"] == "3" and p3["study__funding"] == ""
    assert p3["population__female_percent__unit"] == "%"
    results = read("results.csv")
    row = next(r for r in results if r["record_label"] == "TabFormer on HeartBank")
    assert row["value"] == "0.874" and row["model__label"] == "TabFormer" and row["dataset__label"] == "HeartBank"
    assert row["value__context"] == "Table 2, row TabFormer, column HeartBank"
    datasets = {r["record_id"]: r["record_label"] for r in read("datasets.csv")}
    assert datasets[row["dataset"]] == "HeartBank"  # relational link resolves
    long = read("values_long.csv")
    assert any(r["field_id"] == "age" and r["in_template"] == "no" for r in long)
    evidence = read("evidence.csv")
    assert any(r["field_id"] == "n_participants" and r["verified"] == "yes" and r["page"] == "1" for r in evidence)
    assert any(r["verified"] == "no" for r in evidence)
    doc = json.loads(z.read("extraction.json"))
    p = next(x for x in doc["papers"] if x["paper_id"] == "P003")
    assert len(p["groups"]["datasets"]) == 3 and p["groups"]["population"][0]["values"]["n_participants"]["value"] == 450

    reviewed = zipfile.ZipFile(io.BytesIO(client.get("/api/extraction/export.zip?reviewed_only=true").content))
    long_reviewed = list(csv.DictReader(io.StringIO(reviewed.read("values_long.csv").decode("utf-8-sig"))))
    assert long_reviewed and all(r["review_state"] in ("accepted", "edited") for r in long_reviewed)
    assert len(long_reviewed) < len(long)


def test_backup_restore_covers_extraction(client: TestClient):
    backup = client.get("/api/backup").content
    assert json.loads(backup)["version"] == 2
    d = client.get("/api/extraction/papers/P003").json()
    v = _value(d, "population", "n_participants")
    client.patch(f"/api/extraction/values/{v['id']}", json={"action": "edit", "value": 1})
    assert client.post("/api/restore?mode=replace", files={"file": ("b.json", backup, "application/json")}).status_code == 200
    assert _value(client.get("/api/extraction/papers/P003").json(), "population", "n_participants")["value"] == 450

    # an old (v1) backup without extraction tables must not wipe extraction work
    old = json.loads(backup)
    old["version"] = 1
    old["tables"] = {k: v for k, v in old["tables"].items() if not k.startswith("extraction_")}
    assert client.post("/api/restore?mode=replace", files={"file": ("old.json", json.dumps(old), "application/json")}).status_code == 200
    assert _value(client.get("/api/extraction/papers/P003").json(), "population", "n_participants")["value"] == 450
    assert client.get("/api/extraction/template").json()["active"]["version"] == 2


def test_chunked_extraction_merges_parts():
    from backend.extraction import extract_document
    from backend.pdftext import DocIndex, extract_pdf

    pages = extract_pdf(PDF_DIR / "P003.pdf")["pages"] if (PDF_DIR / "P003.pdf").exists() else None
    if pages is None:
        _make_results_pdf(FIXTURE_ROOT / "chunk.pdf")
        pages = extract_pdf(FIXTURE_ROOT / "chunk.pdf")["pages"]
    fake = FakeExtractor(FAKE_EXTRACTION)
    out = extract_document(fake, TEMPLATE, {"paper_id": "P003", "title": "t"}, pages, DocIndex(pages),
                           max_single_pass_chars=10, chunk_chars=50)
    assert out["stats"]["chunks"] == 2 and fake.calls == 3  # two parts + one merge call
    assert len([r for r in out["records"] if r["group_id"] == "results"]) == 4


def test_verified_quotes_keep_symbols(tmp_path):
    """Punctuation-only words (+, ±) carry no letters/digits but must stay in the displayed quote."""
    from backend.pdftext import DocIndex, extract_pdf

    path = tmp_path / "table.pdf"
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "Ours + PT .780 ± .013 .954 ± .001")
    doc.save(path)
    doc.close()
    m = DocIndex(extract_pdf(path)["pages"]).locate("Ours + PT .780 ± .013 .954 ± .001", 1)
    assert m and m["text"] == "Ours + PT .780 ± .013 .954 ± .001"


def test_accept_all_and_undo(client: TestClient):
    d = _run(client, FAKE_EXTRACTION)  # make sure there are pending suggestions, incl. problematic ones
    live = {r["id"] for r in d["records"] if not r["deleted"]}
    pending = {v["id"] for v in d["values"] if v["review_state"] == "pending" and v["status"] and v["in_template"] and v["record_id"] in live}
    assert pending, "fixture should leave pending suggestions"
    wrong_row = _value(d, "results", "value", "ResNet-34 on CardioNet")
    reviewed_before = {v["id"]: v["review_state"] for v in d["values"] if v["review_state"] != "pending"}

    res = client.post("/api/extraction/papers/P003/accept-all").json()
    assert set(res["value_ids"]) == pending and res["accepted"] == len(pending)
    after = client.get("/api/extraction/papers/P003").json()
    assert not any(v["review_state"] == "pending" and v["id"] in pending for v in after["values"])
    assert _value(after, "results", "value", "ResNet-34 on CardioNet")["review_state"] == "accepted"  # includes mismatched evidence
    assert all(v["review_state"] == reviewed_before[v["id"]] for v in after["values"] if v["id"] in reviewed_before)  # others untouched

    # a value edited after the bulk accept is not reverted by undo
    client.patch(f"/api/extraction/values/{wrong_row['id']}", json={"action": "edit", "value": 0.881})
    undo = client.post("/api/extraction/papers/P003/undo-accept", json={"value_ids": res["value_ids"]}).json()
    assert undo["reverted"] == len(pending) - 1
    final = client.get("/api/extraction/papers/P003").json()
    assert _value(final, "results", "value", "ResNet-34 on CardioNet")["review_state"] == "edited"
    assert sum(1 for v in final["values"] if v["id"] in pending and v["review_state"] == "pending") == len(pending) - 1
