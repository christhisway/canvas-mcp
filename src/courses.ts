import type { CanvasClient } from "./canvas.js";
import type { Course } from "./types.js";

const CACHE_MS = 5 * 60 * 1000;

/**
 * True when the course is over. Canvas keeps a student's enrollment "active" after the term ends until
 * someone concludes it, so `enrollment_state=active` alone still returns old courses (issue #1).
 * A course with no end date anywhere (e.g. Canvas's "Default Term") counts as current.
 */
export function hasEnded(c: Course, now = Date.now()): boolean {
  if (c.concluded) return true;
  // Course dates only override the term's when the course is set to restrict enrollments to them.
  const end = (c.restrict_enrollments_to_course_dates && c.end_at) || c.term?.end_at;
  return Boolean(end && Date.parse(end) < now);
}

/**
 * Caches the course list and resolves a course from an id, a course code ("CS 240"),
 * or part of its name, so the model doesn't need numeric ids.
 */
export class CourseDirectory {
  private cache?: { at: number; courses: Course[] };

  constructor(private readonly canvas: CanvasClient) {}

  /** Every course with an active enrollment, including ones whose term is over. */
  async all(force = false): Promise<Course[]> {
    if (!force && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.courses;
    const courses = await this.canvas.getAll<Course>("/courses", {
      enrollment_state: "active",
      include: ["term", "total_scores", "concluded"],
    });
    // Canvas returns some restricted/concluded shells without a name; skip those.
    const usable = courses.filter((c) => c && typeof c.name === "string");
    this.cache = { at: Date.now(), courses: usable };
    return usable;
  }

  /** Current courses only: past-term courses are left out. */
  async active(force = false): Promise<Course[]> {
    return (await this.all(force)).filter((c) => !hasEnded(c));
  }

  async resolve(ref: string | number): Promise<Course> {
    const all = await this.all();
    const asNumber = typeof ref === "number" ? ref : /^\d+$/.test(ref.trim()) ? Number(ref) : undefined;
    if (asNumber !== undefined) {
      const hit = all.find((c) => c.id === asNumber);
      if (hit) return hit;
      // Not in the list at all (e.g. a concluded course): fetch it directly.
      return this.canvas.get<Course>(`/courses/${asNumber}`, { include: ["term", "total_scores"] });
    }

    // Current courses win; a past course is matched only when no current course is.
    const current = all.filter((c) => !hasEnded(c));
    const past = all.filter((c) => hasEnded(c));
    const needle = normalize(String(ref));
    for (const pool of [current, past]) {
      const exact = pool.filter((c) => normalize(c.course_code) === needle || normalize(c.name) === needle);
      if (exact.length === 1) return exact[0];
      const partial = pool.filter(
        (c) => normalize(c.course_code).includes(needle) || normalize(c.name).includes(needle),
      );
      if (partial.length === 1) return partial[0];
      if (partial.length > 1) {
        const options = partial.map(describe);
        throw new Error(`"${ref}" matches more than one course: ${options.join("; ")}. Use the course id.`);
      }
    }
    throw new Error(`No course matches "${ref}". Current courses: ${current.map(describe).join("; ")}`);
  }
}

const describe = (c: Course) => `${c.course_code} — ${c.name} (id ${c.id})`;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s._-]+/g, "");
}
