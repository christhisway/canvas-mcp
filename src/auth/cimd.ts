import { OAuthClientMetadataSchema, type OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Client ID Metadata Documents: the client_id is an https URL that serves the client's metadata.
 * claude.ai identifies itself this way (the To Do connector saw it). The SDK doesn't support CIMD, so
 * this adds it, limited to an allowlist of hosts. That keeps the server from fetching arbitrary URLs
 * from inside the home network.
 */

const MAX_BYTES = 16 * 1024;
const CACHE_MS = 60 * 60 * 1000;
const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

const cache = new Map<string, { client: OAuthClientInformationFull; until: number }>();

export function isCimdClientId(clientId: string, allowedHosts: string[]): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  // https only; plain http only for loopback (used by the tests).
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  return schemeOk && url.pathname !== "/" && !url.hash && allowedHosts.includes(url.host.toLowerCase());
}

export async function fetchCimdClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const hit = cache.get(clientId);
  if (hit && hit.until > Date.now()) return hit.client;

  let res: Response;
  try {
    res = await fetch(clientId, {
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`CIMD fetch failed for ${clientId}:`, err instanceof Error ? err.message : err);
    return undefined;
  }
  if (!res.ok) {
    console.warn(`CIMD fetch for ${clientId} returned HTTP ${res.status}`);
    return undefined;
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) return undefined;

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = OAuthClientMetadataSchema.safeParse(doc);
  if (!parsed.success || (doc as { client_id?: unknown }).client_id !== clientId) {
    console.warn(`CIMD document at ${clientId} is invalid or names a different client_id`);
    return undefined;
  }
  // Public clients only: a metadata document can't carry a shared secret.
  const method = parsed.data.token_endpoint_auth_method ?? "none";
  if (method !== "none") return undefined;

  const client: OAuthClientInformationFull = {
    ...parsed.data,
    token_endpoint_auth_method: "none",
    client_id: clientId,
    client_secret: undefined,
  };
  cache.set(clientId, { client, until: Date.now() + CACHE_MS });
  return client;
}
