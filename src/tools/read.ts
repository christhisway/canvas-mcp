import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CanvasClient } from "../canvas.js";
import { hasEnded, type CourseDirectory } from "../courses.js";
import { findSyllabus } from "../syllabus.js";
import { compact, errorResult, htmlToText, json, makeDateFormatter } from "../format.js";
import type { Assignment, AssignmentGroup, Course, DiscussionTopic, PlannerItem, Submission } from "../types.js";

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
        "graded discussions, planner notes, with submitted/missing/graded status. Use this for \"what's due\" questions.",
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
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ days_ahead, days_back, include_done }) => {
      const now = Date.now();
      const start = new Date(now - days_back * 86_400_000).toISOString();
      const end = new Date(now + days_ahead * 86_400_000).toISOString();
      const items = await canvas.getAll<PlannerItem>("/planner/items", { start_date: start, end_date: end });
      return items
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
    }),
  );

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
        "with \"syllabus\" in its name: a matching page's text is returned, and files come back as links in " +
        "matches (their contents can't be read).",
      inputSchema: { course: courseRef },
      annotations: READ_ONLY,
    },
    wrap(async ({ course }) => {
      const c = await courses.resolve(course);
      return { course: `${c.course_code} — ${c.name}`, ...(await findSyllabus(canvas, c)) };
    }),
  );
}
