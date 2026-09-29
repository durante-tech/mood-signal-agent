import { afterEach, describe, expect, test } from "bun:test";
import { seedStore } from "../src/mcp/data.ts";
import { TOOL_NAMES } from "../src/mcp/server.ts";
import { connectMemory } from "../src/mcp/connect.ts";

// Read a tool result: the first text block, parsed as JSON when it is JSON.
function read(res: unknown): { isError: boolean; value: unknown; text: string } {
  const r = res as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // Error results are plain text; keep the string.
  }
  return { isError: r.isError === true, value, text };
}

describe("seed data", () => {
  test("is deterministic and forms one manager tree", () => {
    const a = seedStore();
    const b = seedStore();
    const list = [...a.employees.values()];
    expect([...b.employees.values()]).toEqual(list);
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(list.length).toBeLessThanOrEqual(10);
    expect(a.outbox).toEqual([]);

    const teams = new Set(list.map((e) => e.team));
    expect(teams.size).toBeGreaterThanOrEqual(2);
    expect(teams.size).toBeLessThanOrEqual(3);

    expect(list.filter((e) => e.managerId === null).length).toBe(1);
    for (const e of list) {
      expect(e.id).toMatch(/^e-\d{3}$/);
      expect(a.employees.get(e.id)).toBe(e);
      if (e.managerId !== null) expect(a.employees.has(e.managerId)).toBe(true);
    }
  });
});

describe("MCP tools over an in-memory transport", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function open() {
    const conn = await connectMemory(seedStore());
    close = conn.close;
    const list = [...conn.store.employees.values()];
    const top = list.find((e) => e.managerId === null)!;
    const report = list.find((e) => e.managerId !== null)!;
    return { ...conn, top, report };
  }

  test("lists exactly the three tools", async () => {
    const { client } = await open();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  test("find_employee returns a known employee", async () => {
    const { client, report } = await open();
    const r = read(await client.callTool({ name: "find_employee", arguments: { employeeId: report.id } }));
    expect(r.isError).toBe(false);
    expect(r.value).toMatchObject({ id: report.id, name: report.name, managerId: report.managerId });
  });

  test("find_employee reports an unknown id as an error", async () => {
    const { client } = await open();
    const r = read(await client.callTool({ name: "find_employee", arguments: { employeeId: "e-999" } }));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("e-999");
  });

  test("find_manager returns the manager of a known employee", async () => {
    const { client, report } = await open();
    const r = read(await client.callTool({ name: "find_manager", arguments: { employeeId: report.id } }));
    expect(r.isError).toBe(false);
    expect((r.value as { id: string }).id).toBe(report.managerId!);
  });

  test("find_manager reports the top of the tree as having no manager", async () => {
    const { client, top } = await open();
    const r = read(await client.callTool({ name: "find_manager", arguments: { employeeId: top.id } }));
    expect(r.isError).toBe(true);
  });

  test("find_manager reports an unknown id as an error", async () => {
    const { client } = await open();
    const r = read(await client.callTool({ name: "find_manager", arguments: { employeeId: "e-999" } }));
    expect(r.isError).toBe(true);
  });

  test("notify_manager appends to the outbox and returns the notification", async () => {
    const { client, store, top } = await open();
    const r = read(
      await client.callTool({
        name: "notify_manager",
        arguments: { managerId: top.id, subject: "Check in", body: "Talk today." },
      }),
    );
    expect(r.isError).toBe(false);
    const n = r.value as { id: string; toEmployeeId: string; subject: string; body: string; sentAt: string };
    expect(n.id).toMatch(/^n-\d+$/);
    expect(n.toEmployeeId).toBe(top.id);
    expect(n.subject).toBe("Check in");
    expect(n.body).toBe("Talk today.");
    expect(Number.isNaN(Date.parse(n.sentAt))).toBe(false);
    expect(store.outbox.length).toBe(1);
    expect(store.outbox[0]!.id).toBe(n.id);
  });

  test("notify_manager ids stay unique when the injected outbox has gaps", async () => {
    // One entry numbered 3: counting entries would hand out n-2 and then n-3 again.
    const store = seedStore();
    store.outbox.push({ id: "n-3", toEmployeeId: "e-002", subject: "earlier", body: "earlier", sentAt: "2026-01-01T00:00:00.000Z" });
    const conn = await connectMemory(store);
    close = conn.close;
    for (let i = 0; i < 2; i++) {
      await conn.client.callTool({ name: "notify_manager", arguments: { managerId: "e-002", subject: "s", body: "b" } });
    }
    const ids = store.outbox.map((n) => n.id);
    expect(ids).toEqual(["n-3", "n-4", "n-5"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("notify_manager rejects an unknown manager and sends nothing", async () => {
    const { client, store } = await open();
    const r = read(
      await client.callTool({
        name: "notify_manager",
        arguments: { managerId: "e-999", subject: "x", body: "y" },
      }),
    );
    expect(r.isError).toBe(true);
    expect(store.outbox.length).toBe(0);
  });
});
