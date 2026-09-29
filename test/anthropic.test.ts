import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedStore } from "../src/mcp/data.ts";
import { connectMemory } from "../src/mcp/connect.ts";
import { runAgent } from "../src/agent/run.ts";
import { AnthropicModel, parseRecommendation } from "../src/models/anthropic.ts";
import type { MoodEvent, TraceEntry } from "../src/types.ts";

// A localhost stand-in for the Messages API: each test scripts the responses,
// one per request. No test here reaches the network.

type Reply = { content: unknown[]; stop_reason: string };
let script: Reply[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string };
      const next = script.shift();
      if (!next) return new Response("no scripted reply left", { status: 500 });
      return Response.json({
        id: "msg_test", type: "message", role: "assistant", model: body.model,
        content: next.content, stop_reason: next.stop_reason, stop_sequence: null, stop_details: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    },
  });
});

afterAll(() => server.stop(true));

// The SDK reads its base URL from the environment when the client is built.
function model(): AnthropicModel {
  const saved = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.port}`;
  try {
    return new AnthropicModel("test-key-not-real");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved;
  }
}

const FRAGMENT = '{"approach":"A long paragraph that was cut';

describe("AnthropicModel final answers", () => {
  test("a max_tokens stop is an error, not a recommendation", async () => {
    script = [{ stop_reason: "max_tokens", content: [{ type: "text", text: FRAGMENT, citations: null }] }];
    await expect(model().turn({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] }))
      .rejects.toThrow(/ran out of tokens \(max_tokens 600\)/);
  });

  test("a run whose final answer is cut off notifies nobody and ends in an error entry", async () => {
    const store = seedStore();
    const employee = [...store.employees.values()].find((e) => e.managerId !== null)!;
    const event: MoodEvent = { employeeId: employee.id, mood: "stressed", at: "2026-01-15T09:00:00.000Z" };
    script = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "find_employee", input: { employeeId: employee.id } }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_2", name: "find_manager", input: { employeeId: employee.id } }] },
      { stop_reason: "max_tokens", content: [{ type: "text", text: FRAGMENT, citations: null }] },
    ];
    const connection = await connectMemory(store);
    const seen: TraceEntry[] = [];
    try {
      await expect(runAgent(event, { model: model(), connection, onTrace: (e) => seen.push(e) })).rejects.toThrow(/ran out of tokens/);
    } finally {
      await connection.close();
    }
    expect(store.outbox.length).toBe(0);
    expect(seen.some((e) => e.kind === "notification")).toBe(false);
    expect(seen.at(-1)!.kind).toBe("error");
  });

  test("a complete fenced JSON answer still parses", async () => {
    script = [{
      stop_reason: "end_turn",
      content: [{ type: "text", text: '```json\n{"approach":"Check in today.","firstStep":"Message them.","rationale":"On call."}\n```', citations: null }],
    }];
    const turn = await model().turn({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect(turn).toEqual({ kind: "final", recommendation: { approach: "Check in today.", firstStep: "Message them.", rationale: "On call." } });
  });
});

describe("parseRecommendation", () => {
  test("well-formed prose becomes the approach", () => {
    expect(parseRecommendation("Offer a private check-in today.")).toEqual({
      approach: "Offer a private check-in today.", firstStep: "see approach", rationale: "see approach",
    });
  });

  test("a JSON fragment is an error", () => {
    expect(() => parseRecommendation(FRAGMENT)).toThrow(/looked like JSON/);
  });

  test("a JSON fragment inside an unclosed fence is an error", () => {
    expect(() => parseRecommendation("```json\n" + FRAGMENT)).toThrow(/looked like JSON/);
  });

  test("a complete object missing a field is an error", () => {
    expect(() => parseRecommendation('{"approach":"Check in."}')).toThrow(/looked like JSON/);
  });
});
