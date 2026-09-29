import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedStore } from "../src/mcp/data.ts";
import { connectMemory } from "../src/mcp/connect.ts";
import { runAgent } from "../src/agent/run.ts";
import { AnthropicModel, parseRecommendation } from "../src/models/anthropic.ts";
import type { MoodEvent, TraceEntry } from "../src/types.ts";

// A localhost stand-in for the Messages API: each test scripts the responses,
// one per request. No test here reaches the network.

type Reply = { content: unknown[]; stop_reason: string };
type Sent = { model: string; messages: Array<{ role: string; content: unknown }> };
let script: Reply[] = [];
/** Every request body the stand-in received, oldest first. */
let requests: Sent[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Sent;
      requests.push(body);
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

  test("a final answer cut off by max_tokens fails the run before the loop's fallback sends anything", async () => {
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
  const REJECTED = /must be a JSON object with non-empty "approach", "firstStep" and "rationale" strings/;
  const WANT = { approach: "Check in today.", firstStep: "Message them.", rationale: "On call." };
  const OBJECT = JSON.stringify(WANT);

  test("prose with no JSON object is rejected", () => {
    expect(() => parseRecommendation("Offer a private check-in today.")).toThrow(REJECTED);
  });

  test("a JSON fragment is rejected, bare, after prose, or inside an unclosed fence", () => {
    expect(() => parseRecommendation(FRAGMENT)).toThrow(REJECTED);
    expect(() => parseRecommendation("Here is my answer: " + FRAGMENT)).toThrow(REJECTED);
    expect(() => parseRecommendation("```json\n" + FRAGMENT)).toThrow(REJECTED);
  });

  test("an object missing a field or carrying an empty one is rejected", () => {
    expect(() => parseRecommendation('{"approach":"Check in."}')).toThrow(REJECTED);
    expect(() => parseRecommendation('Answer: {"approach":"Check in.","firstStep":"x"} done.')).toThrow(REJECTED);
    expect(() => parseRecommendation('{"approach":"","firstStep":"x","rationale":"y"}')).toThrow(REJECTED);
    expect(() => parseRecommendation('{"approach":"a","firstStep":"  ","rationale":"y"}')).toThrow(REJECTED);
  });

  test("an object embedded in prose is found, even after other braces", () => {
    expect(parseRecommendation(`I weighed {a few options}. Here it is:\n${OBJECT}\nHope that helps.`)).toEqual(WANT);
    expect(parseRecommendation(`Sure.\n\`\`\`json\n${OBJECT}\n\`\`\``)).toEqual(WANT);
  });

  test("a brace inside a string value does not end the object", () => {
    const text = '{"approach":"Use the {team} channel.","firstStep":"Ask \\"how are you?\\"","rationale":"On call."}';
    expect(parseRecommendation(text)).toEqual({
      approach: "Use the {team} channel.", firstStep: 'Ask "how are you?"', rationale: "On call.",
    });
  });
});

describe("AnthropicModel history replay", () => {
  const FINAL: Reply = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ approach: "a", firstStep: "b", rationale: "c" }), citations: null }] };
  const RECORDED = [
    { type: "text", text: "Looking both up.", citations: null },
    { type: "tool_use", id: "toolu_a", name: "find_employee", input: { employeeId: "e-003" } },
    { type: "tool_use", id: "toolu_b", name: "find_manager", input: { employeeId: "e-003" } },
  ];
  const user = { role: "user" as const, content: "u" };
  const marker = { role: "assistant" as const, content: "calls" };
  const result = (id: string) => ({ role: "tool_result" as const, content: "{}", toolCallId: id, isError: false });
  const ids = (content: unknown) => (content as Array<{ id?: string; tool_use_id?: string }>).map((b) => b.id ?? b.tool_use_id);

  test("a recorded turn is replayed only when each tool_use has exactly one result; otherwise it is rebuilt", async () => {
    requests = [];
    script = [{ stop_reason: "tool_use", content: RECORDED }, FINAL, FINAL, FINAL];
    const m = model();
    await m.turn({ system: "s", messages: [user], tools: [] });

    // Both calls answered once: the recorded turn goes back as it came, text block included.
    await m.turn({ system: "s", messages: [user, marker, result("toolu_a"), result("toolu_b")], tools: [] });
    expect(requests[1]!.messages[1]).toEqual({ role: "assistant", content: RECORDED });

    // One call unanswered: the turn is rebuilt so every tool_use sent has its result.
    await m.turn({ system: "s", messages: [user, marker, result("toolu_a")], tools: [] });
    expect(requests[2]!.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_a", name: "find_employee", input: { employeeId: "e-003" } }],
    });
    expect(ids(requests[2]!.messages[2]!.content)).toEqual(["toolu_a"]);

    // One call answered twice: rebuilt, and the repeated result is sent once.
    await m.turn({ system: "s", messages: [user, marker, result("toolu_a"), result("toolu_a"), result("toolu_b")], tools: [] });
    expect(ids(requests[3]!.messages[1]!.content)).toEqual(["toolu_a", "toolu_b"]);
    expect(ids(requests[3]!.messages[2]!.content)).toEqual(["toolu_a", "toolu_b"]);
  });
});
