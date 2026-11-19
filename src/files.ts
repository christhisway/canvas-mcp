import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { optional, type CanvasClient } from "./canvas.js";
import { htmlToText } from "./format.js";
import type { CanvasFile, Course, Module } from "./types.js";

/** Largest file read_file will download. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Most text returned per call; PDFs stop at a page boundary so the next call can carry on. */
export const MAX_TEXT_CHARS = 40_000;

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|py|java|c|h|cpp|hpp|cs|js|ts|tsx|jsx|rb|go|rs|sql|r|m|sh|tex|ipynb)$/i;

type Kind = "pdf" | "html" | "text" | "unsupported";

export function fileKind(file: CanvasFile): Kind {
  const type = (file["content-type"] ?? "").toLowerCase();
  const name = file.display_name ?? file.filename ?? "";
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (type === "text/html" || /\.html?$/i.test(name)) return "html";
  if (type.startsWith("text/") || type === "application/json" || type === "application/xml" || TEXT_EXTENSIONS.test(name)) {
    return "text";
  }
  return "unsupported";
}

/**
 * Finds files in a course whose name contains `name`. Students are often shut out of the Files list (a
 * hidden Files tab gives 401/403) while files linked from modules stay readable, so module items are
 * searched too and their file objects fetched by id.
 */
export async function findFiles(canvas: CanvasClient, course: Course, name: string): Promise<CanvasFile[]> {
  const needle = name.toLowerCase();
  const [listed, modules] = await Promise.all([
    optional(canvas.getAll<CanvasFile>(`/courses/${course.id}/files`, { search_term: name.length >= 2 ? name : undefined }), []),
    optional(canvas.getAll<Module>(`/courses/${course.id}/modules`, { include: ["items"] }), []),
  ]);
  const found = new Map<number, CanvasFile>();
  for (const f of listed) if (f.display_name.toLowerCase().includes(needle)) found.set(f.id, f);
  const moduleFileIds = modules
    .flatMap((m) => m.items ?? [])
    .filter((i) => i.type === "File" && i.content_id !== undefined && i.title.toLowerCase().includes(needle))
    .map((i) => i.content_id as number)
    .filter((id) => !found.has(id));
  for (const id of new Set(moduleFileIds)) {
    const f = await optional<CanvasFile | undefined>(canvas.get<CanvasFile>(`/files/${id}`), undefined);
    if (f) found.set(f.id, f);
  }
  return [...found.values()];
}

/** Picks the file to read: the only match, or the one whose name matches exactly (with or without extension). */
export function pickFile(matches: CanvasFile[], name: string): CanvasFile | undefined {
  if (matches.length === 1) return matches[0];
  const want = name.trim().toLowerCase();
  const exact = matches.filter((f) => {
    const n = f.display_name.toLowerCase();
    return n === want || n.replace(/\.[^.]+$/, "") === want;
  });
  return exact.length === 1 ? exact[0] : undefined;
}

export interface ExtractResult {
  text: string;
  total_pages?: number;
  pages_returned?: string;
  note?: string;
}

/** Text of a PDF from `fromPage`, page by page with markers, stopping before MAX_TEXT_CHARS. */
export async function pdfText(bytes: Uint8Array, fromPage = 1, toPage?: number): Promise<ExtractResult> {
  const task = getDocument({ data: bytes, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const total = pdf.numPages;
    if (fromPage > total) return { text: "", total_pages: total, note: `The PDF has only ${total} pages.` };
    const last = Math.min(toPage ?? total, total);
    const parts: string[] = [];
    let length = 0;
    let stoppedAt: number | undefined;
    let anyText = false;
    for (let n = fromPage; n <= last; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      if (pageText) anyText = true;
      const chunk = `[page ${n}]\n${pageText}`;
      if (length + chunk.length > MAX_TEXT_CHARS && parts.length > 0) {
        stoppedAt = n;
        break;
      }
      // A single page longer than the limit still comes back, cut short.
      parts.push(chunk.length > MAX_TEXT_CHARS ? `${chunk.slice(0, MAX_TEXT_CHARS)}… [page truncated]` : chunk);
      length += chunk.length;
    }
    const end = stoppedAt ? stoppedAt - 1 : last;
    let note: string | undefined;
    if (stoppedAt) note = `Stopped after page ${end} to keep the reply short; call again with from_page ${stoppedAt} for the rest.`;
    else if (!anyText) note = "These pages have no text layer (probably scanned images), so there's nothing to extract.";
    return { text: parts.join("\n\n"), total_pages: total, pages_returned: `${fromPage}-${end}`, note };
  } finally {
    await task.destroy();
  }
}

export function plainText(bytes: Uint8Array, kind: "html" | "text"): ExtractResult {
  const raw = new TextDecoder("utf-8").decode(bytes);
  if (kind === "html") return { text: htmlToText(raw, MAX_TEXT_CHARS) ?? "" };
  if (raw.length <= MAX_TEXT_CHARS) return { text: raw };
  return { text: raw.slice(0, MAX_TEXT_CHARS), note: `Truncated: showing the first ${MAX_TEXT_CHARS} of ${raw.length} characters.` };
}

export function humanSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
