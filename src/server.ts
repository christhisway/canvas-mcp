import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "./canvas.js";
import type { Config } from "./config.js";
import { CourseDirectory } from "./courses.js";
import { registerReadTools } from "./tools/read.js";

// Kept short: it's sent with every message, and each tool's description already says when to use it (issue #12).
const INSTRUCTIONS = `Read-only tools for the student's own Canvas LMS account: they can't submit or change anything, so
to hand work in, give the student the assignment's url. Dates are in the student's time zone, and courses can be
named by code or name instead of id. Exam dates can be calendar events, assignments or only in the syllabus:
try list_events with search (which includes assignments), then get_syllabus.`;

/** Long-lived state shared by every request (the HTTP transport is stateless). */
export function createShared(config: Config) {
  const canvas = new CanvasClient(config.canvasBaseUrl, config.canvasToken);
  return { config, canvas, courses: new CourseDirectory(canvas) };
}

export type Shared = ReturnType<typeof createShared>;

export function buildServer(shared: Shared): McpServer {
  const server = new McpServer({ name: "canvas", version: "0.4.0" }, { instructions: INSTRUCTIONS });
  const { canvas, courses, config } = shared;
  registerReadTools(server, { canvas, courses, timeZone: config.timeZone });
  return server;
}
