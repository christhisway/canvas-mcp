import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Config } from "../config.js";
import { fetchCimdClient, isCimdClientId } from "./cimd.js";
import {
  createPkcePair,
  isAllowedEmail,
  microsoftAuthorizeUrl,
  profileEmail,
  signInWithCode,
} from "./microsoft.js";
import { consentBody, renderPage } from "./pages.js";
import { hashToken, nowSeconds, OAuthStore, randomToken, type Grant } from "./store.js";

/**
 * This server is its own OAuth 2.1 authorization server toward Claude, and signs the user in with
 * Microsoft to decide who may connect. The flow mirrors the To Do connector's:
 *
 *   Claude ──/authorize──▶ consent page ──POST /consent──▶ Microsoft sign-in ──/callback──▶ code back to Claude
 *          ──/token──▶ access + refresh token (opaque; only hashes are stored) ──▶ Bearer on /mcp
 *
 * The SDK's mcpAuthRouter handles parameter validation, PKCE checking, DCR and metadata; this class
 * supplies the decisions and the storage.
 */

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days, sliding: each refresh extends it
const AUTH_FLOW_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const REMEMBER_CONSENT_S = 30 * 24 * 60 * 60;
const MAX_PENDING_FLOWS = 50;

interface PendingFlow {
  handle: string;
  /** Random value in a cookie: the consent POST and the Microsoft callback must come from the browser that started. */
  binding: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
  msState?: string;
  msVerifier?: string;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  email: string;
  name: string;
  expiresAt: number;
  /** Set once exchanged. A second use revokes that grant (RFC 6749 §4.1.2). */
  usedByGrant?: string;
}

export class CanvasOAuthProvider implements OAuthServerProvider {
  readonly resource: URL;
  private readonly flows = new Map<string, PendingFlow>();
  private readonly codes = new Map<string, AuthCode>();
  private readonly secureCookies: boolean;
  private readonly cookiePrefix: string;

  constructor(
    private readonly config: Config,
    readonly store: OAuthStore,
  ) {
    this.resource = new URL("/mcp", config.publicUrl);
    // __Host- cookies need https. Plain-http localhost (dev and tests) uses unprefixed, non-Secure cookies.
    this.secureCookies = config.publicUrl.protocol === "https:";
    this.cookiePrefix = this.secureCookies ? "__Host-canvas" : "canvas";
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const { store, config } = this;
    return {
      async getClient(clientId) {
        if (isCimdClientId(clientId, config.cimdAllowedHosts)) return fetchCimdClient(clientId);
        return store.getClient(clientId);
      },
      registerClient(client) {
        // The SDK has already generated client_id (clientIdGeneration defaults to true).
        return store.addClient(client as OAuthClientInformationFull);
      },
    };
  }

  // ---------- /authorize ----------

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !sameResource(params.resource, this.resource)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.resource.href}`);
    }
    const flow = this.beginFlow(client, params);
    this.setCookie(res, "auth", flow.binding, AUTH_FLOW_TTL_MS / 1000);

    if (this.consentRemembered(res.req, client.client_id, params.redirectUri)) {
      this.redirectToMicrosoft(res, flow);
      return;
    }

    const redirect = new URL(params.redirectUri);
    let clientHost = "";
    if (isCimdClientId(client.client_id, this.config.cimdAllowedHosts)) clientHost = new URL(client.client_id).host;
    this.page(
      res,
      200,
      "Connect Canvas",
      consentBody({
        clientName: client.client_name || "An unnamed app",
        clientHost,
        redirectHost: redirect.host || redirect.protocol,
        redirectIsLoopback: ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname),
        handle: flow.handle,
      }),
      params.redirectUri,
    );
  }

  /** Routes the SDK router doesn't cover: the consent form and Microsoft's callback. */
  routes(): Router {
    const router = express.Router();
    router.post("/consent", express.urlencoded({ extended: false }), (req, res) => this.consent(req, res));
    router.get("/callback", (req, res) => {
      this.callback(req, res).catch((err) => {
        console.error("Sign-in callback failed:", err);
        this.page(res, 500, "Sign-in failed", "<p>Something went wrong. Check the server log, then try connecting again.</p>");
      });
    });
    return router;
  }

  private consent(req: Request, res: Response) {
    const handle = String(req.body?.handle ?? "");
    const flow = this.flows.get(handle);
    if (!flow || flow.expiresAt < Date.now() || !this.bindingMatches(req, flow)) {
      return this.page(res, 400, "Sign-in request expired", "<p>Start connecting again from Claude.</p>");
    }
    if (req.body?.action !== "approve") {
      this.flows.delete(handle);
      return res.redirect(302, errorRedirect(flow.params, "access_denied", "The user cancelled"));
    }
    this.rememberConsent(res, flow.client.client_id, flow.params.redirectUri);
    this.redirectToMicrosoft(res, flow);
  }

  private redirectToMicrosoft(res: Response, flow: PendingFlow) {
    const pkce = createPkcePair();
    flow.msState = randomBytes(24).toString("base64url");
    flow.msVerifier = pkce.verifier;
    res.redirect(302, microsoftAuthorizeUrl(this.config, flow.msState, pkce.challenge));
  }

  private async callback(req: Request, res: Response) {
    const state = String(req.query.state ?? "");
    const flow = state ? [...this.flows.values()].find((f) => f.msState === state) : undefined;
    if (!flow || flow.expiresAt < Date.now() || !this.bindingMatches(req, flow)) {
      return this.page(res, 400, "Sign-in request expired", "<p>Start connecting again from Claude.</p>");
    }
    // One shot: whatever happens next, this flow can't be resumed again.
    this.flows.delete(flow.handle);
    this.clearCookie(res, "auth");

    if (req.query.error) {
      const description = String(req.query.error_description ?? req.query.error).slice(0, 200);
      return res.redirect(302, errorRedirect(flow.params, "access_denied", description));
    }
    const msCode = String(req.query.code ?? "");
    if (!msCode) return res.redirect(302, errorRedirect(flow.params, "invalid_request", "Missing code"));

    const profile = await signInWithCode(this.config, msCode, flow.msVerifier!);
    const email = profileEmail(profile);
    if (!isAllowedEmail(this.config, email)) {
      console.warn(`Rejected sign-in from ${email || "(no email)"}`);
      return res.redirect(
        302,
        errorRedirect(flow.params, "access_denied", "This Microsoft account is not allowed to use this server"),
      );
    }

    this.sweepCodes();
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      clientId: flow.client.client_id,
      redirectUri: flow.params.redirectUri,
      codeChallenge: flow.params.codeChallenge,
      scopes: flow.params.scopes ?? [],
      email,
      name: profile.displayName || email,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    console.log(`Sign-in approved for ${email} (client ${flow.client.client_name ?? flow.client.client_id})`);
    const target = new URL(flow.params.redirectUri);
    target.searchParams.set("code", code);
    if (flow.params.state) target.searchParams.set("state", flow.params.state);
    res.redirect(302, target.href);
  }

  // ---------- /token ----------

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.lookupCode(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const c = this.lookupCode(client, code);
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    if (resource && !sameResource(resource, this.resource)) throw new InvalidTargetError("Unknown resource");
    if (!isAllowedEmail(this.config, c.email)) throw new InvalidGrantError("This account is not allowed");

    const now = nowSeconds();
    const access = randomToken("cmcp_at");
    const refresh = randomToken("cmcp_rt");
    const grant: Grant = {
      id: randomBytes(12).toString("hex"),
      clientId: client.client_id,
      email: c.email,
      name: c.name,
      scopes: c.scopes,
      resource: this.resource.href,
      createdAt: now,
      accessTokenHash: hashToken(access),
      accessExpiresAt: now + ACCESS_TTL,
      refreshTokenHash: hashToken(refresh),
      refreshExpiresAt: now + REFRESH_TTL,
    };
    this.store.putGrant(grant);
    c.usedByGrant = grant.id;
    return tokenResponse(access, refresh, grant.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const found = this.store.findByRefreshToken(refreshToken);
    if (!found || found.grant.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    const { grant, previous } = found;
    const now = nowSeconds();
    if (grant.refreshExpiresAt <= now) {
      this.store.deleteGrant(grant.id);
      throw new InvalidGrantError("Refresh token expired");
    }
    if (!isAllowedEmail(this.config, grant.email)) {
      this.store.deleteGrant(grant.id);
      throw new InvalidGrantError("This account is no longer allowed");
    }
    if (resource && !sameResource(resource, this.resource)) throw new InvalidTargetError("Unknown resource");
    if (scopes?.some((s) => !grant.scopes.includes(s))) throw new InvalidScopeError("Can't widen scopes on refresh");

    const access = randomToken("cmcp_at");
    const refresh = randomToken("cmcp_rt");
    this.store.putGrant({
      ...grant,
      accessTokenHash: hashToken(access),
      accessExpiresAt: now + ACCESS_TTL,
      // Using the current token retires it to "previous"; retrying with the previous one keeps it there.
      previousRefreshTokenHash: previous ? grant.previousRefreshTokenHash : grant.refreshTokenHash,
      refreshTokenHash: hashToken(refresh),
      refreshExpiresAt: now + REFRESH_TTL,
    });
    return tokenResponse(access, refresh, scopes ?? grant.scopes);
  }

  // ---------- /mcp ----------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = this.store.findByAccessToken(token);
    if (!grant || grant.accessExpiresAt <= nowSeconds()) throw new InvalidTokenError("Invalid or expired token");
    if (!isAllowedEmail(this.config, grant.email)) throw new InvalidTokenError("This account is no longer allowed");
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: grant.accessExpiresAt,
      resource: new URL(grant.resource),
      extra: { email: grant.email },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const grant = this.store.findByAccessToken(request.token) ?? this.store.findByRefreshToken(request.token)?.grant;
    if (grant && grant.clientId === client.client_id) this.store.deleteGrant(grant.id);
  }

  // ---------- helpers ----------

  private beginFlow(client: OAuthClientInformationFull, params: AuthorizationParams): PendingFlow {
    const now = Date.now();
    for (const [h, f] of this.flows) if (f.expiresAt < now) this.flows.delete(h);
    if (this.flows.size >= MAX_PENDING_FLOWS) {
      // Drop the oldest; a real user only ever has one or two in flight.
      this.flows.delete(this.flows.keys().next().value!);
    }
    const flow: PendingFlow = {
      handle: randomBytes(24).toString("base64url"),
      binding: randomBytes(24).toString("base64url"),
      client,
      params,
      expiresAt: now + AUTH_FLOW_TTL_MS,
    };
    this.flows.set(flow.handle, flow);
    return flow;
  }

  private lookupCode(client: OAuthClientInformationFull, code: string): AuthCode {
    const c = this.codes.get(code);
    if (!c || c.expiresAt < Date.now() || c.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (c.usedByGrant) {
      this.store.deleteGrant(c.usedByGrant);
      this.codes.delete(code);
      throw new InvalidGrantError("Authorization code was already used; its tokens have been revoked");
    }
    return c;
  }

  private sweepCodes() {
    const now = Date.now();
    for (const [k, c] of this.codes) if (c.expiresAt < now) this.codes.delete(k);
  }

  private bindingMatches(req: Request, flow: PendingFlow): boolean {
    const got = readCookie(req, `${this.cookiePrefix}-auth`);
    return !!got && safeEqual(got, flow.binding);
  }

  private consentKey(clientId: string, redirectUri: string): string {
    return createHash("sha256").update(`${clientId}\n${redirectUri}`).digest("hex").slice(0, 16);
  }

  private consentMac(clientId: string, redirectUri: string, exp: number): string {
    return createHmac("sha256", this.config.cookieSecret)
      .update(`consent\n${clientId}\n${redirectUri}\n${exp}`)
      .digest("base64url");
  }

  private rememberConsent(res: Response, clientId: string, redirectUri: string) {
    const exp = nowSeconds() + REMEMBER_CONSENT_S;
    const value = `${exp}.${this.consentMac(clientId, redirectUri, exp)}`;
    this.setCookie(res, `ok-${this.consentKey(clientId, redirectUri)}`, value, REMEMBER_CONSENT_S);
  }

  private consentRemembered(req: Request, clientId: string, redirectUri: string): boolean {
    const value = readCookie(req, `${this.cookiePrefix}-ok-${this.consentKey(clientId, redirectUri)}`);
    if (!value) return false;
    const [expText, mac] = value.split(".");
    const exp = Number(expText);
    if (!mac || !Number.isFinite(exp) || exp <= nowSeconds()) return false;
    return safeEqual(mac, this.consentMac(clientId, redirectUri, exp));
  }

  private setCookie(res: Response, name: string, value: string, maxAgeSeconds: number) {
    const attrs = [`Path=/`, `Max-Age=${Math.floor(maxAgeSeconds)}`, "HttpOnly", "SameSite=Lax"];
    if (this.secureCookies) attrs.push("Secure");
    res.append("Set-Cookie", `${this.cookiePrefix}-${name}=${value}; ${attrs.join("; ")}`);
  }

  private clearCookie(res: Response, name: string) {
    this.setCookie(res, name, "", 0);
  }

  private page(res: Response, status: number, title: string, body: string, redirectUri?: string) {
    // form-action also governs where the form's redirects may go: Microsoft on approve, the client on cancel.
    const formTargets = ["'self'", new URL(this.config.msAuthority).origin];
    if (redirectUri) {
      const u = new URL(redirectUri);
      formTargets.push(u.protocol === "http:" || u.protocol === "https:" ? u.origin : u.protocol);
    }
    res
      .status(status)
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formTargets.join(" ")}; frame-ancestors 'none'`,
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      })
      .send(renderPage(title, body));
  }
}

function tokenResponse(access: string, refresh: string, scopes: string[]): OAuthTokens {
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: refresh,
    ...(scopes.length ? { scope: scopes.join(" ") } : {}),
  };
}

function errorRedirect(params: AuthorizationParams, error: string, description: string): string {
  const url = new URL(params.redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (params.state) url.searchParams.set("state", params.state);
  return url.href;
}

function sameResource(a: URL, b: URL): boolean {
  const norm = (u: URL) => `${u.origin}${u.pathname}`.replace(/\/$/, "");
  return norm(a) === norm(b);
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

