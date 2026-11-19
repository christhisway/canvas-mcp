import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../config.js";

/**
 * Microsoft sign-in, used only to prove who is connecting. Same Azure app registration as the
 * To Do connector (add this server's /callback as another redirect URI). Unlike To Do, no Microsoft
 * token is kept: Canvas is reached with the server's own Canvas token, so `User.Read` is all we ask for.
 */
export const MICROSOFT_SCOPES = "User.Read";

export interface MicrosoftProfile {
  id: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
}

function loginBase(config: Config): string {
  return `${config.msAuthority}/${encodeURIComponent(config.msTenant)}/oauth2/v2.0`;
}

export function callbackUrl(config: Config): string {
  return new URL("/callback", config.publicUrl).toString();
}

export function microsoftAuthorizeUrl(config: Config, state: string, codeChallenge: string): string {
  const url = new URL(`${loginBase(config)}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.msClientId,
    response_type: "code",
    response_mode: "query",
    redirect_uri: callbackUrl(config),
    scope: MICROSOFT_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/** Exchanges Microsoft's code and returns the signed-in account. The Microsoft token is then dropped. */
export async function signInWithCode(config: Config, code: string, verifier: string): Promise<MicrosoftProfile> {
  const res = await fetch(`${loginBase(config)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.msClientId,
      client_secret: config.msClientSecret,
      scope: MICROSOFT_SCOPES,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: callbackUrl(config),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Microsoft token exchange failed: ${body.error ?? `HTTP ${res.status}`} ${body.error_description ?? ""}`.trim());
  }
  const me = await fetch(`${config.msGraphUrl}/v1.0/me?$select=id,displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${body.access_token}` },
  });
  if (!me.ok) throw new Error(`Could not read Microsoft profile (HTTP ${me.status})`);
  return (await me.json()) as MicrosoftProfile;
}

export function profileEmail(profile: MicrosoftProfile): string {
  return (profile.mail || profile.userPrincipalName || "").trim().toLowerCase();
}

/** Fails closed: with no allowlist configured, nobody can connect. */
export function isAllowedEmail(config: Config, email: string): boolean {
  return email !== "" && config.allowedEmails.includes(email.toLowerCase());
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}
