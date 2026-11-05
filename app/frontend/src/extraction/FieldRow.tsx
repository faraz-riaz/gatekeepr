import { useMutation } from "@tanstack/react-query";
import { Check, CircleAlert, Ellipsis, Eye, EyeOff, Highlighter, Info, Pencil, RotateCcw, Sparkles, Trash, TriangleAlert, User, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, Menu, MenuItem, MenuSeparator, Segmented, Tip } from "../components/ui";
import { cx } from "../lib/format";
import { useUi } from "../store";
import { xapi } from "./api";
import { displayValue, evidenceState, REVIEW, VALUE_STATUS } from "./format";
import { useValueAction, useXInvalidate } from "./hooks";
import type { ExtractionEvidence, ExtractionRecord, ExtractionValue, ReviewState, TemplateField, TemplateGroup, ValueStatus, ValueTarget } from "./types";

export interface FieldContext {
  paperId: string;
  group: TemplateGroup;
  record: ExtractionRecord | null;
  recordName: string;
  recordLabels: Record<string, string>;
  /** live records per group, for reference fields */
  recordsByGroup: Record<string, { id: string; name: string }[]>;
  /** evidence id -> merged PDF passage id, and passage id -> linked value ids */
  primaryOf: Record<string, string>;
  valuesOf: Record<string, string[]>;
}

const STATE_BAR: Record<ReviewState, string> = {
  pending: "bg-violet-400",
  accepted: "bg-emerald-500",
  edited: "bg-sky-500",
  rejected: "bg-rose-400",
};

const STATE_TEXT: Record<ReviewState, string> = {
  pending: "text-violet-600 dark:text-violet-400",
  accepted: "text-emerald-600 dark:text-emerald-400",
  edited: "text-sky-600 dark:text-sky-400",
  rejected: "text-rose-600 dark:text-rose-400",
};

/** Issues that are already shown as an evidence chip are not repeated as text. */
export function visibleIssues(v: ExtractionValue | undefined): string[] {
  return (v?.issues ?? []).filter((i) => !/No source passage was cited|could not be found in the PDF/.test(i));
}

export function FieldRow({ ctx, field, value }: { ctx: FieldContext; field: TemplateField; value: ExtractionValue | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const activeEvidenceId = useUi((s) => s.activeEvidenceId);
  const focusNonce = useUi((s) => s.focusNonce);
  const activeValueId = useUi((s) => s.activeValueId);
  const set = useUi((s) => s.set);
  const focusEvidence = useUi((s) => s.focusEvidence);
  const [editing, setEditing] = useState(false);
  const action = useValueAction(ctx.paperId);
  const target: ValueTarget = { group_id: ctx.group.id, field_id: field.id, record_id: ctx.record?.id ?? null };

  const live = (value?.evidence ?? []).filter((e) => !e.removed);
  const verified = live.filter((e) => e.verified);
  const isActive = !!value && activeValueId === value.id;
  const ev = evidenceState(value);
  const open = value?.status === "reported" || value?.status === "unclear";
  const issues = value?.review_state === "pending" ? visibleIssues(value) : [];
  const primary = (id: string) => ctx.primaryOf[id] ?? id;

  // A highlight clicked in the PDF selects (and scrolls to) the field that owns the passage.
  useEffect(() => {
    if (!value || !activeEvidenceId) return;
    const linked = ctx.valuesOf[activeEvidenceId] ?? [];
    if (!linked.includes(value.id)) return;
    const cur = useUi.getState().activeValueId;
    if (cur !== value.id && (cur && linked.includes(cur) ? true : linked[0] !== value.id)) return;
    if (cur !== value.id) set({ activeValueId: value.id });
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeEvidenceId, focusNonce]);

  const focus = () => {
    if (!value) return;
    set({ activeValueId: value.id });
    const first = verified.find((e) => e.value_check !== "mismatch") ?? verified[0];
    if (first) focusEvidence(primary(first.id));
  };

  const run = (payload: Parameters<typeof action.mutate>[0]["payload"], msg?: string) =>
    action.mutate({ valueId: value?.id, target, payload }, { onSuccess: () => msg && toast.success(msg) });

  const armEvidence = () => {
    set({ addEvidenceFor: { extraction: { ...target, label: `${field.label}${ctx.group.repeatable ? ` (${ctx.recordName})` : ""}` } } });
    toast.info(`Select the passage in the PDF that reports “${field.label}”.`);
  };

  const shown = displayValue(field, value?.value, ctx.recordLabels);
  const rejected = value?.review_state === "rejected";

  return (
    <div
      ref={ref}
      data-value-id={value?.id}
      onClick={focus}
      className={cx(
        "group/field relative border-t border-line/70 transition-colors first:border-t-0",
        isActive ? "bg-accent-soft/70" : "hover:bg-surface-2/80",
        value && !value.in_template && "opacity-70",
        value ? "cursor-pointer" : "",
      )}
    >
      {value?.status && <span className={cx("absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full", STATE_BAR[value.review_state])} />}
      <div className="grid grid-cols-[minmax(92px,34%)_minmax(0,1fr)] gap-x-3 px-3 py-2">
        {/* label column */}
        <div className="min-w-0">
          <div className="flex items-start gap-1 text-[12px] font-medium leading-snug text-ink-2">
            <span className="break-words">
              {field.label}
              {field.required && (
                <Tip content="Required field">
                  <span className="ml-0.5 text-rose-500">*</span>
                </Tip>
              )}
            </span>
            {(field.description || field.instructions) && (
              <Tip content={[field.description, field.instructions && `Instructions: ${field.instructions}`].filter(Boolean).join(" — ")}>
                <Info size={11} className="mt-[3px] shrink-0 cursor-help text-ink-3" />
              </Tip>
            )}
          </div>
          {value?.status && value.review_state !== "pending" && (
            <Tip content={REVIEW[value.review_state].help}>
              <div className={cx("mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-medium", STATE_TEXT[value.review_state])}>
                {value.origin === "manual" && <User size={9} />}
                {REVIEW[value.review_state].label}
              </div>
            </Tip>
          )}
        </div>

        {/* value column */}
        <div className="min-w-0">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {editing ? null : !value?.status ? (
                <span className="text-[13px] text-ink-3/70">—</span>
              ) : open ? (
                <div className={cx("text-[13.5px] leading-snug text-ink", rejected && "text-ink-3 line-through")}>
                  {shown || <span className="italic text-ink-3">(no value)</span>}
                  {value.unit && <span className="ml-1 text-ink-3">{value.unit}</span>}
                  {value.status === "unclear" && (
                    <span className="ml-1.5 inline-block rounded bg-amber-100 px-1 align-[1px] text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                      unclear
                    </span>
                  )}
                </div>
              ) : (
                <div className={cx("text-[13px] italic text-ink-3", rejected && "line-through")}>{VALUE_STATUS[value.status]}</div>
              )}
            </div>
            {!editing && (
              <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                {value?.review_state === "pending" && value.status && (
                  <>
                    <IconAction label="Accept" kbd="Y" tone="accept" onClick={() => run({ action: "accept" })}>
                      <Check size={13} strokeWidth={2.75} />
                    </IconAction>
                    <IconAction label="Reject this suggestion" tone="reject" onClick={() => run({ action: "reject" })}>
                      <X size={13} strokeWidth={2.75} />
                    </IconAction>
                  </>
                )}
                {/* Secondary actions always occupy their space and only fade in, so nothing shifts under the
                    pointer when a row is hovered (✓ and ✕ stay in the same place). */}
                <div
                  className={cx(
                    "flex items-center gap-0.5 transition-opacity duration-100",
                    isActive || !value?.status ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover/field:opacity-100",
                  )}
                >
                  <IconAction label={value?.status ? "Edit value" : "Enter a value"} onClick={() => setEditing(true)}>
                    <Pencil size={12} />
                  </IconAction>
                  <Menu
                    align="end"
                    trigger={
                      <button className="inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="More actions">
                        <Ellipsis size={14} />
                      </button>
                    }
                  >
                    <MenuItem icon={<Highlighter size={14} />} onSelect={armEvidence}>
                      Attach passage from PDF…
                    </MenuItem>
                    <MenuSeparator />
                    {(["not_reported", "unclear", "not_applicable"] as ValueStatus[]).map((st) => (
                      <MenuItem key={st} onSelect={() => run({ action: "edit", status: st, ...(st === "unclear" ? {} : { value: null }) })}>
                        Mark {VALUE_STATUS[st].toLowerCase()}
                      </MenuItem>
                    ))}
                    {value?.ai && value.review_state === "accepted" && (
                      <MenuItem icon={<RotateCcw size={14} />} onSelect={() => run({ action: "reset" })}>
                        Undo confirmation
                      </MenuItem>
                    )}
                    {value?.ai && (value.review_state === "edited" || value.review_state === "rejected") && (
                      <MenuItem icon={<Sparkles size={14} />} onSelect={() => run({ action: "reset" })}>
                        Restore AI suggestion
                      </MenuItem>
                    )}
                  </Menu>
                </div>
              </div>
            )}
          </div>

          {!editing && (
            <>
              {value?.context && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{value.context}</div>}
              {value?.note && <div className="mt-0.5 text-[11.5px] italic leading-snug text-ink-3">Note: {value.note}</div>}
              {(live.length > 0 || (open && !rejected && ev === "none")) && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {live.map((e) => (
                    <EvidenceChip
                      key={e.id}
                      e={e}
                      active={isActive && primary(e.id) === activeEvidenceId}
                      onClick={() => {
                        set({ activeValueId: value!.id });
                        if (e.verified) focusEvidence(primary(e.id));
                      }}
                    />
                  ))}
                  {open && !rejected && ev === "none" && (
                    <span className="inline-flex h-[18px] items-center gap-1 rounded border border-dashed border-amber-400/70 px-1.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
                      <CircleAlert size={10} /> no source
                    </span>
                  )}
                </div>
              )}
              {issues.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {issues.map((i) => (
                    <li key={i} className="flex gap-1 text-[11.5px] leading-snug text-amber-700 dark:text-amber-300">
                      <TriangleAlert size={11} className="mt-0.5 shrink-0" /> {i}
                    </li>
                  ))}
                </ul>
              )}
              {value?.conflict && (
                <div className="mt-1.5 rounded-md border border-violet-300/60 bg-violet-50 px-2 py-1.5 text-[12px] dark:border-violet-500/30 dark:bg-violet-500/10" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-start gap-1.5 text-ink-2">
                    <Sparkles size={12} className="mt-0.5 shrink-0 text-violet-500" />
                    <span>
                      A newer AI run suggests{" "}
                      <span className="font-medium text-ink">
                        {value.conflict.status === "reported" || value.conflict.status === "unclear"
                          ? `${displayValue(field, value.conflict.value, ctx.recordLabels)}${value.conflict.unit ? ` ${value.conflict.unit}` : ""}`
                          : VALUE_STATUS[value.conflict.status]}
                      </span>
                      . Your reviewed value was kept.
                    </span>
                  </div>
                  <div className="mt-1 flex gap-1.5 pl-[18px]">
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11.5px]" onClick={() => run({ action: "use_conflict" }, "Using the new suggestion — review it")}>
                      Use suggestion
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11.5px]" onClick={() => run({ action: "dismiss_conflict" })}>
                      Keep mine
                    </Button>
                  </div>
                </div>
              )}
              {value && !value.in_template && <p className="mt-1 text-[11px] text-ink-3">No longer in the template; kept and exported in the long-format file.</p>}
            </>
          )}
        </div>
      </div>

      {editing && (
        <div className="border-t border-line/70 bg-surface-2/60 px-3 pb-3 pt-1" onClick={(e) => e.stopPropagation()}>
          <ValueEditor
            ctx={ctx}
            field={field}
            value={value}
            saving={action.isPending}
            onCancel={() => setEditing(false)}
            onSave={(payload) => action.mutate({ valueId: value?.id, target, payload: { action: "edit", ...payload } }, { onSuccess: () => setEditing(false) })}
          />
        </div>
      )}
      {isActive && value && !editing && value.evidence.length > 0 && (
        <div className="px-3 pb-2.5">
          <EvidenceList value={value} paperId={ctx.paperId} primaryOf={ctx.primaryOf} />
        </div>
      )}
    </div>
  );
}

function IconAction({ children, onClick, label, tone, kbd }: { children: ReactNode; onClick: () => void; label: string; tone?: "accept" | "reject"; kbd?: string }) {
  return (
    <Tip content={label} kbd={kbd}>
      <button
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={cx(
          "inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors",
          tone === "accept" && "text-emerald-600 ring-1 ring-inset ring-emerald-500/35 hover:bg-emerald-600 hover:text-white dark:text-emerald-400",
          tone === "reject" && "text-rose-600 ring-1 ring-inset ring-rose-400/35 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10",
          !tone && "text-ink-3 hover:bg-surface-3 hover:text-ink",
        )}
      >
        {children}
      </button>
    </Tip>
  );
}

function EvidenceChip({ e, active, onClick }: { e: ExtractionEvidence; active: boolean; onClick: () => void }) {
  const mismatch = e.verified && e.value_check === "mismatch";
  const cls = !e.verified
    ? "border border-dashed border-line-strong text-ink-3"
    : mismatch
      ? "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-400/40 dark:bg-rose-500/10 dark:text-rose-300"
      : "bg-yellow-100 text-yellow-900 ring-1 ring-inset ring-yellow-500/40 dark:bg-yellow-400/10 dark:text-yellow-200 dark:ring-yellow-400/30";
  const tip = !e.verified
    ? `Unverified: this quotation could not be found in the PDF, so it cannot be highlighted. “${e.quote}”`
    : mismatch
      ? `The extracted value does not appear in this passage — check that the right row/column was used. “${e.quote}”`
      : `“${e.quote}”`;
  return (
    <Tip content={<span className="line-clamp-6">{tip}</span>}>
      <button
        onClick={(ev) => {
          ev.stopPropagation();
          onClick();
        }}
        className={cx("inline-flex h-[18px] items-center gap-1 rounded px-1.5 text-[10.5px] font-medium tabular-nums", cls, active && "outline outline-2 outline-offset-1 outline-accent")}
      >
        {!e.verified ? <TriangleAlert size={10} className="text-amber-500" /> : mismatch ? <span className="font-bold">≠</span> : <Check size={10} strokeWidth={3} />}
        {e.page ? `p.${e.page}` : "?"}
        {!e.verified && " unverified"}
        {e.origin === "manual" && <User size={9} />}
      </button>
    </Tip>
  );
}

function EvidenceList({ value, paperId, primaryOf }: { value: ExtractionValue; paperId: string; primaryOf: Record<string, string> }) {
  const invalidate = useXInvalidate();
  const focusEvidence = useUi((s) => s.focusEvidence);
  const [showRemoved, setShowRemoved] = useState(false);
  const remove = useMutation({
    mutationFn: (v: { id: string; removed: boolean }) => xapi.patchEvidence(v.id, v.removed),
    onSuccess: () => invalidate(paperId),
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => xapi.deleteEvidence(id),
    onSuccess: () => invalidate(paperId),
    onError: (e: Error) => toast.error(e.message),
  });
  const items = value.evidence.filter((e) => showRemoved || !e.removed);
  const removedCount = value.evidence.filter((e) => e.removed).length;
  return (
    <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
      {items.map((e) => (
        <div
          key={e.id}
          onClick={() => e.verified && focusEvidence(primaryOf[e.id] ?? e.id)}
          className={cx(
            "group/ev relative rounded-lg border bg-surface py-1.5 pl-3.5 pr-1.5",
            e.verified ? "cursor-pointer border-line hover:border-line-strong" : "border-dashed border-line-strong",
            e.removed && "opacity-50",
          )}
        >
          <span
            className={cx(
              "absolute bottom-1.5 left-1.5 top-1.5 w-[3px] rounded-full",
              !e.verified ? "bg-line-strong" : e.value_check === "mismatch" ? "bg-rose-400" : "bg-yellow-400",
            )}
          />
          <div className="flex items-center gap-1.5 text-[10.5px] text-ink-3">
            <span className="rounded bg-surface-3 px-1 font-medium tabular-nums text-ink-2">p. {e.page ?? "?"}</span>
            <span>{e.origin === "manual" ? "Added by reviewer" : e.verified ? "AI · verified in PDF" : "AI · not found in PDF"}</span>
            {e.match_method === "fuzzy" && e.match_score != null && <span>· ≈{Math.round(e.match_score * 100)}%</span>}
            {e.value_check === "mismatch" && <span className="text-rose-600 dark:text-rose-400">· value not in passage</span>}
            {e.removed && <span>· removed</span>}
            <div className="ml-auto flex opacity-0 transition-opacity group-hover/ev:opacity-100">
              <Tip content={e.removed ? "Restore" : "Remove this passage (incorrect evidence)"}>
                <button className="rounded p-0.5 text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={(ev) => (ev.stopPropagation(), remove.mutate({ id: e.id, removed: !e.removed }))}>
                  {e.removed ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
              </Tip>
              {e.origin === "manual" && (
                <Tip content="Delete">
                  <button className="rounded p-0.5 text-ink-3 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10" onClick={(ev) => (ev.stopPropagation(), del.mutate(e.id))}>
                    <Trash size={12} />
                  </button>
                </Tip>
              )}
            </div>
          </div>
          <blockquote className="quote mt-0.5 text-[12.5px] text-ink">“{e.quote}”</blockquote>
        </div>
      ))}
      {removedCount > 0 && (
        <button className="text-[11px] text-ink-3 hover:text-ink" onClick={() => setShowRemoved((x) => !x)}>
          {showRemoved ? "Hide" : "Show"} {removedCount} removed passage{removedCount > 1 ? "s" : ""}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ editor

function initialText(field: TemplateField, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return field.type === "reference" ? "" : v.join("; ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

function ValueEditor({
  ctx,
  field,
  value,
  saving,
  onSave,
  onCancel,
}: {
  ctx: FieldContext;
  field: TemplateField;
  value: ExtractionValue | undefined;
  saving: boolean;
  onSave: (p: { status: ValueStatus; value?: unknown; unit?: string; context?: string; note?: string }) => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<ValueStatus>(value?.status && value.review_state !== "rejected" ? value.status : "reported");
  const [text, setText] = useState(initialText(field, value?.value));
  const [multi, setMulti] = useState<string[]>(Array.isArray(value?.value) ? (value!.value as string[]).map(String) : []);
  const [unit, setUnit] = useState(value?.unit || field.unit || "");
  const [context, setContext] = useState(value?.context ?? "");
  const [note, setNote] = useState(value?.note ?? "");
  const hasValue = status === "reported" || status === "unclear";
  const options = field.options;
  const otherSelected = field.type === "categorical" && text !== "" && !options.includes(text);
  const [other, setOther] = useState(otherSelected);

  const submit = () => {
    if (!hasValue) return onSave({ status, value: null, context, note });
    let v: unknown = text.trim();
    if (field.type === "multi_categorical" || field.type === "reference") v = multi;
    if (field.type === "boolean") v = text === "yes" ? true : text === "no" ? false : "";
    onSave({ status, value: v, unit: field.type === "number" || field.type === "integer" ? unit : undefined, context, note });
  };

  const input = "w-full rounded-md border border-line bg-surface px-2 py-1 text-[13px] text-ink focus:border-accent focus:outline-none";
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) submit();
  };

  return (
    <div className="mt-1.5 space-y-2" onClick={(e) => e.stopPropagation()} onKeyDown={keys}>
      <Segmented
        value={status}
        onChange={setStatus}
        options={[
          { value: "reported", label: "Reported" },
          { value: "unclear", label: "Unclear" },
          { value: "not_reported", label: "Not reported" },
          { value: "not_applicable", label: "N/A" },
        ]}
      />
      {hasValue && (
        <>
          {(field.type === "text" || field.type === "date") && (
            <input autoFocus className={input} value={text} onChange={(e) => setText(e.target.value)} placeholder={field.type === "date" ? "YYYY, YYYY-MM or YYYY-MM-DD" : ""} />
          )}
          {field.type === "long_text" && <textarea autoFocus rows={3} className={input} value={text} onChange={(e) => setText(e.target.value)} />}
          {(field.type === "number" || field.type === "integer") && (
            <div className="flex gap-2">
              <input autoFocus inputMode="decimal" className={cx(input, "flex-1 tabular-nums")} value={text} onChange={(e) => setText(e.target.value)} placeholder="Value as reported" />
              <input className={cx(input, "w-24")} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit" />
            </div>
          )}
          {field.type === "boolean" && (
            <Segmented value={(text || "unset") as string} onChange={setText} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
          )}
          {field.type === "categorical" && (
            <div className="space-y-1.5">
              <select
                autoFocus
                className={input}
                value={other ? "__other__" : text}
                onChange={(e) => {
                  if (e.target.value === "__other__") {
                    setOther(true);
                    setText("");
                  } else {
                    setOther(false);
                    setText(e.target.value);
                  }
                }}
              >
                <option value="">Choose…</option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
                {field.allow_other && <option value="__other__">Other (as reported)…</option>}
              </select>
              {other && <input className={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Value as reported" />}
            </div>
          )}
          {field.type === "multi_categorical" && (
            <div className="flex flex-wrap gap-1.5">
              {[...options, ...multi.filter((m) => !options.includes(m))].map((o) => (
                <label key={o} className={cx("flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[12px] ring-1 ring-inset", multi.includes(o) ? "bg-accent-soft text-ink ring-accent/40" : "text-ink-2 ring-line")}>
                  <input type="checkbox" className="accent-[var(--accent)]" checked={multi.includes(o)} onChange={(e) => setMulti(e.target.checked ? [...multi, o] : multi.filter((x) => x !== o))} />
                  {o}
                </label>
              ))}
              {field.allow_other && (
                <input
                  className={cx(input, "w-40")}
                  placeholder="Other… (Enter)"
                  onKeyDown={(e) => {
                    const t = (e.target as HTMLInputElement).value.trim();
                    if (e.key === "Enter" && t) {
                      e.stopPropagation();
                      setMulti([...multi, t]);
                      (e.target as HTMLInputElement).value = "";
                    }
                  }}
                />
              )}
            </div>
          )}
          {field.type === "reference" && (
            <div className="flex flex-wrap gap-1.5">
              {(ctx.recordsByGroup[field.target_group] ?? []).map((r) => (
                <label key={r.id} className={cx("flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[12px] ring-1 ring-inset", multi.includes(r.id) ? "bg-accent-soft text-ink ring-accent/40" : "text-ink-2 ring-line")}>
                  <input
                    type={field.multiple ? "checkbox" : "radio"}
                    name={`ref-${field.id}-${ctx.record?.id}`}
                    checked={multi.includes(r.id)}
                    onChange={(e) => setMulti(field.multiple ? (e.target.checked ? [...multi, r.id] : multi.filter((x) => x !== r.id)) : [r.id])}
                  />
                  {r.name}
                </label>
              ))}
              {!(ctx.recordsByGroup[field.target_group] ?? []).length && <span className="text-[12px] text-ink-3">Add a record to “{field.target_group}” first.</span>}
            </div>
          )}
          <input className={cx(input, "text-[12px]")} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Context: subgroup, dataset, model, metric, setting, table row/column…" />
        </>
      )}
      <input className={cx(input, "text-[12px]")} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={saving}>
          Save
        </Button>
      </div>
    </div>
  );
}
