import { optional, type CanvasClient } from "./canvas.js";
import { htmlToText } from "./format.js";
import { modulesWithItems } from "./modules.js";
import type { CanvasFile, Course, Page } from "./types.js";

const MAX_CHARS = 15000;
const SYLLABUS = /syllabus/i;
/** A page whose text, links aside, is shorter than this is treated as a list of links (issue #20). */
const LINKS_ONLY_CHARS = 80;

export interface SyllabusMatch {
  type: string;
  name: string;
  file_id?: number;
  url?: string;
  updated?: string | null;
}

/** One window of a long text, with a note on how to read the next one. */
function window(text: string, fromChar: number) {
  if (fromChar >= text.length) {
    return { syllabus: "", note: `The text is only ${text.length} characters long; call again with a smaller from_char.` };
  }
  const end = fromChar + MAX_CHARS;
  const part = text.slice(fromChar, end);
  return {
    syllabus: part,
    chars: fromChar > 0 || end < text.length ? `${fromChar}-${Math.min(end, text.length)} of ${text.length}` : undefined,
    note: end < text.length ? `Cut off at character ${end}; call again with from_char ${end} for the rest.` : undefined,
  };
}

/** Course files linked from a page's HTML (`/files/<id>` links), with a file_id for read_file. */
export function linkedFiles(canvas: CanvasClient, courseId: number, html: string | null | undefined): SyllabusMatch[] {
  if (!html) return [];
  const out: SyllabusMatch[] = [];
  const seen = new Set<number>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const id = attrs.match(/\b(?:href|data-api-endpoint)\s*=\s*["'][^"']*\/files\/(\d+)/i)?.[1];
    if (!id || seen.has(Number(id))) continue;
    seen.add(Number(id));
    const title = attrs.match(/\btitle\s*=\s*["']([^"']+)["']/i)?.[1];
    const name = htmlToText(m[2], 300) || title || `file ${id}`;
    out.push({ type: "linked file", name, file_id: Number(id), url: canvas.webUrl(`/courses/${courseId}/files/${id}`) });
  }
  return out;
}

async function syllabusFiles(canvas: CanvasClient, id: number): Promise<SyllabusMatch[]> {
  const files = await optional(canvas.getAll<CanvasFile>(`/courses/${id}/files`, { search_term: "syllabus" }), []);
  return files.map((f) => ({ type: "file", name: f.display_name, file_id: f.id, url: canvas.webUrl(`/courses/${id}/files/${f.id}`), updated: f.updated_at }));
}

/**
 * The course's syllabus page, or, when that's empty, whatever looks like a syllabus elsewhere in the
 * course (issue #3): files, pages and module items with "syllabus" in the name. A matching page's text
 * is returned inline; files come back with a file_id for read_file. Long text comes back in windows of
 * MAX_CHARS starting at fromChar, and files linked from the syllabus page are listed (issue #20).
 */
export async function findSyllabus(canvas: CanvasClient, course: Course, fromChar = 0) {
  const id = course.id;
  const full = await canvas.get<Course>(`/courses/${id}`, { include: ["syllabus_body"] });
  const body = htmlToText(full.syllabus_body, Infinity);
  if (body) {
    const linked = linkedFiles(canvas, id, full.syllabus_body);
    const bare = htmlToText(full.syllabus_body!.replace(/<a\b[\s\S]*?<\/a>/gi, ""), Infinity) ?? "";
    const part = window(body, fromChar);
    // A page that's only links, or one too long to return at once, may have its real syllabus in Files.
    const linksOnly = linked.length > 0 && bare.length < LINKS_ONLY_CHARS;
    let matches: SyllabusMatch[] | undefined;
    if (linksOnly || part.note) {
      const linkedIds = new Set(linked.map((l) => l.file_id));
      matches = (await syllabusFiles(canvas, id)).filter((f) => !linkedIds.has(f.file_id));
    }
    const pick = linksOnly ? linked.find((l) => SYLLABUS.test(l.name)) ?? linked[0] : undefined;
    return {
      source: linksOnly ? "syllabus page (links only)" : "syllabus page",
      ...part,
      note: pick
        ? `The syllabus page only links to files; read "${pick.name}" with read_file and file_id ${pick.file_id}.`
        : part.note,
      linked_files: linked.length ? linked : undefined,
      matches: matches?.length ? matches : undefined,
    };
  }

  // Students can be shut out of any one of these (e.g. a hidden Files tab gives 401/403), so each is optional.
  const [files, pages, modules] = await Promise.all([
    syllabusFiles(canvas, id),
    optional(canvas.getAll<Page>(`/courses/${id}/pages`, { search_term: "syllabus" }), []),
    optional(modulesWithItems(canvas, id, { search_term: "syllabus" }), []),
  ]);

  const matches: SyllabusMatch[] = [...files];
  const fileIds = new Set(files.map((f) => f.file_id));
  const pageSlugs: string[] = [];
  for (const p of pages) {
    pageSlugs.push(p.url);
    matches.push({ type: "page", name: p.title, url: p.html_url, updated: p.updated_at });
  }
  // With items included, a module whose *name* matches comes back with all its items; keep only matching titles.
  for (const item of modules.flatMap((m) => m.items ?? [])) {
    if (!SYLLABUS.test(item.title)) continue;
    if (item.type === "File" && item.content_id !== undefined && fileIds.has(item.content_id)) continue;
    if (item.type === "Page" && item.page_url) {
      if (pageSlugs.includes(item.page_url)) continue;
      pageSlugs.push(item.page_url);
    }
    matches.push({ type: `module item (${item.type})`, name: item.title, file_id: item.type === "File" ? item.content_id : undefined, url: item.html_url ?? item.external_url });
  }

  for (const slug of pageSlugs) {
    const page = await optional<Page | undefined>(canvas.get<Page>(`/courses/${id}/pages/${encodeURIComponent(slug)}`), undefined);
    const text = htmlToText(page?.body, Infinity);
    if (page && text) {
      const linked = linkedFiles(canvas, id, page.body);
      return {
        source: `page "${page.title}"`,
        ...window(text, fromChar),
        linked_files: linked.length ? linked : undefined,
        other_matches: matches.filter((m) => m.url !== page.html_url && m.name !== page.title),
      };
    }
  }

  return {
    source: "none",
    syllabus: matches.length
      ? "(the syllabus page is empty; see matches for files or module items named \"syllabus\")"
      : "(no syllabus page on Canvas, and no file, page or module item named \"syllabus\")",
    matches,
  };
}
