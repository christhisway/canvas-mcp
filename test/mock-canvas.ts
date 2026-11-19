// A tiny fake Canvas (plus fake Microsoft sign-in and ntfy) used by the smoke test. Shapes follow the real API closely
// enough to exercise pagination, the file-upload dance, and submissions.
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
    submissions: [] as Array<{ courseId: string; assignmentId: string; form: Record<string, unknown> }>,
    uploads: [] as Array<{ fields: string[]; bytes: number }>,
    ntfy: [] as Array<{ title?: string; body: string }>,
    unauthorized: 0,
    msTokenRequests: [] as Array<Record<string, string>>,
  };

  const now = Date.now();
  const iso = (days: number) => new Date(now + days * 86_400_000).toISOString();

  // Auth on everything under /api/v1
  app.use("/api/v1", (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      state.unauthorized++;
      return res.status(401).json({ errors: [{ message: "Invalid access token." }] });
    }
    next();
  });

  const courses = [
    { id: 101, name: "Software Design", course_code: "CS 240", term: { name: "Fall 2026" }, enrollments: [{ type: "student", computed_current_score: 93.4, computed_current_grade: "A" }] },
    { id: 202, name: "Philosophy of Mind", course_code: "PHIL 230", term: { name: "Fall 2026" }, enrollments: [{ type: "student", computed_current_score: 88.1, computed_current_grade: "B+" }] },
  ];

  app.get("/api/v1/courses", (req, res) => {
    const base = `http://${req.headers.host}/api/v1/courses`;
    if (req.query.page === "2") return res.json([courses[1]]);
    res.set("Link", `<${base}?page=2&per_page=1>; rel="next", <${base}?page=1>; rel="first"`);
    res.json([courses[0]]);
  });
  app.get("/api/v1/courses/:id", (req, res) => {
    const c = courses.find((x) => String(x.id) === req.params.id);
    if (!c) return res.status(404).json({ errors: [{ message: "The specified resource does not exist." }] });
    res.json({ ...c, syllabus_body: "<h2>Syllabus</h2><p>Exams are <b>40%</b>.</p>" });
  });

  const assignments: Record<string, any> = {
    "11": { id: 11, course_id: 101, name: "Factory Pattern Writeup", description: "<p>Write 500 words on <em>factories</em>.</p>", due_at: iso(2), lock_at: null, unlock_at: null, points_possible: 20, submission_types: ["online_upload"], allowed_extensions: ["pdf"], allowed_attempts: -1, html_url: "https://canvas.test/courses/101/assignments/11" },
    "12": { id: 12, course_id: 101, name: "Reflection", description: "<p>Reflect.</p>", due_at: iso(-1), lock_at: null, unlock_at: null, points_possible: 5, submission_types: ["online_text_entry"], allowed_attempts: 1, html_url: "https://canvas.test/courses/101/assignments/12" },
    "13": { id: 13, course_id: 101, name: "Portfolio link", description: null, due_at: iso(5), lock_at: null, unlock_at: null, points_possible: 10, submission_types: ["online_url"], html_url: "https://canvas.test/courses/101/assignments/13" },
  };
  const mySubs: Record<string, any> = {
    "11": { workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, attempt: null },
    "12": { workflow_state: "graded", submitted_at: iso(-2), score: 5, grade: "5", attempt: 1, submission_comments: [{ author_name: "TA", comment: "Nice work", created_at: iso(-1) }] },
    "13": { workflow_state: "unsubmitted", submitted_at: null, score: null, grade: null, attempt: null },
  };

  app.get("/api/v1/courses/:cid/assignments", (_req, res) => {
    res.json(Object.values(assignments).map((a) => ({ ...a, submission: mySubs[a.id] })));
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
      { id: 1, name: "Writeups", group_weight: 60, assignments: [{ ...assignments["11"], submission: mySubs["11"] }] },
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

  // File upload: step 1 ticket, step 2 storage POST (302 → confirm), step 3 confirm.
  app.post("/api/v1/courses/:cid/assignments/:aid/submissions/self/files", (req, res) => {
    res.json({ upload_url: `http://${req.headers.host}/storage/upload`, upload_params: { key: "abc", signature: "sig" } });
  });
  app.post("/storage/upload", express.raw({ type: "multipart/form-data", limit: "50mb" }), (req, res) => {
    if (req.headers.authorization) return res.status(400).send("storage must not receive the Canvas token");
    const raw = (req.body as Buffer).toString("latin1");
    const fields = [...raw.matchAll(/form-data; name="([^"]+)"/g)].map((m) => m[1]);
    state.uploads.push({ fields, bytes: (req.body as Buffer).length });
    res.redirect(302, `http://${req.headers.host}/api/v1/files/555`);
  });
  app.get("/api/v1/files/555", (_req, res) => res.json({ id: 555, display_name: "upload" }));

  app.post("/api/v1/courses/:cid/assignments/:aid/submissions", (req, res) => {
    state.submissions.push({ courseId: req.params.cid, assignmentId: req.params.aid, form: req.body });
    mySubs[req.params.aid] = { workflow_state: "submitted", submitted_at: new Date().toISOString(), score: null, grade: null, attempt: 1, late: req.params.aid === "12" };
    res.json(mySubs[req.params.aid]);
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

  // Stand-in for ntfy.sh
  app.post("/ntfy/topic", express.text({ type: "*/*" }), (req, res) => {
    state.ntfy.push({ title: req.headers.title as string | undefined, body: String(req.body) });
    res.json({ id: "n1" });
  });

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, state, close: () => server.close() };
}
