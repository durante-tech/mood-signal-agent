/**
 * Standalone MCP server over stdio: `bun run src/mcp/main.ts`.
 * stdout carries the protocol, so nothing in this process may print to it.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

const server = createServer();
await server.connect(new StdioServerTransport());
