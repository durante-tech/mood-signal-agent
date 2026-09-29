/**
 * Two ways to reach the MCP server as a client: in-process (tests, the web
 * server) and over stdio (a child process, the way an MCP host runs it).
 */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolSpec } from "../types.ts";
import { seedStore, type HrStore } from "./data.ts";
import { createServer } from "./server.ts";

const CLIENT_INFO = { name: "mood-signal-agent", version: "0.1.0" };
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Server and client in one process, linked by an in-memory transport. */
export async function connectMemory(
  store: HrStore = seedStore(),
): Promise<{ client: Client; store: HrStore; close(): Promise<void> }> {
  const server = createServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(CLIENT_INFO);
  await client.connect(clientTransport);
  return {
    client,
    store,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Spawns `bun run src/mcp/main.ts` from the repo root and talks to it over stdio. */
export async function connectStdio(): Promise<{ client: Client; close(): Promise<void> }> {
  // Under bun, execPath is the bun binary itself, so the child does not depend on PATH.
  const bun = /bun(\.exe)?$/.test(process.execPath) ? process.execPath : "bun";
  const transport = new StdioClientTransport({
    command: bun,
    args: ["run", "src/mcp/main.ts"],
    cwd: REPO_ROOT,
  });
  const client = new Client(CLIENT_INFO);
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

/** The server's tools in the shape the model sees. */
export async function toolSpecs(client: Client): Promise<ToolSpec[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
}
