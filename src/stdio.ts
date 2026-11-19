// Local (stdio) entry: Claude Desktop or Claude Code starts this as a child process and talks to it
// over stdin/stdout. No public URL, no sign-in, no tunnel: whoever can start the process on this
// computer is the user. Only the Canvas settings are needed (ADR 13).
//
// stdout carries the MCP protocol, so nothing else may be written to it: log with console.error.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCanvasConfig } from "./config.js";
import { buildServer, createShared } from "./server.js";

// The client usually starts us from some other directory, so look for .env at the repo root
// (one level up from dist/ or src/). Variables the client passes in `env` win over the file.
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadCanvasConfig();
} catch (err) {
  console.error(`canvas-mcp: ${err instanceof Error ? err.message : err}`);
  console.error("Set CANVAS_BASE_URL and CANVAS_TOKEN in the client's MCP config, or in .env at the repo root.");
  process.exit(1);
}

const server = buildServer(createShared(config));
await server.connect(new StdioServerTransport());
console.error(`canvas-mcp (stdio): ${config.canvasBaseUrl} (read-only)`);
