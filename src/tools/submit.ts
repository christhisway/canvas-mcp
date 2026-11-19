import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApprovalStore, Notifier, SubmissionPayload } from "../approvals.js";
import type { CanvasClient } from "../canvas.js";
import type { CourseDirectory } from "../courses.js";
import { compact, errorResult, json, makeDateFormatter } from "../format.js";
import type { Assignment, Submission } from "../types.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".zip": "application/zip",
  ".java": "text/x-java-source",
  ".py": "text/x-python",
  ".ts": "text/plain",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

export function registerSubmitTools(
  server: McpServer,
  deps: {
    canvas: CanvasClient;
    courses: CourseDirectory;
    approvals: ApprovalStore;
    notifier: Notifier;
    submissionsDir: string;
    timeZone: string;
  },
) {
  const { canvas, courses, approvals, notifier, submissionsDir } = deps;
  const date = makeDateFormatter(deps.timeZone);

  server.registerTool(
    "list_submission_files",
    {
      title: "List files ready to submit",
      description:
        "Lists the files in the connector's submissions folder. Only files in this folder can be submitted to Canvas.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        await fs.mkdir(submissionsDir, { recursive: true });
        const entries = await fs.readdir(submissionsDir, { withFileTypes: true });
        const files = await Promise.all(
          entries
            .filter((e) => e.isFile() && !e.name.startsWith("."))
            .map(async (e) => {
              const st = await fs.stat(path.join(submissionsDir, e.name));
              return { name: e.name, size_kb: Math.round(st.size / 1024), modified: date(st.mtime.toISOString()) };
            }),
        );
        return json({ folder: submissionsDir, files });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "prepare_submission",
    {
      title: "Prepare a submission (needs approval)",
      description:
        "Step 1 of 2 for submitting to Canvas. Checks the assignment, stages exactly one of: text, a URL, or a file " +
        "from the submissions folder, and sends a 6-digit approval code to the student's phone. Nothing is " +
        "submitted yet. After calling this, show the student the preview and ask them to type the code from " +
        "their phone; then call confirm_submission.",
      inputSchema: {
        course: z.string().describe('Course id, course code, or part of the name (e.g. "CS 240")'),
        assignment_id: z.number().int(),
        text: z
          .string()
          .optional()
          .describe("For text-entry assignments. Plain text; blank lines become paragraphs."),
        url: z.string().url().optional().describe("For website-URL assignments"),
        file_name: z
          .string()
          .optional()
          .describe("For file-upload assignments: the name of a file in the submissions folder (see list_submission_files)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ course, assignment_id, text, url, file_name }) => {
      try {
        const given = [text, url, file_name].filter((v) => v !== undefined && v !== "");
        if (given.length !== 1) return errorResult("Provide exactly one of text, url, or file_name.");

        const c = await courses.resolve(course);
        const [a, current] = await Promise.all([
          canvas.get<Assignment>(`/courses/${c.id}/assignments/${assignment_id}`),
          canvas
            .get<Submission>(`/courses/${c.id}/assignments/${assignment_id}/submissions/self`)
            .catch(() => undefined),
        ]);

        // --- Build the payload and check it against the assignment's rules ---
        let payload: SubmissionPayload;
        let what: string;
        if (text !== undefined && text !== "") {
          requireType(a, "online_text_entry", "a text entry");
          payload = { kind: "text", html: textToHtml(text), preview: text.slice(0, 300) };
          what = `text entry (${text.trim().split(/\s+/).length} words): "${text.trim().slice(0, 120)}${text.length > 120 ? "…" : ""}"`;
        } else if (url) {
          requireType(a, "online_url", "a website URL");
          payload = { kind: "url", url };
          what = `URL ${url}`;
        } else {
          requireType(a, "online_upload", "a file upload");
          const file = await readSubmissionFile(submissionsDir, file_name!);
          const ext = path.extname(file.name).toLowerCase().slice(1);
          if (a.allowed_extensions?.length && !a.allowed_extensions.map((x) => x.toLowerCase()).includes(ext)) {
            return errorResult(`This assignment only accepts: ${a.allowed_extensions.join(", ")}. "${file.name}" is .${ext}.`);
          }
          payload = { kind: "file", ...file };
          what = `file ${file.name} (${Math.round(file.data.length / 1024)} KB, sha256 ${file.sha256.slice(0, 12)})`;
        }

        if (a.locked_for_user) {
          return errorResult(`Canvas says this assignment is locked for you${a.lock_explanation ? `: ${a.lock_explanation}` : ""}.`);
        }
        const used = current?.attempt ?? 0;
        if (a.allowed_attempts && a.allowed_attempts > 0 && used >= a.allowed_attempts) {
          return errorResult(`All ${a.allowed_attempts} allowed attempts are used.`);
        }

        const warnings: string[] = [];
        if (a.due_at && Date.parse(a.due_at) < Date.now()) warnings.push(`Past due (${date(a.due_at)}); Canvas will likely mark it late.`);
        if (current && current.workflow_state !== "unsubmitted" && current.submitted_at) {
          warnings.push(
            `Already submitted on ${date(current.submitted_at)}. This becomes attempt ${used + 1}` +
              (a.allowed_attempts && a.allowed_attempts > 0 ? ` of ${a.allowed_attempts}.` : "."),
          );
        }

        const courseLabel = `${c.course_code} — ${c.name}`;
        const summary = `${c.course_code}: "${a.name}" ← ${what}`;
        const { pending, code } = approvals.create({
          courseId: c.id,
          courseLabel,
          assignmentId: a.id,
          assignmentName: a.name,
          payload,
          summary,
        });

        try {
          await notifier.send(
            "Canvas submission approval",
            `${summary}\n${warnings.join("\n")}\n\nCode: ${code}\nExpires ${date(new Date(pending.expiresAt).toISOString())}.` +
              "\nOnly type this code into Claude if you want this submitted.",
          );
        } catch (err) {
          approvals.remove(pending.id);
          return errorResult(
            `Couldn't send the approval code (${err instanceof Error ? err.message : err}), so nothing was staged.`,
          );
        }

        return json(
          compact({
            pending_id: pending.id,
            status: "waiting_for_approval",
            course: courseLabel,
            assignment: a.name,
            due: date(a.due_at),
            submitting: what,
            warnings,
            expires: date(new Date(pending.expiresAt).toISOString()),
            next_step:
              "Show this preview to the student and ask them to type the 6-digit code sent to their phone. " +
              "Do not guess or make up a code. Then call confirm_submission with pending_id and their code.",
          }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "confirm_submission",
    {
      title: "Submit to Canvas (with approval code)",
      description:
        "Step 2 of 2. Submits a prepared submission to Canvas. Requires the 6-digit approval code the student " +
        "received on their phone and typed into the chat. Never call this with a code the student didn't type.",
      inputSchema: {
        pending_id: z.string().describe("The pending_id from prepare_submission"),
        approval_code: z.string().describe("The code exactly as the student typed it"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ pending_id, approval_code }) => {
      let p;
      try {
        p = approvals.redeem(pending_id, approval_code);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      try {
        const form: Array<[string, string]> = [];
        if (p.payload.kind === "text") {
          form.push(["submission[submission_type]", "online_text_entry"], ["submission[body]", p.payload.html]);
        } else if (p.payload.kind === "url") {
          form.push(["submission[submission_type]", "online_url"], ["submission[url]", p.payload.url]);
        } else {
          const fileId = await canvas.uploadSubmissionFile(p.courseId, p.assignmentId, p.payload);
          form.push(["submission[submission_type]", "online_upload"], ["submission[file_ids][]", String(fileId)]);
        }
        const sub = await canvas.postForm<Submission>(
          `/courses/${p.courseId}/assignments/${p.assignmentId}/submissions`,
          form,
        );
        return json(
          compact({
            status: "submitted",
            course: p.courseLabel,
            assignment: p.assignmentName,
            submitted_at: date(sub.submitted_at),
            attempt: sub.attempt,
            late: sub.late || undefined,
            what: p.summary,
          }),
        );
      } catch (err) {
        return errorResult(
          `Approval accepted, but Canvas rejected the submission: ${err instanceof Error ? err.message : err}. ` +
            "Nothing was submitted; prepare it again after fixing the problem.",
        );
      }
    },
  );

  server.registerTool(
    "cancel_submission",
    {
      title: "Cancel a prepared submission",
      description: "Discards a prepared submission that hasn't been confirmed. Also lists anything still pending.",
      inputSchema: { pending_id: z.string().optional().describe("Leave out to just list pending submissions") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pending_id }) => {
      const cancelled = pending_id ? approvals.cancel(pending_id) : undefined;
      return json(
        compact({
          cancelled: pending_id ? (cancelled ? pending_id : `nothing pending with id ${pending_id}`) : undefined,
          still_pending: approvals.list().map((p) => ({ pending_id: p.id, what: p.summary })),
        }),
      );
    },
  );
}

function requireType(a: Assignment, type: string, label: string) {
  if (!a.submission_types.includes(type)) {
    throw new Error(`"${a.name}" doesn't accept ${label}. It accepts: ${a.submission_types.join(", ")}.`);
  }
}

function textToHtml(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((para) => `<p>${escape(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

async function readSubmissionFile(dir: string, name: string) {
  if (name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error("file_name must be a plain file name from the submissions folder.");
  }
  const realDir = await fs.realpath(dir);
  const real = await fs.realpath(path.join(dir, name)).catch(() => {
    throw new Error(`No file named "${name}" in the submissions folder. Use list_submission_files.`);
  });
  if (path.dirname(real) !== realDir) throw new Error("That file isn't inside the submissions folder.");
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error(`"${name}" isn't a file.`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`"${name}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const data = await fs.readFile(real);
  return {
    name,
    contentType: CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream",
    data,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
