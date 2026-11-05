import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, FileUp, Layers, Plus, Repeat, Sparkles, Trash, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, IconButton, Menu, MenuItem, Modal, Segmented, Spinner, Switch } from "../components/ui";
import { cx } from "../lib/format";
import { xapi } from "./api";
import { FIELD_TYPE_LABEL } from "./format";
import { useTemplate } from "./hooks";
import type { ExtractionTemplate, FieldType, TemplateField, TemplateGroup, TemplateImpact } from "./types";

const TYPES = Object.keys(FIELD_TYPE_LABEL) as FieldType[];

function slugify(s: string, fallback: string) {
  let out = s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!out) out = fallback;
  if (!/^[a-z]/.test(out)) out = `${fallback}_${out}`;
  return out.slice(0, 64);
}

function unique(base: string, taken: string[]) {
  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}_${n++}`;
  return id;
}

const newField = (taken: string[], label = "New field"): TemplateField => ({
  id: unique(slugify(label, "field"), taken),
  label,
  type: "text",
  description: "",
  instructions: "",
  required: false,
  options: [],
  allow_other: false,
  unit: "",
  target_group: "",
  multiple: false,
  examples: [],
});

const emptyTemplate = (): ExtractionTemplate => ({
  schema_version: 1,
  title: "Data extraction template",
  description: "",
  instructions: "",
  groups: [{ id: "study", label: "Study characteristics", description: "", instructions: "", repeatable: false, record_label: "", fields: [newField([], "Study design")] }],
});

export function TemplateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: tpl } = useTemplate();
  const qc = useQueryClient();
  const active = tpl?.active ?? null;
  const [draft, setDraft] = useState<ExtractionTemplate>(emptyTemplate);
  const [gi, setGi] = useState(0);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [source, setSource] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [review, setReview] = useState<TemplateImpact | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ids that already hold data stay fixed; only new groups/fields get ids derived from their labels
  const savedIds = useMemo(() => {
    const s = new Set<string>();
    for (const g of active?.template.groups ?? []) {
      s.add(g.id);
      for (const f of g.fields) s.add(`${g.id}.${f.id}`);
    }
    return s;
  }, [active]);

  useEffect(() => {
    if (open) {
      setDraft(active ? structuredClone(active.template) : emptyTemplate());
      setGi(0);
      setTab("edit");
      setSource(active?.source_filename ?? null);
      setWarnings([]);
      setReview(null);
      setError("");
    }
  }, [open, active]);

  const group = draft.groups[gi];
  const update = (fn: (t: ExtractionTemplate) => void) => {
    setDraft((d) => {
      const c = structuredClone(d);
      fn(c);
      return c;
    });
    setReview(null);
    setError("");
  };

  const load = (t: ExtractionTemplate, src: string | null, w: string[] = []) => {
    setDraft(t);
    setGi(0);
    setSource(src);
    setWarnings(w);
    setReview(null);
    setError("");
  };

  const onImport = async (file: File) => {
    try {
      const r = await xapi.importTemplate(file);
      load(r.template, r.source_filename, r.warnings);
      toast.success(`Imported ${r.template.groups.length} group(s) from ${file.name} — review and save`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doReview = async () => {
    setBusy(true);
    setError("");
    try {
      setReview(await xapi.previewTemplate(draft));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const saved = await xapi.saveTemplate(draft, source);
      toast.success(`Extraction template saved (version ${saved.version})`);
      qc.invalidateQueries({ queryKey: ["x-template"] });
      qc.invalidateQueries({ queryKey: ["x-papers"] });
      qc.invalidateQueries({ queryKey: ["x-paper"] });
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const repeatableGroups = draft.groups.filter((g) => g.repeatable);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Extraction template"
      description={active ? `Active: version ${active.version}${active.source_filename ? ` · imported from ${active.source_filename}` : ""}` : "Define what to collect from each included paper."}
      width="max-w-6xl"
    >
      <div className="flex min-h-[60vh] flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={tab} onChange={setTab} options={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} />
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              <FileUp size={13} /> Import JSON / Excel / CSV
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.xlsx,.xlsm,.csv,.tsv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onImport(f);
                e.target.value = "";
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                try {
                  load(await xapi.exampleTemplate(), "example template");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <Sparkles size={13} /> Load example
            </Button>
            {active && (
              <Menu
                trigger={
                  <Button size="sm" variant="ghost">
                    <Download size={13} /> Download
                  </Button>
                }
              >
                <MenuItem onSelect={() => (window.location.href = xapi.templateDownloadUrl("json"))}>Active template (JSON)</MenuItem>
                <MenuItem onSelect={() => (window.location.href = xapi.templateDownloadUrl("xlsx"))}>Active template (Excel)</MenuItem>
              </Menu>
            )}
          </div>
        </div>

        {warnings.length > 0 && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <div className="font-medium">Import notes</div>
            <ul className="mt-0.5 list-disc pl-4">
              {warnings.slice(0, 8).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {tab === "edit" ? (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
              <TextInput label="Template title" value={draft.title} onChange={(v) => update((t) => void (t.title = v))} />
              <TextInput label="General instructions for the AI" value={draft.instructions} onChange={(v) => update((t) => void (t.instructions = v))} placeholder="e.g. extract each model and dataset as a separate record" />
            </div>
            <div className="grid min-h-[48vh] gap-4 md:grid-cols-[230px_1fr]">
              {/* groups */}
              <div className="space-y-1">
                <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Groups</div>
                {draft.groups.map((g, i) => (
                  <div
                    key={i}
                    onClick={() => setGi(i)}
                    className={cx("group/g flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px]", i === gi ? "bg-accent-soft text-ink ring-1 ring-accent/25" : "text-ink-2 hover:bg-surface-3")}
                  >
                    {g.repeatable ? <Repeat size={13} className="shrink-0 text-violet-500" /> : <Layers size={13} className="shrink-0 text-ink-3" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{g.label || "Untitled group"}</div>
                      <div className="text-[11px] text-ink-3">
                        {g.fields.length} field{g.fields.length === 1 ? "" : "s"}
                        {g.repeatable && " · repeatable"}
                      </div>
                    </div>
                    <div className="hidden gap-0.5 group-hover/g:flex">
                      <MiniBtn label="Move up" disabled={i === 0} onClick={() => update((t) => void t.groups.splice(i - 1, 0, ...t.groups.splice(i, 1)))}>
                        <ArrowUp size={11} />
                      </MiniBtn>
                      <MiniBtn label="Move down" disabled={i === draft.groups.length - 1} onClick={() => update((t) => void t.groups.splice(i + 1, 0, ...t.groups.splice(i, 1)))}>
                        <ArrowDown size={11} />
                      </MiniBtn>
                    </div>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1 w-full justify-start"
                  onClick={() => {
                    update((t) =>
                      t.groups.push({
                        id: unique("group", t.groups.map((g) => g.id)),
                        label: "New group",
                        description: "",
                        instructions: "",
                        repeatable: false,
                        record_label: "",
                        fields: [newField([])],
                      }),
                    );
                    setGi(draft.groups.length);
                  }}
                >
                  <Plus size={13} /> Add group
                </Button>
              </div>

              {/* group editor */}
              {group ? (
                <GroupEditor
                  key={gi}
                  group={group}
                  savedIds={savedIds}
                  takenGroupIds={draft.groups.filter((_, i) => i !== gi).map((g) => g.id)}
                  repeatableGroups={repeatableGroups.filter((g) => g !== group || group.repeatable)}
                  onChange={(fn) => update((t) => fn(t.groups[gi]))}
                  onDelete={() => {
                    update((t) => void t.groups.splice(gi, 1));
                    setGi(Math.max(0, gi - 1));
                  }}
                />
              ) : (
                <div className="text-[13px] text-ink-3">Add a group to begin.</div>
              )}
            </div>
          </div>
        ) : (
          <TemplatePreview template={draft} />
        )}

        {review && <ReviewChanges review={review} nextVersion={(active?.version ?? 0) + 1} />}
        {error && (
          <div className="flex gap-2 rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800 dark:bg-rose-500/10 dark:text-rose-200">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div className="mt-auto flex items-center justify-end gap-2 border-t border-line pt-3">
          <span className="mr-auto text-[11.5px] text-ink-3">Values are linked to field IDs. Renaming labels is safe; removed fields keep their data as archived values.</span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!review ? (
            <Button variant="primary" onClick={doReview} disabled={busy}>
              {busy && <Spinner size={12} />} Review changes
            </Button>
          ) : (
            <Button variant="primary" onClick={save} disabled={busy || review.unchanged}>
              {busy && <Spinner size={12} />} {review.unchanged ? "No changes" : `Save as version ${(active?.version ?? 0) + 1}`}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ReviewChanges({ review, nextVersion }: { review: TemplateImpact; nextVersion: number }) {
  const d = review.diff;
  const im = review.impact;
  if (review.unchanged) return <div className="rounded-lg bg-surface-3 px-3 py-2 text-[12.5px] text-ink-2">The template is identical to the active version.</div>;
  const lines: ReactNode[] = [];
  if (d.added_groups.length) lines.push(<>New groups: {d.added_groups.join(", ")}</>);
  if (d.added_fields.length) lines.push(<>New fields: {d.added_fields.join(", ")}</>);
  if (d.removed_groups.length) lines.push(<>Removed groups: {d.removed_groups.join(", ")}</>);
  if (d.removed_fields.length) lines.push(<>Removed fields: {d.removed_fields.join(", ")}</>);
  for (const c of d.changed_fields) lines.push(<>{`${c.group}.${c.field}`}: {c.changes.join("; ")}</>);
  if (d.repeatable_changed.length) lines.push(<>Repeatable setting changed: {d.repeatable_changed.join(", ")}</>);
  if (d.required_added.length) lines.push(<>Now required: {d.required_added.join(", ")}</>);
  const risky = im.values_in_removed_fields > 0 || im.values_in_changed_fields > 0 || im.completed_papers > 0;
  return (
    <div className={cx("rounded-lg px-3 py-2.5 text-[12.5px]", risky ? "bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-100" : "bg-surface-3 text-ink-2")}>
      <div className="font-medium">Changes in version {nextVersion}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {risky && (
        <ul className="mt-2 space-y-0.5">
          {im.values_in_removed_fields > 0 && (
            <li>
              ⚠ {im.values_in_removed_fields} existing value(s) in {im.papers_with_removed_values} paper(s) belong to removed fields. They are <b>kept</b> as archived
              values and remain in the long-format and JSON exports.
            </li>
          )}
          {im.values_in_changed_fields > 0 && (
            <li>
              ⚠ {im.values_in_changed_fields} existing value(s) in {im.papers_with_changed_values} paper(s) are in fields whose type, options or links changed. They are
              kept unchanged — re-check them.
            </li>
          )}
          {im.completed_papers > 0 && <li>⚠ {im.completed_papers} completed paper(s) will be flagged “template changed” for re-checking.</li>}
        </ul>
      )}
    </div>
  );
}

function GroupEditor({
  group,
  savedIds,
  takenGroupIds,
  repeatableGroups,
  onChange,
  onDelete,
}: {
  group: TemplateGroup;
  savedIds: Set<string>;
  takenGroupIds: string[];
  repeatableGroups: TemplateGroup[];
  onChange: (fn: (g: TemplateGroup) => void) => void;
  onDelete: () => void;
}) {
  const [openField, setOpenField] = useState<number | null>(null);
  const groupSaved = savedIds.has(group.id);
  return (
    <div className="min-w-0 space-y-3">
      <div className="grid gap-3 rounded-xl border border-line p-3 md:grid-cols-2">
        <TextInput
          label="Group name"
          value={group.label}
          onChange={(v) =>
            onChange((g) => {
              g.label = v;
              if (!groupSaved) g.id = unique(slugify(v, "group"), takenGroupIds);
            })
          }
        />
        <TextInput label="Group ID" mono value={group.id} disabled={groupSaved} hint={groupSaved ? "Fixed: data is stored under this ID" : undefined} onChange={(v) => onChange((g) => void (g.id = slugify(v, "group")))} />
        <div className="flex flex-wrap items-center gap-4 md:col-span-2">
          <Switch id={`rep-${group.id}`} checked={group.repeatable} onChange={(v) => onChange((g) => void (g.repeatable = v))} label="Repeatable — several records per paper (e.g. datasets, arms, outcomes)" />
          {group.repeatable && (
            <TextInput inline label="Record name" value={group.record_label} placeholder="e.g. Dataset" onChange={(v) => onChange((g) => void (g.record_label = v))} />
          )}
        </div>
        <TextInput label="Description" value={group.description} onChange={(v) => onChange((g) => void (g.description = v))} />
        <TextInput label="Instructions for the AI" value={group.instructions} onChange={(v) => onChange((g) => void (g.instructions = v))} />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Fields</span>
          <Button size="sm" variant="danger" onClick={onDelete}>
            <Trash size={12} /> Delete group
          </Button>
        </div>
        {group.fields.map((f, i) => {
          const saved = savedIds.has(`${group.id}.${f.id}`);
          const taken = group.fields.filter((_, j) => j !== i).map((x) => x.id);
          const isOpen = openField === i;
          return (
            <div key={i} className="rounded-lg border border-line bg-surface">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button className="text-ink-3" onClick={() => setOpenField(isOpen ? null : i)} aria-label="Details">
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <input
                  value={f.label}
                  onChange={(e) =>
                    onChange((g) => {
                      g.fields[i].label = e.target.value;
                      if (!saved) g.fields[i].id = unique(slugify(e.target.value, "field"), taken);
                    })
                  }
                  className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-[13px] font-medium text-ink hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
                />
                <select value={f.type} onChange={(e) => onChange((g) => void (g.fields[i].type = e.target.value as FieldType))} className="h-7 rounded-md border border-line bg-surface-2 px-1.5 text-[12px]">
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {FIELD_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-[11.5px] text-ink-2">
                  <input type="checkbox" checked={f.required} onChange={(e) => onChange((g) => void (g.fields[i].required = e.target.checked))} /> Required
                </label>
                <MiniBtn label="Move up" disabled={i === 0} onClick={() => onChange((g) => void g.fields.splice(i - 1, 0, ...g.fields.splice(i, 1)))}>
                  <ArrowUp size={11} />
                </MiniBtn>
                <MiniBtn label="Move down" disabled={i === group.fields.length - 1} onClick={() => onChange((g) => void g.fields.splice(i + 1, 0, ...g.fields.splice(i, 1)))}>
                  <ArrowDown size={11} />
                </MiniBtn>
                <IconButton label="Delete field" className="h-6 w-6" onClick={() => onChange((g) => void g.fields.splice(i, 1))}>
                  <Trash size={12} />
                </IconButton>
              </div>
              {(f.type === "categorical" || f.type === "multi_categorical") && !f.options.length && !f.allow_other && (
                <div className="px-9 pb-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">Add options or allow other values.</div>
              )}
              {f.type === "reference" && !f.target_group && <div className="px-9 pb-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">Choose which repeatable group this links to.</div>}
              {isOpen && (
                <div className="grid gap-3 border-t border-line px-3 py-3 md:grid-cols-2">
                  <TextInput label="Field ID" mono value={f.id} disabled={saved} hint={saved ? "Fixed: data is stored under this ID" : undefined} onChange={(v) => onChange((g) => void (g.fields[i].id = slugify(v, "field")))} />
                  {(f.type === "number" || f.type === "integer") && <TextInput label="Expected unit" value={f.unit} placeholder="e.g. %, years, mg" onChange={(v) => onChange((g) => void (g.fields[i].unit = v))} />}
                  {f.type === "reference" && (
                    <label className="block">
                      <span className="mb-1 block text-[12px] font-medium text-ink-2">Links to group</span>
                      <select value={f.target_group} onChange={(e) => onChange((g) => void (g.fields[i].target_group = e.target.value))} className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]">
                        <option value="">Choose a repeatable group…</option>
                        {repeatableGroups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.label}
                          </option>
                        ))}
                      </select>
                      <label className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-2">
                        <input type="checkbox" checked={f.multiple} onChange={(e) => onChange((g) => void (g.fields[i].multiple = e.target.checked))} /> Allow several linked records
                      </label>
                    </label>
                  )}
                  <TextInput label="Description" value={f.description} onChange={(v) => onChange((g) => void (g.fields[i].description = v))} />
                  <TextInput label="Instructions for the AI" value={f.instructions} onChange={(v) => onChange((g) => void (g.fields[i].instructions = v))} />
                  {(f.type === "categorical" || f.type === "multi_categorical") && (
                    <label className="block md:col-span-2">
                      <span className="mb-1 block text-[12px] font-medium text-ink-2">Options (one per line)</span>
                      <textarea
                        rows={4}
                        value={f.options.join("\n")}
                        onChange={(e) => onChange((g) => void (g.fields[i].options = e.target.value.split("\n")))}
                        onBlur={() => onChange((g) => void (g.fields[i].options = g.fields[i].options.map((o) => o.trim()).filter(Boolean)))}
                        className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] focus:border-accent focus:outline-none"
                      />
                      <label className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-2">
                        <input type="checkbox" checked={f.allow_other} onChange={(e) => onChange((g) => void (g.fields[i].allow_other = e.target.checked))} /> Allow other values (as reported)
                      </label>
                    </label>
                  )}
                  <TextInput label="Examples (separated by ;)" value={f.examples.join("; ")} onChange={(v) => onChange((g) => void (g.fields[i].examples = v.split(";").map((x) => x.trim()).filter(Boolean)))} />
                </div>
              )}
            </div>
          );
        })}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange((g) => void g.fields.push(newField(g.fields.map((x) => x.id))));
            setOpenField(group.fields.length);
          }}
        >
          <Plus size={13} /> Add field
        </Button>
      </div>
    </div>
  );
}

function TemplatePreview({ template }: { template: ExtractionTemplate }) {
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-ink-3">How the extraction form will look for each paper. Repeatable groups show one card per record.</p>
      {template.groups.map((g) => (
        <section key={g.id}>
          <div className="flex items-center gap-2 pb-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{g.label}</h3>
            {g.repeatable && <span className="rounded-full bg-violet-50 px-1.5 text-[10.5px] font-medium text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">repeatable · {g.record_label || "record"}</span>}
          </div>
          {g.description && <p className="pb-1.5 text-[12px] text-ink-3">{g.description}</p>}
          <div className={cx("rounded-xl border border-line bg-surface p-2", g.repeatable && "border-dashed")}>
            {g.repeatable && <div className="mb-1.5 text-[11px] font-medium text-ink-3">{g.record_label || "Record"} 1</div>}
            <div className="grid gap-x-4 gap-y-2 md:grid-cols-2">
              {g.fields.map((f) => (
                <div key={f.id} className="rounded-md px-2 py-1.5">
                  <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
                    {f.label}
                    {f.required && <span className="text-rose-500">*</span>}
                    <span className="rounded bg-surface-3 px-1 text-[10.5px] font-normal text-ink-3">{FIELD_TYPE_LABEL[f.type]}</span>
                    {f.unit && <span className="text-[10.5px] text-ink-3">{f.unit}</span>}
                    {f.type === "reference" && <span className="text-[10.5px] text-violet-600 dark:text-violet-400">→ {template.groups.find((x) => x.id === f.target_group)?.label ?? "?"}</span>}
                  </div>
                  {f.description && <div className="text-[11.5px] text-ink-3">{f.description}</div>}
                  {f.options.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {f.options.map((o) => (
                        <span key={o} className="rounded px-1.5 text-[10.5px] text-ink-2 ring-1 ring-line">
                          {o}
                        </span>
                      ))}
                      {f.allow_other && <span className="text-[10.5px] italic text-ink-3">+ other</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}

function TextInput({
  label,
  value,
  onChange,
  placeholder,
  mono,
  disabled,
  hint,
  inline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  hint?: string;
  inline?: boolean;
}) {
  return (
    <label className={cx(inline ? "flex items-center gap-2" : "block")}>
      <span className={cx("block text-[12px] font-medium text-ink-2", !inline && "mb-1")}>{label}</span>
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none disabled:bg-surface-3 disabled:text-ink-3",
          inline ? "w-40" : "w-full",
          mono && "font-mono text-[12px]",
        )}
      />
      {hint && <span className="mt-0.5 block text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

function MiniBtn({ children, label, onClick, disabled }: { children: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}
