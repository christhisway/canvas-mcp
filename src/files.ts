import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { optional, type CanvasClient } from "./canvas.js";
import { htmlToText } from "./format.js";
import { modulesWithItems } from "./modules.js";
import type { CanvasFile, Course } from "./types.js";

/** Largest file read_file will download. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Most text returned per call; PDFs stop at a page boundary so the next call can carry on. */
export const MAX_TEXT_CHARS = 20_000;

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|py|java|c|h|cpp|hpp|cs|js|ts|tsx|jsx|rb|go|rs|sql|r|m|sh|tex|ipynb)$/i;

type Kind = "pdf" | "html" | "text" | "unsupported";

/** A name a person would use for a file type read_file can't read (issue #21). */
export function friendlyType(file: CanvasFile): string {
  const type = (file["content-type"] ?? "").toLowerCase();
  const name = (file.display_name ?? file.filename ?? "").toLowerCase();
  const ext = name.match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (type.includes("wordprocessingml") || type === "application/msword" || ["doc", "docx"].includes(ext)) return "Word documents";
  if (type.includes("presentationml") || type === "application/vnd.ms-powerpoint" || ["ppt", "pptx"].includes(ext)) return "PowerPoint files";
  if (type.includes("spreadsheetml") || type === "application/vnd.ms-excel" || ["xls", "xlsx"].includes(ext)) return "Excel spreadsheets";
  if (type.startsWith("image/")) return "images";
  if (type.startsWith("video/")) return "videos";
  if (type.startsWith("audio/")) return "audio files";
  if (type === "application/zip" || ext === "zip") return "zip files";
  return ext ? `.${ext} files` : "this type of file";
}

// Control characters (except tab and newline) that some PDFs carry in their text layer.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** True for a page that's mostly short labels, as maps, charts and diagrams are. */
function looksLikeDiagram(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 40) return false;
  const short = lines.filter((l) => l.length <= 12).length;
  return short / lines.length >= 0.7;
}

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
    optional(modulesWithItems(canvas, course.id), []),
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
    const diagrams: number[] = [];
    for (let n = fromPage; n <= last; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .replace(CONTROL, "")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      if (looksLikeDiagram(pageText)) diagrams.push(n);
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
    const notes: string[] = [];
    if (stoppedAt) notes.push(`Stopped after page ${end} to keep the reply short; call again with from_page ${stoppedAt} for the rest.`);
    else if (end < total) notes.push(`Pages ${end + 1}-${total} weren't read; call again with from_page ${end + 1} for the rest.`);
    if (!anyText) notes.push("These pages have no text layer (probably scanned images), so there's nothing to extract.");
    const shown = diagrams.filter((n) => n <= end);
    if (shown.length) {
      notes.push(`Page${shown.length > 1 ? "s" : ""} ${shown.join(", ")} look${shown.length > 1 ? "" : "s"} like a map or diagram; the text is its labels only.`);
    }
    return { text: parts.join("\n\n"), total_pages: total, pages_returned: `${fromPage}-${end}`, note: notes.length ? notes.join(" ") : undefined };
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
