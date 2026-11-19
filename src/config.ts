import path from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export interface Config {
  /** e.g. https://yourschool.instructure.com — no trailing slash, no /api/v1 */
  canvasBaseUrl: string;
  /** Canvas personal access token (Account → Settings → New Access Token) */
  canvasToken: string;
  /** IANA zone used when formatting due dates */
  timeZone: string;
  host: string;
  port: number;
  /** Long random string; the MCP endpoint is served at /mcp/<secret> */
  pathSecret: string;
  /** Hostnames allowed in the Host header (your tunnel's public hostname, plus localhost) */
  allowedHosts: string[];
  /** ntfy topic URL for approval codes, e.g. https://ntfy.sh/<long-random-topic> */
  ntfyUrl: string;
  ntfyToken: string;
  /** Files in this folder can be submitted by name; nothing outside it is readable */
  submissionsDir: string;
  /** Minutes an approval code stays valid */
  approvalTtlMinutes: number;
}

export function loadConfig(): Config {
  const pathSecret = required("MCP_PATH_SECRET");
  if (pathSecret.length < 24) {
    throw new Error("MCP_PATH_SECRET must be at least 24 characters (try: openssl rand -hex 24)");
  }
  return {
    canvasBaseUrl: required("CANVAS_BASE_URL").replace(/\/+$/, "").replace(/\/api\/v1$/, ""),
    canvasToken: required("CANVAS_TOKEN"),
    timeZone: optional("TIME_ZONE", "America/New_York"),
    host: optional("HOST", "127.0.0.1"),
    port: Number(optional("PORT", "8787")),
    pathSecret,
    allowedHosts: ["localhost", "127.0.0.1", ...optional("ALLOWED_HOSTS")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean)],
    ntfyUrl: optional("NTFY_URL"),
    ntfyToken: optional("NTFY_TOKEN"),
    submissionsDir: path.resolve(optional("SUBMISSIONS_DIR", path.join(process.cwd(), "submissions"))),
    approvalTtlMinutes: Number(optional("APPROVAL_TTL_MINUTES", "15")),
  };
}
