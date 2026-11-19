import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CanvasClient } from "./canvas.js";
import type { Config } from "./config.js";
import { CourseDirectory } from "./courses.js";
import { registerReadTools } from "./tools/read.js";

const INSTRUCTIONS = `Read-only tools for the student's own Canvas LMS account. Dates are shown in the student's time zone.
Use get_upcoming for "what's due" questions; courses can be named by code or name instead of id.
These tools can't submit or change anything in Canvas. To hand something in, give the student the
assignment's url so they can submit it themselves.`;

/** Long-lived state shared by every request (the HTTP transport is stateless). */
export function createShared(config: Config) {
  const canvas = new CanvasClient(config.canvasBaseUrl, config.canvasToken);
  return { config, canvas, courses: new CourseDirectory(canvas) };
}

export type Shared = ReturnType<typeof createShared>;

export function buildServer(shared: Shared): McpServer {
  const server = new McpServer({ name: "canvas", version: "0.2.0" }, { instructions: INSTRUCTIONS });
  const { canvas, courses, config } = shared;
  registerReadTools(server, { canvas, courses, timeZone: config.timeZone });
  return server;
}
