import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasError, optional, type CanvasClient } from "../canvas.js";
import { hasEnded, type CourseDirectory } from "../courses.js";
import { fileKind, findFiles, humanSize, MAX_FILE_BYTES, pdfText, pickFile, plainText } from "../files.js";
import {
  CANVAS_DEFAULT_SCALE, currentView, finalView, gradeCourse, letterFor, parseTarget, round2, scaleFrom, solveTarget,
  toGradeGroups, type GradeGroup, type GradeItem,
} from "../grades.js";
import { findSyllabus } from "../syllabus.js";
import { compact, errorResult, htmlToText, json, makeDateFormatter } from "../format.js";
import type { Assignment, AssignmentGroup, CanvasFile, Course, DiscussionTopic, GradingStandard, PlannerItem, Submission } from "../types.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const courseRef = z
  .string()
  .describe('Course id, course code, or part of the name (e.g. "CS 240" or "philosophy")');

export function registerReadTools(
  server: McpServer,
  deps: { canvas: CanvasClient; courses: CourseDirectory; timeZone: string },
) {
  const { canvas, courses } = deps;
  const date = makeDateFormatter(deps.timeZone);

  const studentEnrollment = (c: Course) => c.enrollments?.find((e) => e.type === "student") ?? c.enrollments?.[0];

  // Canvas's current score leaves out anything not graded yet, so missing work doesn't pull it down.
  // Its final score counts every ungraded assignment as zero, including ones not due yet (issue #2).
  const courseScores = (c: Course) => {
    const e = studentEnrollment(c);
    return {
      current_score: e?.computed_current_score,
      current_grade: e?.computed_current_grade,
      final_score: e?.computed_final_score,
      final_grade: e?.computed_final_grade,
    };
  };
  const SCORES_NOTE =
    "current_score counts graded work only, so missing work doesn't lower it; final_score counts every " +
    "ungraded assignment as zero, including ones not due yet.";

  const submissionSummary = (s: Submission | undefined) =>
    s &&
    compact({
      status: s.excused ? "excused" : s.missing ? "missing" : s.workflow_state,
      submitted_at: date(s.submitted_at),
      late: s.late || undefined,
      score: s.score,
      grade: s.grade,
      attempt: s.attempt,
    });

  const isDone = (s: Submission | undefined) =>
    Boolean(s && (s.submitted_at || s.excused || ["submitted", "graded", "pending_review"].includes(s.workflow_state)));

  const assignmentSummary = (a: Assignment) =>
    compact({
      id: a.id,
      name: a.name,
      due: date(a.due_at),
      points: a.points_possible,
      submission_types: a.submission_types,
      locked: a.locked_for_user || undefined,
      submission: submissionSummary(a.submission),
      url: a.html_url,
    });

  const wrap =
    <A,>(fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      try {
        return json(await fn(args));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };

  server.registerTool(
    "list_courses",
    {
      title: "List courses",
      description:
        "Lists the student's current Canvas courses with term and grade. Courses from terms that have ended " +
        "are left out unless include_past is true. " +
        SCORES_NOTE,
      inputSchema: {
        include_past: z
          .boolean()
          .default(false)
          .describe("Also list courses from terms that have ended (marked ended: true)"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ include_past }) => {
      const list = include_past ? await courses.all(true) : await courses.active(true);
      return list.map((c) =>
        compact({
          id: c.id,
          code: c.course_code,
          name: c.name,
          term: c.term?.name,
          ended: (include_past && hasEnded(c)) || undefined,
          ...courseScores(c),
        }),
      );
    }),
  );

  server.registerTool(
    "get_upcoming",
    {
      title: "What's due",
      description:
        "Everything on the student's Canvas planner in a date window across all courses: assignments, quizzes, " +
        "graded discussions, planner notes, with submitted/missing/graded status. Use this for \"what's due\" questions. " +
        "The planner only holds dated work, so assignments with no due date are listed separately in no_due_date.",
      inputSchema: {
        days_ahead: z.number().int().min(0).max(120).default(7).describe("How many days forward from now"),
        days_back: z
          .number()
          .int()
          .min(0)
          .max(60)
          .default(0)
          .describe("Also include this many past days (useful for catching missing work)"),
        include_done: z.boolean().default(false).describe("Include items already submitted or marked complete"),
        include_undated: z
          .boolean()
          .default(true)
          .describe("Also list assignments with no due date from every current course (one extra request per course)"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ days_ahead, days_back, include_done, include_undated }) => {
      const now = Date.now();
      const start = new Date(now - days_back * 86_400_000).toISOString();
      const end = new Date(now + days_ahead * 86_400_000).toISOString();
      const [items, undated] = await Promise.all([
        canvas.getAll<PlannerItem>("/planner/items", { start_date: start, end_date: end }),
        include_undated ? undatedAssignments(include_done) : undefined,
      ]);
      const dated = items
        .filter((i) => i.plannable_type !== "announcement")
        .map((i) => {
          const s = i.submissions || undefined;
          const done = Boolean(s?.submitted || s?.excused || i.planner_override?.marked_complete);
          return { item: i, done };
        })
        .filter(({ done }) => include_done || !done)
        .sort((a, b) => a.item.plannable_date.localeCompare(b.item.plannable_date))
        .map(({ item: i, done }) => {
          const s = i.submissions || undefined;
          return compact({
            course: i.context_name,
            course_id: i.course_id,
            type: i.plannable_type,
            id: i.plannable_id,
            title: i.plannable.title,
            due: date(i.plannable.due_at ?? i.plannable.todo_date ?? i.plannable_date),
            points: i.plannable.points_possible,
            done,
            missing: s?.missing || undefined,
            late: s?.late || undefined,
            graded: s?.graded || undefined,
            has_feedback: s?.has_feedback || undefined,
            url: i.html_url ? canvas.webUrl(i.html_url) : undefined,
          });
        });
      return compact({ items: dated, no_due_date: undated });
    }),
  );

  /** Assignments with no due date never reach the planner (issue #4), so ask each current course for them. */
  async function undatedAssignments(includeDone: boolean) {
    const current = await courses.active();
    const perCourse = await Promise.all(
      current.map(async (c) => {
        try {
          const list = await canvas.getAll<Assignment>(`/courses/${c.id}/assignments`, {
            include: ["submission"],
            bucket: "undated",
          });
          return list
            .filter((a) => !a.due_at && (includeDone || !isDone(a.submission)))
            .map((a) =>
              compact({
                course: c.name,
                course_id: c.id,
                type: "assignment",
                id: a.id,
                title: a.name,
                points: a.points_possible,
                done: isDone(a.submission),
                locked: a.locked_for_user || undefined,
                missing: a.submission?.missing || undefined,
                url: a.html_url,
              }),
            );
        } catch (err) {
          // One course refusing (e.g. a 403) shouldn't hide what's due everywhere else.
          if (err instanceof CanvasError) return [];
          throw err;
        }
      }),
    );
    return perCourse.flat();
  }

  server.registerTool(
    "list_assignments",
    {
      title: "List assignments",
      description: "Lists assignments in one course with due dates and the student's submission status.",
      inputSchema: {
        course: courseRef,
        filter: z
          .enum(["all", "upcoming", "overdue", "unsubmitted", "past", "undated", "ungraded", "future"])
          .default("all")
          .describe("Canvas assignment bucket"),
        search: z.string().optional().describe("Only assignments whose name contains this text"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, filter, search }) => {
      const c = await courses.resolve(course);
      const list = await canvas.getAll<Assignment>(`/courses/${c.id}/assignments`, {
        include: ["submission"],
        order_by: "due_at",
        bucket: filter === "all" ? undefined : filter,
        search_term: search && search.length >= 2 ? search : undefined,
      });
      return { course: `${c.course_code} — ${c.name}`, course_id: c.id, assignments: list.map(assignmentSummary) };
    }),
  );

  server.registerTool(
    "get_assignment",
    {
      title: "Get assignment",
      description:
        "Full details for one assignment: instructions, due/lock dates, allowed submission types and file " +
        "extensions, and the student's current submission with grader comments.",
      inputSchema: {
        course: courseRef,
        assignment_id: z.number().int().describe("Assignment id"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, assignment_id }) => {
      const c = await courses.resolve(course);
      const [a, sub] = await Promise.all([
        canvas.get<Assignment>(`/courses/${c.id}/assignments/${assignment_id}`),
        canvas
          .get<Submission>(`/courses/${c.id}/assignments/${assignment_id}/submissions/self`, {
            include: ["submission_comments"],
          })
          .catch(() => undefined),
      ]);
      return compact({
        course: `${c.course_code} — ${c.name}`,
        course_id: c.id,
        id: a.id,
        name: a.name,
        due: date(a.due_at),
        available_from: date(a.unlock_at),
        available_until: date(a.lock_at),
        points: a.points_possible,
        submission_types: a.submission_types,
        allowed_extensions: a.allowed_extensions,
        allowed_attempts: a.allowed_attempts === -1 ? "unlimited" : a.allowed_attempts,
        locked: a.locked_for_user || undefined,
        lock_explanation: a.lock_explanation ? htmlToText(a.lock_explanation, 500) : undefined,
        instructions: htmlToText(a.description),
        submission: sub && {
          ...submissionSummary(sub),
          comments: sub.submission_comments?.map((m) => ({ from: m.author_name, at: date(m.created_at), text: m.comment })),
        },
        url: a.html_url,
      });
    }),
  );

  server.registerTool(
    "get_grades",
    {
      title: "Get grades",
      description:
        "Grade breakdown for one course: overall scores, assignment groups with weights, each graded " +
        "assignment's score, and assignments Canvas marks missing. " +
        SCORES_NOTE +
        " group_score_percent also counts graded work only; check each group's missing list.",
      inputSchema: { course: courseRef },
      annotations: READ_ONLY,
    },
    wrap(async ({ course }) => {
      const c = await courses.resolve(course);
      const groups = await canvas.getAll<AssignmentGroup>(`/courses/${c.id}/assignment_groups`, {
        include: ["assignments", "submission"],
      });
      const missing = (g: AssignmentGroup) => (g.assignments ?? []).filter((a) => a.submission?.missing);
      return compact({
        course: `${c.course_code} — ${c.name}`,
        ...courseScores(c),
        missing_count: groups.reduce((n, g) => n + missing(g).length, 0) || undefined,
        groups: groups.map((g) => {
          const graded = (g.assignments ?? []).filter((a) => a.submission && a.submission.score !== null);
          const earned = graded.reduce((sum, a) => sum + (a.submission?.score ?? 0), 0);
          const possible = graded.reduce((sum, a) => sum + (a.points_possible ?? 0), 0);
          return compact({
            name: g.name,
            weight_percent: g.group_weight || undefined,
            group_score_percent: possible > 0 ? Math.round((earned / possible) * 1000) / 10 : undefined,
            graded: graded.map((a) =>
              compact({
                name: a.name,
                score: a.submission?.score,
                out_of: a.points_possible,
                grade: a.submission?.grade,
                late: a.submission?.late || undefined,
              }),
            ),
            ungraded_count: (g.assignments ?? []).length - graded.length || undefined,
            missing: missing(g).map((a) =>
              compact({ name: a.name, due: date(a.due_at), points: a.points_possible, score: a.submission?.score }),
            ),
          });
        }),
      });
    }),
  );

  server.registerTool(
    "grade_whatif",
    {
      title: "Grade what-if",
      description:
        "Projects a course grade. Give target (a letter like \"B+\" or a percentage) to get the average needed " +
        "on the remaining ungraded work, or hypotheticals (scores for named assignments) to see the grade they'd " +
        "give; both can be used together. Uses the course's group weights, drop rules and letter scale, and " +
        "computes locally (nothing is changed in Canvas). " +
        SCORES_NOTE,
      inputSchema: {
        course: courseRef,
        target: z.string().optional().describe('Goal for the course: a letter ("B+") or a percentage ("87" or "87%")'),
        hypotheticals: z
          .array(
            z.object({
              assignment_id: z.number().int().optional(),
              name: z.string().optional().describe("Part of the assignment's name, if no assignment_id"),
              score: z
                .union([z.number(), z.string().regex(/^\s*\d+(\.\d+)?\s*%\s*$/)])
                .describe('Points (e.g. 42), or a percentage of the points as a string (e.g. "85%")'),
            }),
          )
          .optional()
          .describe("Scores to assume, including for work already graded"),
        count_missing_as_zero: z
          .boolean()
          .default(true)
          .describe("Count work Canvas marks missing as 0 instead of as still to do"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, target, hypotheticals, count_missing_as_zero }) => {
      const c = await courses.resolve(course);
      const [full, canvasGroups] = await Promise.all([
        canvas.get<Course>(`/courses/${c.id}`, { include: ["total_scores"] }),
        canvas.getAll<AssignmentGroup>(`/courses/${c.id}/assignment_groups`, {
          include: ["assignments", "submission"],
        }),
      ]);
      const weighted = Boolean(full.apply_assignment_group_weights);
      const groups = toGradeGroups(canvasGroups);
      const notes: string[] = [];

      let scale = CANVAS_DEFAULT_SCALE;
      let scaleSource = "Canvas default";
      if (full.grading_standard_id) {
        const standards = await optional(canvas.getAll<GradingStandard>(`/courses/${c.id}/grading_standards`), []);
        const own = standards.find((s) => s.id === full.grading_standard_id);
        if (own?.grading_scheme?.length) {
          scale = scaleFrom(own);
          scaleSource = `course ("${own.title}")`;
        } else {
          notes.push("Couldn't read the course's own letter scale, so letters use Canvas's default scale.");
        }
      }

      // Hypothetical scores, keyed by assignment id.
      const items = groups.flatMap((g) => g.items);
      const assumed = new Map<number, number>();
      const assumedOut = (hypotheticals ?? []).map((h) => {
        const item = findItem(items, h.assignment_id, h.name);
        const score = typeof h.score === "number" ? h.score : (parseFloat(h.score) / 100) * item.points;
        assumed.set(item.id, score);
        return compact({ id: item.id, name: item.name, score: round2(score), out_of: item.points, excused_now: item.excused || undefined });
      });
      // An assumed score overrides an excusal too.
      const withAssumed = groups.map((g) => ({
        ...g,
        items: g.items.map((i) => (assumed.has(i.id) ? { ...i, score: assumed.get(i.id)!, excused: false } : i)),
      }));

      const view = (gs: GradeGroup[], fn: typeof currentView) => {
        const r = gradeCourse(gs, weighted, fn);
        return { result: r, out: compact({ percent: r.percent === null ? undefined : round2(r.percent), letter: letterFor(r.percent, scale) }) };
      };
      const now = { current: view(groups, currentView), final: view(groups, finalView) };

      const e = studentEnrollment(full) ?? studentEnrollment(c);
      const canvasCurrent = e?.computed_current_score;
      if (typeof canvasCurrent === "number" && now.current.result.percent !== null) {
        if (Math.abs(round2(now.current.result.percent) - canvasCurrent) > 0.01) {
          notes.push(
            `This tool's current score (${round2(now.current.result.percent)}) differs from Canvas's (${canvasCurrent}); ` +
              "the course may use settings students can't see, so treat projections as approximate.",
          );
        }
      }

      let projected: Record<string, unknown> | undefined;
      if (assumed.size > 0) {
        projected = { current: view(withAssumed, currentView).out, final: view(withAssumed, finalView).out };
      }

      let targetOut: Record<string, unknown> | undefined;
      if (target !== undefined) {
        const goal = parseTarget(target, scale);
        const remainingItems = withAssumed
          .flatMap((g) => g.items)
          .filter((i) => i.score === null && !i.excused && i.points > 0 && !(count_missing_as_zero && i.missing));
        const remaining = new Set(remainingItems.map((i) => i.id));
        const r = solveTarget(withAssumed, weighted, goal, remaining, finalView);
        const zeroed = count_missing_as_zero
          ? withAssumed.flatMap((g) => g.items).filter((i) => i.score === null && !i.excused && i.missing)
          : [];
        targetOut = compact({
          target: target.trim(),
          target_percent: r.target_percent,
          needed_average_percent: r.needed_percent,
          reachable: r.reachable,
          already_secured: r.already_secured || undefined,
          best_possible: r.best_possible,
          worst_possible: r.worst_possible,
          note: r.already_secured
            ? "Reached even with 0 on everything remaining."
            : !r.reachable
              ? `Unreachable: 100% on everything remaining gives ${r.best_possible ?? "no grade"}.`
              : `Needs an average of ${r.needed_percent}% on the remaining work (every remaining item at that percentage).`,
          remaining: remainingItems.map((i) => ({ id: i.id, name: i.name, points: i.points })),
          counted_as_zero: zeroed.length ? zeroed.map((i) => ({ id: i.id, name: i.name, points: i.points })) : undefined,
        });
      }

      const finalGroups = now.final.result.groups;
      return compact({
        course: `${c.course_code} — ${c.name}`,
        weighted,
        letter_scale: scaleSource,
        canvas: compact({
          current_score: e?.computed_current_score,
          current_grade: e?.computed_current_grade,
          final_score: e?.computed_final_score,
          final_grade: e?.computed_final_grade,
        }),
        now: { current: now.current.out, final: now.final.out },
        hypotheticals: assumedOut.length ? assumedOut : undefined,
        projected,
        target: targetOut,
        groups: now.current.result.groups.map((r, i) =>
          compact({
            name: r.group.name,
            weight_percent: weighted ? r.group.weight : undefined,
            current_percent: r.percent === null ? undefined : round2(r.percent),
            final_percent: finalGroups[i].percent === null ? undefined : round2(finalGroups[i].percent!),
            drops: r.group.drop_lowest || r.group.drop_highest
              ? compact({ lowest: r.group.drop_lowest || undefined, highest: r.group.drop_highest || undefined })
              : undefined,
            dropped_now: r.dropped.length ? r.dropped.map((d) => d.name) : undefined,
          }),
        ),
        notes: notes.length ? notes : undefined,
      });
    }),
  );

  server.registerTool(
    "list_announcements",
    {
      title: "List announcements",
      description: "Recent announcements, from one course or from all current courses.",
      inputSchema: {
        course: courseRef.optional().describe("Leave out for all current courses"),
        days: z.number().int().min(1).max(120).default(14).describe("How many days back"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, days }) => {
      const scope = course ? [await courses.resolve(course)] : await courses.active();
      if (scope.length === 0) return [];
      const byCode = new Map(scope.map((c) => [`course_${c.id}`, c]));
      const topics = await canvas.getAll<DiscussionTopic>("/announcements", {
        context_codes: [...byCode.keys()],
        start_date: new Date(Date.now() - days * 86_400_000).toISOString(),
        end_date: new Date().toISOString(),
      });
      return topics
        .sort((a, b) => (b.posted_at ?? "").localeCompare(a.posted_at ?? ""))
        .map((t) => {
          const c = t.context_code ? byCode.get(t.context_code) : undefined;
          return compact({
            course: c?.course_code,
            title: t.title,
            posted: date(t.posted_at),
            author: t.author?.display_name ?? t.user_name,
            message: htmlToText(t.message, 2500),
            url: t.html_url,
          });
        });
    }),
  );

  server.registerTool(
    "get_syllabus",
    {
      title: "Get syllabus",
      description:
        "The course's syllabus as text. If the syllabus page is empty, looks for a page, file or module item " +
        "with \"syllabus\" in its name: a matching page's text is returned, and files come back in matches " +
        "with a file_id to pass to read_file.",
      inputSchema: { course: courseRef },
      annotations: READ_ONLY,
    },
    wrap(async ({ course }) => {
      const c = await courses.resolve(course);
      return { course: `${c.course_code} — ${c.name}`, ...(await findSyllabus(canvas, c)) };
    }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read course file",
      description:
        "Returns the text of a file in a course: PDFs (lecture slides, handouts, readings), plain text, " +
        "code and HTML. Name the file by file_id or by part of its name; if several files match, they're " +
        "listed so you can call again with a file_id. Leave out both to list the course's files. Long PDFs " +
        "come back in parts marked [page N]: follow the note and call again with from_page. Other formats " +
        "(Word, PowerPoint, images) and files over 25 MB return only their details and link.",
      inputSchema: {
        course: courseRef,
        file_id: z.number().int().optional().describe("Canvas file id (from a previous call or get_syllabus)"),
        name: z.string().optional().describe('Part of the file name, e.g. "lecture 5" or "syllabus"'),
        from_page: z.number().int().min(1).default(1).describe("PDFs: first page to read"),
        to_page: z.number().int().min(1).optional().describe("PDFs: last page to read (default: as far as fits)"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, file_id, name, from_page, to_page }) => {
      const c = await courses.resolve(course);
      const label = `${c.course_code} — ${c.name}`;
      const fileInfo = (f: CanvasFile) =>
        compact({
          file_id: f.id,
          name: f.display_name,
          size: humanSize(f.size),
          updated: date(f.updated_at),
          url: canvas.webUrl(`/courses/${c.id}/files/${f.id}`),
        });

      let file: CanvasFile | undefined;
      if (file_id !== undefined) {
        file = await canvas.get<CanvasFile>(`/files/${file_id}`);
      } else if (name?.trim()) {
        const matches = await findFiles(canvas, c, name.trim());
        if (matches.length === 0) {
          return { course: label, note: `No file in this course has "${name}" in its name (that the student can see).` };
        }
        file = pickFile(matches, name);
        if (!file) {
          return { course: label, note: "Several files match; call again with one file_id.", matches: matches.map(fileInfo) };
        }
      } else {
        const files = await optional(canvas.getAll<CanvasFile>(`/courses/${c.id}/files`, { sort: "updated_at", order: "desc" }), undefined);
        if (!files) return { course: label, note: "The Files list is hidden in this course; search by name to find files linked from modules." };
        return { course: label, files: files.slice(0, 100).map(fileInfo), more: files.length > 100 ? files.length - 100 : undefined };
      }

      const info = fileInfo(file);
      const kind = fileKind(file);
      if (file.locked_for_user || !file.url) {
        return { course: label, file: info, note: file.lock_explanation ? htmlToText(file.lock_explanation, 500) : "This file is locked." };
      }
      if (kind === "unsupported") {
        return { course: label, file: info, note: `Can't read ${file["content-type"] ?? "this type of file"} yet; open it with the url.` };
      }
      if (file.size !== undefined && file.size > MAX_FILE_BYTES) {
        return { course: label, file: info, note: `Too big to read here (over ${humanSize(MAX_FILE_BYTES)}); open it with the url.` };
      }
      const { bytes } = await canvas.download(file.url, MAX_FILE_BYTES);
      const extracted = kind === "pdf" ? await pdfText(bytes, from_page, to_page) : plainText(bytes, kind);
      return compact({ course: label, file: info, ...extracted });
    }),
  );
}

/** An assignment by id, or by exact (then partial) name, for grade_whatif's hypotheticals. */
function findItem(items: GradeItem[], id: number | undefined, name: string | undefined): GradeItem {
  if (id !== undefined) {
    const hit = items.find((i) => i.id === id);
    if (!hit) throw new Error(`No graded assignment with id ${id} in this course.`);
    return hit;
  }
  const needle = name?.trim().toLowerCase();
  if (!needle) throw new Error("Each hypothetical needs an assignment_id or a name.");
  const exact = items.filter((i) => i.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const partial = items.filter((i) => i.name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0) throw new Error(`No graded assignment in this course has "${name}" in its name.`);
  throw new Error(
    `"${name}" matches more than one assignment: ${partial.map((i) => `${i.name} (id ${i.id})`).join("; ")}. Use assignment_id.`,
  );
}
