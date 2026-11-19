import fs from "node:fs";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { CanvasOAuthProvider } from "./auth/provider.js";
import { OAuthStore } from "./auth/store.js";
import { loadConfig } from "./config.js";
import { buildServer, createShared } from "./server.js";

// Load .env if present (Node 20.12+).
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
const shared = createShared(config);
const provider = new CanvasOAuthProvider(config, new OAuthStore(config.dataDir));

const app = createMcpExpressApp({
  host: config.host,
  // Host-header check (DNS rebinding): the public hostname, plus loopback for local checks.
  allowedHosts: [config.publicUrl.hostname, "localhost", "127.0.0.1"],
});
// The tunnel connects from loopback; trust its X-Forwarded-For so rate limits see real client IPs.
app.set("trust proxy", "loopback");

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true });
});
app.get("/", (_req: Request, res: Response) => {
  res.type("text/plain").send("Canvas MCP server. Add <this URL>/mcp as a custom connector in Claude.\n");
});

// Same metadata the SDK router serves, plus the Client ID Metadata Document flag (the SDK doesn't
// set it). Registered first so it wins. Without the flag, clients use dynamic registration instead.
const asMetadata = {
  ...createOAuthMetadata({ provider, issuerUrl: config.publicUrl }),
  ...(config.cimdAllowedHosts.length ? { client_id_metadata_document_supported: true } : {}),
};
app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
  res.set("Access-Control-Allow-Origin", "*").json(asMetadata);
});

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: config.publicUrl,
    resourceServerUrl: provider.resource,
    resourceName: "Canvas",
    // A registered client keeps working as long as its grant does; don't expire its secret after 30 days.
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }),
);
app.use(provider.routes());

const bearer = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(provider.resource),
  expectedResource: provider.resource,
});

// Stateless Streamable HTTP: a fresh server + transport per request. The Canvas
// client and course cache live in `shared`, so they survive across requests.
app.all("/mcp", bearer, async (req: Request, res: Response) => {
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
  console.log(`Canvas MCP listening on http://${config.host}:${config.port} · public ${provider.resource.href}`);
  console.log(`Canvas: ${config.canvasBaseUrl} (read-only)`);
  console.log(`Allowed accounts: ${config.allowedEmails.length ? config.allowedEmails.join(", ") : "NONE (nobody can connect)"}`);
});
