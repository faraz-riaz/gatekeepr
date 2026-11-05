import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// pdf_viewer.mjs reads `globalThis.pdfjsLib` when it is evaluated, so it is loaded dynamically
// after the global has been set.
(globalThis as unknown as { pdfjsLib: typeof pdfjsLib }).pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type ViewerModule = typeof import("pdfjs-dist/web/pdf_viewer.mjs");
export const viewerModule: Promise<ViewerModule> = import("pdfjs-dist/web/pdf_viewer.mjs");
export { pdfjsLib };

export const DOCUMENT_OPTIONS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  iccUrl: "/pdfjs/iccs/",
};

/** Imperative controls registered by the mounted PDF viewer (used by global keyboard shortcuts). */
export const viewerControls: {
  zoomIn?: () => void;
  zoomOut?: () => void;
  fitPage?: () => void;
  nextHighlight?: () => void;
  prevHighlight?: () => void;
  focusSearch?: () => void;
} = {};
