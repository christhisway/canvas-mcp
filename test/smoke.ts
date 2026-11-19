// End-to-end check: real HTTP server process ↔ mock Canvas + mock Microsoft ↔ OAuth + MCP client.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ALLOWED_EMAIL, MS_CLIENT_ID, MS_CLIENT_SECRET, startMockCanvas, TOKEN } from "./mock-canvas.js";
import { Jar, register, signIn, token } from "./oauth-client.js";

const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT = "https://claude.example/api/mcp/auth_callback";

const mock = await startMockCanvas();
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-data-"));

const proc = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
  env: {
    ...process.env,
    CANVAS_BASE_URL: mock.url,
    CANVAS_TOKEN: TOKEN,
    PUBLIC_URL: BASE,
    PORT: String(PORT),
    MS_CLIENT_ID,
    MS_CLIENT_SECRET,
    MS_AUTHORITY: `${mock.url}/ms`,
    MS_GRAPH_URL: `${mock.url}/graph`,
    ALLOWED_EMAILS: ` ${ALLOWED_EMAIL.toUpperCase()} , other@example.com`,
    COOKIE_SECRET: "c".repeat(64),
    CIMD_ALLOWED_HOSTS: new URL(mock.url).host,
    DATA_DIR: dataDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
proc.stdout.on("data", (d) => (serverLog += d));
proc.stderr.on("data", (d) => (serverLog += d));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server didn't start:\n${serverLog}`);
}

const parse = (r: any) => {
  const text = r.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return text; }
};

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}

const mcpPing = (accessToken: string) =>
  fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

try {
  await waitForServer();
  console.log("auth");

  await check("/mcp without a token is a 401 pointing at resource metadata", async () => {
    const r = await fetch(`${BASE}/mcp`, { method: "POST" });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const bogus = await mcpPing("cmcp_at_nope");
    assert.equal(bogus.status, 401);
  });

  await check("metadata: protected resource + authorization server (with CIMD flag)", async () => {
    const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(prm.resource, `${BASE}/mcp`);
    assert.deepEqual(prm.authorization_servers, [`${BASE}/`]);
    const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.client_id_metadata_document_supported, true);
    assert.equal(as.registration_endpoint, `${BASE}/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  });

  let accessToken = "";
  let refreshToken = "";
  let dcr: { client_id: string; client_secret?: string } = { client_id: "" };

  await check("DCR client: consent → Microsoft → code → tokens", async () => {
    dcr = await register(BASE, { client_name: "Smoke Client", redirect_uris: [REDIRECT] });
    assert.ok(dcr.client_secret, "confidential client gets a secret");
    const s = await signIn(BASE, { clientId: dcr.client_id, redirectUri: REDIRECT, msCode: "ms-code-owner" });
    assert.equal(s.sawConsent, true);
    assert.equal(s.redirect.searchParams.get("state"), "client-state");
    const code = s.redirect.searchParams.get("code")!;
    assert.ok(code);
    const ms = mock.state.msTokenRequests.at(-1)!;
    assert.equal(ms.redirect_uri, `${BASE}/callback`);
    assert.equal(ms.scope, "User.Read");

    const t = await token(BASE, {
      grant_type: "authorization_code", code, code_verifier: s.verifier, client_id: dcr.client_id,
      client_secret: dcr.client_secret!, redirect_uri: REDIRECT, resource: `${BASE}/mcp`,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.match(t.body.access_token, /^cmcp_at_/);
    assert.equal(t.body.expires_in, 3600);
    accessToken = t.body.access_token;
    refreshToken = t.body.refresh_token;
    assert.equal((await mcpPing(accessToken)).status, 200);

    // Reusing the code fails and revokes what it issued.
    const again = await token(BASE, {
      grant_type: "authorization_code", code, code_verifier: s.verifier, client_id: dcr.client_id, client_secret: dcr.client_secret!,
    });
    assert.equal(again.body.error, "invalid_grant");
    assert.equal((await mcpPing(accessToken)).status, 401, "reused code must revoke its tokens");
  });

  await check("wrong PKCE verifier and missing client secret are refused", async () => {
    const s = await signIn(BASE, { clientId: dcr.client_id, redirectUri: REDIRECT, msCode: "ms-code-owner" });
    const code = s.redirect.searchParams.get("code")!;
    const noSecret = await token(BASE, { grant_type: "authorization_code", code, code_verifier: s.verifier, client_id: dcr.client_id });
    assert.equal(noSecret.body.error, "invalid_client");
    const badVerifier = await token(BASE, {
      grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: dcr.client_id, client_secret: dcr.client_secret!,
    });
    assert.equal(badVerifier.body.error, "invalid_grant");
    const ok = await token(BASE, {
      grant_type: "authorization_code", code, code_verifier: s.verifier, client_id: dcr.client_id, client_secret: dcr.client_secret!,
    });
    assert.equal(ok.status, 200);
    accessToken = ok.body.access_token;
    refreshToken = ok.body.refresh_token;
  });

  await check("refresh rotates tokens; the previous refresh token survives one retry", async () => {
    const secret = dcr.client_secret!;
    const r1 = await token(BASE, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: dcr.client_id, client_secret: secret });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.notEqual(r1.body.refresh_token, refreshToken);
    assert.equal((await mcpPing(accessToken)).status, 401, "old access token is retired");
    assert.equal((await mcpPing(r1.body.access_token)).status, 200);

    // Client lost r1's response and retries with the old refresh token: still accepted.
    const retry = await token(BASE, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: dcr.client_id, client_secret: secret });
    assert.equal(retry.status, 200);
    // ...which makes r1's never-used refresh token invalid.
    const stale = await token(BASE, { grant_type: "refresh_token", refresh_token: r1.body.refresh_token, client_id: dcr.client_id, client_secret: secret });
    assert.equal(stale.body.error, "invalid_grant");

    // Another client can't use this grant's refresh token.
    const other = await register(BASE, { client_name: "Other", redirect_uris: [REDIRECT] });
    const theft = await token(BASE, { grant_type: "refresh_token", refresh_token: retry.body.refresh_token, client_id: other.client_id, client_secret: other.client_secret! });
    assert.equal(theft.body.error, "invalid_grant");

    accessToken = retry.body.access_token;
    refreshToken = retry.body.refresh_token;
  });

  await check("a Microsoft account not on the allowlist is turned away", async () => {
    const s = await signIn(BASE, { clientId: dcr.client_id, redirectUri: REDIRECT, msCode: "ms-code-stranger" });
    assert.equal(s.redirect.searchParams.get("error"), "access_denied");
    assert.equal(s.redirect.searchParams.get("code"), null);
    assert.match(serverLog, /Rejected sign-in from stranger@example\.com/);
  });

  await check("consent POST without the browser cookie, and a replayed callback, are rejected", async () => {
    const jar = new Jar();
    const auth = new URL(`${BASE}/authorize`);
    auth.search = new URLSearchParams({
      response_type: "code", client_id: dcr.client_id, redirect_uri: REDIRECT,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    }).toString();
    const page = await fetch(auth, { redirect: "manual" });
    jar.take(page);
    const html = await page.text();
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(html, /Smoke Client/);
    const handle = html.match(/name="handle" value="([^"]+)"/)![1]!;
    const forged = await fetch(`${BASE}/consent`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, action: "approve" }),
    });
    assert.equal(forged.status, 400);

    // A completed callback can't be replayed.
    const approved = await fetch(`${BASE}/consent`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
      body: new URLSearchParams({ handle, action: "approve" }),
    });
    jar.take(approved);
    const state = new URL(approved.headers.get("location")!).searchParams.get("state")!;
    const cb = `${BASE}/callback?code=ms-code-owner&state=${encodeURIComponent(state)}`;
    const first = await fetch(cb, { redirect: "manual", headers: { Cookie: jar.header() } });
    assert.equal(first.status, 302);
    const replay = await fetch(cb, { redirect: "manual", headers: { Cookie: jar.header() } });
    assert.equal(replay.status, 400);
  });

  await check("cancel on the consent page returns access_denied to the client", async () => {
    const jar = new Jar();
    const auth = new URL(`${BASE}/authorize`);
    auth.search = new URLSearchParams({
      response_type: "code", client_id: dcr.client_id, redirect_uri: REDIRECT, state: "s1",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    }).toString();
    const page = await fetch(auth, { redirect: "manual" });
    jar.take(page);
    const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1]!;
    const deny = await fetch(`${BASE}/consent`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
      body: new URLSearchParams({ handle, action: "deny" }),
    });
    const loc = new URL(deny.headers.get("location")!);
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get("error"), "access_denied");
    assert.equal(loc.searchParams.get("state"), "s1");
  });

  await check("CIMD client (no registration), with remembered consent on the second sign-in", async () => {
    const clientId = `${mock.url}/cimd/client.json`;
    const jar = new Jar();
    const s1 = await signIn(BASE, { clientId, redirectUri: REDIRECT, msCode: "ms-code-owner", jar });
    assert.equal(s1.sawConsent, true);
    const t = await token(BASE, {
      grant_type: "authorization_code", code: s1.redirect.searchParams.get("code")!, code_verifier: s1.verifier, client_id: clientId,
    });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal((await mcpPing(t.body.access_token)).status, 200);

    const s2 = await signIn(BASE, { clientId, redirectUri: REDIRECT, msCode: "ms-code-owner", jar });
    assert.equal(s2.sawConsent, false, "consent should be remembered for the same client + redirect");

    // A CIMD URL on a host that isn't allowlisted is an unknown client.
    const r = await fetch(`${BASE}/authorize?response_type=code&client_id=${encodeURIComponent("https://evil.example/client.json")}&code_challenge=x&code_challenge_method=S256`, { redirect: "manual" });
    assert.equal(r.status, 400);
  });

  await check("resource for a different server is refused", async () => {
    const auth = new URL(`${BASE}/authorize`);
    auth.search = new URLSearchParams({
      response_type: "code", client_id: dcr.client_id, redirect_uri: REDIRECT, state: "s2",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
      resource: "https://elsewhere.example/mcp",
    }).toString();
    const r = await fetch(auth, { redirect: "manual" });
    assert.equal(r.status, 302, "no consent page for a foreign resource");
    const loc = new URL(r.headers.get("location")!);
    assert.equal(loc.searchParams.get("error"), "invalid_target");
    assert.equal(loc.searchParams.get("state"), "s2");
  });

  await check("revocation kills the token", async () => {
    const s = await signIn(BASE, { clientId: dcr.client_id, redirectUri: REDIRECT, msCode: "ms-code-owner" });
    const t = await token(BASE, {
      grant_type: "authorization_code", code: s.redirect.searchParams.get("code")!, code_verifier: s.verifier,
      client_id: dcr.client_id, client_secret: dcr.client_secret!,
    });
    const r = await fetch(`${BASE}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t.body.access_token, client_id: dcr.client_id, client_secret: dcr.client_secret! }),
    });
    assert.equal(r.status, 200);
    assert.equal((await mcpPing(t.body.access_token)).status, 401);
  });

  await check("grants persist to a 0600 file holding only token hashes", async () => {
    const file = path.join(dataDir, "oauth.json");
    const st = await fs.stat(file);
    assert.equal(st.mode & 0o777, 0o600);
    const text = await fs.readFile(file, "utf8");
    assert.ok(!text.includes(accessToken) && !text.includes(refreshToken), "raw tokens must not be stored");
    assert.match(text, new RegExp(ALLOWED_EMAIL));
  });

  console.log("tools");
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

  await check("lists only the read tools, all marked read-only", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "course_people", "get_assignment", "get_discussion", "get_feedback", "get_grades", "get_message", "get_syllabus", "get_upcoming", "grade_whatif",
      "list_announcements", "list_assignments", "list_courses", "list_discussions", "list_events", "list_messages", "list_modules", "read_file", "recently_graded",
    ]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} isn't marked read-only`);
  });

  await check("list_courses follows pagination and leaves out ended courses", async () => {
    const out = parse(await call("list_courses"));
    assert.deepEqual(out.map((c: any) => c.code), ["CS 240", "PHIL 230"]);
    assert.equal(out[0].current_grade, "A-");
    assert.equal(out[0].final_score, 57.8);
    const all = parse(await call("list_courses", { include_past: true }));
    assert.deepEqual(all.map((c: any) => [c.code, c.ended ?? false]), [
      ["CS 240", false], ["PHIL 230", false], ["GEOL 101", true], ["HIST 105", true],
    ]);
  });

  await check("a past course still resolves by name or id; announcements skip it", async () => {
    const byName = parse(await call("get_grades", { course: "geology" }));
    assert.match(byName.course, /GEOL 101/);
    const byId = parse(await call("get_grades", { course: "404" }));
    assert.match(byId.course, /HIST 105/);
    const announcements = parse(await call("list_announcements", {}));
    assert.ok(announcements.every((a: any) => a.course !== "GEOL 101"));
  });

  await check("get_upcoming hides done items + announcements, sorts by date", async () => {
    const out = parse(await call("get_upcoming", { days_ahead: 7 }));
    assert.deepEqual(out.items.map((i: any) => i.title), ["Factory Pattern Writeup", "Portfolio link"]);
    assert.match(out.items[0].url, /\/courses\/101\/assignments\/11$/);
    const all = parse(await call("get_upcoming", { days_ahead: 7, include_done: true }));
    assert.equal(all.items.length, 3);
  });

  await check("get_upcoming lists undated assignments from current courses", async () => {
    const out = parse(await call("get_upcoming", { days_ahead: 7 }));
    assert.deepEqual(out.no_due_date.map((i: any) => [i.course_id, i.title]), [[202, "Group report"]]);
    const all = parse(await call("get_upcoming", { days_ahead: 7, include_done: true }));
    assert.deepEqual(all.no_due_date.map((i: any) => [i.title, i.done]), [["Group report", false], ["Reading response", true]]);
    const off = parse(await call("get_upcoming", { days_ahead: 7, include_undated: false }));
    assert.equal(off.no_due_date, undefined);
  });

  await check("resolves a course by code and lists assignments", async () => {
    const out = parse(await call("list_assignments", { course: "cs240" }));
    assert.equal(out.course_id, 101);
    assert.equal(out.assignments.length, 5);
  });

  await check("ambiguous / unknown course gives a helpful error", async () => {
    const r: any = await call("list_assignments", { course: "biology" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /CS 240/);
  });

  await check("get_assignment converts HTML and includes comments", async () => {
    const out = parse(await call("get_assignment", { course: "CS 240", assignment_id: 12 }));
    assert.match(out.instructions, /Reflect/);
    assert.equal(out.submission.comments[0].text, "Nice work");
  });

  await check("get_feedback shows rubric criteria, the grader's comments and comment attachments", async () => {
    const out = parse(await call("get_feedback", { course: "PHIL 230", name: "essay" }));
    assert.equal(out.id, 25);
    assert.equal(out.score, 45);
    assert.equal(out.out_of, 50);
    assert.deepEqual(out.rubric[0], {
      criterion: "Thesis", detail: "A clear, arguable claim.", points: 15, out_of: 20, rating: "Partial",
      rating_detail: "Thesis is present but vague", comment: "State the claim in the first paragraph.",
    });
    assert.deepEqual(out.rubric.map((r: any) => [r.criterion, r.points, r.rating]), [["Thesis", 15, "Partial"], ["Evidence", 20, "Strong"], ["Mechanics", 10, undefined]]);
    assert.equal(out.comments[0].from, "Prof. B");
    assert.match(out.comments[0].at, /\d/);
    assert.deepEqual(out.comments[0].attachments, [{ name: "essay1-markup.pdf", url: "https://canvas.test/files/9/download" }]);
    assert.equal(out.note, undefined);
  });

  await check("get_feedback lists assignments with feedback, asks which of several matches, and flags ungraded work", async () => {
    const list = parse(await call("get_feedback", { course: "PHIL 230" }));
    assert.deepEqual(list.assignments.map((a: any) => [a.id, a.comments, a.rubric]), [[25, 1, true]]);
    assert.match(list.assignments[0].latest_comment, /^Prof\. B: Good use of Searle/);
    const cs = parse(await call("get_feedback", { course: "CS 240" }));
    assert.deepEqual(cs.assignments.map((a: any) => a.name), ["Reflection"]);
    const many = parse(await call("get_feedback", { course: "PHIL 230", name: "quiz" }));
    assert.equal(many.matches.length, 4);
    const ungraded = parse(await call("get_feedback", { course: "CS 240", name: "factory" }));
    assert.match(ungraded.note, /Not graded yet/);
    assert.equal(ungraded.rubric, undefined);
  });

  await check("course_people lists teachers and TAs, emails only where Canvas shows them, and the student's groups", async () => {
    const out = parse(await call("course_people", { course: "CS 240" }));
    assert.deepEqual(out.staff, [
      { name: "Dana Ortiz", role: "teacher", pronouns: "she/her", email: "dortiz@example.edu" },
      { name: "Sam Park", role: "ta", role_name: "Lead TA" },
    ]);
    assert.deepEqual(out.groups, [{ group: "Lab Group 4", members: [{ name: "Owner Student", you: true }, { name: "Riley Classmate" }] }]);
    // Riley appears only as a groupmate; the roster entry (with an email) is never fetched.
    assert.ok(!JSON.stringify(out).includes("riley@example.edu"), "roster data leaked into the output");
    const tas = parse(await call("course_people", { course: "CS 240", role: "ta" }));
    assert.deepEqual(tas.staff.map((p: any) => p.name), ["Sam Park"]);
    assert.equal(tas.groups, undefined);
    const groupsOnly = parse(await call("course_people", { course: "PHIL 230", role: "group" }));
    assert.equal(groupsOnly.staff, undefined);
    assert.deepEqual(groupsOnly.groups.map((g: any) => g.group), ["Reading circle"]);
    const hidden = parse(await call("course_people", { course: "GEOL 101" }));
    assert.match(hidden.notes.join(" "), /People list is hidden/);
    assert.match(hidden.notes.join(" "), /isn't in any group/);
    assert.deepEqual([...mock.state.peopleTypesAsked].sort(), ["ta", "teacher"], "never asks for the student roster");
  });

  await check("recently_graded filters by graded date across current courses, newest first", async () => {
    const week = parse(await call("recently_graded", {}));
    // Reading response is graded but not posted, so it's left out; GEOL 101 is a past course.
    assert.deepEqual(week.graded.map((g: any) => [g.course, g.name, g.grade]), [
      ["CS 240", "Reflection", "5"], ["PHIL 230", "Quiz 4", "excused"], ["PHIL 230", "Quiz 1", "2"],
    ]);
    assert.equal(week.graded[0].comments, 1);
    assert.equal(week.graded[0].out_of, 5);
    const two = parse(await call("recently_graded", { days: 14, course: "PHIL 230" }));
    assert.deepEqual(two.graded.map((g: any) => g.name), ["Quiz 4", "Quiz 1", "Essay 1"]);
    assert.equal(two.graded[2].rubric, true);
    const none = parse(await call("recently_graded", { days: 1, course: "CS 240" }));
    assert.match(none.note, /Nothing graded/);
  });

  await check("list_events: window, time zone, course names, personal events; never a past course", async () => {
    const out = parse(await call("list_events", {}));
    assert.deepEqual(out.events.map((e: any) => [e.title, e.course]), [
      ["Office hours", "PHIL 230"], ["Advising appointment", "personal"], ["Midterm exam", "CS 240"], ["Reading day", "PHIL 230"],
    ]);
    const midterm = out.events[2];
    const ny = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
    assert.equal(midterm.start, ny.format(new Date(mock.events[0].start_at)));
    assert.match(midterm.start, /E[SD]T$/);
    assert.equal(midterm.location, "Sitterson 014");
    assert.match(midterm.description, /lectures 1–8/);
    assert.match(out.events[3].start, /\(all day\)$/);
    assert.equal(out.events[3].end, undefined);
    assert.ok(mock.state.eventRequests.every((codes) => !codes.includes("course_303")));
    const exams = parse(await call("list_events", { days_ahead: 60, days_back: 7, search: "exam" }));
    assert.deepEqual(exams.events.map((e: any) => e.title), ["Review session", "Midterm exam", "Final exam"]);
    const phil = parse(await call("list_events", { course: "philosophy", days_ahead: 3 }));
    assert.deepEqual(phil.events.map((e: any) => e.title), ["Office hours"]);
    assert.deepEqual(mock.state.eventRequests.at(-1), ["course_202"]);
  });

  await check("list_discussions: graded topic with due date and posted, required-post topic not posted", async () => {
    const out = parse(await call("list_discussions", { course: "PHIL 230" }));
    assert.deepEqual(out.discussions.map((d: any) => [d.id, d.posted]), [[31, true], [32, false], [33, undefined], [34, undefined]]);
    const [graded, zombies] = out.discussions;
    assert.equal(graded.graded, true);
    assert.equal(graded.points, 10);
    assert.match(graded.due, /\d{4}/);
    assert.equal(graded.unread, 2);
    assert.equal(zombies.post_required_to_see_replies, true);
    const none = parse(await call("list_discussions", { course: "CS 240" }));
    assert.deepEqual(none.discussions, []);
  });

  await check("get_discussion: prompt, threaded replies with authors, posted flag, hidden replies", async () => {
    const out = parse(await call("get_discussion", { course: "PHIL 230", topic_id: 31 }));
    assert.match(out.prompt, /understand/);
    assert.equal(out.posted, true);
    assert.deepEqual(out.replies.map((r: any) => [r.id, r.depth, r.author, r.reply_to]), [
      [401, 0, "Alex Kim", undefined], [403, 1, "you", 401], [404, 2, "Alex Kim", 403], [402, 0, "Jordan Lee", undefined],
    ]);
    assert.match(out.replies[1].text, /SYSTEM|system/);
    assert.equal(out.note, undefined);
    const hidden = parse(await call("get_discussion", { course: "PHIL 230", topic_id: 32 }));
    assert.equal(hidden.replies, undefined);
    assert.match(hidden.note, /must post before replies/);
    assert.match(hidden.prompt, /zombie/);
    const empty = parse(await call("get_discussion", { course: "PHIL 230", topic_id: 33 }));
    assert.equal(empty.note, "No replies yet.");
    const long = parse(await call("get_discussion", { course: "PHIL 230", topic_id: 34 }));
    assert.equal(long.replies.length, 150);
    assert.equal(long.replies.at(-1).text, "Post 149");
    assert.match(long.note, /Showing 150 of 200 replies/);
    assert.equal(empty.posted, false);
  });

  await check("list_modules: order, progress, prerequisites, what's next, and a large module's items", async () => {
    const out = parse(await call("list_modules", { course: "CS 240" }));
    assert.deepEqual(out.modules.map((m: any) => [m.name, m.state]), [
      ["Syllabus & Start Here", "completed"], ["Week 1: Creational patterns", "started"], ["Week 2: Behavioral patterns", "locked"],
    ]);
    assert.deepEqual(out.next, {
      module: "Week 1: Creational patterns", title: "Factory Pattern Writeup", type: "Assignment", due: out.next.due,
      points: 20, requirement: "submit", done: false, url: "https://canvas.test/courses/101/modules/items/76",
    });
    assert.match(out.next.due, /\d{4}/);
    const [, week1, week2] = out.modules;
    assert.deepEqual(week1.prerequisites, ["Syllabus & Start Here"]);
    assert.deepEqual(week1.items.map((i: any) => [i.title, i.type, i.requirement, i.done]), [
      ["Readings", "heading", undefined, undefined], ["Factory reading", "Page", "view", true],
      ["Factory Pattern Writeup", "Assignment", "submit", false], ["Week 1 quiz", "Quiz", "score at least 8", false],
    ]);
    assert.equal(week2.in_order, true);
    assert.match(week2.unlocks, /\d{4}/);
    assert.equal(week2.items.length, 60);
    assert.ok(mock.state.moduleItemsFetched.has("101/4"));
    const search = parse(await call("list_modules", { course: "CS 240", search: "quiz" }));
    assert.deepEqual(search.modules.map((m: any) => [m.name, m.items.map((i: any) => i.title)]), [["Week 1: Creational patterns", ["Week 1 quiz"]]]);
    assert.equal(search.next.title, "Factory Pattern Writeup");
    const none = parse(await call("list_modules", { course: "PHIL 230" }));
    assert.match(none.note, /no modules/);
  });

  await check("list_messages: inbox, unread, sent and course filter, with previews", async () => {
    const inbox = parse(await call("list_messages", {}));
    assert.deepEqual(inbox.conversations.map((v: any) => [v.id, v.unread]), [[70, true], [71, undefined], [72, undefined]]);
    const room = inbox.conversations[0];
    assert.deepEqual(room.with, ["Dana Ortiz"]);
    assert.equal(room.course, "Software Design");
    assert.equal(room.attachments, true);
    assert.equal(room.preview, "See the attached seating chart.");
    assert.equal(room.messages, 3);
    const unread = parse(await call("list_messages", { scope: "unread" }));
    assert.deepEqual(unread.conversations.map((v: any) => v.id), [70]);
    const phil = parse(await call("list_messages", { course: "PHIL 230" }));
    assert.deepEqual(phil.conversations.map((v: any) => v.subject), ["Essay extension"]);
    const sent = parse(await call("list_messages", { scope: "sent", limit: 1 }));
    assert.deepEqual(sent.conversations.map((v: any) => v.id), [70]);
    const none = parse(await call("list_messages", { scope: "archived" }));
    assert.match(none.note, /No conversations in archived/);
  });

  await check("get_message: full thread oldest first with attachments, and never marks it read", async () => {
    const out = parse(await call("get_message", { conversation_id: 70 }));
    assert.deepEqual(out.messages.map((m: any) => m.from), ["Dana Ortiz", "you", "Dana Ortiz"]);
    assert.match(out.messages[0].text, /Sitterson 014/);
    assert.deepEqual(out.messages[2].attachments, [{ name: "seating.pdf", url: "https://canvas.test/files/77/download" }]);
    assert.deepEqual(out.participants, ["you", "Dana Ortiz"]);
    assert.equal(out.unread, true);
    assert.equal(mock.state.conversationsMarkedRead, 0, "get_message must pass auto_mark_as_read=false");
    const still = parse(await call("list_messages", { scope: "unread" }));
    assert.deepEqual(still.conversations.map((v: any) => v.id), [70]);
  });

  await check("get_grades computes group percentages and shows final score + missing work", async () => {
    const out = parse(await call("get_grades", { course: "101" }));
    assert.equal(out.groups[1].group_score_percent, 100);
    assert.equal(out.groups[0].ungraded_count, 2);
    assert.equal(out.current_score, 93.4);
    assert.equal(out.final_score, 57.8);
    assert.equal(out.final_grade, "F");
    assert.equal(out.missing_count, 1);
    assert.deepEqual(out.groups[0].missing.map((a: any) => a.name), ["Observer Pattern Writeup"]);
    assert.equal(out.groups[1].missing, undefined);
  });

  await check("grade_whatif matches Canvas in a weighted course and finds what's needed for a target", async () => {
    const out = parse(await call("grade_whatif", { course: "CS 240", target: "C" }));
    assert.equal(out.weighted, true);
    assert.equal(out.letter_scale, "Canvas default");
    assert.deepEqual(out.now.current, { percent: 93.4, letter: "A-" });
    assert.equal(out.now.current.percent, out.canvas.current_score);
    assert.deepEqual(out.now.final, { percent: 57.8, letter: "F" });
    assert.equal(out.notes, undefined);
    // Writeups are 60%: 17.8/20 so far, 20 points still to do, the missing writeup counts as 0.
    assert.equal(out.target.target_percent, 74);
    assert.equal(out.target.needed_average_percent, 81);
    assert.deepEqual(out.target.remaining.map((r: any) => r.name), ["Factory Pattern Writeup"]);
    assert.deepEqual(out.target.counted_as_zero.map((r: any) => r.name), ["Observer Pattern Writeup"]);
    const a = parse(await call("grade_whatif", { course: "CS 240", target: "A" }));
    assert.equal(a.target.reachable, false);
    assert.equal(a.target.best_possible, 77.8);
    assert.match(a.target.note, /Unreachable/);
    const lenient = parse(await call("grade_whatif", { course: "CS 240", target: "94%", count_missing_as_zero: false }));
    assert.equal(lenient.target.needed_average_percent, 90.5);
  });

  await check("grade_whatif: unweighted course with drop-lowest, an excused quiz and the course's own scale", async () => {
    const out = parse(await call("grade_whatif", { course: "PHIL 230", target: "B+" }));
    assert.equal(out.weighted, false);
    assert.match(out.letter_scale, /Philosophy scale/);
    assert.deepEqual(out.now.current, { percent: 83.75, letter: "B" });
    assert.equal(out.now.current.percent, out.canvas.current_score);
    assert.equal(out.now.final.percent, out.canvas.final_score);
    assert.deepEqual(out.groups[0].dropped_now, ["Quiz 2"]);
    assert.equal(out.target.needed_average_percent, 91.8); // (67 + 55x) / 135 ≥ 0.87
    assert.deepEqual(out.target.remaining.map((r: any) => r.name), ["Group report", "Reading response"]);
    const what = parse(await call("grade_whatif", {
      course: "PHIL 230",
      hypotheticals: [{ name: "group report", score: 48 }, { assignment_id: 16, score: "80%" }],
    }));
    assert.deepEqual(what.hypotheticals.map((h: any) => [h.name, h.score]), [["Group report", 48], ["Reading response", 4]]);
    assert.deepEqual(what.projected.current, { percent: 88.15, letter: "B+" }); // (67 + 48 + 4) / 135, nothing left ungraded
    assert.deepEqual(what.projected.final, what.projected.current);
    const ambiguous: any = await call("grade_whatif", { course: "PHIL 230", hypotheticals: [{ name: "quiz", score: 10 }] });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /more than one assignment/);
    const badLetter: any = await call("grade_whatif", { course: "PHIL 230", target: "D-" });
    assert.match(badLetter.content[0].text, /isn't a percentage or a letter/);
  });

  await check("announcements across all courses", async () => {
    const out = parse(await call("list_announcements", {}));
    assert.equal(out[0].course, "PHIL 230");
    assert.match(out[0].message, /FRIDAY|Friday/);
  });

  await check("syllabus as text", async () => {
    const out = parse(await call("get_syllabus", { course: "philosophy" }));
    assert.match(out.syllabus, /40%/);
    assert.equal(out.source, "syllabus page");
  });

  await check("empty syllabus page falls back to a module page, linking the PDF; hidden tabs are skipped", async () => {
    const out = parse(await call("get_syllabus", { course: "CS 240" }));
    assert.equal(out.source, 'page "Course Syllabus"');
    assert.match(out.syllabus, /10% per day/);
    assert.deepEqual(out.other_matches.map((m: any) => [m.type, m.name]), [["file", "CS 240 Syllabus.pdf"]]);
    assert.match(out.other_matches[0].url, /\/courses\/101\/files\/501$/);
    assert.equal(out.other_matches[0].file_id, 501);
    const none = parse(await call("get_syllabus", { course: "GEOL 101" }));
    assert.equal(none.source, "none");
    assert.match(none.syllabus, /no syllabus page/);
  });

  await check("read_file finds a PDF by name and returns its text by page", async () => {
    const out = parse(await call("read_file", { course: "CS 240", name: "syllabus" }));
    assert.equal(out.file.file_id, 501);
    assert.equal(out.total_pages, 2);
    assert.match(out.text, /\[page 2\]\nGrading: exams 50%/);
    assert.equal(out.note, undefined);
  });

  await check("read_file lists several matches, then reads one by file_id", async () => {
    const many = parse(await call("read_file", { course: "CS 240", name: "lecture 5" }));
    assert.deepEqual(many.matches.map((m: any) => m.file_id).sort(), [502, 503]);
    assert.equal(many.text, undefined);
    const one = parse(await call("read_file", { course: "CS 240", file_id: 503 }));
    assert.match(one.text, /observers register/);
    const listed = parse(await call("read_file", { course: "CS 240" }));
    assert.equal(listed.files.length, 7);
  });

  await check("read_file stops a long PDF at a page boundary and continues from_page", async () => {
    const first = parse(await call("read_file", { course: "CS 240", file_id: 502 }));
    assert.equal(first.total_pages, 6);
    assert.ok(first.text.length <= 40_000);
    const next = Number(first.note.match(/from_page (\d+)/)[1]);
    assert.ok(next > 1 && next <= 6);
    assert.equal(first.pages_returned, `1-${next - 1}`);
    const rest = parse(await call("read_file", { course: "CS 240", file_id: 502, from_page: next }));
    assert.equal(rest.pages_returned, `${next}-6`);
    assert.match(rest.text, /Observer pattern part 6/);
    assert.equal(rest.note, undefined);
  });

  await check("read_file returns only details for unsupported, locked and oversized files", async () => {
    const before = mock.state.storageRequests;
    const pptx = parse(await call("read_file", { course: "CS 240", file_id: 504 }));
    assert.match(pptx.note, /Can't read/);
    const locked = parse(await call("read_file", { course: "CS 240", file_id: 505 }));
    assert.match(locked.note, /locked until after the exam/);
    const big = parse(await call("read_file", { course: "CS 240", file_id: 506 }));
    assert.match(big.note, /Too big/);
    for (const r of [pptx, locked, big]) assert.equal(r.text, undefined);
    assert.equal(mock.state.storageRequests, before);
  });

  await check("read_file won't follow a download redirect to a plain-http host", async () => {
    const r: any = await call("read_file", { course: "CS 240", file_id: 507 });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /refusing to follow a download redirect to http:\/\/intranet\.example/);
  });

  await check("read_file falls back to module files when the Files tab is hidden", async () => {
    const out = parse(await call("read_file", { course: "GEOL 101", name: "rock cycle" }));
    assert.equal(out.file.file_id, 601);
    assert.match(out.text, /Igneous, sedimentary, metamorphic/);
    const listed = parse(await call("read_file", { course: "GEOL 101" }));
    assert.match(listed.note, /Files list is hidden/);
  });

  await check("file storage never received the Canvas token", async () => {
    assert.ok(mock.state.storageRequests > 0);
    assert.equal(mock.state.storageSawAuth, false);
  });

  await check("every Canvas request was an authenticated GET", async () => {
    assert.equal(mock.state.unauthorized, 0);
    assert.deepEqual([...mock.state.canvasMethods], ["GET"]);
  });

  await client.close();
} finally {
  proc.kill();
  mock.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
}
