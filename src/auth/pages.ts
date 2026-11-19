/** HTML for the consent and error pages. Same look as the To Do connector's. */

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function consentBody(opts: {
  clientName: string;
  clientHost: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  handle: string;
}): string {
  const host = opts.clientHost ? ` <span class="muted">(${esc(opts.clientHost)})</span>` : "";
  const loopbackWarning = opts.redirectIsLoopback
    ? `<p class="warn">This app redirects to your own computer (${esc(opts.redirectHost)}). Any local program could receive access. Only continue if you started this.</p>`
    : "";
  return `
    <p><strong>${esc(opts.clientName)}</strong>${host} wants to read your Canvas courses, assignments, grades and announcements. It can't submit or change anything.</p>
    <p class="muted">After approving, you'll sign in with Microsoft. Access will be sent to <strong>${esc(opts.redirectHost)}</strong>.</p>
    ${loopbackWarning}
    <form method="POST" action="/consent">
      <input type="hidden" name="handle" value="${esc(opts.handle)}">
      <button type="submit" name="action" value="approve" class="primary">Approve and sign in</button>
      <button type="submit" name="action" value="deny">Cancel</button>
    </form>`;
}

export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1.25rem; color: #1f2328; }
  h1 { font-size: 1.35rem; }
  .muted { color: #59636e; font-size: .95rem; }
  .warn { background: #fff8c5; border: 1px solid #d4a72c; padding: .6rem .8rem; border-radius: 6px; }
  form { display: flex; gap: .6rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .55rem 1rem; border-radius: 6px; border: 1px solid #d1d9e0; background: #f6f8fa; cursor: pointer; }
  button.primary { background: #0f6cbd; border-color: #0f6cbd; color: #fff; }
  @media (prefers-color-scheme: dark) { body { background: #0d1117; color: #e6edf3; } .muted { color: #9198a1; } button { background: #21262d; border-color: #3d444d; color: #e6edf3; } .warn { background: #3b2e00; border-color: #9e6a03; } }
</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}
