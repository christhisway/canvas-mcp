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
/** The student-type enrollment types Canvas uses on a course's enrollments (course list) or users. */
const STUDENT_TYPES = new Set(["student", "StudentEnrollment"]);

/**
 * False when the user's only enrollments in a course aren't student ones (e.g. a TA in an old course), so
 * student-only endpoints such as /students/submissions would 403 (issue #25). Unknown counts as a student.
 */
export function isStudent(c: Course): boolean {
  if (!c.enrollments?.length) return true;
  return c.enrollments.some((e) => STUDENT_TYPES.has(e.type));
}

/** A plain error to raise before calling a student-only endpoint on a course where the user isn't one. */
export function notStudentError(c: Course, what: string): Error {
  const roles = [...new Set((c.enrollments ?? []).map((e) => e.type.replace(/Enrollment$/, "").toLowerCase()))].map((r) => (r === "ta" ? "TA" : r));
  const role = roles.length ? roles.join(" and ") : "something other than a student";
  return new Error(`You're enrolled in ${c.course_code} as ${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}, not a student, so there's no ${what} to show.`);
}

export class CourseDirectory {
  private cache?: { at: number; courses: Course[] };
  private completedCache?: { at: number; courses: Course[] };

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

  /**
   * Courses whose enrollment Canvas has concluded ("completed"). These aren't in all(): most old inbox
   * conversations belong to them (issue #17), so they're fetched only when a name doesn't match otherwise.
   */
  async completed(force = false): Promise<Course[]> {
    if (!force && this.completedCache && Date.now() - this.completedCache.at < CACHE_MS) return this.completedCache.courses;
    const courses = await this.canvas.getAll<Course>("/courses", {
      enrollment_state: "completed",
      include: ["term", "total_scores", "concluded"],
    });
    const known = new Set((await this.all()).map((c) => c.id));
    const usable = courses.filter((c) => c && typeof c.name === "string" && !known.has(c.id)).map((c) => ({ ...c, concluded: true }));
    this.completedCache = { at: Date.now(), courses: usable };
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

    // Current courses win; a past course is matched only when no current course is, and a concluded
    // enrollment only when neither is.
    const current = all.filter((c) => !hasEnded(c));
    const past = all.filter((c) => hasEnded(c));
    const needle = normalize(String(ref));
    const pools: Array<Course[] | (() => Promise<Course[]>)> = [current, past, () => this.completed().catch(() => [])];
    for (const entry of pools) {
      const pool = typeof entry === "function" ? await entry() : entry;
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
    throw new Error(
      `No course matches "${ref}", including past courses. Current courses: ${current.map(describe).join("; ")}. ` +
        "A course id works for any course.",
    );
  }
}

const describe = (c: Course) => `${c.course_code} — ${c.name} (id ${c.id})`;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s._-]+/g, "");
}
