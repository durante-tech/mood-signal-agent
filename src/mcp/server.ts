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
 * True when at least one employee in the store reports to `id`. An employee
 * nobody reports to is not a manager, so notify_manager refuses them.
 */
function isManager(store: HrStore, id: string): boolean {
  for (const e of store.employees.values()) if (e.managerId === id) return true;
  return false;
}

export function createServer(store: HrStore = seedStore()): McpServer {
  const server = new McpServer({ name: "mood-signal-hr", version: "0.1.0" });
  // The last number this server issued. Each send reads the outbox as it is at
  // that moment and moves on to the next number whose "n-<number>" id is not in
  // it, so a new id never equals one already there, whatever shape the other
  // ids have or whoever added them. Numbers only go up, so an id is never
  // issued twice even if entries leave the outbox.
  let counter = 0;
  const nextId = (): string => {
    const taken = new Set(store.outbox.map((n) => n.id));
    do counter += 1;
    while (taken.has(`n-${counter}`));
    return `n-${counter}`;
  };

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
      description:
        "Send a private message to a manager: an employee at least one other employee reports to. Returns the notification that was recorded.",
      inputSchema: {
        managerId: z.string().describe("Employee id of the manager to notify"),
        subject: z.string().describe("Short subject line"),
        body: z.string().describe("The message: what to do and why"),
      },
    },
    async ({ managerId, subject, body }) => {
      if (!store.employees.has(managerId)) return fail(`No employee with id "${managerId}".`);
      if (!isManager(store, managerId)) return fail(`Employee "${managerId}" is not the manager of anyone.`);
      const notification: Notification = {
        id: nextId(),
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
