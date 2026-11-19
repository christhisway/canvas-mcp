// Plays the part of Claude (OAuth client) and the user's browser for the smoke test.
import { createHash, randomBytes } from "node:crypto";

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** Minimal cookie jar: name → value, from Set-Cookie headers. */
export class Jar {
  private cookies = new Map<string, string>();
  take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      if (/max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  names(): string[] {
    return [...this.cookies.keys()];
  }
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export async function register(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`register: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

export interface SignInResult {
  /** Final redirect back to the client (code or error). */
  redirect: URL;
  /** Whether the consent page was shown (false when consent was remembered). */
  sawConsent: boolean;
  verifier: string;
}

/** /authorize → consent page → approve → (Microsoft) → /callback → redirect with code. */
export async function signIn(
  base: string,
  opts: { clientId: string; redirectUri: string; msCode: string; jar?: Jar; resource?: string; state?: string },
): Promise<SignInResult> {
  const jar = opts.jar ?? new Jar();
  const { verifier, challenge } = pkce();
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: opts.state ?? "client-state",
    resource: opts.resource ?? `${base}/mcp`,
  }).toString();

  let res = await fetch(authorize, { redirect: "manual", headers: { Cookie: jar.header() } });
  jar.take(res);
  let sawConsent = false;
  if (res.status === 200) {
    sawConsent = true;
    const html = await res.text();
    const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
    if (!handle) throw new Error(`no consent handle in page:\n${html.slice(0, 500)}`);
    res = await fetch(`${base}/consent`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
      body: new URLSearchParams({ handle, action: "approve" }),
    });
    jar.take(res);
  }
  if (res.status !== 302) throw new Error(`expected redirect to Microsoft, got ${res.status} ${await res.text()}`);
  const ms = new URL(res.headers.get("location")!);
  if (ms.searchParams.get("code_challenge_method") !== "S256") throw new Error("Microsoft request lacks PKCE");

  // The browser would now sign in at Microsoft and come back to /callback.
  const cb = new URL(`${base}/callback`);
  cb.search = new URLSearchParams({ code: opts.msCode, state: ms.searchParams.get("state")! }).toString();
  res = await fetch(cb, { redirect: "manual", headers: { Cookie: jar.header() } });
  jar.take(res);
  if (res.status !== 302) throw new Error(`callback: HTTP ${res.status} ${await res.text()}`);
  return { redirect: new URL(res.headers.get("location")!), sawConsent, verifier };
}

export async function token(base: string, params: Record<string, string>) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as Tokens & { error?: string } };
}
