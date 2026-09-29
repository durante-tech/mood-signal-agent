/**
 * The MCP server: three tools over an in-memory HR store.
 * Each result is JSON, returned as one text content block.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Notification } from "../types.ts";
import { seedStore, type HrStore } from "./data.ts";

export const TOOL_NAMES = ["find_employee", "find_manager", "notify_manager"] as const;

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * The highest number among outbox ids of the form "n-<1 to 15 digits>". Other
 * ids are ignored. Fifteen digits stay below 2^53, so the number is exact and
 * the next id is always new; a longer suffix is never converted.
 */
function highestNotificationNumber(outbox: Notification[]): number {
  let highest = 0;
  for (const n of outbox) {
    const match = /^n-(\d{1,15})$/.exec(n.id);
    if (!match?.[1]) continue;
    const value = Number.parseInt(match[1], 10);
    if (value > highest) highest = value;
  }
  return highest;
}

export function createServer(store: HrStore = seedStore()): McpServer {
  const server = new McpServer({ name: "mood-signal-hr", version: "0.1.0" });
  // Continue numbering after the highest "n-<number>" id already in the outbox,
  // so ids stay unique per store even when an injected outbox has gaps.
  let counter = highestNotificationNumber(store.outbox);

  server.registerTool(
    "find_employee",
    {
      description: "Look up an employee by id. Returns name, role, team, managerId and notes.",
      inputSchema: { employeeId: z.string().describe("Employee id, for example e-003") },
    },
    async ({ employeeId }) => {
      const employee = store.employees.get(employeeId);
      return employee ? ok(employee) : fail(`No employee with id "${employeeId}".`);
    },
  );

  server.registerTool(
    "find_manager",
    {
      description: "Look up the manager of an employee. Returns the manager as an employee record.",
      inputSchema: { employeeId: z.string().describe("Id of the employee whose manager you want") },
    },
    async ({ employeeId }) => {
      const employee = store.employees.get(employeeId);
      if (!employee) return fail(`No employee with id "${employeeId}".`);
      if (employee.managerId === null) return fail(`Employee "${employeeId}" has no manager.`);
      const manager = store.employees.get(employee.managerId);
      if (!manager) return fail(`Manager "${employee.managerId}" of "${employeeId}" is not in the directory.`);
      return ok(manager);
    },
  );

  server.registerTool(
    "notify_manager",
    {
      description: "Send a private message to a manager. Returns the notification that was recorded.",
      inputSchema: {
        managerId: z.string().describe("Employee id of the manager to notify"),
        subject: z.string().describe("Short subject line"),
        body: z.string().describe("The message: what to do and why"),
      },
    },
    async ({ managerId, subject, body }) => {
      if (!store.employees.has(managerId)) return fail(`No employee with id "${managerId}".`);
      counter += 1;
      const notification: Notification = {
        id: `n-${counter}`,
        toEmployeeId: managerId,
        subject,
        body,
        sentAt: new Date().toISOString(),
      };
      store.outbox.push(notification);
      return ok(notification);
    },
  );

  return server;
}
