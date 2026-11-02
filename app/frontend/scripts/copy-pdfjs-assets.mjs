// Copies pdf.js runtime assets (CMaps, standard fonts, wasm decoders) into public/pdfjs
// so the viewer renders PDFs with non-embedded fonts or CJK text correctly.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dest = join(root, "public", "pdfjs");
mkdirSync(dest, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  if (existsSync(join(src, dir))) cpSync(join(src, dir), join(dest, dir), { recursive: true });
}
console.log("pdf.js assets copied to public/pdfjs");
