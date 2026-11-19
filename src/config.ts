import path from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function list(name: string, fallback = ""): string[] {
  return optional(name, fallback)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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
  /** Public origin Claude reaches this server at, e.g. https://canvas.example.com. Also the OAuth issuer. */
  publicUrl: URL;
  /** Microsoft sign-in (identity only: the server never keeps Microsoft tokens). */
  msClientId: string;
  msClientSecret: string;
  msTenant: string;
  /** Overridable for tests only. */
  msAuthority: string;
  msGraphUrl: string;
  /** Lowercased Microsoft account emails allowed to connect. Empty means nobody can (fails closed). */
  allowedEmails: string[];
  /** Signs the "remember this consent" cookie. */
  cookieSecret: string;
  /** Hosts whose Client ID Metadata Documents are accepted as client_ids (e.g. claude.ai). */
  cimdAllowedHosts: string[];
  /** Where OAuth clients and grants are persisted (oauth.json, mode 0600). */
  dataDir: string;
}

export function loadConfig(): Config {
  const publicUrl = new URL(required("PUBLIC_URL"));
  const loopback = ["localhost", "127.0.0.1"].includes(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !loopback) throw new Error("PUBLIC_URL must be https (except localhost)");
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("PUBLIC_URL must be an origin only, e.g. https://canvas.example.com");
  }

  const cookieSecret = required("COOKIE_SECRET");
  if (cookieSecret.length < 32) throw new Error("COOKIE_SECRET must be at least 32 characters (openssl rand -hex 32)");

  return {
    canvasBaseUrl: required("CANVAS_BASE_URL").replace(/\/+$/, "").replace(/\/api\/v1$/, ""),
    canvasToken: required("CANVAS_TOKEN"),
    timeZone: optional("TIME_ZONE", "America/New_York"),
    host: optional("HOST", "127.0.0.1"),
    port: Number(optional("PORT", "8787")),
    publicUrl,
    msClientId: required("MS_CLIENT_ID"),
    msClientSecret: required("MS_CLIENT_SECRET"),
    msTenant: optional("MS_TENANT", "common"),
    msAuthority: optional("MS_AUTHORITY", "https://login.microsoftonline.com").replace(/\/+$/, ""),
    msGraphUrl: optional("MS_GRAPH_URL", "https://graph.microsoft.com").replace(/\/+$/, ""),
    allowedEmails: list("ALLOWED_EMAILS"),
    cookieSecret,
    // "none" turns CIMD off (clients then fall back to dynamic registration).
    cimdAllowedHosts: list("CIMD_ALLOWED_HOSTS", "claude.ai").filter((h) => h !== "none"),
    dataDir: path.resolve(optional("DATA_DIR", path.join(process.cwd(), "data"))),
  };
}
