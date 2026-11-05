import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { relTime } from "../lib/format";

/**
 * Debounced, autosaving notes field. Mount it once per paper (key it by paper ID): refetches never
 * overwrite what the reviewer is typing, and unsaved edits are flushed when switching papers.
 */
export function AutosaveNotes({
  title,
  initial,
  updatedAt,
  placeholder,
  save: persist,
  onSaved,
}: {
  title: string;
  initial: string;
  updatedAt: string | null | undefined;
  placeholder: string;
  save: (body: string) => Promise<unknown>;
  onSaved?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const lastSaved = useRef(initial);
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const save = async (body: string) => {
    window.clearTimeout(timer.current);
    pending.current = null;
    if (body === lastSaved.current) {
      setState((s) => (s === "dirty" ? "saved" : s));
      return;
    }
    setState("saving");
    try {
      await persist(body);
      lastSaved.current = body;
      setState("saved");
      onSaved?.();
    } catch (e) {
      pending.current = body;
      setState("dirty");
      toast.error(`Notes not saved: ${(e as Error).message}`);
    }
  };

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current !== null && pending.current !== lastSaved.current) {
        persist(pending.current).then(() => onSaved?.(), (e) => toast.error(`Notes not saved: ${e.message}`));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onChange = (v: string) => {
    setValue(v);
    setState("dirty");
    pending.current = v;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(v), 700);
  };

  return (
    <section>
      <div className="flex items-center justify-between px-1 pb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</h3>
        <span className="text-[11px] text-ink-3">
          {state === "saving" && "Saving…"}
          {state === "saved" && "Saved"}
          {state === "dirty" && "Unsaved"}
          {state === "idle" && updatedAt && `Updated ${relTime(updatedAt)}`}
        </span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => pending.current !== null && save(value)}
        rows={4}
        placeholder={placeholder}
        className="w-full resize-y rounded-xl border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
      />
    </section>
  );
}
