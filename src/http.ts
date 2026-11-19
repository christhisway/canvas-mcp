import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { loadConfig } from "./config.js";
import { buildServer, createShared } from "./server.js";

// Load .env if present (Node 20.12+ / 22).
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
const shared = createShared(config);

const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

function secretMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(config.pathSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Stateless Streamable HTTP: a fresh server + transport per request. Approval
// state lives in `shared`, so it survives across requests.
app.all("/mcp/:secret", async (req: Request, res: Response) => {
  if (!secretMatches(String(req.params.secret))) {
    res.status(404).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
    return;
  }
  const server = buildServer(shared);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.listen(config.port, config.host, () => {
  console.log(`Canvas MCP listening on http://${config.host}:${config.port}/mcp/<secret>`);
  console.log(`Canvas: ${config.canvasBaseUrl} · submissions folder: ${config.submissionsDir}`);
  console.log(config.ntfyUrl ? "Approval codes go to ntfy." : "NTFY_URL not set: approval codes will print here.");
});
