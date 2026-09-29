import { expect, test } from "bun:test";
import { connectStdio, toolSpecs } from "../src/mcp/connect.ts";
import { TOOL_NAMES } from "../src/mcp/server.ts";

test(
  "the standalone server answers listTools over stdio",
  async () => {
    const { client, close } = await connectStdio();
    try {
      const specs = await toolSpecs(client);
      expect(specs.map((s) => s.name).sort()).toEqual([...TOOL_NAMES].sort());
      for (const s of specs) {
        expect(s.description.length).toBeGreaterThan(0);
        expect(typeof s.inputSchema).toBe("object");
      }
    } finally {
      await close();
    }
  },
  20_000,
);
