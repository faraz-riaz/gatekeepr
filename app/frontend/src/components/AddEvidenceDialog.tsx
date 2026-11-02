import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useCriteria, useInvalidatePaper } from "../hooks";
import { cx } from "../lib/format";
import { useUi } from "../store";
import type { Stance } from "../types";
import { Button, Modal } from "./ui";

export function AddEvidenceDialog() {
  const sel = useUi((s) => s.pendingSelection);
  const target = useUi((s) => s.addEvidenceFor);
  const paperId = useUi((s) => s.selectedId);
  const set = useUi((s) => s.set);
  const focus = useUi((s) => s.focusEvidence);
  const { data: criteria, map } = useCriteria();
  const invalidate = useInvalidatePaper();
  const open = !!(sel && target && paperId);

  const [criterionId, setCriterionId] = useState("");
  const [stance, setStance] = useState<Stance>("supports");
  const [explanation, setExplanation] = useState("");

  useEffect(() => {
    if (open) {
      setCriterionId(target?.criterionId ?? "");
      setStance("supports");
      setExplanation("");
    }
  }, [open, target?.criterionId]);

  const kind = map[criterionId]?.kind;
  const effect =
    stance === "ambiguous" ? "uncertain" : kind === "exclusion" ? (stance === "supports" ? "exclude" : "include") : stance === "supports" ? "include" : "exclude";

  const add = useMutation({
    mutationFn: () =>
      api.addEvidence(paperId!, { criterion_id: criterionId, stance, quote: sel!.text, page: sel!.page, explanation, selection_rects: sel!.rects }),
    onSuccess: (e) => {
      invalidate(paperId!);
      set({ pendingSelection: null, addEvidenceFor: null });
      window.getSelection()?.removeAllRanges();
      toast.success(`Evidence added to ${e.criterion_id} (p. ${e.page})`);
      setTimeout(() => focus(e.id), 300);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const close = () => set({ addEvidenceFor: null });

  return (
    <Modal open={open} onOpenChange={(v) => !v && close()} title="Add evidence" description="Link the selected passage to a criterion. It will be highlighted and saved." width="max-w-lg">
      {sel && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (criterionId) add.mutate();
          }}
        >
          <blockquote className="quote max-h-36 overflow-y-auto rounded-lg border-l-[3px] border-accent bg-surface-2 px-3 py-2 text-ink">
            “{sel.text}”<span className="ml-2 font-sans text-[11px] text-ink-3">p. {sel.page}</span>
          </blockquote>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink-2">Criterion</span>
            <select
              autoFocus
              required
              value={criterionId}
              onChange={(e) => setCriterionId(e.target.value)}
              className="h-9 w-full rounded-md border border-line bg-surface px-2 text-[13px] focus:border-accent focus:outline-none"
            >
              <option value="" disabled>
                Choose a criterion…
              </option>
              {(["inclusion", "exclusion"] as const).map((k) => (
                <optgroup key={k} label={k === "inclusion" ? "Inclusion" : "Exclusion"}>
                  {criteria?.[k].flatMap((c) => [
                    <option key={c.id} value={c.id}>
                      {c.id} — {c.name}
                    </option>,
                    ...(c.sub_requirements ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {"   "}
                        {s.id} — {s.text.length > 70 ? s.text.slice(0, 70) + "…" : s.text}
                      </option>
                    )),
                  ])}
                </optgroup>
              ))}
            </select>
          </label>
          <div>
            <span className="mb-1 block text-[12px] font-medium text-ink-2">This passage…</span>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ["supports", kind === "exclusion" ? "Shows the exclusion applies" : "Shows the criterion is met"],
                  ["contradicts", kind === "exclusion" ? "Shows it does not apply" : "Shows it is NOT met"],
                  ["ambiguous", "Relevant but unclear"],
                ] as [Stance, string][]
              ).map(([v, l]) => (
                <button
                  type="button"
                  key={v}
                  onClick={() => setStance(v)}
                  className={cx("rounded-lg border px-2 py-2 text-left text-[12px] leading-snug transition-colors", stance === v ? "border-accent bg-accent-soft text-ink" : "border-line text-ink-2 hover:border-line-strong")}
                >
                  {l}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11.5px] text-ink-3">
              Highlighted in{" "}
              <span className={cx("font-medium", effect === "include" ? "text-emerald-600" : effect === "exclude" ? "text-rose-600" : "text-amber-600")}>
                {effect === "include" ? "green (supports inclusion)" : effect === "exclude" ? "red (supports exclusion)" : "amber (ambiguous)"}
              </span>
              .
            </p>
          </div>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink-2">Explanation (optional)</span>
            <textarea
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] focus:border-accent focus:outline-none"
              placeholder="Why this passage matters for the criterion"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!criterionId || add.isPending}>
              Add evidence
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
