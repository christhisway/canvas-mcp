import { convert } from "html-to-text";

const CONVERT_OPTIONS = {
  wordwrap: false as const,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
  ],
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Tables become one line per row, cells joined by " | " (issue #26); html-to-text would otherwise put
 * every cell on its own line and lose the rows.
 */
function tablesToRows(html: string): string {
  return html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(([tr]) =>
      [...tr.matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)]
        .map((m) => convert(m[2], CONVERT_OPTIONS).replace(/\s+/g, " ").trim())
        .join(" | "),
    );
    const kept = rows.filter((r) => r.replace(/[\s|]/g, ""));
    return kept.length ? `<p>${kept.map(escapeHtml).join("<br>")}</p>` : "";
  });
}

export function htmlToText(html: string | null | undefined, maxChars = 6000): string | null {
  if (!html) return null;
  const text = convert(/<table\b/i.test(html) ? tablesToRows(html) : html, CONVERT_OPTIONS).trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}… [truncated]` : text;
}

export function makeDateFormatter(timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return (iso: string | null | undefined): string | null => (iso ? fmt.format(new Date(iso)) : null);
}

/** Drops null/undefined/empty-array fields so tool output stays compact. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export function json(value: unknown) {
  // Minified: indentation was a quarter to a third of most replies (issue #12).
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
