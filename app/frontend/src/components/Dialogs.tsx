import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, Database, Download, ExternalLink, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { useCriteria, useStatus } from "../hooks";
import { Button, Kbd, Modal, Segmented, Spinner } from "./ui";

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const groups: [string, [string[], string][]][] = [
    [
      "Screening",
      [
        [["I"], "Include"],
        [["E"], "Exclude"],
        [["M"], "Maybe"],
        [["A"], "Analyse current paper"],
      ],
    ],
    [
      "Data extraction",
      [
        [["Y"], "Accept selected field, go to next suggestion"],
        [["N"], "Next paper to extract"],
        [["J"], "Next / K previous included paper"],
      ],
    ],
    [
      "Navigation",
      [
        [["J"], "Next paper"],
        [["K"], "Previous paper"],
        [["N"], "Next unscreened paper"],
        [["/"], "Search papers"],
        [["["], "Toggle paper list"],
        [["]"], "Toggle evidence panel"],
      ],
    ],
    [
      "PDF & highlights",
      [
        [["."], "Next highlight"],
        [[","], "Previous highlight"],
        [["H"], "Show / hide all highlights"],
        [["G"], "Toggle green (inclusion) highlights"],
        [["R"], "Toggle red (exclusion) highlights"],
        [["U"], "Toggle amber (ambiguous) highlights"],
        [["Ctrl", "F"], "Search within the PDF"],
        [["+"], "Zoom in"],
        [["−"], "Zoom out"],
        [["0"], "Fit page (default zoom)"],
        [["?"], "Show this help"],
      ],
    ],
  ];
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" width="max-w-xl">
      <div className="grid gap-6 sm:grid-cols-2">
        {groups.map(([g, items]) => (
          <div key={g} className={g === "PDF & highlights" ? "sm:col-span-2" : ""}>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{g}</div>
            <div className={g === "PDF & highlights" ? "grid gap-x-6 gap-y-1.5 sm:grid-cols-2" : "space-y-1.5"}>
              {items.map(([keys, label]) => (
                <div key={label} className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="text-ink-2">{label}</span>
                  <span className="flex gap-1">
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function CriteriaDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: c, error } = useCriteria();
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Eligibility criteria"
      description={c ? `Parsed from ${c.source_file}. Definitions are shown verbatim.` : undefined}
      width="max-w-3xl"
    >
      {error && <p className="text-rose-600">{(error as Error).message}</p>}
      {c && (
        <div className="space-y-5 text-[13px]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-serif text-[16px] font-semibold">{c.title}</div>
            <a href="/api/criteria/source" target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-[12.5px] text-accent hover:underline">
              Open source <ExternalLink size={12} />
            </a>
          </div>
          {c.core_rule && (
            <p className="rounded-lg bg-accent-soft px-3 py-2 leading-relaxed">
              <span className="font-semibold">Core rule. </span>
              {c.core_rule}
            </p>
          )}
          {(["inclusion", "exclusion"] as const).map((k) => (
            <div key={k}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">{k === "inclusion" ? "Inclusion criteria" : "Exclusion criteria"}</div>
              <p className="mb-2 text-[12px] text-ink-3">{k === "inclusion" ? c.inclusion_rule : c.exclusion_rule}</p>
              <div className="divide-y divide-line rounded-lg border border-line">
                {c[k].map((cr) => (
                  <div key={cr.id} className="grid grid-cols-[44px_1fr] gap-2 px-3 py-2.5">
                    <span className={`font-mono font-semibold ${k === "inclusion" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>{cr.id}</span>
                    <div>
                      <div className="font-medium">{cr.name}</div>
                      <div className="mt-0.5 leading-relaxed text-ink-2">{cr.definition}</div>
                      {cr.sub_requirements && (
                        <ul className="mt-1.5 space-y-0.5 text-[12.5px] text-ink-2">
                          {cr.sub_requirements.map((s) => (
                            <li key={s.id}>
                              <span className="font-mono text-ink-3">{s.id}</span> {s.text}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {c.unretrieved.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Reports that cannot be retrieved</div>
              {c.unretrieved.map((u) => (
                <p key={u.id} className="text-ink-2">
                  <span className="font-mono font-semibold">{u.id}</span> {u.name} — {u.definition}
                </p>
              ))}
            </div>
          )}
          {c.do_not_exclude && <p className="rounded-lg border border-line px-3 py-2 text-ink-2">{c.do_not_exclude}</p>}
          {c.if_uncertain && (
            <p className="text-ink-2">
              <span className="font-medium">If uncertain: </span>
              {c.if_uncertain}
            </p>
          )}
          <details className="rounded-lg border border-line">
            <summary className="cursor-pointer px-3 py-2 text-[12.5px] text-ink-2">Full document text (as provided to the AI)</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-2">{c.full_text}</pre>
          </details>
        </div>
      )}
    </Modal>
  );
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data: status, refetch } = useStatus();
  const qc = useQueryClient();
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const fileRef = useRef<HTMLInputElement>(null);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testAi());
      refetch();
    } catch (e) {
      setTest({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const onRestore = async (f: File) => {
    if (mode === "replace" && !confirm("Replace ALL local reviewer data (decisions, notes, evidence, analyses) with the backup?")) return;
    try {
      const r = await api.restore(f, mode);
      toast.success(`Backup restored (${Object.entries(r.restored).map(([k, v]) => `${v} ${k}`).join(", ")})`);
      qc.invalidateQueries();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Settings & data" width="max-w-xl">
      <div className="space-y-6 text-[13px]">
        <section>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">AI provider</div>
          <div className="rounded-lg border border-line p-3">
            <div className="flex items-center gap-2">
              {status?.ai.available ? <CircleCheck size={15} className="text-emerald-500" /> : <CircleX size={15} className="text-rose-500" />}
              <span className="font-medium">{status?.ai.available ? `${status.ai.provider} · ${status.ai.model}` : "Not available"}</span>
            </div>
            <p className="mt-1 text-[12.5px] text-ink-3">{status?.ai.status}</p>
            {status?.ai.check && !test && (
              <p className={`mt-2 break-words rounded-md px-2.5 py-2 text-[12px] ${status.ai.check.ok ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300"}`}>
                Last check: {status.ai.check.message}
              </p>
            )}
            <div className="mt-2.5 flex items-center gap-2">
              <Button size="sm" onClick={runTest} disabled={testing || !status?.ai.available}>
                {testing ? <Spinner size={12} /> : null} Test connection
              </Button>
              <Button size="sm" variant="ghost" onClick={() => refetch()}>
                Refresh
              </Button>
            </div>
            {test && (
              <p className={`mt-2 break-words rounded-md px-2.5 py-2 text-[12px] ${test.ok ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300"}`}>
                {test.message}
              </p>
            )}
            <p className="mt-2 text-[11.5px] text-ink-3">Configured server-side in the project <span className="font-mono">.env</span>. Keys are never sent to the browser.</p>
          </div>
        </section>
        <section>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Backup & restore</div>
          <div className="space-y-3 rounded-lg border border-line p-3">
            <p className="text-[12.5px] text-ink-3">Reviewer data (decisions, decision history, notes, evidence, analyses) is stored in SQLite. Download a JSON backup or restore one.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => (window.location.href = "/api/backup")}>
                <Download size={13} /> Download backup
              </Button>
              <Button size="sm" onClick={() => fileRef.current?.click()}>
                <Upload size={13} /> Restore…
              </Button>
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: "merge", label: "Merge", title: "Keep newer local decisions/notes" },
                  { value: "replace", label: "Replace", title: "Overwrite all local reviewer data" },
                ]}
              />
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onRestore(f);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        </section>
        <section>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3">Data sources</div>
          <div className="space-y-1 rounded-lg border border-line p-3 font-mono text-[11.5px] text-ink-2">
            {status &&
              Object.entries(status.paths).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="w-24 shrink-0 text-ink-3">{k}</span>
                  <span className="break-all">{v}</span>
                </div>
              ))}
            <div className="flex gap-2">
              <span className="w-24 shrink-0 text-ink-3">last sync</span>
              <span>{status?.last_sync}</span>
            </div>
          </div>
          <Button
            size="sm"
            className="mt-2"
            onClick={async () => {
              const r = await api.sync();
              toast.success(`Re-synced: ${r.papers} papers, ${r.with_pdf} with PDF`);
              qc.invalidateQueries();
            }}
          >
            <Database size={13} /> Re-sync papers.csv & manifest
          </Button>
        </section>
      </div>
    </Modal>
  );
}
