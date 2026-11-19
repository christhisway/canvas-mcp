import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Out-of-band approval for submissions.
 *
 * prepare_submission stores the exact payload server-side and sends a one-time
 * code to the student's phone (ntfy). confirm_submission only goes through when
 * the student types that code back into the chat. The model never sees the code,
 * so it cannot approve on its own, and because the payload is stored here, what
 * gets submitted is exactly what was previewed in the notification.
 */

export type SubmissionPayload =
  | { kind: "text"; html: string; preview: string }
  | { kind: "url"; url: string }
  | { kind: "file"; name: string; contentType: string; data: Buffer; sha256: string };

export interface PendingSubmission {
  id: string;
  courseId: number;
  courseLabel: string;
  assignmentId: number;
  assignmentName: string;
  payload: SubmissionPayload;
  summary: string;
  expiresAt: number;
  attemptsLeft: number;
  codeHash: Buffer;
}

const MAX_PENDING = 5;
const MAX_ATTEMPTS = 3;

export class ApprovalStore {
  private pending = new Map<string, PendingSubmission>();

  constructor(private readonly ttlMs: number) {}

  private sweep() {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
  }

  create(p: Omit<PendingSubmission, "id" | "expiresAt" | "attemptsLeft" | "codeHash">): {
    pending: PendingSubmission;
    code: string;
  } {
    this.sweep();
    if (this.pending.size >= MAX_PENDING) {
      throw new Error(
        `There are already ${MAX_PENDING} submissions waiting for approval. Confirm or cancel those first.`,
      );
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const pending: PendingSubmission = {
      ...p,
      id: randomUUID().slice(0, 8),
      expiresAt: Date.now() + this.ttlMs,
      attemptsLeft: MAX_ATTEMPTS,
      codeHash: hash(code),
    };
    this.pending.set(pending.id, pending);
    return { pending, code };
  }

  /** Returns the pending submission and removes it if the code matches. */
  redeem(id: string, code: string): PendingSubmission {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) throw new Error(`No pending submission "${id}" (it may have expired, been used, or been cancelled).`);
    const ok = timingSafeEqual(hash(code.replace(/\D/g, "")), p.codeHash);
    if (!ok) {
      p.attemptsLeft -= 1;
      if (p.attemptsLeft <= 0) {
        this.pending.delete(id);
        throw new Error("Wrong approval code too many times; this submission was cancelled. Prepare it again.");
      }
      throw new Error(`Wrong approval code. ${p.attemptsLeft} attempt(s) left.`);
    }
    this.pending.delete(id);
    return p;
  }

  cancel(id: string): boolean {
    return this.pending.delete(id);
  }

  list(): PendingSubmission[] {
    this.sweep();
    return [...this.pending.values()];
  }

  remove(id: string) {
    this.pending.delete(id);
  }
}

function hash(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export interface Notifier {
  send(title: string, body: string): Promise<void>;
}

export class NtfyNotifier implements Notifier {
  constructor(private readonly url: string, private readonly token?: string) {}

  async send(title: string, body: string) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Title: title,
        Priority: "high",
        Tags: "warning",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body,
    });
    if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
  }
}

/** Fallback when NTFY_URL isn't set: the code only appears in the server's own log. */
export class ConsoleNotifier implements Notifier {
  async send(title: string, body: string) {
    console.log(`\n==== ${title} ====\n${body}\n`);
  }
}
