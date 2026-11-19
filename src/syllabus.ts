import { CanvasError, type CanvasClient } from "./canvas.js";
import { htmlToText } from "./format.js";
import type { CanvasFile, Course, Module, Page } from "./types.js";

const MAX_CHARS = 15000;
const SYLLABUS = /syllabus/i;

export interface SyllabusMatch {
  type: string;
  name: string;
  url?: string;
  updated?: string | null;
}

/**
 * The course's syllabus page, or, when that's empty, whatever looks like a syllabus elsewhere in the
 * course (issue #3): files, pages and module items with "syllabus" in the name. A matching page's text
 * is returned inline; files are only linked, since reading PDFs/DOCX is a separate feature.
 */
export async function findSyllabus(canvas: CanvasClient, course: Course) {
  const id = course.id;
  const full = await canvas.get<Course>(`/courses/${id}`, { include: ["syllabus_body"] });
  const body = htmlToText(full.syllabus_body, MAX_CHARS);
  if (body) return { source: "syllabus page", syllabus: body };

  // Students can be shut out of any one of these (e.g. a hidden Files tab gives 401/403), so each is optional.
  const [files, pages, modules] = await Promise.all([
    optional(canvas.getAll<CanvasFile>(`/courses/${id}/files`, { search_term: "syllabus" }), []),
    optional(canvas.getAll<Page>(`/courses/${id}/pages`, { search_term: "syllabus" }), []),
    optional(canvas.getAll<Module>(`/courses/${id}/modules`, { include: ["items"], search_term: "syllabus" }), []),
  ]);

  const matches: SyllabusMatch[] = [];
  const fileIds = new Set<number>();
  const pageSlugs: string[] = [];
  for (const f of files) {
    fileIds.add(f.id);
    matches.push({ type: "file", name: f.display_name, url: canvas.webUrl(`/courses/${id}/files/${f.id}`), updated: f.updated_at });
  }
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
    matches.push({ type: `module item (${item.type})`, name: item.title, url: item.html_url ?? item.external_url });
  }

  for (const slug of pageSlugs) {
    const page = await optional<Page | undefined>(canvas.get<Page>(`/courses/${id}/pages/${encodeURIComponent(slug)}`), undefined);
    const text = htmlToText(page?.body, MAX_CHARS);
    if (page && text) {
      return {
        source: `page "${page.title}"`,
        syllabus: text,
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

/** Treats "you can't see this" (401/403/404) as `fallback`; anything else still fails the call. */
async function optional<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof CanvasError && [401, 403, 404].includes(err.status)) return fallback;
    throw err;
  }
}
