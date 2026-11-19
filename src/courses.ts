import type { CanvasClient } from "./canvas.js";
import type { Course } from "./types.js";

const CACHE_MS = 5 * 60 * 1000;

/**
 * Caches the active course list and resolves a course from an id, a course
 * code ("CS 240"), or part of its name, so the model doesn't need numeric ids.
 */
export class CourseDirectory {
  private cache?: { at: number; courses: Course[] };

  constructor(private readonly canvas: CanvasClient) {}

  async active(force = false): Promise<Course[]> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.courses;
    const courses = await this.canvas.getAll<Course>("/courses", {
      enrollment_state: "active",
      include: ["term", "total_scores"],
    });
    // Canvas returns some restricted/concluded shells without a name; skip those.
    const usable = courses.filter((c) => c && typeof c.name === "string");
    this.cache = { at: Date.now(), courses: usable };
    return usable;
  }

  async resolve(ref: string | number): Promise<Course> {
    const courses = await this.active();
    const asNumber = typeof ref === "number" ? ref : /^\d+$/.test(ref.trim()) ? Number(ref) : undefined;
    if (asNumber !== undefined) {
      const hit = courses.find((c) => c.id === asNumber);
      if (hit) return hit;
      // Not in the active list (e.g. a past course): fetch it directly.
      return this.canvas.get<Course>(`/courses/${asNumber}`, { include: ["term", "total_scores"] });
    }

    const needle = normalize(String(ref));
    const exact = courses.filter((c) => normalize(c.course_code) === needle || normalize(c.name) === needle);
    if (exact.length === 1) return exact[0];
    const partial = courses.filter(
      (c) => normalize(c.course_code).includes(needle) || normalize(c.name).includes(needle),
    );
    if (partial.length === 1) return partial[0];

    const options = (partial.length ? partial : courses).map((c) => `${c.course_code} — ${c.name} (id ${c.id})`);
    throw new Error(
      partial.length
        ? `"${ref}" matches more than one course: ${options.join("; ")}. Use the course id.`
        : `No active course matches "${ref}". Active courses: ${options.join("; ")}`,
    );
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s._-]+/g, "");
}
