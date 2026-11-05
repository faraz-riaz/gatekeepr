"""Data-extraction templates: model, validation, import (JSON / Excel / CSV), export and diffs.

A template is a list of *groups*. Each group holds typed *fields* and is either single
(one record per paper, e.g. "Study characteristics") or *repeatable* (any number of records
per paper, e.g. datasets, models, outcomes). Relationships between repeated records are
expressed with ``reference`` fields that point to records of another repeatable group
(e.g. a result row references the dataset and the model it belongs to).

Templates are stored as immutable versions. Values are keyed by (group id, field id), so
renaming labels or adding fields never touches existing data; removed fields are kept as
archived values and reported in the change preview.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

FieldType = Literal["text", "long_text", "number", "integer", "categorical", "multi_categorical", "date", "boolean", "reference"]
FIELD_TYPES: tuple[str, ...] = FieldType.__args__  # type: ignore[attr-defined]
ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

TYPE_ALIASES = {
    "string": "text", "str": "text", "short_text": "text", "free_text": "text", "char": "text", "varchar": "text",
    "textarea": "long_text", "paragraph": "long_text", "longtext": "long_text", "long text": "long_text", "narrative": "long_text",
    "float": "number", "numeric": "number", "decimal": "number", "double": "number", "continuous": "number", "real": "number",
    "int": "integer", "count": "integer", "whole number": "integer",
    "enum": "categorical", "select": "categorical", "category": "categorical", "choice": "categorical", "single choice": "categorical",
    "dropdown": "categorical", "factor": "categorical", "single_select": "categorical", "nominal": "categorical", "ordinal": "categorical",
    "multiselect": "multi_categorical", "multi_select": "multi_categorical", "multiple choice": "multi_categorical",
    "multi": "multi_categorical", "checkbox": "multi_categorical", "checkboxes": "multi_categorical", "list": "multi_categorical",
    "bool": "boolean", "yes/no": "boolean", "y/n": "boolean", "binary": "boolean", "logical": "boolean",
    "datetime": "date", "year": "date",
    "ref": "reference", "link": "reference", "relation": "reference", "foreign_key": "reference", "fk": "reference",
}


def slugify(s: str, fallback: str = "field") -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (s or "").strip().lower()).strip("_")
    if not s:
        s = fallback
    if not s[0].isalpha():
        s = f"{fallback}_{s}"
    return s[:64]


class TemplateField(BaseModel):
    id: str
    label: str
    type: FieldType = "text"
    description: str = ""
    instructions: str = ""
    required: bool = False
    options: list[str] = Field(default_factory=list)
    allow_other: bool = False
    unit: str = ""
    target_group: str = ""
    multiple: bool = False
    examples: list[str] = Field(default_factory=list)

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not ID_RE.match(v):
            raise ValueError(f"field id '{v}' must be lowercase letters, digits and underscores, starting with a letter")
        return v

    @model_validator(mode="after")
    def _type_rules(self) -> "TemplateField":
        self.options = [o.strip() for o in self.options if o and o.strip()]
        if len(set(o.lower() for o in self.options)) != len(self.options):
            raise ValueError(f"field '{self.id}' has duplicate options")
        if self.type in ("categorical", "multi_categorical") and not self.options and not self.allow_other:
            raise ValueError(f"categorical field '{self.id}' needs options (or allow_other)")
        if self.type == "reference" and not self.target_group:
            raise ValueError(f"reference field '{self.id}' needs a target_group")
        if self.type == "multi_categorical":
            self.multiple = True
        return self


class TemplateGroup(BaseModel):
    id: str
    label: str
    description: str = ""
    instructions: str = ""
    repeatable: bool = False
    record_label: str = ""
    fields: list[TemplateField]

    @field_validator("id")
    @classmethod
    def _id(cls, v: str) -> str:
        if not ID_RE.match(v):
            raise ValueError(f"group id '{v}' must be lowercase letters, digits and underscores, starting with a letter")
        return v

    @model_validator(mode="after")
    def _unique(self) -> "TemplateGroup":
        ids = [f.id for f in self.fields]
        dup = {i for i in ids if ids.count(i) > 1}
        if dup:
            raise ValueError(f"group '{self.id}' has duplicate field ids: {', '.join(sorted(dup))}")
        if not self.fields:
            raise ValueError(f"group '{self.id}' has no fields")
        return self


class Template(BaseModel):
    schema_version: Literal[1] = 1
    title: str = "Data extraction template"
    description: str = ""
    instructions: str = ""
    groups: list[TemplateGroup]

    @model_validator(mode="after")
    def _relations(self) -> "Template":
        if not self.groups:
            raise ValueError("the template has no groups")
        ids = [g.id for g in self.groups]
        dup = {i for i in ids if ids.count(i) > 1}
        if dup:
            raise ValueError(f"duplicate group ids: {', '.join(sorted(dup))}")
        repeatable = {g.id for g in self.groups if g.repeatable}
        for g in self.groups:
            for f in g.fields:
                if f.type == "reference" and f.target_group not in repeatable:
                    raise ValueError(f"reference field '{g.id}.{f.id}' must target a repeatable group (got '{f.target_group}')")
        return self


def validate_template(data: dict[str, Any]) -> dict[str, Any]:
    """Validate and return the canonical template dict. Raises ValueError with readable messages."""
    try:
        return Template.model_validate(data).model_dump()
    except ValidationError as e:
        msgs = []
        for err in e.errors()[:12]:
            loc = ".".join(str(x) for x in err["loc"])
            msgs.append(f"{loc}: {err['msg']}" if loc else err["msg"])
        raise ValueError("; ".join(m.replace("Value error, ", "") for m in msgs)) from None


def template_hash(t: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(t, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def field_map(t: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    return {(g["id"], f["id"]): f for g in t["groups"] for f in g["fields"]}


def group_map(t: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {g["id"]: g for g in t["groups"]}


# ---------------------------------------------------------------- tolerant normalisation

def _truthy(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    s = str(v or "").strip().lower()
    return s in {"1", "y", "yes", "true", "required", "mandatory", "x", "✓", "repeatable", "multiple", "many"}


def _split_options(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    s = str(v).strip()
    if not s:
        return []
    for sep in ("\n", ";", "|"):
        if sep in s:
            return [p.strip() for p in s.split(sep) if p.strip()]
    return [p.strip() for p in s.split(",") if p.strip()]


def _norm_type(v: Any, has_options: bool) -> tuple[str, list[str]]:
    warnings: list[str] = []
    s = str(v or "").strip().lower()
    if not s:
        return ("categorical" if has_options else "text"), warnings
    if s in FIELD_TYPES:
        return s, warnings
    if s in TYPE_ALIASES:
        return TYPE_ALIASES[s], warnings
    for alias, canon in TYPE_ALIASES.items():
        if alias in s:
            return canon, warnings
    warnings.append(f"unknown field type '{v}' treated as text")
    return "text", warnings


def _normalise_field(raw: dict[str, Any], used: set[str], warnings: list[str], where: str) -> dict[str, Any]:
    r = {str(k).strip().lower(): v for k, v in raw.items()}
    label = str(r.get("label") or r.get("name") or r.get("field") or r.get("title") or r.get("id") or "").strip()
    fid = str(r.get("id") or r.get("key") or "").strip()
    fid = fid if ID_RE.match(fid) else slugify(fid or label)
    base, n = fid, 2
    while fid in used:
        fid = f"{base}_{n}"
        n += 1
    used.add(fid)
    options = _split_options(r.get("options") or r.get("choices") or r.get("values") or r.get("allowed_values") or r.get("categories"))
    ftype, tw = _norm_type(r.get("type") or r.get("data_type") or r.get("datatype"), bool(options))
    warnings.extend(f"{where}.{fid}: {w}" for w in tw)
    target = r.get("target_group") or r.get("references") or r.get("target")
    allow_other = _truthy(r.get("allow_other")) or any(o.lower() in {"other", "other (specify)"} for o in options)
    if ftype in ("categorical", "multi_categorical") and not options:
        allow_other = True
        warnings.append(f"{where}.{fid}: categorical field without options accepts free text")
    return {
        "id": fid,
        "label": label or fid,
        "type": ftype,
        "description": str(r.get("description") or r.get("definition") or "").strip(),
        "instructions": str(r.get("instructions") or r.get("guidance") or r.get("ai_instructions") or r.get("prompt") or "").strip(),
        "required": _truthy(r.get("required")) or str(r.get("optional", "")).strip().lower() in {"no", "n", "false"},
        "options": options,
        "allow_other": allow_other,
        "unit": str(r.get("unit") or r.get("units") or "").strip(),
        "target_group": slugify(str(target), "group") if target else "",
        "multiple": _truthy(r.get("multiple")) or ftype == "multi_categorical",
        "examples": _split_options(r.get("examples") or r.get("example")),
    }


def normalise_template(data: Any) -> tuple[dict[str, Any], list[str]]:
    """Accept the canonical format and common looser variants; return (template, warnings)."""
    warnings: list[str] = []
    if isinstance(data, list):
        data = {"fields": data}
    if not isinstance(data, dict):
        raise ValueError("template must be a JSON object")
    d = {str(k).lower(): v for k, v in data.items()}
    groups_raw = d.get("groups") or d.get("sections") or d.get("categories")
    if not groups_raw and d.get("fields"):
        groups_raw = [{"id": "study", "label": "Study data", "fields": d["fields"]}]
        warnings.append("flat field list placed in a single group 'study'")
    if not groups_raw:
        raise ValueError("no groups or fields found")
    groups, used_g = [], set()
    for i, g in enumerate(groups_raw):
        if not isinstance(g, dict):
            raise ValueError(f"group {i + 1} is not an object")
        gl = {str(k).lower(): v for k, v in g.items()}
        label = str(gl.get("label") or gl.get("name") or gl.get("title") or gl.get("id") or f"Group {i + 1}").strip()
        gid = str(gl.get("id") or gl.get("key") or "").strip()
        gid = gid if ID_RE.match(gid) else slugify(gid or label, "group")
        base, n = gid, 2
        while gid in used_g:
            gid = f"{base}_{n}"
            n += 1
        used_g.add(gid)
        used_f: set[str] = set()
        fields = [_normalise_field(f if isinstance(f, dict) else {"label": str(f)}, used_f, warnings, gid)
                  for f in (gl.get("fields") or gl.get("items") or gl.get("variables") or [])]
        groups.append({
            "id": gid,
            "label": label,
            "description": str(gl.get("description") or "").strip(),
            "instructions": str(gl.get("instructions") or gl.get("guidance") or "").strip(),
            "repeatable": _truthy(gl.get("repeatable") or gl.get("multiple") or gl.get("repeat")),
            "record_label": str(gl.get("record_label") or gl.get("item_label") or "").strip(),
            "fields": fields,
        })
    # resolve reference targets given as labels
    by_label = {slugify(g["label"], "group"): g["id"] for g in groups}
    for g in groups:
        for f in g["fields"]:
            if f["target_group"] and f["target_group"] not in used_g:
                f["target_group"] = by_label.get(f["target_group"], f["target_group"])
            if f["target_group"] and f["type"] != "reference":
                f["type"] = "reference"
    out = {
        "schema_version": 1,
        "title": str(d.get("title") or d.get("name") or "Data extraction template").strip(),
        "description": str(d.get("description") or "").strip(),
        "instructions": str(d.get("instructions") or d.get("guidance") or "").strip(),
        "groups": groups,
    }
    return validate_template(out), warnings


# ---------------------------------------------------------------- tabular import (Excel / CSV)

COLS = {
    "group": ["group", "section", "category", "domain", "table", "group name", "section name", "sheet"],
    "group_id": ["group id", "group_id", "section id", "group key"],
    "label": ["field", "field name", "label", "item", "variable", "data item", "question", "name", "field label", "data element", "element"],
    "id": ["field id", "field_id", "key", "variable name", "var", "code", "column name", "id"],
    "type": ["type", "data type", "datatype", "field type", "format", "value type"],
    "description": ["description", "definition", "meaning", "explanation", "field description"],
    "instructions": ["instructions", "instruction", "guidance", "ai instructions", "extraction instructions", "how to extract", "notes", "coding notes", "prompt"],
    "required": ["required", "mandatory", "required?", "is required", "obligatory"],
    "options": ["options", "allowed values", "choices", "categories", "values", "response options", "levels", "codes", "allowed responses"],
    "unit": ["unit", "units", "unit of measure"],
    "repeatable": ["repeatable", "multiple records", "repeat", "repeating", "one-to-many", "multiple", "repeatable group", "per record"],
    "record_label": ["record label", "record name", "entity", "item label"],
    "target_group": ["references", "reference", "links to", "link to", "target group", "relates to", "related group"],
    "examples": ["example", "examples", "example value"],
    "allow_other": ["allow other", "allow_other", "other allowed", "free text allowed", "allow free text"],
}


def _match_header(headers: list[str]) -> dict[str, int]:
    hdr = [re.sub(r"\s+", " ", (h or "").strip().lower()) for h in headers]
    found: dict[str, int] = {}
    for key, names in COLS.items():
        for i, h in enumerate(hdr):
            if i in found.values():
                continue
            if h in names:
                found[key] = i
                break
    return found


def _rows_to_template(rows: list[list[Any]], title: str, warnings: list[str]) -> dict[str, Any]:
    rows = [[("" if c is None else c) for c in r] for r in rows if any(str(c or "").strip() for c in r)]
    if not rows:
        raise ValueError("the sheet is empty")
    header_idx, cols = 0, {}
    for i, r in enumerate(rows[:10]):  # header may be preceded by a title row
        c = _match_header([str(x) for x in r])
        if "label" in c and len(c) >= 2:
            header_idx, cols = i, c
            break
    if cols:
        groups: dict[str, dict[str, Any]] = {}
        order: list[str] = []
        current_group = None
        for r in rows[header_idx + 1:]:
            get = lambda k: (r[cols[k]] if k in cols and cols[k] < len(r) else "")  # noqa: E731
            label = str(get("label")).strip()
            gname = str(get("group")).strip() or current_group or "Study data"
            current_group = gname
            if not label:
                continue
            gkey = str(get("group_id")).strip() or gname
            if gkey not in groups:
                groups[gkey] = {"id": str(get("group_id")).strip() or slugify(gname, "group"), "label": gname,
                                "repeatable": False, "record_label": "", "fields": []}
                order.append(gkey)
            g = groups[gkey]
            if _truthy(get("repeatable")):
                g["repeatable"] = True
            if str(get("record_label")).strip():
                g["record_label"] = str(get("record_label")).strip()
            g["fields"].append({k: get(k) for k in ("label", "id", "type", "description", "instructions", "required",
                                                     "options", "unit", "target_group", "examples", "allow_other")})
        return {"title": title, "groups": [groups[k] for k in order]}
    # "Wide" layout: the first row lists the fields as column headers (a blank extraction sheet).
    header = [str(x).strip() for x in rows[0]]
    second = [str(x).strip() for x in rows[1]] if len(rows) > 1 else []
    looks_descriptive = second and sum(len(s.split()) >= 3 for s in second) >= max(1, len([h for h in header if h]) // 3)
    warnings.append("no field/type columns found: each column header was read as a text field")
    fields = [{"label": h, "description": (second[i] if looks_descriptive and i < len(second) else "")}
              for i, h in enumerate(header) if h and h.lower() not in {"paper_id", "paper id", "study id", "id"}]
    return {"title": title, "groups": [{"id": "study", "label": "Study data", "fields": fields}]}


def parse_template_file(filename: str, content: bytes) -> tuple[dict[str, Any], list[str]]:
    """Parse an uploaded template (.json, .xlsx/.xlsm, .csv/.tsv). Returns (template, warnings)."""
    name = (filename or "").lower()
    warnings: list[str] = []
    title = re.sub(r"[_-]+", " ", (filename or "template").rsplit(".", 1)[0]).strip().title() or "Data extraction template"
    if name.endswith(".json"):
        try:
            data = json.loads(content.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"invalid JSON: {e}") from None
        t, w = normalise_template(data)
        return t, warnings + w
    if name.endswith((".xlsx", ".xlsm")):
        try:
            import openpyxl
        except ImportError:  # pragma: no cover
            raise ValueError("Excel import needs the 'openpyxl' package (pip install openpyxl)") from None
        try:
            wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
        except Exception as e:
            raise ValueError(f"could not read the Excel file: {e}") from None
        sheets = {ws.title.strip().lower(): ws for ws in wb.worksheets}
        ws = next((sheets[n] for n in ("fields", "variables", "data items", "codebook", "extraction template", "template") if n in sheets),
                  wb.worksheets[0])
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        raw = _rows_to_template(rows, title, warnings)
        # optional "groups" sheet: Group | Description | Repeatable | Record label | Instructions
        gws = sheets.get("groups") or sheets.get("sections")
        if gws is not None:
            grows = [list(r) for r in gws.iter_rows(values_only=True) if any(r)]
            if grows:
                h = [str(x or "").strip().lower() for x in grows[0]]
                for r in grows[1:]:
                    rec = {h[i]: r[i] for i in range(min(len(h), len(r)))}
                    gname = str(rec.get("group") or rec.get("section") or rec.get("name") or "").strip()
                    for g in raw["groups"]:
                        if g["label"].lower() == gname.lower() or g["id"] == slugify(gname, "group"):
                            g["description"] = str(rec.get("description") or "").strip()
                            g["instructions"] = str(rec.get("instructions") or rec.get("guidance") or "").strip()
                            if _truthy(rec.get("repeatable")):
                                g["repeatable"] = True
                            if rec.get("record label"):
                                g["record_label"] = str(rec["record label"]).strip()
        # optional "template" sheet: key/value rows for title, description and instructions
        tws = sheets.get("template") if ws is not sheets.get("template") else None
        if tws is not None:
            for r in tws.iter_rows(values_only=True):
                if r and r[0] and str(r[0]).strip().lower() in ("title", "description", "instructions"):
                    raw[str(r[0]).strip().lower()] = str(r[1] or "").strip() if len(r) > 1 else ""
        t, w = normalise_template(raw)
        return t, warnings + w
    if name.endswith((".csv", ".tsv", ".txt")):
        text = content.decode("utf-8-sig", errors="replace")
        dialect = csv.excel_tab if name.endswith(".tsv") or text.count("\t") > text.count(",") else csv.excel
        rows = list(csv.reader(io.StringIO(text), dialect))
        t, w = normalise_template(_rows_to_template(rows, title, warnings))
        return t, warnings + w
    raise ValueError("unsupported file type: use .json, .xlsx or .csv")


def template_to_xlsx(t: dict[str, Any]) -> bytes:
    import openpyxl
    from openpyxl.styles import Font, PatternFill

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "fields"
    head = ["Group", "Group ID", "Field", "Field ID", "Type", "Required", "Options", "Allow other", "Unit", "References",
            "Description", "Instructions", "Examples", "Repeatable", "Record label"]
    ws.append(head)
    for c in ws[1]:
        c.font = Font(bold=True)
        c.fill = PatternFill("solid", fgColor="EEF0FB")
    for g in t["groups"]:
        for f in g["fields"]:
            ws.append([g["label"], g["id"], f["label"], f["id"], f["type"], "yes" if f["required"] else "no",
                       "; ".join(f["options"]), "yes" if f["allow_other"] else "no", f["unit"], f["target_group"], f["description"], f["instructions"],
                       "; ".join(f["examples"]), "yes" if g["repeatable"] else "no", g["record_label"]])
    for col, w in zip("ABCDEFGHIJKLMNO", (22, 16, 28, 20, 16, 9, 34, 11, 9, 14, 48, 48, 30, 11, 14)):
        ws.column_dimensions[col].width = w
    ts = wb.create_sheet("template")
    for k in ("title", "description", "instructions"):
        ts.append([k.title(), t.get(k, "")])
    ts.column_dimensions["A"].width = 14
    ts.column_dimensions["B"].width = 90
    gs = wb.create_sheet("groups")
    gs.append(["Group", "Description", "Repeatable", "Record label", "Instructions"])
    for c in gs[1]:
        c.font = Font(bold=True)
    for g in t["groups"]:
        gs.append([g["label"], g["description"], "yes" if g["repeatable"] else "no", g["record_label"], g["instructions"]])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------- diffs

def diff_templates(old: dict[str, Any] | None, new: dict[str, Any]) -> dict[str, Any]:
    """Structural differences keyed by ids (labels/descriptions changes are harmless)."""
    if not old:
        return {"added_groups": [g["id"] for g in new["groups"]], "removed_groups": [], "added_fields": [],
                "removed_fields": [], "changed_fields": [], "repeatable_changed": [], "required_added": []}
    og, ng = group_map(old), group_map(new)
    of, nf = field_map(old), field_map(new)
    changed = []
    for key in of.keys() & nf.keys():
        a, b = of[key], nf[key]
        ch = []
        if a["type"] != b["type"]:
            ch.append(f"type {a['type']} → {b['type']}")
        if a["type"] in ("categorical", "multi_categorical") and set(a["options"]) - set(b["options"]):
            ch.append("options removed: " + ", ".join(sorted(set(a["options"]) - set(b["options"]))))
        if a.get("target_group") != b.get("target_group"):
            ch.append(f"reference target {a.get('target_group') or '—'} → {b.get('target_group') or '—'}")
        if ch:
            changed.append({"group": key[0], "field": key[1], "changes": ch})
    return {
        "added_groups": [g for g in ng if g not in og],
        "removed_groups": [g for g in og if g not in ng],
        "added_fields": [f"{g}.{f}" for (g, f) in nf if (g, f) not in of and g in og],
        "removed_fields": [f"{g}.{f}" for (g, f) in of if (g, f) not in nf and g in ng],
        "changed_fields": changed,
        "repeatable_changed": [g for g in og.keys() & ng.keys() if og[g]["repeatable"] != ng[g]["repeatable"]],
        "required_added": [f"{g}.{f}" for (g, f), fd in nf.items() if fd["required"] and not of.get((g, f), {}).get("required")],
    }
