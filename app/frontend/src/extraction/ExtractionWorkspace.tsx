import { useMutation } from "@tanstack/react-query";
import { Check, FileCog, FileText, Sparkles, Table2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DocumentViewer, MissingPdf } from "../components/PdfViewer";
import { Button, Modal, Spinner } from "../components/ui";
import { useUi } from "../store";
import { xapi } from "./api";
import { recordName } from "./format";
import { buildExtractionHighlights } from "./highlights";
import { useTemplate, useXInvalidate, useXPaper, useXPapers } from "./hooks";

export function ExtractionWorkspace({ onOpenTemplate }: { onOpenTemplate: () => void }) {
  const id = useUi((s) => s.xSelectedId);
  const armed = useUi((s) => s.addEvidenceFor?.extraction?.label);
  const { data: tpl, isLoading: tplLoading } = useTemplate();
  const { data: detail, isLoading, error } = useXPaper(tpl?.active ? id : null);
  const template = tpl?.active?.template;
  const activeValueId = useUi((s) => s.activeValueId);
  const focusOnly = useUi((s) => s.xFocusHighlights);
  const highlights = useMemo(
    () => (detail && template ? buildExtractionHighlights(detail, template, activeValueId, focusOnly).highlights : []),
    [detail, template, activeValueId, focusOnly],
  );

  if (tplLoading) return <Centered>Loading…</Centered>;
  if (!template) return <SetupHero onOpenTemplate={onOpenTemplate} />;
  if (!id) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-viewer text-ink-3">
        <FileText size={28} />
        <div className="text-[13px]">Select an included paper to start extracting.</div>
      </div>
    );
  }
  if (error) return <Centered>Could not load paper: {(error as Error).message}</Centered>;
  if (isLoading || !detail || detail.paper.paper_id !== id) return <Centered>Loading…</Centered>;
  if (!detail.paper.pdf_available) return <MissingPdf detail={{ paper: { ...detail.paper } }} stage="extraction" />;
  return <DocumentViewer paperId={detail.paper.paper_id} text={detail.text} highlights={highlights} variant="extraction" armedLabel={armed ? `for “${armed}”` : ""} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 bg-viewer text-ink-3">
      <Spinner /> {children}
    </div>
  );
}

function SetupHero({ onOpenTemplate }: { onOpenTemplate: () => void }) {
  const { data } = useXPapers();
  const included = data?.papers.filter((p) => p.eligible).length ?? 0;
  const steps = [
    { icon: <Check size={14} />, title: "Screening", text: `${included} paper${included === 1 ? "" : "s"} with a final Include decision`, done: included > 0 },
    { icon: <FileCog size={14} />, title: "Define the extraction template", text: "Groups, typed fields, repeatable records and links between them", current: true },
    { icon: <Sparkles size={14} />, title: "Extract and verify", text: "AI suggestions with highlighted source passages, or manual entry" },
    { icon: <Table2 size={14} />, title: "Export", text: "Study-level and relational CSV files, long format, provenance and JSON" },
  ];
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-viewer p-8">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-7 shadow-xl">
        <h2 className="text-[18px] font-semibold tracking-tight">Data extraction</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">Extraction follows screening: only papers you included are extracted. Start by describing what to collect from each paper.</p>
        <ol className="mt-5 space-y-3">
          {steps.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span
                className={
                  s.done
                    ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white"
                    : s.current
                      ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-white"
                      : "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-ink-3"
                }
              >
                {s.done ? <Check size={14} strokeWidth={3} /> : i + 1}
              </span>
              <div>
                <div className="text-[13px] font-medium text-ink">{s.title}</div>
                <div className="text-[12px] text-ink-3">{s.text}</div>
              </div>
            </li>
          ))}
        </ol>
        <Button variant="primary" className="mt-6" onClick={onOpenTemplate}>
          <FileCog size={14} /> Set up extraction template
        </Button>
      </div>
    </div>
  );
}

/** Attach a PDF text selection to an extracted field (pre-targeted from a field, or chosen here). */
export function AttachEvidenceDialog() {
  const sel = useUi((s) => s.pendingSelection);
  const target = useUi((s) => s.addEvidenceFor);
  const paperId = useUi((s) => s.xSelectedId);
  const set = useUi((s) => s.set);
  const focus = useUi((s) => s.focusEvidence);
  const { data: tpl } = useTemplate();
  const { data: detail } = useXPaper(paperId);
  const invalidate = useXInvalidate();
  const open = !!(sel && target && paperId && tpl?.active);
  const template = tpl?.active?.template;
  const preset = target?.extraction;

  const [groupId, setGroupId] = useState("");
  const [recordId, setRecordId] = useState("");
  const [fieldId, setFieldId] = useState("");
  useEffect(() => {
    if (open) {
      setGroupId(preset?.group_id ?? template?.groups[0]?.id ?? "");
      setRecordId(preset?.record_id ?? "");
      setFieldId(preset?.field_id ?? "");
    }
  }, [open, preset, template]);

  const group = template?.groups.find((g) => g.id === groupId);
  const records = (detail?.records ?? []).filter((r) => r.group_id === groupId && !r.deleted);
  const attach = useMutation({
    mutationFn: () =>
      xapi.addEvidence(
        paperId!,
        { group_id: groupId, field_id: fieldId, record_id: group?.repeatable ? recordId : records[0]?.id ?? null },
        { quote: sel!.text, page: sel!.page, selection_rects: sel!.rects },
      ),
    onSuccess: (e) => {
      invalidate(paperId);
      set({ pendingSelection: null, addEvidenceFor: null, activeValueId: e.value_id });
      window.getSelection()?.removeAllRanges();
      toast.success(e.value_check === "mismatch" ? "Passage attached — note: the current value does not appear in it" : `Passage attached (p. ${e.page})`);
      setTimeout(() => focus(e.id), 300);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const ready = groupId && fieldId && (!group?.repeatable || recordId);

  return (
    <Modal open={open} onOpenChange={(v) => !v && set({ addEvidenceFor: null })} title="Attach source passage" description="Link the selected text to an extracted field. It is located in the PDF and highlighted." width="max-w-lg">
      {sel && template && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) attach.mutate();
          }}
        >
          <blockquote className="quote max-h-36 overflow-y-auto rounded-lg border-l-[3px] border-violet-500 bg-surface-2 px-3 py-2 text-ink">
            “{sel.text}”<span className="ml-2 font-sans text-[11px] text-ink-3">p. {sel.page}</span>
          </blockquote>
          {preset ? (
            <p className="text-[13px] text-ink-2">
              Attach to <span className="font-medium text-ink">{preset.label}</span>
            </p>
          ) : (
            <div className="grid gap-3">
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-ink-2">Group</span>
                <select
                  autoFocus
                  value={groupId}
                  onChange={(e) => {
                    setGroupId(e.target.value);
                    setRecordId("");
                    setFieldId("");
                  }}
                  className="h-9 w-full rounded-md border border-line bg-surface px-2 text-[13px]"
                >
                  {template.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </label>
              {group?.repeatable && (
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-ink-2">{group.record_label || "Record"}</span>
                  <select value={recordId} onChange={(e) => setRecordId(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-[13px]">
                    <option value="" disabled>
                      Choose…
                    </option>
                    {records.map((r, i) => (
                      <option key={r.id} value={r.id}>
                        {recordName(r, group, i + 1)}
                      </option>
                    ))}
                  </select>
                  {!records.length && <span className="mt-1 block text-[11.5px] text-ink-3">Add a {group.record_label || "record"} in the panel first.</span>}
                </label>
              )}
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-ink-2">Field</span>
                <select value={fieldId} onChange={(e) => setFieldId(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-[13px]">
                  <option value="" disabled>
                    Choose a field…
                  </option>
                  {group?.fields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => set({ addEvidenceFor: null })}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!ready || attach.isPending} autoFocus={!!preset}>
              Attach passage
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
