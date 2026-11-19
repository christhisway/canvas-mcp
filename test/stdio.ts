// Local (stdio) mode: spawn src/stdio.ts the way Claude Desktop / Claude Code would, against mock Canvas.
import { spawn } from "node:child_process";
import fs from "node:fs";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockCanvas, TOKEN } from "./mock-canvas.js";

const mock = await startMockCanvas();
let passed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${name}\n`, err);
  }
}

// Only what a local user would set: no PUBLIC_URL, Microsoft or cookie settings.
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  CANVAS_BASE_URL: `${mock.url}/api/v1/`,
  CANVAS_TOKEN: TOKEN,
};

console.log("stdio");
const client = new Client({ name: "stdio-test", version: "0" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/stdio.ts"], env, stderr: "ignore" }));

  await check("starts with only the Canvas settings and lists the 18 read-only tools", async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 18);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} isn't marked read-only`);
  });

  await check("list_courses answers over stdio", async () => {
    const res = await client.callTool({ name: "list_courses", arguments: {} });
    const out = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    assert.deepEqual(out.map((c: any) => c.code), ["CS 240", "PHIL 230"]);
  });

  await check("every Canvas request was an authenticated GET", async () => {
    assert.equal(mock.state.unauthorized, 0);
    assert.deepEqual([...mock.state.canvasMethods], ["GET"]);
  });

  // A real .env at the repo root (a developer's machine) would supply the missing settings.
  if (!fs.existsSync(".env")) {
    await check("exits with a clear message when CANVAS_TOKEN is missing", async () => {
      const proc = spawn(process.execPath, ["--import", "tsx", "src/stdio.ts"], {
        env: { PATH: env.PATH, CANVAS_BASE_URL: env.CANVAS_BASE_URL },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (err += d));
      const code = await new Promise<number | null>((r) => proc.on("exit", r));
      assert.equal(code, 1);
      assert.match(err, /CANVAS_TOKEN/);
      assert.equal(out, "", "nothing but protocol may go to stdout");
    });
  }
} finally {
  await client.close();
  mock.close();
  console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
}
