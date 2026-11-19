import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Persistent OAuth state: registered clients and grants. Only token *hashes* are stored.
 * One JSON file (mode 0600), rewritten atomically on every change. Changes are rare
 * (a sign-in, an hourly refresh), so a database would be overkill.
 */

export interface Grant {
  id: string;
  clientId: string;
  email: string;
  name: string;
  scopes: string[];
  resource: string;
  createdAt: number;
  accessTokenHash: string;
  /** Unix seconds */
  accessExpiresAt: number;
  refreshTokenHash: string;
  refreshExpiresAt: number;
  /**
   * The refresh token before the last rotation. It stays valid until the new one is used, so a
   * client that lost the refresh response (network blip) can retry. Same rule as workers-oauth-provider.
   */
  previousRefreshTokenHash?: string;
}

interface FileShape {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  grants: Record<string, Grant>;
}

export const MAX_DCR_CLIENTS = 50;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export class OAuthStore {
  private readonly file: string;
  private data: FileShape;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, "oauth.json");
    this.data = fs.existsSync(this.file)
      ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as FileShape)
      : { version: 1, clients: {}, grants: {} };
    this.sweep();
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Drops grants whose refresh token has expired. */
  private sweep() {
    const now = nowSeconds();
    let changed = false;
    for (const [id, g] of Object.entries(this.data.grants)) {
      if (g.refreshExpiresAt <= now) {
        delete this.data.grants[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  // --- clients (dynamic client registration) ---

  getClient(id: string): OAuthClientInformationFull | undefined {
    return this.data.clients[id];
  }

  addClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    // Registration is unauthenticated, so cap how much it can write. Evict the oldest clients that
    // hold no grant; if every client is in use, refuse.
    const ids = Object.keys(this.data.clients);
    if (ids.length >= MAX_DCR_CLIENTS) {
      const inUse = new Set(Object.values(this.data.grants).map((g) => g.clientId));
      const evictable = ids
        .filter((id) => !inUse.has(id))
        .sort((a, b) => (this.data.clients[a]!.client_id_issued_at ?? 0) - (this.data.clients[b]!.client_id_issued_at ?? 0));
      if (evictable.length === 0) throw new Error("Too many registered clients");
      delete this.data.clients[evictable[0]!];
    }
    this.data.clients[client.client_id] = client;
    this.save();
    return client;
  }

  // --- grants ---

  putGrant(g: Grant) {
    this.data.grants[g.id] = g;
    this.save();
  }

  deleteGrant(id: string) {
    if (this.data.grants[id]) {
      delete this.data.grants[id];
      this.save();
    }
  }

  findByAccessToken(token: string): Grant | undefined {
    const h = hashToken(token);
    return Object.values(this.data.grants).find((g) => g.accessTokenHash === h);
  }

  findByRefreshToken(token: string): { grant: Grant; previous: boolean } | undefined {
    const h = hashToken(token);
    for (const g of Object.values(this.data.grants)) {
      if (g.refreshTokenHash === h) return { grant: g, previous: false };
      if (g.previousRefreshTokenHash === h) return { grant: g, previous: true };
    }
    return undefined;
  }

  grants(): Grant[] {
    return Object.values(this.data.grants);
  }

  /** Revokes every grant: every connected client has to sign in again. */
  revokeAll(): number {
    const n = Object.keys(this.data.grants).length;
    this.data.grants = {};
    this.save();
    return n;
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
