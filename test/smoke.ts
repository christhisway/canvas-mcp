// End-to-end check: real HTTP server process ↔ mock Canvas ↔ MCP client.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockCanvas, TOKEN } from "./mock-canvas.js";

const SECRET = "s".repeat(32);
const PORT = 18787;

const mock = await startMockCanvas();
const subsDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-subs-"));
await fs.writeFile(path.join(subsDir, "factory.pdf"), Buffer.from("%PDF-1.4 fake pdf body"));
await fs.writeFile(path.join(subsDir, "notes.txt"), "not allowed for a pdf-only assignment");

const proc = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
  env: {
    ...process.env,
    CANVAS_BASE_URL: mock.url,
    CANVAS_TOKEN: TOKEN,
    MCP_PATH_SECRET: SECRET,
    PORT: String(PORT),
    NTFY_URL: `${mock.url}/ntfy/topic`,
    SUBMISSIONS_DIR: subsDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
proc.stdout.on("data", (d) => (serverLog += d));
proc.stderr.on("data", (d) => (serverLog += d));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return;
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

try {
  await waitForServer();

  await check("wrong path secret is a 404", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/mcp/${"x".repeat(32)}`, { method: "POST" });
    assert.equal(r.status, 404);
  });

  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${SECRET}`)));
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

  await check("lists all tools with annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "cancel_submission", "confirm_submission", "get_assignment", "get_grades", "get_syllabus", "get_upcoming",
      "list_announcements", "list_assignments", "list_courses", "list_submission_files", "prepare_submission",
    ]);
    assert.equal(tools.find((t) => t.name === "confirm_submission")?.annotations?.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === "get_upcoming")?.annotations?.readOnlyHint, true);
  });

  await check("list_courses follows pagination", async () => {
    const out = parse(await call("list_courses"));
    assert.equal(out.length, 2);
    assert.equal(out[1].code, "PHIL 230");
    assert.equal(out[0].current_grade, "A");
  });

  await check("get_upcoming hides done items + announcements, sorts by date", async () => {
    const out = parse(await call("get_upcoming", { days_ahead: 7 }));
    assert.deepEqual(out.map((i: any) => i.title), ["Factory Pattern Writeup", "Portfolio link"]);
    assert.match(out[0].url, /\/courses\/101\/assignments\/11$/);
    const all = parse(await call("get_upcoming", { days_ahead: 7, include_done: true }));
    assert.equal(all.length, 3);
  });

  await check("resolves a course by code and lists assignments", async () => {
    const out = parse(await call("list_assignments", { course: "cs240" }));
    assert.equal(out.course_id, 101);
    assert.equal(out.assignments.length, 3);
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

  await check("get_grades computes group percentages", async () => {
    const out = parse(await call("get_grades", { course: "101" }));
    assert.equal(out.groups[1].group_score_percent, 100);
    assert.equal(out.groups[0].ungraded_count, 1);
  });

  await check("announcements across all courses", async () => {
    const out = parse(await call("list_announcements", {}));
    assert.equal(out[0].course, "PHIL 230");
    assert.match(out[0].message, /FRIDAY|Friday/);
  });

  await check("syllabus as text", async () => {
    const out = parse(await call("get_syllabus", { course: "philosophy" }));
    assert.match(out.syllabus, /40%/);
  });

  await check("rejects wrong submission type and disallowed extension", async () => {
    const r1: any = await call("prepare_submission", { course: "CS 240", assignment_id: 11, text: "hi" });
    assert.equal(r1.isError, true);
    const r2: any = await call("prepare_submission", { course: "CS 240", assignment_id: 11, file_name: "notes.txt" });
    assert.match(r2.content[0].text, /only accepts: pdf/);
    const r3: any = await call("prepare_submission", { course: "CS 240", assignment_id: 11, file_name: "../etc/passwd" });
    assert.equal(r3.isError, true);
  });

  await check("blocks a text resubmission when attempts are used up", async () => {
    const r: any = await call("prepare_submission", { course: "CS 240", assignment_id: 12, text: "again" });
    assert.match(r.content[0].text, /attempts are used/);
  });

  await check("file submission: code goes to phone only, wrong code refused, right code submits", async () => {
    const before = mock.state.ntfy.length;
    const prep = parse(await call("prepare_submission", { course: "CS 240", assignment_id: 11, file_name: "factory.pdf" }));
    assert.equal(prep.status, "waiting_for_approval");
    const note = mock.state.ntfy[before];
    const code = note.body.match(/Code: (\d{6})/)![1];
    assert.ok(!JSON.stringify(prep).includes(code), "code leaked into the tool result");
    assert.equal(mock.state.submissions.length, 0);

    const wrong: any = await call("confirm_submission", { pending_id: prep.pending_id, approval_code: code === "000000" ? "111111" : "000000" });
    assert.match(wrong.content[0].text, /Wrong approval code. 2 attempt/);
    assert.equal(mock.state.submissions.length, 0);

    const ok = parse(await call("confirm_submission", { pending_id: prep.pending_id, approval_code: code }));
    assert.equal(ok.status, "submitted");
    assert.equal(mock.state.submissions.length, 1);
    assert.equal(mock.state.submissions[0].form["submission[file_ids][]"], "555");
    assert.deepEqual(mock.state.uploads[0].fields, ["key", "signature", "file"]);

    const replay: any = await call("confirm_submission", { pending_id: prep.pending_id, approval_code: code });
    assert.equal(replay.isError, true, "a code must not be reusable");
  });

  await check("three wrong codes cancel the pending submission", async () => {
    const prep = parse(await call("prepare_submission", { course: "CS 240", assignment_id: 13, url: "https://example.com/portfolio" }));
    const code = mock.state.ntfy.at(-1)!.body.match(/Code: (\d{6})/)![1];
    const bad = code === "000000" ? "999999" : "000000";
    for (let i = 0; i < 3; i++) await call("confirm_submission", { pending_id: prep.pending_id, approval_code: bad });
    const r: any = await call("confirm_submission", { pending_id: prep.pending_id, approval_code: code });
    assert.equal(r.isError, true);
    assert.equal(mock.state.submissions.length, 1);
  });

  await check("cancel_submission discards and lists pending", async () => {
    const prep = parse(await call("prepare_submission", { course: "CS 240", assignment_id: 13, url: "https://example.com/p" }));
    let out = parse(await call("cancel_submission", {}));
    assert.equal(out.still_pending.length, 1);
    out = parse(await call("cancel_submission", { pending_id: prep.pending_id }));
    assert.equal(out.cancelled, prep.pending_id);
    assert.equal(out.still_pending, undefined);
  });

  await check("Canvas token never sent to the storage host", async () => {
    assert.equal(mock.state.unauthorized, 0);
  });

  await client.close();
} finally {
  proc.kill();
  mock.close();
  await fs.rm(subsDir, { recursive: true, force: true });
  console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
}
