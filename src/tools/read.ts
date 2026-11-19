import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasError, optional, type CanvasClient } from "../canvas.js";
import { hasEnded, isStudent, notStudentError, type CourseDirectory } from "../courses.js";
import { fileKind, findFiles, friendlyType, humanSize, MAX_FILE_BYTES, pdfText, pickFile, plainText } from "../files.js";
import {
  CANVAS_DEFAULT_SCALE, currentView, finalView, gradeCourse, gradeGroup, letterFor, parseTarget, round2, scaleFrom, solveTarget,
  toGradeGroups, type CourseResult as GradeCourseResult, type GradeGroup, type GradeItem,
} from "../grades.js";
import { modulesWithItems } from "../modules.js";
import { findSyllabus } from "../syllabus.js";
import { compact, errorResult, htmlToText, json, makeDateFormatter } from "../format.js";
import type { Assignment, AssignmentGroup, CalendarEvent, CanvasFile, Conversation, Course, CourseUser, DiscussionTopic, DiscussionView, DiscussionEntry, GradingStandard, Group, Module, ModuleItem, PlannerItem, Submission } from "../types.js";

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
    "current_score counts graded work only; final_score counts all ungraded work as zero, even if not due.";

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

  /** A course for a student-only tool; a TA or teacher enrollment gets a plain message, not a 403 (issue #25). */
  const studentCourse = async (ref: string, what: string) => {
    const c = await courses.resolve(ref);
    if (!isStudent(c)) throw notStudentError(c, what);
    return c;
  };
  /** Student-only endpoints still 403 when Canvas's enrollment list didn't say; say why instead. */
  const asStudent = <T,>(c: Course, what: string, p: Promise<T>) =>
    p.catch((err) => {
      if (err instanceof CanvasError && err.status === 403 && !/rate limit/i.test(err.message)) {
        throw new Error(`Canvas won't show ${what} in ${c.course_code}; this usually means you aren't enrolled there as a student.`);
      }
      throw err;
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
        "The student's current courses with term and grade; include_past adds ended ones. " + SCORES_NOTE,
      inputSchema: {
        include_past: z
          .boolean()
          .default(false)
          .describe("Also list courses from terms that have ended (marked ended: true)"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ include_past }) => {
      const list = include_past
        ? [...(await courses.all(true)), ...(await optional(courses.completed(true), []))]
        : await courses.active(true);
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
        "For \"what's due\": the planner across all courses in a date window, with submitted/missing/graded " +
        "status; undated work is in no_due_date. For quizzes and discussions, pass assignment_id (not id) to " +
        "other tools.",
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
          const ticked = Boolean(i.planner_override?.marked_complete);
          // A planner checkmark doesn't hand anything in: missing work stays not done and visible (issue #18).
          const done = Boolean(s?.submitted || s?.excused || (ticked && !s?.missing));
          return { item: i, done, ticked };
        })
        .filter(({ done }) => include_done || !done)
        .sort((a, b) => a.item.plannable_date.localeCompare(b.item.plannable_date))
        .map(({ item: i, done, ticked }) => {
          const s = i.submissions || undefined;
          // Quizzes and graded discussions have their own ids; get_assignment etc. need the assignment's (issue #19).
          const assignmentId = i.plannable_type === "assignment" ? undefined : i.plannable.assignment_id ?? undefined;
          return compact({
            course: i.context_name,
            course_id: i.course_id,
            type: i.plannable_type,
            id: i.plannable_id,
            assignment_id: assignmentId,
            title: i.plannable.title,
            due: date(i.plannable.due_at ?? i.plannable.todo_date ?? i.plannable_date),
            points: i.plannable.points_possible,
            done,
            marked_done: (ticked && !done) || undefined,
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
        "One assignment: instructions, dates, submission types, and the student's submission with comments.",
      inputSchema: {
        course: courseRef,
        assignment_id: z.number().int().describe("Assignment id"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, assignment_id }) => {
      const c = await courses.resolve(course);
      const [a, sub] = await Promise.all([
        canvas.get<Assignment>(`/courses/${c.id}/assignments/${assignment_id}`).catch((err) => {
          if (err instanceof CanvasError && err.status === 404) {
            throw new Error(
              `No assignment ${assignment_id} in ${c.course_code}. A quiz or discussion id isn't an assignment id; ` +
                "use the assignment_id that get_upcoming gives for those.",
            );
          }
          throw err;
        }),
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

  const commentsOut = (s: Submission) =>
    (s.submission_comments ?? []).map((m) =>
      compact({
        from: m.author_name,
        at: date(m.created_at),
        text: m.comment?.length > 4000 ? `${m.comment.slice(0, 4000)}…` : m.comment,
        attachments: m.attachments?.length
          ? m.attachments.map((f) => compact({ name: f.display_name ?? f.filename, url: f.url }))
          : undefined,
      }),
    );

  /** Each rubric criterion with the grader's points, chosen rating and comment. */
  const rubricOut = (a: Assignment, s: Submission) => {
    const assessment = s.rubric_assessment ?? {};
    return (a.rubric ?? []).map((c) => {
      const r = assessment[c.id];
      const rating = r?.rating_id ? c.ratings?.find((x) => x.id === r.rating_id) : undefined;
      return compact({
        criterion: c.description,
        detail: c.long_description ? htmlToText(c.long_description, 1000) : undefined,
        points: r?.points ?? undefined,
        out_of: c.points,
        rating: rating?.description,
        rating_detail: rating?.long_description ? htmlToText(rating.long_description, 1000) : undefined,
        comment: r?.comments || undefined,
        assessed: r ? undefined : false,
      });
    });
  };

  server.registerTool(
    "get_feedback",
    {
      title: "Get feedback",
      description:
        "For \"where did I lose points\": score, rubric criteria and comments for one assignment (by id or name). " +
        "With neither, lists the course's assignments that have feedback.",
      inputSchema: {
        course: courseRef,
        assignment_id: z.number().int().optional().describe("Assignment id"),
        name: z.string().optional().describe('Part of the assignment name, e.g. "project 1"'),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, assignment_id, name }) => {
      const c = await studentCourse(course, "feedback");
      const label = `${c.course_code} — ${c.name}`;

      if (assignment_id === undefined && !name?.trim()) {
        const subs = await asStudent(c, "feedback", canvas.getAll<Submission>(`/courses/${c.id}/students/submissions`, {
          include: ["submission_comments", "rubric_assessment", "assignment"],
        }));
        const withFeedback = subs
          .filter((s) => s.assignment && ((s.submission_comments?.length ?? 0) > 0 || hasAssessment(s)))
          .sort((x, y) => (y.graded_at ?? "").localeCompare(x.graded_at ?? ""));
        return compact({
          course: label,
          note: withFeedback.length ? undefined : "No assignment in this course has comments or a rubric assessment yet.",
          assignments: withFeedback.map((s) => {
            const last = s.submission_comments?.at(-1);
            return compact({
              id: s.assignment!.id,
              name: s.assignment!.name,
              score: s.score,
              out_of: s.assignment!.points_possible,
              graded: date(s.graded_at),
              comments: s.submission_comments?.length || undefined,
              rubric: hasAssessment(s) || undefined,
              latest_comment: last
                ? `${last.author_name}: ${last.comment.length > 300 ? `${last.comment.slice(0, 300)}…` : last.comment}`
                : undefined,
            });
          }),
        });
      }

      let aid = assignment_id;
      if (aid === undefined) {
        const needle = name!.trim();
        const found = await canvas.getAll<Assignment>(`/courses/${c.id}/assignments`, {
          search_term: needle.length >= 2 ? needle : undefined,
        });
        const lower = needle.toLowerCase();
        const partial = found.filter((a) => a.name.toLowerCase().includes(lower));
        const exact = partial.filter((a) => a.name.toLowerCase() === lower);
        const pick = exact.length === 1 ? exact : partial;
        if (pick.length === 0) return { course: label, note: `No assignment in this course has "${needle}" in its name.` };
        if (pick.length > 1) {
          return {
            course: label,
            note: "Several assignments match; call again with one assignment_id.",
            matches: pick.map((a) => compact({ id: a.id, name: a.name, due: date(a.due_at) })),
          };
        }
        aid = pick[0].id;
      }

      const [a, s] = await Promise.all([
        canvas.get<Assignment>(`/courses/${c.id}/assignments/${aid}`),
        asStudent(c, "feedback", canvas.get<Submission>(`/courses/${c.id}/assignments/${aid}/submissions/self`, {
          include: ["submission_comments", "rubric_assessment"],
        })),
      ]);
      const rubric = hasAssessment(s) ? rubricOut(a, s) : undefined;
      const comments = commentsOut(s);
      const graded = s.score !== null || s.excused || s.workflow_state === "graded";
      return compact({
        course: label,
        id: a.id,
        name: a.name,
        score: s.score,
        out_of: a.points_possible,
        grade: s.grade,
        status: s.excused ? "excused" : s.missing ? "missing" : s.workflow_state,
        graded: date(s.graded_at),
        late: s.late || undefined,
        rubric,
        rubric_unassessed: !rubric && a.rubric?.length ? "This assignment has a rubric, but it hasn't been filled in for you." : undefined,
        comments: comments.length ? comments : undefined,
        note: !graded
          ? "Not graded yet (or the grade isn't posted to students)."
          : !rubric && comments.length === 0
            ? "No comments or rubric feedback on this submission."
            : undefined,
        url: a.html_url,
      });
    }),
  );

  server.registerTool(
    "recently_graded",
    {
      title: "Recently graded",
      description:
        "Work graded in the last few days, newest first, with scores and whether there's feedback to read.",
      inputSchema: {
        days: z.number().int().min(1).max(120).default(7).describe("How many days back"),
        course: courseRef.optional().describe("Leave out for all current courses"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ days, course }) => {
      const since = new Date(Date.now() - days * 86_400_000);
      const scope = course ? [await studentCourse(course, "graded work")] : (await courses.active()).filter(isStudent);
      const perCourse = await Promise.all(
        scope.map(async (c) => {
          try {
            const subs = await canvas.getAll<Submission>(`/courses/${c.id}/students/submissions`, {
              graded_since: since.toISOString(),
              include: ["assignment", "submission_comments", "rubric_assessment"],
            });
            return subs
              // Unposted grades come back without a score; leave them out rather than hint at them.
              .filter((s) => s.assignment && s.graded_at && Date.parse(s.graded_at) >= since.getTime())
              .filter((s) => s.score !== null || s.excused)
              .map((s) => ({ c, s }));
          } catch (err) {
            if (err instanceof CanvasError && !course) return [];
            if (err instanceof CanvasError && err.status === 403) {
              throw new Error(`Canvas won't show graded work in ${c.course_code}; this usually means you aren't enrolled there as a student.`);
            }
            throw err;
          }
        }),
      );
      const rows = perCourse
        .flat()
        .sort((x, y) => (y.s.graded_at ?? "").localeCompare(x.s.graded_at ?? ""))
        .map(({ c, s }) =>
          compact({
            course: c.course_code,
            course_id: c.id,
            assignment_id: s.assignment!.id,
            name: s.assignment!.name,
            score: s.excused ? undefined : s.score,
            out_of: s.assignment!.points_possible,
            grade: s.excused ? "excused" : s.grade,
            graded: date(s.graded_at),
            late: s.late || undefined,
            comments: s.submission_comments?.length || undefined,
            rubric: hasAssessment(s) || undefined,
          }),
        );
      return compact({
        since: date(since.toISOString()),
        graded: rows,
        note: rows.length ? undefined : `Nothing graded in the last ${days} days.`,
      });
    }),
  );

  server.registerTool(
    "get_grades",
    {
      title: "Get grades",
      description:
        "A course's grade breakdown: scores, groups with weights and drop rules, graded and missing work. " +
        SCORES_NOTE + " group_score_percent is like current_score.",
      inputSchema: { course: courseRef },
      annotations: READ_ONLY,
    },
    wrap(async ({ course }) => {
      const c = await studentCourse(course, "grade");
      const groups = await canvas.getAll<AssignmentGroup>(`/courses/${c.id}/assignment_groups`, {
        include: ["assignments", "submission"],
      });
      // Same arithmetic as grade_whatif (issue #14), so drop rules and omitted assignments match Canvas.
      const results = toGradeGroups(groups).map((g) => gradeGroup(g, currentView));
      const missing = (g: AssignmentGroup) => (g.assignments ?? []).filter((a) => a.submission?.missing);
      return compact({
        course: `${c.course_code} — ${c.name}`,
        ...courseScores(c),
        missing_count: groups.reduce((n, g) => n + missing(g).length, 0) || undefined,
        groups: groups.map((g, i) => {
          const r = results[i];
          const dropped = new Set(r.dropped.map((d) => d.id));
          // Canvas sometimes leaves score out entirely, so `!= null` (issue #13).
          const graded = (g.assignments ?? []).filter((a) => a.submission?.score != null);
          return compact({
            name: g.name,
            weight_percent: g.group_weight || undefined,
            group_score_percent: r.percent === null ? undefined : Math.round(r.percent * 10) / 10,
            drops: r.group.drop_lowest || r.group.drop_highest
              ? compact({ lowest: r.group.drop_lowest || undefined, highest: r.group.drop_highest || undefined })
              : undefined,
            dropped_now: r.dropped.length ? r.dropped.map((d) => d.name) : undefined,
            graded: graded.map((a) =>
              compact({
                name: a.name,
                score: a.submission?.score,
                out_of: a.points_possible,
                grade: a.submission?.grade,
                late: a.submission?.late || undefined,
                dropped: dropped.has(a.id) || undefined,
                excluded_from_grade: a.omit_from_final_grade || a.grading_type === "not_graded" || undefined,
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
        "For \"what do I need for a B+\" (target) or \"what if I get 85 on the final\" (hypotheticals), using the " +
        "course's weights, drop rules and letter scale.",
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
      const c = await studentCourse(course, "grade");
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
        const sid = full.grading_standard_id;
        const standards = await optional(canvas.getAll<GradingStandard>(`/courses/${c.id}/grading_standards`), []);
        // A scheme set at the account or institution level isn't in the course's list (issue #22); ask for it
        // by id, through the course and then the account.
        let own = standards.find((s) => s.id === sid);
        if (!own) own = await optional<GradingStandard | undefined>(canvas.get<GradingStandard>(`/courses/${c.id}/grading_standards/${sid}`), undefined);
        if (!own && full.account_id) {
          own = await optional<GradingStandard | undefined>(canvas.get<GradingStandard>(`/accounts/${full.account_id}/grading_standards/${sid}`), undefined);
        }
        if (own?.grading_scheme?.length) {
          scale = scaleFrom(own);
          scaleSource = `course ("${own.title}")`;
        } else {
          notes.push(
            "The course has its own letter scale, but Canvas doesn't let students read it, so letters use Canvas's " +
              "default scale; check the syllabus for the real cutoffs.",
          );
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
      let projectedGroups: GradeCourseResult["groups"] | undefined;
      if (assumed.size > 0) {
        const pc = view(withAssumed, currentView);
        projected = { current: pc.out, final: view(withAssumed, finalView).out };
        projectedGroups = pc.result.groups;
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
            : remainingItems.length === 0
              ? "No ungraded work is left in Canvas (after any hypotheticals), so nothing can change the grade here. Assignments the " +
                "instructor hasn't created in Canvas yet (often the final exam) aren't counted; check the syllabus."
              : !r.reachable
                ? `Unreachable: 100% on everything remaining gives ${r.best_possible ?? "no grade"}.`
                : `Needs an average of ${r.needed_percent}% on the remaining work (every remaining item at that ` +
                  "percentage), rounded up to a tenth of a percent so it's always enough.",
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
            // With hypotheticals, the group as projected; current and final stay as Canvas has them now.
            projected_percent: projectedGroups?.[i].percent == null ? undefined : round2(projectedGroups[i].percent!),
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
    "course_people",
    {
      title: "Course people",
      description:
        "A course's instructors and TAs (with email when shown) and the student's group members. No class roster.",
      inputSchema: {
        course: courseRef,
        role: z.enum(["teacher", "ta", "group"]).optional().describe("Only this kind of person (default: all three)"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, role }) => {
      const c = await courses.resolve(course);
      const want = (r: "teacher" | "ta" | "group") => !role || role === r;
      const staffTypes = [want("teacher") && "teacher", want("ta") && "ta"].filter(Boolean) as string[];
      const notes: string[] = [];

      const [staff, groups, me] = await Promise.all([
        staffTypes.length
          ? optional(
              canvas.getAll<CourseUser>(`/courses/${c.id}/users`, {
                enrollment_type: staffTypes,
                include: ["email", "enrollments"],
              }),
              undefined,
            )
          : [],
        want("group")
          ? optional(canvas.getAll<Group>("/users/self/groups", { context_type: "Course" }), undefined)
          : [],
        want("group") ? optional(canvas.get<{ id: number }>("/users/self"), undefined) : undefined,
      ]);
      if (staff === undefined) notes.push("The People list is hidden in this course, so instructors and TAs can't be listed.");

      const staffOut = (staff ?? []).map((u) => {
        const mine = (u.enrollments ?? []).filter((e) => e.course_id === undefined || e.course_id === c.id);
        const kinds = [
          ...new Set(mine.map((e) => STAFF_ROLE[e.type]).filter((k): k is "teacher" | "ta" => Boolean(k) && staffTypes.includes(k!))),
        ];
        // Without enrollment details, Canvas still only returned the types asked for.
        const roles = kinds.length ? kinds : staffTypes.length === 1 ? [staffTypes[0]] : ["teacher or ta"];
        const custom = mine.map((e) => e.role).find((r) => r && !STAFF_ROLE[r]);
        return compact({
          name: displayName(u),
          role: roles.join(", "),
          role_name: custom,
          pronouns: u.pronouns || undefined,
          email: u.email || undefined,
        });
      });
      // The same person can come back once per section or account (issue #26): merge identical name + role
      // pairs unless they show different emails.
      const merged: typeof staffOut = [];
      for (const p of staffOut) {
        const same = merged.find((m) => m.name === p.name && m.role === p.role && (!m.email || !p.email || m.email === p.email));
        if (!same) merged.push(p);
        else Object.assign(same, compact({ ...p, ...same }));
      }
      staffOut.splice(0, staffOut.length, ...merged);
      staffOut.sort((a, b) => (a.role === b.role ? 0 : a.role === "teacher" ? -1 : 1));

      if (groups === undefined) notes.push("Couldn't read the student's groups.");
      const courseGroups = (groups ?? []).filter((g) => g.course_id === c.id);
      const groupOut = await Promise.all(
        courseGroups.map(async (g) => {
          const members = await optional(canvas.getAll<CourseUser>(`/groups/${g.id}/users`, { include: ["email"] }), undefined);
          return compact({
            group: g.name,
            members: members?.map((u) =>
              compact({ name: displayName(u), pronouns: u.pronouns || undefined, email: u.email || undefined, you: me && u.id === me.id ? true : undefined }),
            ),
            note: members ? undefined : "This group's member list is hidden.",
          });
        }),
      );
      if (want("group") && groups && courseGroups.length === 0) notes.push("The student isn't in any group in this course.");

      return compact({
        course: `${c.course_code} — ${c.name}`,
        staff: staffTypes.length ? staffOut : undefined,
        groups: want("group") ? groupOut : undefined,
        notes: notes.length ? notes : undefined,
      });
    }),
  );

  server.registerTool(
    "list_events",
    {
      title: "Calendar events",
      description:
        "Calendar events (exams, office hours, review sessions) in a date window. Many exams are only here; " +
        "exams that are quizzes come with include_assignments (on when searching).",
      inputSchema: {
        days_ahead: z.number().int().min(0).max(365).default(14).describe("How many days forward from now"),
        days_back: z.number().int().min(0).max(120).default(0).describe("Also include this many past days"),
        course: courseRef.optional().describe("Leave out for all current courses (plus the student's own calendar)"),
        search: z.string().optional().describe('Only events whose title or description contains this, e.g. "exam"'),
        include_assignments: z
          .boolean()
          .optional()
          .describe("Also list assignment due dates from the calendar (default: true when search is given)"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ days_ahead, days_back, course, search, include_assignments }) => {
      const scope = course ? [await courses.resolve(course)] : await courses.active();
      const byCode = new Map(scope.map((c) => [`course_${c.id}`, c]));
      const codes = [...byCode.keys()];
      if (!course) {
        const me = await optional(canvas.get<{ id: number }>("/users/self"), undefined);
        if (me) codes.push(`user_${me.id}`);
      }
      const now = Date.now();
      const window = {
        start_date: new Date(now - days_back * 86_400_000).toISOString(),
        end_date: new Date(now + days_ahead * 86_400_000).toISOString(),
      };
      // Exams are often assignments (issue #23), which Canvas only returns for type=assignment.
      const withAssignments = include_assignments ?? Boolean(search?.trim());
      const types = withAssignments ? ["event", "assignment"] : ["event"];
      // Canvas accepts only a limited number of context codes per request (10 for most users).
      const batches: string[][] = [];
      for (let i = 0; i < codes.length; i += 10) batches.push(codes.slice(i, i + 10));
      const events = (
        await Promise.all(
          types.flatMap((type) =>
            batches
              .filter((b) => type === "event" || b.some((code) => code.startsWith("course_")))
              .map((b) => canvas.getAll<CalendarEvent>("/calendar_events", { type, ...window, context_codes: b })),
          ),
        )
      ).flat();

      const needle = search?.trim().toLowerCase();
      const seen = new Set<string>();
      const rows = events
        .filter((e) => e.workflow_state !== "deleted")
        .filter((e) => !seen.has(String(e.id)) && seen.add(String(e.id)))
        .map((e) => ({ e, text: htmlToText(e.description, 600) }))
        .filter(({ e, text }) => !needle || e.title.toLowerCase().includes(needle) || (text ?? "").toLowerCase().includes(needle))
        .sort((a, b) => (a.e.start_at ?? a.e.all_day_date ?? "").localeCompare(b.e.start_at ?? b.e.all_day_date ?? ""))
        .map(({ e, text }) => {
          const c = e.context_code ? byCode.get(e.context_code) : undefined;
          const allDay = Boolean(e.all_day && e.all_day_date);
          if (e.assignment) {
            return compact({
              title: e.title,
              course: c?.course_code ?? e.context_code,
              type: e.assignment.is_quiz_assignment || e.assignment.submission_types?.includes("online_quiz") ? "quiz" : "assignment",
              assignment_id: e.assignment.id,
              due: date(e.assignment.due_at ?? e.start_at),
              points: e.assignment.points_possible ?? undefined,
              url: e.html_url,
            });
          }
          return compact({
            title: e.title,
            course: c?.course_code ?? (e.context_code?.startsWith("user_") ? "personal" : e.context_code),
            start: allDay ? `${dayOnly(e.all_day_date!)} (all day)` : date(e.start_at),
            end: allDay || e.end_at === e.start_at ? undefined : date(e.end_at),
            location: [e.location_name, e.location_address].filter(Boolean).join(", ") || undefined,
            description: text || undefined,
            url: e.html_url,
          });
        });
      return compact({
        events: rows,
        note: rows.length
          ? undefined
          : withAssignments
            ? "Nothing on the calendar in that window. Exam dates may be only in the syllabus (get_syllabus) or module headings (list_modules)."
            : "No calendar events in that window. Exams may be assignments: call again with include_assignments, " +
              "or try list_assignments with search \"final\" or get_syllabus.",
      });
    }),
  );

  server.registerTool(
    "list_announcements",
    {
      title: "List announcements",
      description:
        "Recent announcements, newest first; previews across courses, full text for one course.",
      inputSchema: {
        course: courseRef.optional().describe("Leave out for all current courses"),
        days: z.number().int().min(1).max(120).default(14).describe("How many days back"),
        limit: z.number().int().min(1).max(50).default(10).describe("Most announcements to return"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, days, limit }) => {
      const scope = course ? [await courses.resolve(course)] : await courses.active();
      if (scope.length === 0) return [];
      const byCode = new Map(scope.map((c) => [`course_${c.id}`, c]));
      const topics = await canvas.getAll<DiscussionTopic>("/announcements", {
        context_codes: [...byCode.keys()],
        start_date: new Date(Date.now() - days * 86_400_000).toISOString(),
        end_date: new Date().toISOString(),
      });
      // Previews across courses, full text for one (issue #12).
      const maxChars = course ? 2500 : 600;
      return topics
        .sort((a, b) => (b.posted_at ?? "").localeCompare(a.posted_at ?? ""))
        .slice(0, limit)
        .map((t) => {
          const c = t.context_code ? byCode.get(t.context_code) : undefined;
          return compact({
            course: c?.course_code,
            title: t.title,
            posted: date(t.posted_at),
            author: t.author?.display_name ?? t.user_name,
            message: htmlToText(t.message, maxChars),
            url: t.html_url,
          });
        });
    }),
  );

  server.registerTool(
    "list_discussions",
    {
      title: "List discussions",
      description:
        "A course's discussions: due date and points if graded, whether the student posted, reply counts. " +
        "False or empty fields are left out.",
      inputSchema: { course: courseRef },
      annotations: READ_ONLY,
    },
    wrap(async ({ course }) => {
      const c = await courses.resolve(course);
      const topics = await canvas.getAll<DiscussionTopic>(`/courses/${c.id}/discussion_topics`, { order_by: "recent_activity" });
      // A graded topic's assignment carries its due date and the student's submission (submitted = posted).
      const graded = topics.some((t) => t.assignment_id);
      const assignments = graded
        ? new Map(
            (await optional(canvas.getAll<Assignment>(`/courses/${c.id}/assignments`, { include: ["submission"] }), [])).map((a) => [a.id, a]),
          )
        : new Map<number, Assignment>();
      return {
        course: `${c.course_code} — ${c.name}`,
        discussions: topics.map((t) => {
          const a = t.assignment_id ? assignments.get(t.assignment_id) ?? t.assignment ?? undefined : undefined;
          const posted = a?.submission
            ? isDone(a.submission)
            : t.require_initial_post && t.user_can_see_posts === false
              ? false
              : undefined;
          return compact({
            id: t.id,
            title: t.title,
            graded: Boolean(t.assignment_id) || undefined,
            due: date(a?.due_at),
            points: a?.points_possible,
            posted,
            post_required_to_see_replies: t.require_initial_post || undefined,
            replies: t.discussion_subentry_count,
            unread: t.unread_count || undefined,
            last_reply: date(t.last_reply_at),
            locked: t.locked_for_user || undefined,
            url: t.html_url,
          });
        }),
      };
    }),
  );

  server.registerTool(
    "get_discussion",
    {
      title: "Get discussion",
      description:
        "One discussion's prompt and replies in thread order (depth 0 = top level). Long threads are shortened, " +
        "with a note; mine_only keeps the student's posts and replies around them.",
      inputSchema: {
        course: courseRef,
        topic_id: z.number().int().describe("Discussion topic id (from list_discussions)"),
        mine_only: z.boolean().default(false).describe("Only the student's posts and the replies around them"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, topic_id, mine_only }) => {
      const c = await courses.resolve(course);
      const [t, view, me] = await Promise.all([
        canvas.get<DiscussionTopic>(`/courses/${c.id}/discussion_topics/${topic_id}`),
        optional(canvas.get<DiscussionView>(`/courses/${c.id}/discussion_topics/${topic_id}/view`), undefined),
        optional(canvas.get<{ id: number }>("/users/self"), undefined),
      ]);
      const a = t.assignment_id
        ? await optional(canvas.get<Assignment>(`/courses/${c.id}/assignments/${t.assignment_id}`, { include: ["submission"] }), undefined)
        : undefined;
      const names = new Map((view?.participants ?? []).map((p) => [p.id, p.display_name]));

      const replies = threadReplies(view, me, mine_only);
      const postedByMe = replies.postedByMe;
      const entries = replies.entries.map((r) =>
        compact({
          id: r.id,
          reply_to: r.replyTo,
          depth: r.depth,
          author: r.mine ? "you" : (r.userId !== undefined ? names.get(r.userId) : undefined) ?? "unknown",
          at: date(r.createdAt),
          text: r.text,
        }),
      );
      const total = replies.total;

      const posted = a?.submission ? isDone(a.submission) || postedByMe : view ? postedByMe : undefined;
      return compact({
        course: `${c.course_code} — ${c.name}`,
        id: t.id,
        title: t.title,
        posted_at: date(t.posted_at),
        author: t.author?.display_name ?? t.user_name,
        graded: Boolean(t.assignment_id) || undefined,
        due: date(a?.due_at),
        points: a?.points_possible,
        posted,
        prompt: htmlToText(t.message, 8000),
        replies: view ? entries : undefined,
        note: !view
          ? t.require_initial_post
            ? "The student must post before replies are visible."
            : "Replies aren't visible to the student."
          : replies.all === 0
            ? "No replies yet."
            : mine_only && total === 0
              ? "The student hasn't posted in this discussion."
              : replies.note,
        url: t.html_url,
      });
    }),
  );

  server.registerTool(
    "list_modules",
    {
      title: "List modules",
      description:
        "For \"what's next\": a course's modules with progress, prerequisites and items (due dates, requirements, " +
        "submitted/missing). next is the first required item to do. Completed modules are shortened.",
      inputSchema: {
        course: courseRef,
        search: z.string().optional().describe("Only modules or items whose name contains this text"),
        include_completed: z.boolean().default(false).describe("Also list the items of completed modules"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, search, include_completed }) => {
      const c = await courses.resolve(course);
      const [unsorted, assignments] = await Promise.all([
        modulesWithItems(canvas, c.id, { include: ["content_details"] }),
        // Module items carry no submission status (issue #24); the assignments list does, in one request.
        optional(canvas.getAll<Assignment>(`/courses/${c.id}/assignments`, { include: ["submission"] }), []),
      ]);
      const modules = unsorted.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const byItem = new Map<string, Assignment>();
      for (const a of assignments) {
        byItem.set(`Assignment:${a.id}`, a);
        if (a.quiz_id) byItem.set(`Quiz:${a.quiz_id}`, a);
        if (a.discussion_topic?.id) byItem.set(`Discussion:${a.discussion_topic.id}`, a);
      }
      const names = new Map(modules.map((m) => [m.id, m.name]));
      const sorted = (m: Module) => [...(m.items ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

      const itemOut = (i: ModuleItem) => {
        const sub = i.content_id !== undefined ? byItem.get(`${i.type}:${i.content_id}`)?.submission : undefined;
        return compact({
          title: i.title,
          type: i.type === "SubHeader" ? "heading" : i.type,
          indent: i.indent || undefined,
          due: date(i.content_details?.due_at),
          points: i.content_details?.points_possible ?? undefined,
          requirement: requirementLabel(i),
          done: i.completion_requirement ? Boolean(i.completion_requirement.completed) : undefined,
          submitted: isDone(sub) || undefined,
          missing: sub?.missing || undefined,
          locked: i.content_details?.locked_for_user || undefined,
          url: i.html_url ?? i.external_url,
        });
      };

      // What's next: the first unmet requirement in a module the student can work in.
      let next: Record<string, unknown> | undefined;
      for (const m of modules) {
        if (m.state === "completed" || m.state === "locked") continue;
        const item = sorted(m).find((i) => i.completion_requirement && !i.completion_requirement.completed);
        if (item) {
          next = { module: m.name, ...itemOut(item) };
          break;
        }
      }

      const needle = search?.trim().toLowerCase();
      const shown = modules
        .map((m) => {
          const items = sorted(m);
          if (!needle || m.name.toLowerCase().includes(needle)) return { m, items };
          return { m, items: items.filter((i) => i.title.toLowerCase().includes(needle)) };
        })
        .filter(({ m, items }) => !needle || m.name.toLowerCase().includes(needle) || items.length > 0);

      const anyRequirement = modules.some((m) => (m.items ?? []).some((i) => i.completion_requirement));
      const allDone = modules.length > 0 && modules.every((m) => m.state === "completed" || !(m.items ?? []).some((i) => i.completion_requirement));
      return compact({
        course: `${c.course_code} — ${c.name}`,
        next,
        note: modules.length === 0
          ? "This course has no modules the student can see (or the Modules page is hidden)."
          : !next
            ? !anyRequirement
              // Not "all complete" when nothing was ever required (issue #24).
              ? "These modules have no completion requirements, so there's no next step to track; see each " +
                "item's submitted/missing flags, or use get_upcoming for due work."
              : allDone
                ? "Every module requirement is complete."
                : "Nothing to do in the unlocked modules; the remaining modules are locked."
            : undefined,
        modules: shown.map(({ m, items }) => {
          // A finished module is mostly noise (issue #12): keep it short unless asked or searched for.
          const brief = m.state === "completed" && !include_completed && !needle && !items.some((i) => itemOut(i).missing);
          return compact({
            id: m.id,
            name: m.name,
            state: m.state,
            unlocks: m.state === "locked" ? date(m.unlock_at) : undefined,
            prerequisites: m.prerequisite_module_ids?.length ? m.prerequisite_module_ids.map((id) => names.get(id) ?? `module ${id}`) : undefined,
            in_order: m.require_sequential_progress || undefined,
            completed: date(m.completed_at),
            item_count: brief ? items.length : undefined,
            items: brief ? undefined : items.map(itemOut),
          });
        }),
      });
    }),
  );

  const myId = async () => (await optional(canvas.get<{ id: number }>("/users/self"), undefined))?.id;

  server.registerTool(
    "list_messages",
    {
      title: "List inbox messages",
      description:
        "Canvas inbox conversations with participants, course, date, unread flag and a preview. Never marks " +
        "anything read.",
      inputSchema: {
        scope: z.enum(["inbox", "unread", "sent", "archived", "starred"]).default("inbox").describe("Which mailbox"),
        course: courseRef.optional().describe("Only conversations in this course"),
        limit: z.number().int().min(1).max(100).default(20).describe("How many conversations, newest first"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ scope, course, limit }) => {
      const c = course ? await courses.resolve(course) : undefined;
      const filter = c ? [`course_${c.id}`] : undefined;
      let [list, me] = await Promise.all([
        canvas.get<Conversation[]>("/conversations", {
          scope: scope === "inbox" ? undefined : scope,
          filter,
          per_page: limit,
        }),
        myId(),
      ]);
      let note: string | undefined;
      if (scope === "sent" && list.length === 0) {
        // Real Canvas has answered scope=sent with nothing for an account with sent messages (issue #15), so
        // fall back to the inbox and archive, keeping conversations the student has written in.
        const [inbox, archived] = await Promise.all([
          canvas.getAll<Conversation>("/conversations", { filter }),
          optional(canvas.getAll<Conversation>("/conversations", { scope: "archived", filter }), []),
        ]);
        const seen = new Set<number>();
        const all = [...inbox, ...archived].filter((v) => !seen.has(v.id) && seen.add(v.id));
        // Real Canvas can leave last_authored_message_at out of inbox lists even when the student wrote in a
        // conversation (seen 2026-11-19), so check the authors of the newest conversations that lack it.
        const unknown = me === undefined ? [] : all
          .filter((v) => !v.last_authored_message_at)
          .sort((a, b) => (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""));
        const MAX_CHECKED = 30;
        const checked = unknown.slice(0, MAX_CHECKED);
        for (let i = 0; i < checked.length; i += 5) {
          await Promise.all(checked.slice(i, i + 5).map(async (v) => {
            const full = await optional(
              canvas.get<Conversation>(`/conversations/${v.id}`, { auto_mark_as_read: false }),
              undefined,
            );
            const mine = (full?.messages ?? [])
              .filter((m) => m.author_id === me)
              .map((m) => m.created_at)
              .sort()
              .at(-1);
            if (mine) v.last_authored_message_at = mine;
          }));
        }
        list = all
          .filter((v) => v.last_authored_message_at)
          .sort((a, b) => b.last_authored_message_at!.localeCompare(a.last_authored_message_at!));
        const skipped = unknown.length - checked.length;
        if (list.length || skipped > 0) {
          note = "Canvas's sent mailbox came back empty, so these are conversations the student has written in." +
            (skipped > 0 ? ` ${skipped} older conversations weren't checked.` : "");
        }
      }
      const rows = list.slice(0, limit).map((v) =>
        compact({
          id: v.id,
          subject: v.subject || "(no subject)",
          course: v.context_name ?? undefined,
          with: withSummary(v, me),
          last_message: date(scope === "sent" ? v.last_authored_message_at ?? v.last_message_at : v.last_message_at),
          messages: v.message_count,
          unread: v.workflow_state === "unread" || undefined,
          attachments: v.properties?.includes("attachments") || undefined,
          preview: v.last_message ? clip(v.last_message.replace(/\s+/g, " ").trim(), 200) : undefined,
        }),
      );
      return compact({
        course: c ? `${c.course_code} — ${c.name}` : undefined,
        scope,
        conversations: rows,
        note: rows.length ? note : `No conversations in ${scope}${c ? " for this course" : ""}.`,
      });
    }),
  );

  server.registerTool(
    "get_message",
    {
      title: "Read inbox thread",
      description:
        "One inbox conversation in full, oldest first, with attachments. Doesn't mark it read.",
      inputSchema: { conversation_id: z.number().int().describe("Conversation id (from list_messages)") },
      annotations: READ_ONLY,
    },
    wrap(async ({ conversation_id }) => {
      const [v, me] = await Promise.all([
        // Canvas marks a conversation read when it's fetched unless told not to; the connector changes nothing.
        canvas.get<Conversation>(`/conversations/${conversation_id}`, { auto_mark_as_read: false }),
        myId(),
      ]);
      const names = new Map((v.participants ?? []).map((p) => [p.id, p.name]));
      const others = (v.participants ?? []).filter((p) => p.id !== me);
      const MAX_MESSAGES = 60;
      const all = [...(v.messages ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const shown = all.slice(-MAX_MESSAGES);
      return compact({
        id: v.id,
        subject: v.subject || "(no subject)",
        course: v.context_name ?? undefined,
        // A class-wide message lists the whole class; give a count instead of a roster (issue #16).
        participants: others.length <= MAX_NAMED
          ? (v.participants ?? []).map((p) => (p.id === me ? "you" : p.name))
          : undefined,
        participant_count: others.length > MAX_NAMED ? others.length + 1 : undefined,
        unread: v.workflow_state === "unread" || undefined,
        messages: shown.map((m) =>
          compact({
            from: m.author_id === me ? "you" : names.get(m.author_id) ?? "unknown",
            at: date(m.created_at),
            text: clip(m.body ?? "", 6000),
            attachments: m.attachments?.length
              ? m.attachments.map((f) => compact({ name: f.display_name ?? f.filename, url: f.url }))
              : undefined,
            media: m.media_comment ? compact({ name: m.media_comment.display_name, url: m.media_comment.url }) : undefined,
          }),
        ),
        note: all.length > shown.length ? `Showing the latest ${shown.length} of ${all.length} messages.` : undefined,
      });
    }),
  );

  server.registerTool(
    "get_syllabus",
    {
      title: "Get syllabus",
      description:
        "The syllabus page as text, else a page, file or module item named \"syllabus\". Files come back with " +
        "a file_id for read_file. Long syllabi come in parts (from_char).",
      inputSchema: {
        course: courseRef,
        from_char: z.number().int().min(0).default(0).describe("Where to start in a long syllabus (from the previous note)"),
      },
      annotations: READ_ONLY,
    },
    wrap(async ({ course, from_char }) => {
      const c = await courses.resolve(course);
      return compact({ course: `${c.course_code} — ${c.name}`, ...(await findSyllabus(canvas, c, from_char)) });
    }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read course file",
      description:
        "Text of a course file (PDF slides and handouts, text, code, HTML) by file_id or name; with neither, " +
        "lists files. Long PDFs come in parts (from_page). Other formats return just a link.",
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
        return { course: label, file: info, note: `Can't read ${friendlyType(file)} yet; open it with the url.` };
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

interface ThreadEntry {
  id: number;
  replyTo?: number;
  depth: number;
  /** Index of the top-level thread the entry belongs to. */
  thread: number;
  userId?: number;
  mine: boolean;
  createdAt?: string;
  html?: string | null;
  text: string;
}

const MAX_REPLIES = 150;
const MAX_REPLY_CHARS = 30_000;
const REPLY_CAP = 1500;
const MIN_REPLY_CAP = 300;

/**
 * A discussion's replies in thread order (issue #26). Entries Canvas hasn't folded into the cached view yet
 * (new_entries) are attached to their parent. When the thread is too long, long replies are shortened first
 * (down to MIN_REPLY_CAP), then whole threads are left out from the end, so the replies shown have no gaps.
 */
export function threadReplies(view: DiscussionView | undefined, me: { id: number } | undefined, mineOnly: boolean) {
  const top: DiscussionEntry[] = [...(view?.view ?? [])];
  const known = new Map<number, DiscussionEntry>();
  const index = (list: DiscussionEntry[] | undefined) => {
    for (const e of list ?? []) {
      known.set(e.id, e);
      index(e.replies);
    }
  };
  index(top);
  for (const e of view?.new_entries ?? []) {
    if (known.has(e.id)) continue;
    const parent = e.parent_id != null ? known.get(e.parent_id) : undefined;
    if (parent) parent.replies = [...(parent.replies ?? []), e];
    else top.push(e);
    known.set(e.id, e);
  }

  const flat: ThreadEntry[] = [];
  let thread = 0;
  const walk = (list: DiscussionEntry[] | undefined, depth: number, replyTo?: number) => {
    for (const e of list ?? []) {
      if (depth === 0) thread++;
      if (!e.deleted) {
        flat.push({
          id: e.id, replyTo, depth, thread, userId: e.user_id, mine: me !== undefined && e.user_id === me.id,
          createdAt: e.created_at, html: e.message, text: "",
        });
      }
      walk(e.replies, depth + 1, e.id);
    }
  };
  walk(top, 0);
  const postedByMe = flat.some((r) => r.mine);

  let pool = flat;
  if (mineOnly) {
    const mine = flat.filter((r) => r.mine);
    const mineIds = new Set(mine.map((r) => r.id));
    const answered = new Set(mine.map((r) => r.replyTo).filter((id): id is number => id !== undefined));
    // The student's posts, replies to them, and the posts they replied to (for context).
    pool = flat.filter((r) => r.mine || (r.replyTo !== undefined && mineIds.has(r.replyTo)) || answered.has(r.id));
  }

  const full = pool.map((r) => ({ ...r, text: htmlToText(r.html, 100_000) ?? "" }));
  // A clipped reply is cap characters plus "…".
  const size = (cap: number) => full.slice(0, MAX_REPLIES).reduce((n, r) => n + (r.text.length > cap ? cap + 1 : r.text.length), 0);
  // The largest per-reply cap that fits, so short replies keep their share of the budget.
  let cap = REPLY_CAP;
  if (size(cap) > MAX_REPLY_CHARS) {
    let lo = MIN_REPLY_CAP;
    let hi = REPLY_CAP;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(mid) <= MAX_REPLY_CHARS) lo = mid;
      else hi = mid - 1;
    }
    cap = lo;
  }
  const shortened = full.filter((r) => r.text.length > cap).length;
  const sized = full.map((r) => ({ ...r, text: clip(r.text, cap) }));

  // Whole threads, in order, while they fit; a first thread too big for the budget is cut at an entry.
  const entries: ThreadEntry[] = [];
  let chars = 0;
  for (let i = 0; i < sized.length; ) {
    const t = sized[i].thread;
    let j = i;
    while (j < sized.length && sized[j].thread === t) j++;
    const group = sized.slice(i, j);
    const groupChars = group.reduce((n, r) => n + r.text.length, 0);
    if (entries.length + group.length <= MAX_REPLIES && chars + groupChars <= MAX_REPLY_CHARS) {
      entries.push(...group);
      chars += groupChars;
      i = j;
      continue;
    }
    if (entries.length === 0) {
      for (const r of group) {
        if (entries.length >= MAX_REPLIES || chars + r.text.length > MAX_REPLY_CHARS) break;
        entries.push(r);
        chars += r.text.length;
      }
    }
    break;
  }

  const notes: string[] = [];
  if (entries.length < sized.length) {
    notes.push(`Showing ${entries.length} of ${sized.length} replies; later threads are left out. Open the url to read them all, or use mine_only.`);
  }
  if (shortened) notes.push(`${shortened} long repl${shortened === 1 ? "y was" : "ies were"} shortened to ${cap} characters.`);
  return {
    entries,
    total: sized.length,
    all: flat.length,
    postedByMe,
    note: notes.length ? notes.join(" ") : undefined,
  };
}

/** True when a grader filled in at least one rubric criterion. */
function hasAssessment(s: Submission): boolean {
  return Object.values(s.rubric_assessment ?? {}).some((r) => r && (r.points != null || r.rating_id || r.comments));
}

/** A person's name, preferring short_name or sortable_name when Canvas's name is just a login email. */
function displayName(u: CourseUser): string {
  const isEmail = (s: string | null | undefined) => !s || /^[^\s@]+@[^\s@]+$/.test(s.trim());
  if (!isEmail(u.name)) return u.name;
  return [u.short_name, u.sortable_name].find((n) => !isEmail(n)) ?? u.name;
}

const STAFF_ROLE: Record<string, "teacher" | "ta"> = { TeacherEnrollment: "teacher", TaEnrollment: "ta" };

const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
/** "2026-11-25" → "Wed, Nov 25, 2026"; all-day events have a date but no time zone. */
function dayOnly(ymd: string): string {
  return dayFormat.format(new Date(`${ymd}T12:00:00Z`));
}

function requirementLabel(i: ModuleItem): string | undefined {
  const r = i.completion_requirement;
  if (!r) return undefined;
  const labels: Record<string, string> = {
    must_view: "view", must_submit: "submit", must_contribute: "contribute", must_mark_done: "mark done",
  };
  if (r.type === "min_score") return `score at least ${r.min_score}`;
  return labels[r.type] ?? r.type;
}

/** Above this many other people, a conversation's participants are summarised rather than listed (issue #16). */
const MAX_NAMED = 5;

/** The other participants by name, or "First Name + N others" for a class-wide message. */
function withSummary(v: Conversation, me: number | undefined): string[] | string {
  const others = (v.participants ?? []).filter((p) => p.id !== me);
  if (others.length <= MAX_NAMED) return others.map((p) => p.name);
  return `${others[0].name} + ${others.length - 1} others`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
