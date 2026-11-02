import { Check, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useCriteria, useDecide } from "../hooks";
import { cx, DECISION_LABEL, decisionTone, fmtDateTime, relTime } from "../lib/format";
import { useUi } from "../store";
import type { Decision, PaperDetail } from "../types";
import { api } from "../api";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Kbd, Switch, Tip } from "./ui";

/** Registered by the mounted decision bar so global shortcuts can record decisions. */
export const decisionControls: { decide?: (d: Decision) => void } = {};

function compatible(decision: Decision, code: string): boolean {
  if (!code) return true;
  if (decision === "include") return /^I/.test(code);
  if (decision === "exclude") return /^[EU]/.test(code);
  return true;
}

export function DecisionBar({ detail }: { detail: PaperDetail }) {
  return <DecisionBarInner key={detail.paper.paper_id} detail={detail} />;
}

function DecisionBarInner({ detail }: { detail: PaperDetail }) {
  const id = detail.paper.paper_id;
  const current = detail.decision;
  const rec = detail.analysis?.recommendation;
  const { data: criteria } = useCriteria();
  const decide = useDecide();
  const qc = useQueryClient();
  const autoAdvance = useUi((s) => s.autoAdvance);
  const set = useUi((s) => s.set);
  const [code, setCode] = useState<string>(current?.code ?? "");
  const [reason, setReason] = useState<string>(current?.reason ?? "");
  const [codeTouched, setCodeTouched] = useState(!!current?.code);

  const routes = criteria?.inclusion.flatMap((c) => (c.sub_requirements ?? []).filter((s) => s.kind === "route").map((s) => ({ id: s.id, name: s.text }))) ?? [];
  const exclusions = criteria?.exclusion.map((c) => ({ id: c.id, name: c.name })) ?? [];
  const unretrieved = criteria?.unretrieved ?? [];

  const codeFor = (d: Decision): string | null => {
    if (codeTouched && code && compatible(d, code)) return code;
    if (!codeTouched && rec && rec.decision === d && rec.code) return rec.code;
    if (!codeTouched && current?.decision === d && current.code) return current.code;
    if (!detail.paper.pdf_available && d === "exclude" && unretrieved[0]) return unretrieved[0].id;
    return null;
  };

  const record = (d: Decision) => {
    const c = codeFor(d);
    if (codeTouched && code && !compatible(d, code)) {
      toast.warning(`Code ${code} does not fit a ${DECISION_LABEL[d]} decision and was not applied.`);
    }
    setCode(c ?? "");
    decide.mutate({ id, decision: d, code: c, reason: reason.trim() || null, advance: autoAdvance, previous: current });
  };

  useEffect(() => {
    decisionControls.decide = record;
    return () => {
      if (decisionControls.decide === record) decisionControls.decide = undefined;
    };
  });

  // Edits to code/reason after a decision exists are saved against that decision.
  const resave = async (patch: { code?: string; reason?: string }) => {
    if (!current) return;
    const c = patch.code ?? code;
    const r = patch.reason ?? reason;
    if ((c || null) === (current.code || null) && (r.trim() || null) === (current.reason || null)) return;
    try {
      await api.setDecision(id, current.decision, c || null, r.trim() || null);
      qc.invalidateQueries({ queryKey: ["paper", id] });
      qc.invalidateQueries({ queryKey: ["papers"] });
      toast.success("Decision details updated");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const clear = async () => {
    const prev = current;
    await api.clearDecision(id);
    qc.invalidateQueries({ queryKey: ["paper", id] });
    qc.invalidateQueries({ queryKey: ["papers"] });
    toast("Decision cleared", {
      action: prev
        ? {
            label: "Undo",
            onClick: async () => {
              await api.setDecision(id, prev.decision, prev.code, prev.reason);
              qc.invalidateQueries({ queryKey: ["paper", id] });
              qc.invalidateQueries({ queryKey: ["papers"] });
            },
          }
        : undefined,
    });
  };

  return (
    <div className="shrink-0 border-t border-line bg-surface px-3 pb-3 pt-2.5 shadow-[0_-4px_12px_rgb(0_0_0/0.03)]">
      <div className="mb-2 flex min-h-[20px] items-center gap-2 text-[12px]">
        {current ? (
          <>
            <span className="text-ink-3">Your decision</span>
            <span className={cx("inline-flex items-center gap-1 font-semibold", decisionTone[current.decision].text)}>
              <span className={cx("h-2 w-2 rounded-full", decisionTone[current.decision].dot)} />
              {DECISION_LABEL[current.decision].toUpperCase()}
              {current.code && <span className="font-mono font-medium">· {current.code}</span>}
            </span>
            <Tip content={fmtDateTime(current.decided_at)}>
              <span className="text-ink-3">{relTime(current.decided_at)}</span>
            </Tip>
            <Tip content="Clear decision">
              <button onClick={clear} className="ml-auto rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Clear decision">
                <Undo2 size={13} />
              </button>
            </Tip>
          </>
        ) : (
          <>
            <span className="font-medium text-ink-2">Not yet screened</span>
            {rec && (
              <span className="ml-auto text-ink-3">
                AI suggests <span className={cx("font-semibold", decisionTone[rec.decision].text)}>{DECISION_LABEL[rec.decision].toUpperCase()}</span>
                {rec.code ? <span className="font-mono"> · {rec.code}</span> : null}
              </span>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {(["include", "exclude", "maybe"] as Decision[]).map((d) => {
          const selected = current?.decision === d;
          const t = decisionTone[d];
          const k = d === "include" ? "I" : d === "exclude" ? "E" : "M";
          return (
            <button
              key={d}
              onClick={() => record(d)}
              disabled={decide.isPending}
              className={cx(
                "group relative flex h-11 items-center justify-center gap-1.5 rounded-xl text-[13px] font-bold tracking-wide transition-all",
                selected ? cx(t.bg, "text-white shadow-md") : cx("border-2 bg-surface", t.text, d === "include" ? "border-emerald-500/50 hover:bg-emerald-50 dark:hover:bg-emerald-500/10" : d === "exclude" ? "border-rose-500/50 hover:bg-rose-50 dark:hover:bg-rose-500/10" : "border-amber-500/60 hover:bg-amber-50 dark:hover:bg-amber-500/10"),
              )}
            >
              {selected && <Check size={15} strokeWidth={3} />}
              {DECISION_LABEL[d].toUpperCase()}
              <span className={cx("absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] font-medium", selected ? "text-white/70" : "text-ink-3/70")}>{k}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <select
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setCodeTouched(true);
            if (current && compatible(current.decision, e.target.value)) resave({ code: e.target.value });
          }}
          className="h-7 w-[120px] shrink-0 rounded-md border border-line bg-surface-2 px-1.5 text-[12px] text-ink focus:border-accent focus:outline-none"
          aria-label="Decision code"
          title="INCLUDE code (route) or ONE primary EXCLUDE code"
        >
          <option value="">{rec?.code && !codeTouched ? `Code: auto (${rec.code.length > 8 ? rec.code.slice(0, 8) + "…" : rec.code})` : "Code…"}</option>
          {code && ![...routes, ...exclusions, ...unretrieved].some((o) => o.id === code) && <option value={code}>{code}</option>}
          {routes.length > 0 && (
            <optgroup label="Include">
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Exclude (primary reason)">
            {exclusions.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id} — {e.name}
              </option>
            ))}
          </optgroup>
          {unretrieved.length > 0 && (
            <optgroup label="Not retrieved">
              {unretrieved.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id} — {u.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => resave({ reason })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="Reason / evidence note (optional)"
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 text-[12px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
        />
      </div>
      <div className="mt-2 flex items-center justify-between">
        <Switch id="auto-advance" checked={autoAdvance} onChange={(v) => set({ autoAdvance: v })} label="Auto-advance to next unscreened" />
        <span className="flex items-center gap-1 text-[11px] text-ink-3">
          <Kbd>I</Kbd>
          <Kbd>E</Kbd>
          <Kbd>M</Kbd>
        </span>
      </div>
    </div>
  );
}
