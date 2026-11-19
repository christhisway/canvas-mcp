// A tiny fake Canvas (plus fake Microsoft sign-in) used by the smoke test. Shapes follow the real API closely
// enough to exercise pagination and the read tools. It records every Canvas request's method so the test can
// check the server never writes.
import express from "express";
import type { AddressInfo } from "node:net";
import { makePdf } from "./make-pdf.js";

export const TOKEN = "test-token";
export const MS_CLIENT_ID = "ms-client-id";
export const MS_CLIENT_SECRET = "ms-client-secret";
export const ALLOWED_EMAIL = "owner@example.com";

const msAccounts: Record<string, { id: string; displayName: string; mail: string | null; userPrincipalName: string }> = {
  owner: { id: "u1", displayName: "Owner", mail: null, userPrincipalName: "Owner@Example.com" },
  stranger: { id: "u2", displayName: "Stranger", mail: "stranger@example.com", userPrincipalName: "stranger@example.com" },
};

export async function startMockCanvas() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  const state = {
    canvasMethods: new Set<string>(),
    unauthorized: 0,
    msTokenRequests: [] as Array<Record<string, string>>,
    /** Requests that reached the file-storage host, and whether any carried an Authorization header. */
    storageRequests: 0,
    storageSawAuth: false,
    /** enrollment_type[] values asked of /courses/:id/users, to check the roster is never requested. */
    peopleTypesAsked: new Set<string>(),
    /** context_codes[] of each /calendar_events request. */
    eventRequests: [] as string[][],
  };

  const now = Date.now();
  const iso = (days: number) => new Date(now + days * 86_400_000).toISOString();

  // Course files for read_file. Downloads go to /files/:id/download on the Canvas host, which redirects to a
  // separate storage server (another origin), as real Canvas does.
  type MockFile = { id: number; course_id: number; display_name: string; type: string; body?: Buffer; size?: number; locked?: boolean; redirect?: string };
  // About 10,000 characters a page, so a 6-page PDF is too long for one read_file reply.
  const longPage = (n: number) => [`Observer pattern part ${n}.`, ...Array(100).fill("Subjects notify observers. ".repeat(4))].join("\n");
  const files: Record<string, MockFile> = {
    "501": { id: 501, course_id: 101, display_name: "CS 240 Syllabus.pdf", type: "application/pdf", body: makePdf(["CS 240 Syllabus", "Grading: exams 50%"]) },
    "502": { id: 502, course_id: 101, display_name: "Lecture 5 - Observer Pattern.pdf", type: "application/pdf", body: makePdf([1, 2, 3, 4, 5, 6].map(longPage)) },
    "503": { id: 503, course_id: 101, display_name: "Lecture 5 notes.txt", type: "text/plain", body: Buffer.from("Remember: observers register with the subject.\n") },
    "504": { id: 504, course_id: 101, display_name: "Lecture 6 slides.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", body: Buffer.from("PK") },
    "505": { id: 505, course_id: 101, display_name: "Exam 1 answers.pdf", type: "application/pdf", locked: true },
    "506": { id: 506, course_id: 101, display_name: "Lecture recording.pdf", type: "application/pdf", size: 30 * 1024 * 1024 },
    "507": { id: 507, course_id: 101, display_name: "Sneaky.pdf", type: "application/pdf", body: makePdf(["x"]), redirect: "http://intranet.example/secret" },
    "601": { id: 601, course_id: 303, display_name: "Rock cycle handout.pdf", type: "application/pdf", body: makePdf(["Igneous, sedimentary, metamorphic"]) },
  };
  const fileJson = (req: express.Request, f: MockFile) => ({
    id: f.id,
    display_name: f.display_name,
    filename: f.display_name,
    "content-type": f.type,
    size: f.size ?? f.body?.length ?? 0,
    updated_at: iso(-3),
    url: f.locked ? "" : `http://${req.headers.host}/files/${f.id}/download?download_frd=1&verifier=v${f.id}`,
    locked_for_user: f.locked || undefined,
    lock_explanation: f.locked ? "<p>This file is locked until after the exam.</p>" : undefined,
  });

  const storage = express();
  storage.get("/blob/:id", (req, res) => {
    state.storageRequests++;
    if (req.headers.authorization) state.storageSawAuth = true;
    const f = files[req.params.id];
    if (!f?.body) return res.status(404).end();
    res.type(f.type).send(f.body);
  });
  const storageServer = await new Promise<import("node:http").Server>((resolve) => {
    const s = storage.listen(0, "127.0.0.1", () => resolve(s));
  });
  const storageUrl = `http://127.0.0.1:${(storageServer.address() as AddressInfo).port}`;

  app.get("/files/:id/download", (req, res) => {
    state.canvasMethods.add(req.method);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      state.unauthorized++;
      return res.status(401).end();
    }
    const f = files[req.params.id];
    if (!f?.body) return res.status(404).end();
    res.redirect(302, f.redirect ?? `${storageUrl}/blob/${f.id}`);
  });

  // Auth on everything under /api/v1
  app.use("/api/v1", (req, res, next) => {
    state.canvasMethods.add(req.method);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      state.unauthorized++;
      return res.status(401).json({ errors: [{ message: "Invalid access token." }] });
    }
    next();
  });

  const courses = [
    // Scores match what Canvas would compute from the assignment groups below (grade_whatif checks this).
    // CS 240 weights its groups and uses Canvas's default letter scale.
    { id: 101, name: "Software Design", course_code: "CS 240", term: { name: "Fall 2026", end_at: iso(40) }, apply_assignment_group_weights: true, grading_standard_id: null, enrollments: [{ type: "student", computed_current_score: 93.4, computed_current_grade: "A-", computed_final_score: 57.8, computed_final_grade: "F" }] },
    // PHIL 230 counts total points, drops the lowest quiz, and has its own letter scale.
    { id: 202, name: "Philosophy of Mind", course_code: "PHIL 230", term: { name: "Fall 2026" }, apply_assignment_group_weights: false, grading_standard_id: 5, enrollments: [{ type: "student", computed_current_score: 83.75, computed_current_grade: "B", computed_final_score: 49.63, computed_final_grade: "F" }] },
    // Enrollments Canvas still calls "active" although the course is over (issue #1).
    { id: 303, name: "Intro to Geology", course_code: "GEOL 101", term: { name: "Fall 2025", end_at: iso(-320) }, enrollments: [{ type: "student", computed_current_score: 91, computed_current_grade: "A-" }] },
    { id: 404, name: "World History", course_code: "HIST 105", concluded: true, term: { name: "Spring 2026" }, enrollments: [{ type: "student" }] },
  ];

  app.get("/api/v1/courses", (req, res) => {
    const base = `http://${req.headers.host}/api/v1/courses`;
    if (req.query.page === "2") return res.json(courses.slice(1));
    res.set("Link", `<${base}?page=2&per_page=1>; rel="next", <${base}?page=1>; rel="first"`);
    res.json([courses[0]]);
  });
  app.get("/api/v1/courses/:id", (req, res) => {
    const c = courses.find((x) => String(x.id) === req.params.id);
    if (!c) return res.status(404).json({ errors: [{ message: "The specified resource does not exist." }] });
    const syllabus: Record<number, string | null> = { 202: "<h2>Syllabus</h2><p>Exams are <b>40%</b>.</p>", 101: "<p> </p>" };
    res.json({ ...c, syllabus_body: syllabus[c.id] ?? null });
  });

  // Syllabus fallback (issue #3). CS 240's syllabus page is empty; its syllabus is a module page plus a
  // PDF. Its Pages tab is hidden (401). GEOL 101 has no syllabus, and its Files tab is hidden (403).
  app.get("/api/v1/courses/:cid/files", (req, res) => {
    if (req.params.cid === "303") return res.status(403).json({ status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] });
    const term = String(req.query.search_term ?? "").toLowerCase();
    res.json(
      Object.values(files)
        .filter((f) => f.course_id === Number(req.params.cid) && f.display_name.toLowerCase().includes(term))
        .map((f) => fileJson(req, f)),
    );
  });
  app.get("/api/v1/files/:id", (req, res) => {
    const f = files[req.params.id];
    if (!f) return res.status(404).json({ errors: [{ message: "The specified resource does not exist." }] });
    res.json(fileJson(req, f));
  });
  app.get("/api/v1/courses/:cid/pages", (req, res) => {
    if (req.params.cid === "101") return res.status(401).json({ status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] });
    res.json([]);
  });
  app.get("/api/v1/courses/:cid/pages/:slug", (req, res) => {
    if (req.params.cid === "101" && req.params.slug === "course-syllabus") {
      return res.json({ url: "course-syllabus", title: "Course Syllabus", body: "<p>Late work loses <b>10% per day</b>.</p>", html_url: "https://canvas.test/courses/101/pages/course-syllabus" });
    }
    res.status(404).json({ errors: [{ message: "The specified resource does not exist." }] });
  });
  app.get("/api/v1/courses/:cid/modules", (req, res) => {
    // GEOL 101 hides its Files tab, but a module still links a handout (read_file's fallback).
    if (req.params.cid === "303") {
      return res.json([{ id: 2, name: "Week 3", items: [
        { id: 81, title: "Rock cycle handout", type: "File", content_id: 601, html_url: "https://canvas.test/courses/303/modules/items/81" },
      ] }]);
    }
    if (req.params.cid !== "101") return res.json([]);
    // The module's name matches "syllabus", so Canvas returns all its items, matching or not.
    res.json([{ id: 1, name: "Syllabus & Start Here", items: [
      { id: 71, title: "CS 240 Syllabus.pdf", type: "File", content_id: 501, html_url: "https://canvas.test/courses/101/modules/items/71" },
      { id: 72, title: "Course Syllabus", type: "Page", page_url: "course-syllabus", html_url: "https://canvas.test/courses/101/modules/items/72" },
      { id: 73, title: "Welcome video", type: "ExternalUrl", external_url: "https://video.example/welcome" },
    ] }]);
  });

  const assignments: Record<string, any> = {
    "11": { id: 11, course_id: 101, name: "Factory Pattern Writeup", description: "<p>Write 500 words on <em>factories</em>.</p>", due_at: iso(2), lock_at: null, unlock_at: null, points_possible: 20, submission_types: ["online_upload"], allowed_extensions: ["pdf"], allowed_attempts: -1, html_url: "https://canvas.test/courses/101/assignments/11" },
    "12": { id: 12, course_id: 101, name: "Reflection", description: "<p>Reflect.</p>", due_at: iso(-1), lock_at: null, unlock_at: null, points_possible: 5, submission_types: ["online_text_entry"], allowed_attempts: 1, html_url: "https://canvas.test/courses/101/assignments/12" },
    "13": { id: 13, course_id: 101, name: "Portfolio link", description: null, due_at: iso(5), lock_at: null, unlock_at: null, points_possible: 10, submission_types: ["online_url"], html_url: "https://canvas.test/courses/101/assignments/13" },
    // No due date, so never on the planner (issue #4); one still to do, one already handed in.
    "15": { id: 15, course_id: 202, name: "Group report", description: null, due_at: null, lock_at: null, unlock_at: null, points_possible: 50, submission_types: ["online_upload"], html_url: "https://canvas.test/courses/202/assignments/15" },
    "16": { id: 16, course_id: 202, name: "Reading response", description: null, due_at: null, lock_at: null, unlock_at: null, points_possible: 5, submission_types: ["online_text_entry"], html_url: "https://canvas.test/courses/202/assignments/16" },
    "17": { id: 17, course_id: 101, name: "Strategy Pattern Writeup", description: null, due_at: iso(-10), lock_at: null, unlock_at: null, points_possible: 20, submission_types: ["online_upload"], html_url: "https://canvas.test/courses/101/assignments/17" },
    // PHIL 230's graded work. Dropping the lowest *percentage* quiz (21) would be wrong: dropping 22 leaves
    // 22/30, a better ratio than 25/40. Quiz 4 is excused.
    "21": { id: 21, course_id: 202, name: "Quiz 1", description: null, due_at: iso(-40), lock_at: null, unlock_at: null, points_possible: 10, submission_types: ["online_quiz"], html_url: "https://canvas.test/courses/202/assignments/21" },
    "22": { id: 22, course_id: 202, name: "Quiz 2", description: null, due_at: iso(-30), lock_at: null, unlock_at: null, points_possible: 20, submission_types: ["online_quiz"], html_url: "https://canvas.test/courses/202/assignments/22" },
    "23": { id: 23, course_id: 202, name: "Quiz 3", description: null, due_at: iso(-20), lock_at: null, unlock_at: null, points_possible: 20, submission_types: ["online_quiz"], html_url: "https://canvas.test/courses/202/assignments/23" },
    "24": { id: 24, course_id: 202, name: "Quiz 4", description: null, due_at: iso(-10), lock_at: null, unlock_at: null, points_possible: 20, submission_types: ["online_quiz"], html_url: "https://canvas.test/courses/202/assignments/24" },
    // Essay 1 has a rubric for get_feedback (GitHub #3).
    "25": { id: 25, course_id: 202, name: "Essay 1", description: null, due_at: iso(-15), lock_at: null, unlock_at: null, points_possible: 50, submission_types: ["online_upload"], html_url: "https://canvas.test/courses/202/assignments/25", rubric: [
      { id: "c1", description: "Thesis", long_description: "<p>A clear, arguable claim.</p>", points: 20, ratings: [
        { id: "r1", description: "Full marks", points: 20 },
        { id: "r2", description: "Partial", long_description: "Thesis is present but vague", points: 15 },
        { id: "r3", description: "Missing", points: 0 },
      ] },
      { id: "c2", description: "Evidence", points: 20, ratings: [{ id: "r4", description: "Strong", points: 20 }, { id: "r5", description: "Weak", points: 10 }] },
      { id: "c3", description: "Mechanics", points: 10, ratings: [] },
    ] },
    // The graded discussion's assignment (GitHub #7).
    "26": { id: 26, course_id: 202, name: "Week 5: Chinese Room", description: null, due_at: iso(2), lock_at: null, unlock_at: null, points_possible: 10, submission_types: ["discussion_topic"], html_url: "https://canvas.test/courses/202/assignments/26" },
    "14": { id: 14, course_id: 101, name: "Observer Pattern Writeup", description: null, due_at: iso(-4), lock_at: null, unlock_at: null, points_possible: 20, submission_types: ["online_upload"], html_url: "https://canvas.test/courses/101/assignments/14" },
  };
  const mySubs: Record<string, any> = {
    "11": { workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, attempt: null },
    "12": { workflow_state: "graded", submitted_at: iso(-2), graded_at: iso(-1), score: 5, grade: "5", attempt: 1, submission_comments: [{ author_name: "TA", comment: "Nice work", created_at: iso(-1) }] },
    "13": { workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, attempt: null },
    // Past due, never handed in, not graded: invisible in the current score (issue #2).
    "14": { workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, attempt: null, missing: true },
    "15": { workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, attempt: null },
    "26": { workflow_state: "submitted", submitted_at: iso(-1), score: null, grade: null, attempt: 1 },
    "17": { workflow_state: "graded", submitted_at: iso(-11), graded_at: iso(-9), score: 17.8, grade: "17.8", attempt: 1 },
    "21": { workflow_state: "graded", submitted_at: iso(-40), graded_at: iso(-3), score: 2, grade: "2", attempt: 1 },
    "22": { workflow_state: "graded", submitted_at: iso(-30), graded_at: iso(-29), score: 5, grade: "5", attempt: 1 },
    "23": { workflow_state: "graded", submitted_at: iso(-20), graded_at: iso(-19), score: 20, grade: "20", attempt: 1 },
    "24": { workflow_state: "graded", submitted_at: null, graded_at: iso(-2), score: null, grade: null, attempt: null, excused: true },
    "25": { workflow_state: "graded", submitted_at: iso(-16), graded_at: iso(-12), score: 45, grade: "45", attempt: 1,
      rubric_assessment: { c1: { points: 15, rating_id: "r2", comments: "State the claim in the first paragraph." }, c2: { points: 20, rating_id: "r4", comments: "" }, c3: { points: 10, comments: "" } },
      submission_comments: [{ author_name: "Prof. B", comment: "Good use of Searle. See my markup.", created_at: iso(-12), attachments: [{ display_name: "essay1-markup.pdf", url: "https://canvas.test/files/9/download" }] }] },
    // Graded but not posted to students yet: Canvas hides the score.
    "16": { workflow_state: "graded", submitted_at: iso(-3), graded_at: iso(-1), score: null, grade: null, attempt: 1 },
  };

  app.get("/api/v1/courses/:cid/assignments", (req, res) => {
    res.json(
      Object.values(assignments)
        .filter((a) => String(a.course_id) === req.params.cid)
        .filter((a) => req.query.bucket !== "undated" || a.due_at === null)
        .filter((a) => !req.query.search_term || a.name.toLowerCase().includes(String(req.query.search_term).toLowerCase()))
        .map((a) => ({ ...a, submission: mySubs[a.id] })),
    );
  });
  app.get("/api/v1/courses/:cid/assignments/:aid", (req, res) => {
    const a = assignments[req.params.aid];
    if (!a) return res.status(404).json({ errors: [{ message: "The specified resource does not exist." }] });
    res.json(a);
  });
  // course_people (GitHub #4). CS 240's teacher shows an email; its TA doesn't, as when Canvas hides it.
  const people: Record<string, Array<{ id: number; name: string; email?: string; pronouns?: string; type: string; role: string }>> = {
    "101": [
      { id: 50, name: "Dana Ortiz", email: "dortiz@example.edu", pronouns: "she/her", type: "TeacherEnrollment", role: "TeacherEnrollment" },
      { id: 51, name: "Sam Park", type: "TaEnrollment", role: "Lead TA" },
      { id: 52, name: "Riley Classmate", email: "riley@example.edu", type: "StudentEnrollment", role: "StudentEnrollment" },
    ],
  };
  app.get("/api/v1/courses/:cid/users", (req, res) => {
    if (req.params.cid === "303") return res.status(403).json({ status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] });
    const types = ([] as string[]).concat((req.query["enrollment_type[]"] as string | string[]) ?? []);
    for (const t of types) state.peopleTypesAsked.add(t);
    if (types.length === 0) state.peopleTypesAsked.add("(all)");
    const include = ([] as string[]).concat((req.query["include[]"] as string | string[]) ?? []);
    const typeName = (t: string) => ({ teacher: "TeacherEnrollment", ta: "TaEnrollment", student: "StudentEnrollment" })[t];
    res.json(
      (people[req.params.cid] ?? [])
        .filter((p) => types.length === 0 || types.some((t) => typeName(t) === p.type))
        .map((p) => ({
          id: p.id, name: p.name, pronouns: p.pronouns,
          email: include.includes("email") ? p.email : undefined,
          enrollments: include.includes("enrollments") ? [{ type: p.type, role: p.role, course_id: Number(req.params.cid) }] : undefined,
        })),
    );
  });
  app.get("/api/v1/users/self", (_req, res) => res.json({ id: 1, name: "Owner Student" }));
  app.get("/api/v1/users/self/groups", (_req, res) => {
    res.json([
      { id: 900, name: "Lab Group 4", course_id: 101, context_type: "Course", members_count: 2 },
      { id: 901, name: "Reading circle", course_id: 202, context_type: "Course", members_count: 3 },
    ]);
  });
  app.get("/api/v1/groups/:gid/users", (req, res) => {
    const members: Record<string, unknown[]> = {
      "900": [{ id: 1, name: "Owner Student" }, { id: 52, name: "Riley Classmate" }],
      "901": [{ id: 1, name: "Owner Student" }],
    };
    res.json(members[req.params.gid] ?? []);
  });

  // list_events (GitHub #6). GEOL 101 is a past course, so its event must never be asked for.
  const ymd = (days: number) => iso(days).slice(0, 10);
  const events = [
    { id: 1, title: "Midterm exam", start_at: iso(3), end_at: iso(3.0833), context_code: "course_101", location_name: "Sitterson 014", description: "<p>Covers <b>lectures 1–8</b>.</p>", html_url: "https://canvas.test/calendar?event_id=1" },
    { id: 2, title: "Office hours", start_at: iso(1), end_at: iso(1.04), context_code: "course_202", location_name: "Caldwell 105", description: null, html_url: "https://canvas.test/calendar?event_id=2" },
    { id: 3, title: "Final exam", start_at: iso(30), end_at: iso(30.1), context_code: "course_202", description: null, html_url: "https://canvas.test/calendar?event_id=3" },
    { id: 4, title: "Review session", start_at: iso(-2), end_at: iso(-1.95), context_code: "course_101", description: "<p>Bring questions about the midterm exam.</p>", html_url: "https://canvas.test/calendar?event_id=4" },
    { id: 5, title: "Field trip", start_at: iso(2), end_at: iso(2), context_code: "course_303", description: null },
    { id: 6, title: "Advising appointment", start_at: iso(2), end_at: iso(2.02), context_code: "user_1", description: null },
    { id: 7, title: "Reading day", start_at: `${ymd(5)}T00:00:00Z`, end_at: `${ymd(5)}T00:00:00Z`, all_day: true, all_day_date: ymd(5), context_code: "course_202", description: null },
    { id: 8, title: "Cancelled section", start_at: iso(4), end_at: iso(4), context_code: "course_101", workflow_state: "deleted", description: null },
  ];
  app.get("/api/v1/calendar_events", (req, res) => {
    const codes = ([] as string[]).concat((req.query["context_codes[]"] as string | string[]) ?? []);
    state.eventRequests.push(codes);
    const start = String(req.query.start_date ?? "");
    const end = String(req.query.end_date ?? "9999");
    res.json(events.filter((e) => codes.includes(e.context_code) && e.end_at >= start && e.start_at <= end));
  });

  // Discussions (GitHub #7) in PHIL 230: a graded topic the student has posted in, one that hides replies
  // until the student posts, and an empty Q&A. User 1 is the student.
  const topics: Record<string, any> = {
    "31": { id: 31, title: "Week 5: Chinese Room", message: "<p>Does the room <em>understand</em> Chinese?</p>", posted_at: iso(-6), assignment_id: 26, require_initial_post: false, user_can_see_posts: true, discussion_subentry_count: 4, unread_count: 2, last_reply_at: iso(-1), author: { display_name: "Prof. B" }, html_url: "https://canvas.test/courses/202/discussion_topics/31" },
    "32": { id: 32, title: "Week 6: Zombies", message: "<p>Could a zombie be conscious?</p>", posted_at: iso(-2), assignment_id: null, require_initial_post: true, user_can_see_posts: false, discussion_subentry_count: 5, unread_count: 0, last_reply_at: iso(0), author: { display_name: "Prof. B" }, html_url: "https://canvas.test/courses/202/discussion_topics/32" },
    "34": { id: 34, title: "Introductions", message: "<p>Say hi.</p>", posted_at: iso(-60), assignment_id: null, require_initial_post: false, user_can_see_posts: true, discussion_subentry_count: 200, unread_count: 0, last_reply_at: iso(-1), html_url: "https://canvas.test/courses/202/discussion_topics/34" },
    "33": { id: 33, title: "General Q&A", message: "<p>Ask anything.</p>", posted_at: iso(-30), assignment_id: null, require_initial_post: false, user_can_see_posts: true, discussion_subentry_count: 0, unread_count: 0, last_reply_at: null, html_url: "https://canvas.test/courses/202/discussion_topics/33" },
  };
  app.get("/api/v1/courses/:cid/discussion_topics", (req, res) => res.json(req.params.cid === "202" ? Object.values(topics) : []));
  app.get("/api/v1/courses/:cid/discussion_topics/:tid", (req, res) => {
    const t = req.params.cid === "202" ? topics[req.params.tid] : undefined;
    if (!t) return res.status(404).json({ errors: [{ message: "The specified resource does not exist." }] });
    res.json(t);
  });
  app.get("/api/v1/courses/:cid/discussion_topics/:tid/view", (req, res) => {
    if (req.params.tid === "32") return res.status(403).json({ errors: [{ message: "You must post before viewing replies" }] });
    if (req.params.tid === "33") return res.json({ participants: [], view: [] });
    if (req.params.tid === "34") {
      return res.json({
        participants: [{ id: 60, display_name: "Alex Kim" }],
        view: Array.from({ length: 200 }, (_, i) => ({ id: 1000 + i, user_id: 60, message: `<p>Post ${i}</p>`, created_at: iso(-1) })),
      });
    }
    res.json({
      participants: [{ id: 1, display_name: "Owner Student" }, { id: 60, display_name: "Alex Kim" }, { id: 61, display_name: "Jordan Lee" }],
      view: [
        { id: 401, user_id: 60, message: "<p>No: syntax isn't semantics.</p>", created_at: iso(-5), replies: [
          { id: 403, user_id: 1, message: "<p>But the <b>system</b> might understand.</p>", created_at: iso(-4), replies: [
            { id: 404, user_id: 60, message: "<p>The systems reply! Searle answers it.</p>", created_at: iso(-3) },
          ] },
        ] },
        { id: 402, user_id: 61, message: "<p>Depends on what understanding is.</p>", created_at: iso(-2) },
        { id: 405, deleted: true, created_at: iso(-1) },
      ],
    });
  });

  // The calling student's submissions in a course (no student_ids, so Canvas means "me").
  app.get("/api/v1/courses/:cid/students/submissions", (req, res) => {
    const include = ([] as string[]).concat((req.query["include[]"] as string | string[]) ?? []);
    res.json(
      Object.values(assignments)
        .filter((a) => String(a.course_id) === req.params.cid)
        .filter((a) => !req.query.graded_since || (mySubs[a.id].graded_at && mySubs[a.id].graded_at >= String(req.query.graded_since)))
        .map((a) => ({ ...mySubs[a.id], assignment_id: a.id, assignment: include.includes("assignment") ? a : undefined })),
    );
  });
  app.get("/api/v1/courses/:cid/assignments/:aid/submissions/self", (req, res) => {
    res.json(mySubs[req.params.aid]);
  });
  const withSubs = (ids: string[]) => ids.map((id) => ({ ...assignments[id], submission: mySubs[id] }));
  app.get("/api/v1/courses/:cid/assignment_groups", (req, res) => {
    const groups: Record<string, unknown[]> = {
      "101": [
        { id: 1, name: "Writeups", group_weight: 60, rules: {}, assignments: withSubs(["17", "11", "14"]) },
        { id: 2, name: "Participation", group_weight: 40, rules: {}, assignments: withSubs(["12"]) },
      ],
      "202": [
        { id: 3, name: "Quizzes", group_weight: 0, rules: { drop_lowest: 1 }, assignments: withSubs(["21", "22", "23", "24"]) },
        { id: 4, name: "Essays", group_weight: 0, rules: {}, assignments: withSubs(["25", "15", "16"]) },
      ],
    };
    res.json(groups[req.params.cid] ?? []);
  });
  app.get("/api/v1/courses/:cid/grading_standards", (req, res) => {
    if (req.params.cid !== "202") return res.json([]);
    const cutoffs: Array<[string, number]> = [
      ["A", 0.93], ["A-", 0.9], ["B+", 0.87], ["B", 0.83], ["B-", 0.8], ["C+", 0.77], ["C", 0.73], ["C-", 0.7], ["D+", 0.67], ["D", 0.6], ["F", 0],
    ];
    res.json([{ id: 5, title: "Philosophy scale", grading_scheme: cutoffs.map(([name, value]) => ({ name, value })) }]);
  });

  app.get("/api/v1/planner/items", (_req, res) => {
    res.json([
      { plannable_type: "assignment", plannable_id: 13, plannable_date: iso(5), course_id: 101, context_name: "Software Design", html_url: "/courses/101/assignments/13", plannable: { title: "Portfolio link", due_at: iso(5), points_possible: 10 }, submissions: { submitted: false, missing: false } },
      { plannable_type: "assignment", plannable_id: 11, plannable_date: iso(2), course_id: 101, context_name: "Software Design", html_url: "/courses/101/assignments/11", plannable: { title: "Factory Pattern Writeup", due_at: iso(2), points_possible: 20 }, submissions: { submitted: false, missing: false } },
      { plannable_type: "quiz", plannable_id: 99, plannable_date: iso(1), course_id: 202, context_name: "Philosophy of Mind", html_url: "/courses/202/quizzes/99", plannable: { title: "Chinese Room quiz", due_at: iso(1), points_possible: 10 }, submissions: { submitted: true } },
      { plannable_type: "announcement", plannable_id: 5, plannable_date: iso(0), course_id: 202, plannable: { title: "hidden" }, submissions: false },
    ]);
  });

  app.get("/api/v1/announcements", (req, res) => {
    const codes = ([] as string[]).concat((req.query["context_codes[]"] as string | string[]) ?? []);
    res.json(
      codes.includes("course_202")
        ? [{ id: 7, title: "Essay deadline moved", message: "<p>Now due <strong>Friday</strong>.</p>", posted_at: iso(-1), context_code: "course_202", html_url: "https://canvas.test/courses/202/discussion_topics/7", author: { display_name: "Prof. B" } }]
        : [],
    );
  });

  // Stand-in for Microsoft sign-in. The test drives the browser part itself (it reads the authorize
  // redirect and calls /callback directly), so only the token endpoint and Graph /me are needed.
  // The Microsoft code picks the account: "ms-code-<who>".
  app.post("/ms/:tenant/oauth2/v2.0/token", express.urlencoded({ extended: false }), (req, res) => {
    const b = req.body as Record<string, string>;
    state.msTokenRequests.push(b);
    if (b.client_id !== MS_CLIENT_ID || b.client_secret !== MS_CLIENT_SECRET || !b.code_verifier) {
      return res.status(400).json({ error: "invalid_client" });
    }
    const who = b.code?.replace(/^ms-code-/, "");
    if (!who || !(who in msAccounts)) return res.status(400).json({ error: "invalid_grant" });
    res.json({ access_token: `ms-at-${who}`, token_type: "Bearer", expires_in: 3600 });
  });
  app.get("/graph/v1.0/me", (req, res) => {
    const who = req.headers.authorization?.replace(/^Bearer ms-at-/, "") ?? "";
    const p = msAccounts[who];
    if (!p) return res.status(401).json({ error: { code: "InvalidAuthenticationToken" } });
    res.json(p);
  });

  // A Client ID Metadata Document, like the one claude.ai serves.
  app.get("/cimd/client.json", (req, res) => {
    res.json({
      client_id: `http://${req.headers.host}/cimd/client.json`,
      client_name: "Mock Claude",
      redirect_uris: ["https://claude.example/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    events,
    close: () => {
      server.close();
      storageServer.close();
    },
  };
}
