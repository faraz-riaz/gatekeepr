import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  Download,
  Ellipsis,
  Eye,
  EyeOff,
  Highlighter,
  Maximize2,
  Minimize2,
  PanelLeftOpen,
  PanelRightOpen,
  Plus,
  RotateCw,
  Search,
  TriangleAlert,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useCriteria } from "../hooks";
import { cx, POLARITY_LABEL } from "../lib/format";
import { DOCUMENT_OPTIONS, pdfjsLib, viewerControls, viewerModule, type ViewerModule } from "../lib/pdfjs";
import { useUi } from "../store";
import type { PaperDetail, Polarity, Rect } from "../types";
import { Button, IconButton, Kbd, Menu, MenuItem, MenuSeparator, Spinner, Tip } from "./ui";

type Viewer = InstanceType<ViewerModule["PDFViewer"]>;
type Bus = InstanceType<ViewerModule["EventBus"]>;
type Hit = { eid: string; l: number; t: number; r: number; b: number };

const ZOOM_PRESETS: [string, string][] = [
  ["page-width", "Fit width"],
  ["page-fit", "Fit page"],
  ["0.75", "75%"],
  ["1", "100%"],
  ["1.25", "125%"],
  ["1.5", "150%"],
  ["2", "200%"],
  ["3", "300%"],
];

export type HighlightTone = Polarity | "extract" | "mismatch";

/** A passage to highlight, independent of the stage (screening evidence or extracted-value evidence). */
export interface ViewerHighlight {
  id: string;
  page: number;
  rects: Rect[];
  tone: HighlightTone;
  dismissed: boolean;
  manual: boolean;
  /** de-emphasised (e.g. extraction passages unrelated to the selected field) */
  faint?: boolean;
  kicker: string;
  title: string;
  code?: string;
  detail?: string | null;
  body?: string | null;
  meta: string;
}

const POLARITY_DOT: Record<HighlightTone, string> = {
  include: "bg-emerald-500",
  exclude: "bg-rose-500",
  uncertain: "bg-amber-500",
  extract: "bg-yellow-400",
  mismatch: "bg-rose-500",
};

/** Screening stage: criterion evidence coloured by polarity. */
export function PdfViewer({ detail }: { detail: PaperDetail }) {
  const { map: criteriaMap } = useCriteria();
  const highlights = useMemo<ViewerHighlight[]>(
    () =>
      detail.evidence.map((e) => {
        const c = criteriaMap[e.criterion_id];
        return {
          id: e.id,
          page: e.page,
          rects: e.rects,
          tone: e.polarity,
          dismissed: e.dismissed,
          manual: e.origin === "manual",
          kicker: POLARITY_LABEL[e.polarity],
          code: e.criterion_id,
          title: c?.name ?? "Unknown criterion",
          detail: c && c.definition !== c.name ? c.definition : null,
          body: e.explanation,
          meta: [
            `p. ${e.page}`,
            e.origin === "manual" ? "Added by reviewer" : "AI · verified in PDF",
            e.match_method === "fuzzy" && e.match_score != null ? `${Math.round(e.match_score * 100)}% match` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        };
      }),
    [detail.evidence, criteriaMap],
  );
  const armed = useUi((s) => s.addEvidenceFor?.criterionId);
  return (
    <DocumentViewer
      paperId={detail.paper.paper_id}
      text={detail.text}
      highlights={highlights}
      variant="screening"
      armedLabel={armed ? `for ${armed}` : ""}
    />
  );
}

export function DocumentViewer({
  paperId,
  text,
  highlights,
  variant,
  armedLabel,
}: {
  paperId: string;
  text: PaperDetail["text"];
  highlights: ViewerHighlight[];
  variant: "screening" | "extraction";
  armedLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerElRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const inst = useRef<{ mod: ViewerModule; viewer: Viewer; bus: Bus } | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const preferredScale = useRef("page-fit"); // default zoom: whole page visible
  const numPagesRef = useRef(0);
  const hitMap = useRef(new Map<number, Hit[]>());

  const [ready, setReady] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1);
  const [scaleValue, setScaleValue] = useState("page-fit");
  const [findQuery, setFindQuery] = useState("");
  const [findCount, setFindCount] = useState<{ current: number; total: number } | null>(null);
  const [findPending, setFindPending] = useState(false);
  const [hover, setHover] = useState<{ eid: string; x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState<{ eid: string; x: number; y: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const ui = useUi();
  const evidence = highlights;
  const screening = variant === "screening";

  const visible = useMemo(() => {
    return evidence.filter((e) => {
      if (e.id === ui.activeEvidenceId) return true; // the focused passage is always shown
      if (!ui.showHighlights) return false;
      if (e.dismissed && !ui.showDismissed) return false;
      if (screening && e.tone === "include" && !ui.showInclude) return false;
      if (screening && e.tone === "exclude" && !ui.showExclude) return false;
      if (screening && e.tone === "uncertain" && !ui.showUncertain) return false;
      return true;
    });
  }, [evidence, screening, ui.showHighlights, ui.showDismissed, ui.showInclude, ui.showExclude, ui.showUncertain, ui.activeEvidenceId]);

  const counts = useMemo(() => {
    const c: Record<HighlightTone, number> = { include: 0, exclude: 0, uncertain: 0, extract: 0, mismatch: 0 };
    for (const e of evidence) if (!e.dismissed) c[e.tone]++;
    return c;
  }, [evidence]);

  // Sorted reading order for "next/previous highlight"
  const ordered = useMemo(
    () =>
      visible
        .filter((e) => !e.dismissed || ui.showDismissed)
        .slice()
        .sort((a, b) => a.page - b.page || (b.rects[0]?.[4] ?? 0) - (a.rects[0]?.[4] ?? 0)),
    [visible, ui.showDismissed],
  );

  // refs for event handlers registered once
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const activeRef = useRef(ui.activeEvidenceId);
  activeRef.current = ui.activeEvidenceId;
  const hoverRef = useRef<string | null>(null);
  hoverRef.current = hover?.eid ?? pinned?.eid ?? null;

  // ------------------------------------------------------------------ highlight painting

  const paintPage = useCallback((pageNumber: number) => {
    const v = inst.current;
    if (!v) return;
    const pv = v.viewer.getPageView(pageNumber - 1);
    if (!pv?.div || !pv.viewport) return;
    const div: HTMLDivElement = pv.div;
    let layer = div.querySelector(":scope > .hl-layer") as HTMLDivElement | null;
    const textLayer = div.querySelector(":scope > .textLayer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "hl-layer";
    }
    // keep the highlight layer directly below the text layer so text stays selectable
    if (textLayer && layer.nextSibling !== textLayer) div.insertBefore(layer, textLayer);
    else if (!textLayer && layer.parentNode !== div) div.appendChild(layer);

    const vp = pv.viewport;
    const W = vp.width;
    const H = vp.height;
    const hits: Hit[] = [];
    const frag = document.createDocumentFragment();
    for (const e of visibleRef.current) {
      for (const r of e.rects) {
        if (r[0] !== pageNumber) continue;
        const [ax, ay] = vp.convertToViewportPoint(r[1], r[2]);
        const [bx, by] = vp.convertToViewportPoint(r[3], r[4]);
        const padX = 1.5 / W;
        const padY = 1 / H;
        const l = Math.max(0, Math.min(ax, bx) / W - padX) * 100;
        const t = Math.max(0, Math.min(ay, by) / H - padY) * 100;
        const rr = Math.min(1, Math.max(ax, bx) / W + padX) * 100;
        const bb = Math.min(1, Math.max(ay, by) / H + padY) * 100;
        const d = document.createElement("div");
        d.className = cx(
          "hl",
          e.dismissed ? "dismissed" : e.tone,
          e.manual && "manual",
          e.faint && activeRef.current !== e.id && "faint",
          activeRef.current === e.id && cx("active", e.tone),
          hoverRef.current === e.id && "hover",
        );
        d.style.left = `${l}%`;
        d.style.top = `${t}%`;
        d.style.width = `${rr - l}%`;
        d.style.height = `${bb - t}%`;
        frag.appendChild(d);
        hits.push({ eid: e.id, l, t, r: rr, b: bb });
      }
    }
    layer.replaceChildren(frag);
    hitMap.current.set(pageNumber, hits);
  }, []);

  const paintAll = useCallback(() => {
    for (let i = 1; i <= numPagesRef.current; i++) paintPage(i);
  }, [paintPage]);

  // ------------------------------------------------------------------ viewer lifecycle

  useEffect(() => {
    let disposed = false;
    viewerModule.then((mod) => {
      if (disposed || !containerRef.current || !viewerElRef.current) return;
      const bus = new mod.EventBus();
      const link = new mod.PDFLinkService({ eventBus: bus, externalLinkTarget: 2 });
      const find = new mod.PDFFindController({ eventBus: bus, linkService: link });
      const viewer = new mod.PDFViewer({
        container: containerRef.current,
        viewer: viewerElRef.current,
        eventBus: bus,
        linkService: link,
        findController: find,
        removePageBorders: true,
        textLayerMode: 1,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      });
      link.setViewer(viewer);
      bus.on("pagesinit", () => {
        viewer.currentScaleValue = preferredScale.current;
      });
      bus.on("pagechanging", (e: { pageNumber: number }) => {
        setPage(e.pageNumber);
        setPageInput(String(e.pageNumber));
      });
      bus.on("scalechanging", (e: { scale: number; presetValue?: string }) => {
        setScale(e.scale);
        setScaleValue(e.presetValue ?? String(e.scale));
      });
      bus.on("pagerender", (e: { pageNumber: number }) => paintPage(e.pageNumber));
      bus.on("pagerendered", (e: { pageNumber: number }) => paintPage(e.pageNumber));
      bus.on("textlayerrendered", (e: { pageNumber: number }) => paintPage(e.pageNumber));
      bus.on("rotationchanging", () => requestAnimationFrame(paintAll));
      bus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => setFindCount(e.matchesCount));
      bus.on("updatefindcontrolstate", (e: { state: number; matchesCount?: { current: number; total: number } }) => {
        setFindPending(e.state === 3);
        if (e.matchesCount) setFindCount(e.matchesCount);
      });
      inst.current = { mod, viewer, bus };
      setReady(true);
    });
    return () => {
      disposed = true;
      docRef.current?.loadingTask.destroy();
      docRef.current = null;
    };
  }, [paintPage, paintAll]);

  // load the selected paper's PDF
  useEffect(() => {
    if (!ready) return;
    const v = inst.current!;
    let cancelled = false;
    let resolved = false;
    setLoadState("loading");
    setFindQuery("");
    setFindCount(null);
    setHover(null);
    setPinned(null);
    hitMap.current.clear();
    const task = pdfjsLib.getDocument({ url: api.pdfUrl(paperId), ...DOCUMENT_OPTIONS });
    task.promise.then(
      (doc) => {
        resolved = true;
        if (cancelled) {
          doc.loadingTask.destroy();
          return;
        }
        const old = docRef.current;
        docRef.current = doc;
        numPagesRef.current = doc.numPages;
        v.viewer.setDocument(doc);
        (v.viewer.linkService as { setDocument: (d: PDFDocumentProxy, b: null) => void }).setDocument(doc, null);
        v.bus.dispatch("findbarclose", { source: null });
        setNumPages(doc.numPages);
        setPage(1);
        setPageInput("1");
        setLoadState("ready");
        if (old) old.loadingTask.destroy();
      },
      (err: Error) => {
        resolved = true;
        if (!cancelled) {
          setLoadState("error");
          setLoadError(err?.message ?? String(err));
        }
      },
    );
    return () => {
      cancelled = true;
      if (!resolved) task.destroy();
    };
  }, [paperId, ready]);

  // repaint highlights whenever evidence, toggles, focus or hover change
  useEffect(() => {
    if (loadState === "ready") paintAll();
  }, [visible, ui.activeEvidenceId, hover?.eid, pinned?.eid, loadState, paintAll]);

  // keep "fit" zoom modes correct when the window or sidebars resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const v = inst.current?.viewer;
        if (v && docRef.current && ["page-width", "page-fit", "auto"].includes(v.currentScaleValue)) {
          v.currentScaleValue = v.currentScaleValue;
        }
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // scroll to the focused evidence passage
  useEffect(() => {
    const id = ui.activeEvidenceId;
    const v = inst.current?.viewer;
    if (!id || !v || loadState !== "ready") return;
    const e = evidence.find((x) => x.id === id);
    const r = e?.rects[0];
    if (!e || !r) return;
    v.scrollPageIntoView({
      pageNumber: r[0],
      destArray: [null, { name: "XYZ" }, null, Math.max(r[2], r[4]) + 80, null],
      allowNegativeOffset: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.focusNonce, loadState]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // ------------------------------------------------------------------ actions

  const setZoom = useCallback((value: string) => {
    const v = inst.current?.viewer;
    if (!v) return;
    preferredScale.current = value;
    v.currentScaleValue = value;
  }, []);

  const zoomBy = useCallback((dir: 1 | -1) => {
    const v = inst.current?.viewer;
    if (!v) return;
    if (dir > 0) v.increaseScale();
    else v.decreaseScale();
    preferredScale.current = String(v.currentScale);
  }, []);

  const goToPage = (n: number) => {
    const v = inst.current?.viewer;
    if (!v || !numPages) return;
    v.currentPageNumber = Math.min(numPages, Math.max(1, n));
  };

  const runFind = (type: "" | "again", previous = false, query = findQuery) => {
    inst.current?.bus.dispatch("find", {
      source: null,
      type,
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  };

  const stepHighlight = useCallback(
    (dir: 1 | -1) => {
      if (!ordered.length) return;
      const i = ordered.findIndex((e) => e.id === useUi.getState().activeEvidenceId);
      let next: ViewerHighlight | undefined;
      if (i >= 0) next = ordered[(i + dir + ordered.length) % ordered.length];
      else next = dir > 0 ? ordered.find((e) => e.page >= page) ?? ordered[0] : [...ordered].reverse().find((e) => e.page <= page) ?? ordered[ordered.length - 1];
      if (next) useUi.getState().focusEvidence(next.id);
    },
    [ordered, page],
  );

  useEffect(() => {
    viewerControls.zoomIn = () => zoomBy(1);
    viewerControls.zoomOut = () => zoomBy(-1);
    viewerControls.fitPage = () => setZoom("page-fit");
    viewerControls.nextHighlight = () => stepHighlight(1);
    viewerControls.prevHighlight = () => stepHighlight(-1);
    viewerControls.focusSearch = () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
  }, [zoomBy, setZoom, stepHighlight]);

  const rotate = () => {
    const v = inst.current?.viewer;
    if (v) v.pagesRotation = (v.pagesRotation + 90) % 360;
  };

  const download = () => window.open(api.pdfUrl(paperId, true), "_blank");

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else shellRef.current?.requestFullscreen();
  };

  // ------------------------------------------------------------------ pointer handling

  const hitTest = (ev: React.MouseEvent): Hit | null => {
    const pageEl = (ev.target as HTMLElement).closest?.(".page") as HTMLElement | null;
    if (!pageEl) return null;
    const pn = Number(pageEl.dataset.pageNumber);
    const rect = pageEl.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * 100;
    const y = ((ev.clientY - rect.top) / rect.height) * 100;
    const hits = hitMap.current.get(pn) ?? [];
    // last painted wins (topmost)
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (x >= h.l && x <= h.r && y >= h.t && y <= h.b) return h;
    }
    return null;
  };

  const onMouseMove = (ev: React.MouseEvent) => {
    if (ev.buttons) return; // selecting text
    const h = hitTest(ev);
    if (h) {
      if (hover?.eid !== h.eid) setHover({ eid: h.eid, x: ev.clientX, y: ev.clientY });
    } else if (hover) setHover(null);
  };

  const onClick = (ev: React.MouseEvent) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const h = hitTest(ev);
    if (h) {
      setPinned({ eid: h.eid, x: ev.clientX, y: ev.clientY });
      useUi.getState().set({ activeEvidenceId: h.eid, rightOpen: true });
    } else {
      setPinned(null);
    }
  };

  const onMouseUp = () => {
    window.setTimeout(() => {
      const sel = window.getSelection();
      const st = useUi.getState();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        if (st.pendingSelection) st.set({ pendingSelection: null });
        return;
      }
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (text.length < 3) return;
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const el = node.nodeType === 3 ? node.parentElement : (node as Element);
      if (!el || !containerRef.current?.contains(el)) return;
      const v = inst.current?.viewer;
      if (!v) return;
      const pages = Array.from(containerRef.current.querySelectorAll<HTMLElement>(".page"));
      const rects: Rect[] = [];
      const clientRects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
      for (const cr of clientRects) {
        const cxp = cr.left + cr.width / 2;
        const cyp = cr.top + cr.height / 2;
        const pageEl = pages.find((p) => {
          const b = p.getBoundingClientRect();
          return cxp >= b.left && cxp <= b.right && cyp >= b.top && cyp <= b.bottom;
        });
        if (!pageEl) continue;
        const b = pageEl.getBoundingClientRect();
        if (cr.height > b.height * 0.15) continue; // ignore pdf.js end-of-content filler
        const pn = Number(pageEl.dataset.pageNumber);
        const pv = v.getPageView(pn - 1);
        const k = pv.viewport.width / b.width;
        const [x0, y0] = pv.viewport.convertToPdfPoint((cr.left - b.left) * k, (cr.top - b.top) * k);
        const [x1, y1] = pv.viewport.convertToPdfPoint((cr.right - b.left) * k, (cr.bottom - b.top) * k);
        rects.push([pn, Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
      }
      if (!rects.length) return;
      const last = clientRects[clientRects.length - 1];
      st.set({ pendingSelection: { text, page: rects[0][0], rects, x: last.right, y: last.bottom } });
      if (st.addEvidenceFor) st.set({ addEvidenceFor: { ...st.addEvidenceFor } });
    }, 0);
  };

  const tipEvidence = useMemo(() => {
    const id = pinned?.eid ?? hover?.eid;
    return id ? evidence.find((e) => e.id === id) ?? null : null;
  }, [pinned, hover, evidence]);
  const tipPos = pinned ?? hover;

  const scaleLabel = ZOOM_PRESETS.find(([v]) => v === scaleValue)?.[1] ?? `${Math.round(scale * 100)}%`;

  // ------------------------------------------------------------------ render

  return (
    <div ref={shellRef} className="flex h-full min-w-0 flex-col bg-surface">
      {/* toolbar (container queries move secondary actions into a menu when the column is narrow) */}
      <div className="@container shrink-0 border-b border-line">
      <div className="flex h-11 items-center gap-1 px-2">
        {!ui.leftOpen && (
          <IconButton label="Show paper list" kbd="[" onClick={() => ui.set({ leftOpen: true })}>
            <PanelLeftOpen size={16} />
          </IconButton>
        )}
        <div className="flex items-center gap-0.5">
          <div className="hidden @xl:flex">
            <IconButton label="Previous page" onClick={() => goToPage(page - 1)} disabled={page <= 1}>
              <ChevronLeft size={16} />
            </IconButton>
          </div>
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && goToPage(Number(pageInput) || 1)}
            onBlur={() => setPageInput(String(page))}
            className="h-7 w-10 rounded-md border border-line bg-surface-2 text-center text-[12.5px] tabular-nums text-ink focus:border-accent focus:outline-none"
            aria-label="Page number"
          />
          <span className="whitespace-nowrap px-1 text-[12.5px] tabular-nums text-ink-3">/ {numPages || "–"}</span>
          <div className="hidden @xl:flex">
            <IconButton label="Next page" onClick={() => goToPage(page + 1)} disabled={page >= numPages}>
              <ChevronRight size={16} />
            </IconButton>
          </div>
        </div>
        <Divider />
        <div className="hidden @2xl:flex">
          <IconButton label="Zoom out" kbd="−" onClick={() => zoomBy(-1)}>
            <ZoomOut size={16} />
          </IconButton>
        </div>
        <Menu
          align="start"
          trigger={
            <button className="flex h-7 items-center justify-between gap-1 whitespace-nowrap rounded-md px-1.5 @xl:min-w-[78px] @xl:px-2 text-[12.5px] tabular-nums text-ink-2 hover:bg-surface-3">
              {scaleLabel}
              <ChevronDown size={13} className="text-ink-3" />
            </button>
          }
        >
          {ZOOM_PRESETS.map(([v, l], i) => (
            <div key={v}>
              {i === 2 && <MenuSeparator />}
              <MenuItem onSelect={() => setZoom(v)} hint={v === "page-fit" ? "0" : undefined}>
                {l}
              </MenuItem>
            </div>
          ))}
        </Menu>
        <div className="hidden @2xl:flex">
          <IconButton label="Zoom in" kbd="+" onClick={() => zoomBy(1)}>
            <ZoomIn size={16} />
          </IconButton>
        </div>
        <div className="hidden @4xl:flex">
          <IconButton label="Rotate pages" onClick={rotate}>
            <RotateCw size={15} />
          </IconButton>
        </div>
        <div className="hidden @2xl:block">
          <Divider />
        </div>
        {/* search */}
        <div className="relative flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2 text-ink-3" />
          <input
            ref={searchRef}
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value);
              runFind("", false, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") runFind("again", e.shiftKey);
              if (e.key === "Escape") {
                setFindQuery("");
                runFind("", false, "");
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder="Search in PDF"
            className="h-7 w-28 rounded-md border border-line bg-surface-2 pl-7 pr-9 @xl:w-32 @xl:pr-16 text-[12.5px] text-ink placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:outline-none @3xl:w-44 @6xl:w-56"
          />
          <div className="absolute right-1 flex items-center">
            {findQuery && (
              <span className="mr-0.5 text-[11px] tabular-nums text-ink-3">
                {findPending ? "…" : findCount ? `${findCount.current}/${findCount.total}` : "0"}
              </span>
            )}
            <button className="hidden rounded p-0.5 text-ink-3 hover:text-ink @xl:block" onClick={() => runFind("again", true)} aria-label="Previous match" title="Previous match (Shift+Enter)">
              <ChevronUp size={13} />
            </button>
            <button className="hidden rounded p-0.5 text-ink-3 hover:text-ink @xl:block" onClick={() => runFind("again", false)} aria-label="Next match" title="Next match (Enter)">
              <ChevronDown size={13} />
            </button>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {/* highlight controls + legend */}
          <IconButton label={ui.showHighlights ? "Hide all highlights" : "Show all highlights"} kbd="H" active={!ui.showHighlights} onClick={() => ui.set({ showHighlights: !ui.showHighlights })}>
            {ui.showHighlights ? <Eye size={16} /> : <EyeOff size={16} />}
          </IconButton>
          {screening ? (
            <>
              <LegendToggle label="Supports inclusion" kbd="G" polarity="include" count={counts.include} on={ui.showInclude && ui.showHighlights} onClick={() => ui.set({ showInclude: !ui.showInclude })} />
              <LegendToggle label="Supports exclusion" kbd="R" polarity="exclude" count={counts.exclude} on={ui.showExclude && ui.showHighlights} onClick={() => ui.set({ showExclude: !ui.showExclude })} />
              <LegendToggle label="Ambiguous / uncertain" kbd="U" polarity="uncertain" count={counts.uncertain} on={ui.showUncertain && ui.showHighlights} onClick={() => ui.set({ showUncertain: !ui.showUncertain })} />
            </>
          ) : (
            <>
              <Tip content="Verified source passages of extracted values">
                <span className="flex h-7 items-center gap-1.5 px-1.5 text-[12px] font-medium tabular-nums text-ink-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-yellow-400 ring-1 ring-yellow-600/40" />
                  <span className="hidden @xl:inline">{counts.extract + counts.mismatch}</span>
                </span>
              </Tip>
              <IconButton
                label={ui.xFocusHighlights ? "Show all source passages" : "Show only the selected field's passages"}
                active={ui.xFocusHighlights}
                onClick={() => ui.set({ xFocusHighlights: !ui.xFocusHighlights })}
              >
                <Crosshair size={15} />
              </IconButton>
            </>
          )}
          <IconButton label="Previous highlight" kbd="," onClick={() => stepHighlight(-1)} disabled={!ordered.length}>
            <ChevronUp size={16} />
          </IconButton>
          <IconButton label="Next highlight" kbd="." onClick={() => stepHighlight(1)} disabled={!ordered.length}>
            <ChevronDown size={16} />
          </IconButton>
          <div className="hidden items-center gap-1 @4xl:flex">
            <Divider />
            <IconButton label="Download PDF" onClick={download}>
              <Download size={15} />
            </IconButton>
            <IconButton label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen}>
              {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </IconButton>
          </div>
          <div className="@4xl:hidden">
            <Menu trigger={<IconButton label="More PDF actions"><Ellipsis size={16} /></IconButton>}>
              <MenuItem icon={<ZoomIn size={14} />} onSelect={() => zoomBy(1)} hint="+">Zoom in</MenuItem>
              <MenuItem icon={<ZoomOut size={14} />} onSelect={() => zoomBy(-1)} hint="−">Zoom out</MenuItem>
              <MenuItem icon={<RotateCw size={14} />} onSelect={rotate}>Rotate pages</MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Download size={14} />} onSelect={download}>Download PDF</MenuItem>
              <MenuItem icon={fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />} onSelect={toggleFullscreen}>
                {fullscreen ? "Exit fullscreen" : "Fullscreen"}
              </MenuItem>
            </Menu>
          </div>
          {!ui.rightOpen && (
            <IconButton label="Show evidence panel" kbd="]" onClick={() => ui.set({ rightOpen: true })}>
              <PanelRightOpen size={16} />
            </IconButton>
          )}
        </div>
      </div>
      </div>

      {text && text.status !== "ok" && text.message && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
          <TriangleAlert size={13} /> {text.message}
        </div>
      )}
      {ui.addEvidenceFor && !ui.pendingSelection && (
        <div className="flex items-center gap-2 border-b border-accent/20 bg-accent-soft px-3 py-1.5 text-[12.5px] text-ink">
          <Highlighter size={14} className="text-accent" />
          Select the passage in the PDF to add as evidence{armedLabel ? ` ${armedLabel}` : ""}.
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => ui.set({ addEvidenceFor: null })}>
            Cancel
          </Button>
        </div>
      )}

      {/* document */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="pdf-container"
          onMouseMove={onMouseMove}
          onMouseLeave={() => setHover(null)}
          onClick={onClick}
          onMouseUp={onMouseUp}
          onScroll={() => hover && setHover(null)}
        >
          <div ref={viewerElRef} className="pdfViewer" />
        </div>

        {loadState === "loading" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-viewer/60">
            <div className="flex items-center gap-2 rounded-lg bg-surface px-4 py-2.5 text-[13px] text-ink-2 shadow-lg">
              <Spinner /> Loading PDF…
            </div>
          </div>
        )}
        {loadState === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-viewer">
            <div className="max-w-md rounded-xl border border-line bg-surface p-6 text-center shadow-lg">
              <TriangleAlert className="mx-auto text-rose-500" />
              <div className="mt-2 font-medium">The PDF could not be opened</div>
              <div className="mt-1 text-[12.5px] text-ink-3">{loadError}</div>
            </div>
          </div>
        )}

        {/* legend */}
        {loadState === "ready" && evidence.length > 0 && ui.showHighlights && (
          <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 rounded-full border border-line bg-surface/90 px-3 py-1 text-[11px] text-ink-2 shadow-sm backdrop-blur">
            {screening ? (
              <>
                <LegendSwatch cls="bg-emerald-500/40 border-b-2 border-emerald-600" label="Supports inclusion" />
                <LegendSwatch cls="bg-rose-500/40 border-b-2 border-rose-600" label="Supports exclusion" />
                <LegendSwatch cls="bg-amber-400/40 border-b-2 border-amber-600" label="Ambiguous" />
              </>
            ) : (
              <>
                <LegendSwatch cls="bg-yellow-300/70 border-b-[1.5px] border-yellow-600" label="Source passage" />
                <LegendSwatch cls="bg-yellow-200/40" label="Other fields" />
                <LegendSwatch cls="bg-rose-400/25 border-b-2 border-dashed border-rose-600" label="Value not in passage" />
              </>
            )}
            <LegendSwatch cls="bg-stone-300/60 bg-[repeating-linear-gradient(135deg,transparent_0_3px,rgba(255,255,255,.7)_3px_5px)]" label="Manual" />
          </div>
        )}

        {/* floating "add evidence" for a text selection */}
        {ui.pendingSelection && (
          <div className="fixed z-50" style={{ left: Math.min(ui.pendingSelection.x + 6, window.innerWidth - 190), top: Math.min(ui.pendingSelection.y + 6, window.innerHeight - 50) }}>
            <Button
              size="sm"
              variant="primary"
              className="shadow-lg"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => ui.set({ addEvidenceFor: { ...(ui.addEvidenceFor ?? {}) } })}
            >
              <Plus size={13} /> {variant === "extraction" ? "Attach as source" : "Add as evidence"}
            </Button>
          </div>
        )}
      </div>

      {tipEvidence && tipPos && (
        <HighlightTip
          e={tipEvidence}
          x={tipPos.x}
          y={tipPos.y}
          pinned={!!pinned}
          onClose={() => setPinned(null)}
        />
      )}
    </div>
  );
}

function Divider() {
  return <div className="mx-1 hidden h-5 w-px bg-line @xl:block" />;
}

function LegendSwatch({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("h-2.5 w-4 rounded-[2px]", cls)} />
      {label}
    </span>
  );
}

function LegendToggle({ label, kbd, polarity, count, on, onClick }: { label: string; kbd: string; polarity: HighlightTone; count: number; on: boolean; onClick: () => void }) {
  return (
    <Tip content={`${on ? "Hide" : "Show"} ${label.toLowerCase()} highlights`} kbd={kbd}>
      <button
        onClick={onClick}
        aria-pressed={on}
        className={cx(
          "flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium tabular-nums transition-colors @xl:px-2",
          on ? "text-ink-2 hover:bg-surface-3" : "text-ink-3/60 line-through hover:bg-surface-3",
        )}
      >
        <span className={cx("h-2.5 w-2.5 rounded-full", POLARITY_DOT[polarity], !on && "opacity-30")} />
        <span className="hidden @xl:inline">{count}</span>
      </button>
    </Tip>
  );
}

function HighlightTip({ e, x, y, pinned, onClose }: { e: ViewerHighlight; x: number; y: number; pinned: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 14, top: y + 14 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      left: x + 14 + w > window.innerWidth - 8 ? Math.max(8, x - w - 14) : x + 14,
      top: y + 14 + h > window.innerHeight - 8 ? Math.max(8, y - h - 14) : y + 14,
    });
  }, [x, y, e.id]);
  const tone = e.dismissed ? "text-ink-3" : TONE_TEXT[e.tone];
  return (
    <div
      ref={ref}
      className={cx("fixed z-[80] w-[340px] rounded-xl border border-line bg-surface p-3 text-[12.5px] shadow-2xl", !pinned && "pointer-events-none")}
      style={pos}
      onMouseDown={(ev) => ev.stopPropagation()}
    >
      <div className="flex items-start gap-2">
        <span className={cx("mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full", e.dismissed ? "bg-stone-400" : POLARITY_DOT[e.tone])} />
        <div className="min-w-0 flex-1">
          <div className={cx("text-[11px] font-semibold uppercase tracking-wide", tone)}>
            {e.dismissed ? "Dismissed · " : ""}
            {e.kicker}
          </div>
          <div className="mt-0.5 font-medium text-ink">
            {e.code && <span className="mr-1 font-mono text-[11.5px] text-ink-2">{e.code}</span>}
            <span className="whitespace-pre-line">{e.title}</span>
          </div>
        </div>
        {pinned && (
          <button className="-mr-1 -mt-1 rounded p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" onClick={onClose} aria-label="Close">
            <X size={13} />
          </button>
        )}
      </div>
      {e.detail && <p className="mt-2 line-clamp-3 border-l-2 border-line pl-2 text-[11.5px] leading-snug text-ink-3">{e.detail}</p>}
      {e.body && <p className="mt-2 leading-snug text-ink-2">{e.body}</p>}
      <div className="mt-2 text-[11px] text-ink-3">{e.meta}</div>
      {!pinned && (
        <div className="mt-1.5 text-[10.5px] text-ink-3">
          Click to pin · details in the side panel <Kbd className="ml-1">.</Kbd>
        </div>
      )}
    </div>
  );
}

const TONE_TEXT: Record<HighlightTone, string> = {
  include: "text-emerald-600 dark:text-emerald-400",
  exclude: "text-rose-600 dark:text-rose-400",
  uncertain: "text-amber-600 dark:text-amber-400",
  extract: "text-amber-700 dark:text-yellow-400",
  mismatch: "text-rose-600 dark:text-rose-400",
};

type MissingPdfPaper = Pick<
  PaperDetail["paper"],
  "paper_id" | "doi" | "landing_page_url" | "pdf_url" | "link" | "pmcid" | "access_status" | "manifest_notes"
>;

export function MissingPdf({ detail, stage = "screening" }: { detail: { paper: MissingPdfPaper }; stage?: "screening" | "extraction" }) {
  const p = detail.paper;
  const links = [
    p.doi && { label: `DOI: ${p.doi}`, href: `https://doi.org/${p.doi}` },
    p.landing_page_url && { label: "Publisher landing page", href: p.landing_page_url },
    p.pdf_url && { label: "Known PDF location", href: p.pdf_url },
    p.link && p.link !== p.landing_page_url && { label: "Link from papers.csv", href: p.link },
    p.pmcid && { label: `PubMed Central ${p.pmcid}`, href: `https://www.ncbi.nlm.nih.gov/pmc/articles/${p.pmcid}/` },
  ].filter(Boolean) as { label: string; href: string }[];
  return (
    <div className="flex h-full items-center justify-center bg-viewer p-8">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-7 shadow-xl">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-rose-50 text-rose-500 dark:bg-rose-500/10">
          <TriangleAlert size={20} />
        </div>
        <h2 className="mt-4 text-[17px] font-semibold">Full text not available locally</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          No PDF for <span className="font-mono">{p.paper_id}</span> was retrieved by the acquisition pipeline
          {p.access_status ? (
            <>
              {" "}
              (status: <span className="font-medium">{p.access_status}</span>)
            </>
          ) : null}
          . No other document is substituted. {stage === "extraction" ? "AI extraction needs the full text, but you can still enter values manually in the panel." : "AI analysis requires the full text."}
        </p>
        {p.manifest_notes && <p className="mt-3 rounded-lg bg-surface-3 p-3 text-[12.5px] leading-relaxed text-ink-2">{p.manifest_notes}</p>}
        {links.length > 0 && (
          <div className="mt-4 space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Sources</div>
            {links.map((l) => (
              <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="block truncate text-[13px] text-accent hover:underline">
                {l.label} ↗
              </a>
            ))}
          </div>
        )}
        <p className={cx("mt-4 text-[12px] text-ink-3", stage === "extraction" && "hidden")}>
          If the full text cannot be obtained, you can record the paper as <span className="font-medium text-ink-2">U1 — Not retrieved</span> using the decision
          panel. After adding a PDF named <span className="font-mono">&lt;Paper_ID&gt;.pdf</span> to <span className="font-mono">pdfs/</span>, use “Re-sync sources”.
        </p>
      </div>
    </div>
  );
}
