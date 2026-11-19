import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApprovalStore, ConsoleNotifier, NtfyNotifier, type Notifier } from "./approvals.js";
import { CanvasClient } from "./canvas.js";
import type { Config } from "./config.js";
import { CourseDirectory } from "./courses.js";
import { registerReadTools } from "./tools/read.js";
import { registerSubmitTools } from "./tools/submit.js";

const INSTRUCTIONS = `Tools for the student's own Canvas LMS account. Dates are shown in the student's time zone.
Use get_upcoming for "what's due" questions; courses can be named by code or name instead of id.
Submitting is a two-step process: prepare_submission sends a one-time code to the student's phone,
and confirm_submission needs that code typed by the student. Never invent or guess a code, and never
submit without the student explicitly asking to.`;

/** Long-lived state shared by every request (the HTTP transport is stateless). */
export function createShared(config: Config) {
  const canvas = new CanvasClient(config.canvasBaseUrl, config.canvasToken);
  const notifier: Notifier = config.ntfyUrl
    ? new NtfyNotifier(config.ntfyUrl, config.ntfyToken || undefined)
    : new ConsoleNotifier();
  return {
    config,
    canvas,
    courses: new CourseDirectory(canvas),
    approvals: new ApprovalStore(config.approvalTtlMinutes * 60_000),
    notifier,
  };
}

export type Shared = ReturnType<typeof createShared>;

export function buildServer(shared: Shared): McpServer {
  const server = new McpServer({ name: "canvas", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const { canvas, courses, approvals, notifier, config } = shared;
  registerReadTools(server, { canvas, courses, timeZone: config.timeZone });
  registerSubmitTools(server, {
    canvas,
    courses,
    approvals,
    notifier,
    submissionsDir: config.submissionsDir,
    timeZone: config.timeZone,
  });
  return server;
}
