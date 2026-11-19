/**
 * Minimal, read-only Canvas REST client: auth, pagination via Link headers, and
 * a retry on Canvas's throttling response. It only ever sends GET requests
 * (ADR 9); the Canvas token itself can't be limited to reading.
 */

export class CanvasError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | Array<string | number>>;

const MAX_PAGES = 20;

export class CanvasClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  /** Turns a relative Canvas page path ("/courses/1/assignments/2") into a full link. */
  webUrl(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  url(pathOrUrl: string, query: Query = {}): string {
    const url = pathOrUrl.startsWith("http")
      ? new URL(pathOrUrl)
      : new URL(`/api/v1${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        // Canvas array params look like include[]=submission&include[]=term
        const name = key.endsWith("[]") ? key : `${key}[]`;
        for (const v of value) url.searchParams.append(name, String(v));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request(url: string, attempt = 0): Promise<Response> {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
    });
    // Canvas throttles with 403 + "Rate Limit Exceeded" (and sometimes 429).
    if ((res.status === 429 || res.status === 403) && attempt < 3) {
      const text = await res.clone().text();
      if (res.status === 429 || /rate limit/i.test(text)) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        return this.request(url, attempt + 1);
      }
    }
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = undefined; }
      const detail = extractCanvasMessage(body);
      throw new CanvasError(
        `Canvas GET ${new URL(url).pathname} failed: ${res.status}${detail ? ` — ${detail}` : ""}`,
        res.status,
        body,
      );
    }
    return res;
  }

  async get<T>(path: string, query: Query = {}): Promise<T> {
    const res = await this.request(this.url(path, query));
    return (await res.json()) as T;
  }

  /**
   * Downloads a file's bytes from a Canvas file URL (a file object's `url`), refusing anything bigger than
   * `maxBytes`. The URL must be on the Canvas host. Canvas answers with a redirect to its file storage on
   * another host, so redirects are followed by hand: the token goes only to the Canvas origin, and a
   * redirect may only lead to https (or back to the Canvas hostname).
   */
  async download(fileUrl: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const canvasOrigin = new URL(this.baseUrl).origin;
    const canvasHost = new URL(this.baseUrl).hostname;
    let url = new URL(fileUrl, this.baseUrl);
    if (url.origin !== canvasOrigin) throw new Error(`refusing to download from ${url.host}: not the Canvas host`);
    for (let hop = 0; hop <= 5; hop++) {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: url.origin === canvasOrigin ? { Authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) throw new Error(`download redirect without a location (${res.status})`);
        const next = new URL(location, url);
        if (next.protocol !== "https:" && next.hostname !== canvasHost) {
          throw new Error(`refusing to follow a download redirect to ${next.protocol}//${next.host}`);
        }
        url = next;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new CanvasError(`file download failed: ${res.status}`, res.status);
      }
      const declared = Number(res.headers.get("content-length"));
      if (declared > maxBytes) {
        await res.body?.cancel();
        throw new Error(`file is ${declared} bytes, over the ${maxBytes}-byte limit`);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of res.body ?? []) {
        total += chunk.length;
        if (total > maxBytes) throw new Error(`file is over the ${maxBytes}-byte limit`);
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      return { bytes, contentType: res.headers.get("content-type") };
    }
    throw new Error("too many download redirects");
  }

  /** Follows rel="next" links until exhausted (or MAX_PAGES). */
  async getAll<T>(path: string, query: Query = {}): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = this.url(path, { per_page: 100, ...query });
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const res = await this.request(next);
      const data = (await res.json()) as T[] | Record<string, T[]>;
      if (Array.isArray(data)) out.push(...data);
      next = parseNextLink(res.headers.get("link"));
    }
    return out;
  }
}

/** Treats "you can't see this" (401/403/404) as `fallback`; anything else still fails the call. */
export async function optional<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof CanvasError && [401, 403, 404].includes(err.status)) return fallback;
    throw err;
  }
}

export function parseNextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) return match[1];
  }
  return undefined;
}

function extractCanvasMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as { errors?: unknown; message?: string };
  if (typeof b.message === "string") return b.message;
  if (Array.isArray(b.errors)) {
    return b.errors.map((e) => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e))).join("; ");
  }
  if (b.errors && typeof b.errors === "object") return JSON.stringify(b.errors);
  return undefined;
}
