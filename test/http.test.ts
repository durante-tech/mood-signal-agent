import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";

// Starts the real HTTP server as a child process on a free port, with no API
// key in its environment, and talks to it over HTTP. Nothing reaches the network
// beyond localhost.

const root = new URL("..", import.meta.url).pathname;
let proc: Subprocess | undefined;
let base = "";

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("could not find a free port");
  return port;
}

interface SseBlock {
  event?: string;
  data: unknown;
}

// Split an SSE body into blocks, joining multi-line data and parsing it as JSON.
function parseSse(body: string): SseBlock[] {
  const blocks: SseBlock[] = [];
  for (const raw of body.split(/\r?\n\r?\n/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) continue;
    const text = data.join("\n");
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep the raw text
    }
    blocks.push({ event, data: parsed });
  }
  return blocks;
}

// The final block: an `event: done` block, or a payload carrying answeredBy.
function isDone(b: SseBlock): boolean {
  if (b.event === "done") return true;
  return typeof b.data === "object" && b.data !== null && "answeredBy" in b.data;
}

function traceEntries(blocks: SseBlock[]): Array<{ kind: string; name?: string }> {
  return blocks
    .filter((b) => !isDone(b) && typeof b.data === "object" && b.data !== null && "kind" in b.data)
    .map((b) => b.data as { kind: string; name?: string });
}

beforeAll(async () => {
  const port = freePort();
  const { ANTHROPIC_API_KEY: _omit, ...env } = process.env;
  proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: root,
    env: { ...env, PORT: String(port) },
    stdout: "ignore",
    stderr: "inherit",
  });
  base = `http://localhost:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error("server did not start within 10 s");
}, 15_000);

afterAll(() => {
  proc?.kill();
});

describe("HTTP server", () => {
  test("GET /api/health reports ok, not live without a key, and the remaining budget", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; live: boolean; remaining: number };
    expect(body.ok).toBe(true);
    expect(body.live).toBe(false);
    expect(typeof body.remaining).toBe("number");
  });

  test("GET /api/employees lists the seeded employees", async () => {
    const res = await fetch(`${base}/api/employees`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; name: string; role: string; team: string }>;
    expect(list.length).toBeGreaterThanOrEqual(8);
    for (const e of list) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.name).toBe("string");
      expect(typeof e.role).toBe("string");
      expect(typeof e.team).toBe("string");
    }
  });

  test("GET / serves the page", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
  });

  test("POST /api/event with stressed streams the agent's trace and ends in done", async () => {
    // The seeded tree has one top node with no manager; pick someone who has one.
    const { seedStore } = await import("../src/mcp/data.ts");
    const employee = [...seedStore().employees.values()].find((e) => e.managerId !== null)!;
    const res = await fetch(`${base}/api/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employeeId: employee.id, mood: "stressed" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    const blocks = parseSse(await res.text());
    expect(blocks.length).toBeGreaterThan(1);
    const last = blocks.at(-1)!;
    expect(isDone(last)).toBe(true);
    expect(last.data).toMatchObject({ answeredBy: "stub", live: false });

    const entries = traceEntries(blocks);
    expect(entries[0]!.kind).toBe("event");
    const calls = entries.filter((e) => e.kind === "tool_call").map((e) => e.name);
    expect(calls).toEqual(["find_employee", "find_manager", "notify_manager"]);
    expect(entries.some((e) => e.kind === "error")).toBe(false);
  }, 15_000);

  test("POST /api/event with another mood runs no agent", async () => {
    const res = await fetch(`${base}/api/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employeeId: "e-002", mood: "good" }),
    });
    expect(res.status).toBe(200);
    const blocks = parseSse(await res.text());
    expect(isDone(blocks.at(-1)!)).toBe(true);
    const entries = traceEntries(blocks);
    expect(entries.length).toBe(1);
    expect(entries[0]!.kind).toBe("event");
  });
});
