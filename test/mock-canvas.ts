// A tiny fake Canvas (plus fake Microsoft sign-in) used by the smoke test. Shapes follow the real API closely
// enough to exercise pagination and the read tools. It records every Canvas request's method so the test can
// check the server never writes.
import express from "express";
import type { AddressInfo } from "node:net";

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
  };

  const now = Date.now();
  const iso = (days: number) => new Date(now + days * 86_400_000).toISOString();

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
    { id: 101, name: "Software Design", course_code: "CS 240", term: { name: "Fall 2026", end_at: iso(40) }, enrollments: [{ type: "student", computed_current_score: 93.4, computed_current_grade: "A", computed_final_score: 71.2, computed_final_grade: "C-" }] },
    { id: 202, name: "Philosophy of Mind", course_code: "PHIL 230", term: { name: "Fall 2026" }, enrollments: [{ type: "student", computed_current_score: 88.1, computed_current_grade: "B+" }] },
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
  // PDF. Its Pages tab is hidden (401). GEOL 101 has nothing, and its Files tab is hidden (403).
  const needsSyllabusSearch = (req: express.Request) => req.query.search_term === "syllabus";
  app.get("/api/v1/courses/:cid/files", (req, res) => {
    if (req.params.cid === "303") return res.status(403).json({ status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] });
    if (req.params.cid === "101" && needsSyllabusSearch(req)) return res.json([{ id: 501, display_name: "CS 240 Syllabus.pdf", updated_at: iso(-60) }]);
    res.json([]);
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
    if (req.params.cid !== "101" || !needsSyllabusSearch(req)) return res.json([]);
    // The module's name matches, so Canvas returns all its items, matching or not.
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
    "14": { id: 14, course_id: 101, name: "Observer Pattern Writeup", description: null, due_at: iso(-4), lock_at: null, unlock_at: null, points_possible: 20, submission_types: ["online_upload"], html_url: "https://canvas.test/courses/101/assignments/14" },
  };
  const mySubs: Record<string, any> = {
    "11": { workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, attempt: null },
    "12": { workflow_state: "graded", submitted_at: iso(-2), score: 5, grade: "5", attempt: 1, submission_comments: [{ author_name: "TA", comment: "Nice work", created_at: iso(-1) }] },
    "13": { workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, attempt: null },
    // Past due, never handed in, not graded: invisible in the current score (issue #2).
    "14": { workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, attempt: null, missing: true },
    "15": { workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, attempt: null },
    "16": { workflow_state: "submitted", submitted_at: iso(-3), score: null, grade: null, attempt: 1 },
  };

  app.get("/api/v1/courses/:cid/assignments", (req, res) => {
    res.json(
      Object.values(assignments)
        .filter((a) => String(a.course_id) === req.params.cid)
        .filter((a) => req.query.bucket !== "undated" || a.due_at === null)
        .map((a) => ({ ...a, submission: mySubs[a.id] })),
    );
  });
  app.get("/api/v1/courses/:cid/assignments/:aid", (req, res) => {
    const a = assignments[req.params.aid];
    if (!a) return res.status(404).json({ errors: [{ message: "The specified resource does not exist." }] });
    res.json(a);
  });
  app.get("/api/v1/courses/:cid/assignments/:aid/submissions/self", (req, res) => {
    res.json(mySubs[req.params.aid]);
  });
  app.get("/api/v1/courses/:cid/assignment_groups", (_req, res) => {
    res.json([
      { id: 1, name: "Writeups", group_weight: 60, assignments: ["11", "14"].map((id) => ({ ...assignments[id], submission: mySubs[id] })) },
      { id: 2, name: "Participation", group_weight: 40, assignments: [{ ...assignments["12"], submission: mySubs["12"] }] },
    ]);
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
  return { url: `http://127.0.0.1:${port}`, state, close: () => server.close() };
}
