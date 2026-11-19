/**
 * Minimal Canvas REST client: auth, pagination via Link headers, and
 * a retry on Canvas's throttling response.
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

  private async request(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...init.headers },
    });
    // Canvas throttles with 403 + "Rate Limit Exceeded" (and sometimes 429).
    if ((res.status === 429 || res.status === 403) && attempt < 3) {
      const text = await res.clone().text();
      if (res.status === 429 || /rate limit/i.test(text)) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        return this.request(url, init, attempt + 1);
      }
    }
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = undefined; }
      const detail = extractCanvasMessage(body);
      throw new CanvasError(
        `Canvas ${init.method ?? "GET"} ${new URL(url).pathname} failed: ${res.status}${detail ? ` — ${detail}` : ""}`,
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

  async postForm<T>(path: string, form: Array<[string, string]>): Promise<T> {
    const body = new URLSearchParams(form);
    const res = await this.request(this.url(path), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return (await res.json()) as T;
  }

  /**
   * Canvas's three-step file upload, scoped to an assignment submission.
   * Returns the new file's id, which then goes in submission[file_ids][].
   */
  async uploadSubmissionFile(
    courseId: number,
    assignmentId: number,
    file: { name: string; contentType: string; data: Buffer },
  ): Promise<number> {
    // 1. Tell Canvas about the file
    const ticket = await this.postForm<{ upload_url: string; upload_params: Record<string, string> }>(
      `/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`,
      [["name", file.name], ["size", String(file.data.length)], ["content_type", file.contentType]],
    );

    // 2. Upload to the storage URL Canvas gave us. No Authorization header here:
    //    the upload_params carry their own signature. The file field must be last.
    const form = new FormData();
    for (const [k, v] of Object.entries(ticket.upload_params)) form.append(k, v);
    form.append("file", new Blob([new Uint8Array(file.data)], { type: file.contentType }), file.name);
    const upload = await fetch(ticket.upload_url, { method: "POST", body: form, redirect: "manual" });

    // 3. Confirm. Depending on the Canvas storage backend this is either a redirect
    //    to a confirmation URL, or a JSON body with the file (or a location to confirm).
    let confirmUrl: string | undefined;
    if (upload.status >= 300 && upload.status < 400) {
      confirmUrl = upload.headers.get("location") ?? undefined;
    } else if (upload.ok) {
      const json = (await upload.json().catch(() => ({}))) as { id?: number; location?: string };
      if (typeof json.id === "number") return json.id;
      confirmUrl = json.location;
    } else {
      throw new CanvasError(`File upload to Canvas storage failed: ${upload.status}`, upload.status);
    }
    if (!confirmUrl) throw new CanvasError("Canvas file upload returned no file id or confirmation URL", 502);
    const confirmed = await this.request(confirmUrl);
    const fileObj = (await confirmed.json()) as { id?: number };
    if (typeof fileObj.id !== "number") throw new CanvasError("Canvas file confirmation returned no id", 502);
    return fileObj.id;
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
