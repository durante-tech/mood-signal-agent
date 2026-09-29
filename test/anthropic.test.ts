import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { seedStore } from "../src/mcp/data.ts";
import { connectMemory } from "../src/mcp/connect.ts";
import { runAgent } from "../src/agent/run.ts";
import { AnthropicModel, parseRecommendation } from "../src/models/anthropic.ts";
import type { MoodEvent, TraceEntry } from "../src/types.ts";

// A localhost stand-in for the Messages API: each test scripts the responses,
// one per request. No test here reaches the network.

type Reply = { content: unknown[]; stop_reason: string } | { status: number };
type Sent = { model: string; messages: Array<{ role: string; content: unknown }>; thinking?: unknown };
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
      if ("status" in next) {
        // retry-after-ms keeps the SDK's wait between retries at 1 ms.
        return Response.json(
          { type: "error", error: { type: "api_error", message: "scripted failure" } },
          { status: next.status, headers: { "retry-after-ms": "1" } },
        );
      }
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

describe("AnthropicModel requests", () => {
  const FINAL_TEXT = JSON.stringify({ approach: "a", firstStep: "b", rationale: "c" });
  const final = (): Reply => ({ stop_reason: "end_turn", content: [{ type: "text", text: FINAL_TEXT, citations: null }] });

  test("a turn with no user message throws a clear error and sends no request", async () => {
    requests = [];
    script = [final()];
    const m = model();
    await expect(m.turn({ system: "s", messages: [], tools: [] })).rejects.toThrow(
      "nothing to send to the model: the conversation needs at least one user message",
    );
    await expect(m.turn({ system: "s", messages: [{ role: "assistant", content: "calls" }], tools: [] })).rejects.toThrow(
      /needs at least one user message/,
    );
    expect(requests.length).toBe(0);
    expect(script.length).toBe(1);
  });

  test("a turn sends one request plus at most 2 retries on a server error, then fails", async () => {
    requests = [];
    script = [{ status: 500 }, { status: 500 }, { status: 500 }, final()];
    await expect(model().turn({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] })).rejects.toThrow(
      /500/,
    );
    expect(requests.length).toBe(3);
    // The fourth reply was never asked for.
    expect(script.length).toBe(1);
  });

  test("a turn that succeeds on its second retry returns the answer after 3 requests", async () => {
    requests = [];
    script = [{ status: 503 }, { status: 429 }, final()];
    const turn = await model().turn({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect(turn).toEqual({ kind: "final", recommendation: { approach: "a", firstStep: "b", rationale: "c" } });
    expect(requests.length).toBe(3);
  });

  test("usage sums every answered request's usage block", async () => {
    requests = [];
    script = [final(), final()];
    const m = model();
    expect(m.usage).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    await m.turn({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    await m.turn({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    // The mock answers every request with usage { input_tokens: 10, output_tokens: 10 }.
    expect(m.usage).toEqual({ requests: 2, inputTokens: 20, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("parseRecommendation", () => {
  const REJECTED = /^the final answer must be exactly one JSON object whose only keys are "approach", "firstStep" and "rationale", each a non-empty string/;
  const WANT = { approach: "Check in today.", firstStep: "Message them.", rationale: "On call." };
  const OBJECT = JSON.stringify(WANT);

  test("prose with no JSON object is rejected", () => {
    expect(() => parseRecommendation("Offer a private check-in today.")).toThrow(REJECTED);
  });

  test("prose around a complete object is rejected", () => {
    expect(() => parseRecommendation(`Here it is:\n${OBJECT}`)).toThrow(REJECTED);
    expect(() => parseRecommendation(`${OBJECT}\nHope that helps.`)).toThrow(REJECTED);
    expect(() => parseRecommendation(`I weighed {a few options}. ${OBJECT}`)).toThrow(REJECTED);
    expect(() => parseRecommendation(`Sure.\n\`\`\`json\n${OBJECT}\n\`\`\``)).toThrow(REJECTED);
  });

  test("an object with an extra key is rejected", () => {
    expect(() => parseRecommendation(JSON.stringify({ ...WANT, managerId: "e-006" }))).toThrow(/unexpected key\(s\): managerId/);
  });

  test("a JSON fragment is rejected, bare, after prose, or inside an unclosed fence", () => {
    expect(() => parseRecommendation(FRAGMENT)).toThrow(REJECTED);
    expect(() => parseRecommendation("Here is my answer: " + FRAGMENT)).toThrow(REJECTED);
    expect(() => parseRecommendation("```json\n" + FRAGMENT)).toThrow(REJECTED);
  });

  test("two objects, an array, or a string are rejected", () => {
    expect(() => parseRecommendation(`${OBJECT}\n${OBJECT}`)).toThrow(REJECTED);
    expect(() => parseRecommendation(`[${OBJECT}]`)).toThrow(REJECTED);
    expect(() => parseRecommendation(JSON.stringify(OBJECT))).toThrow(REJECTED);
  });

  test("an object missing a field or carrying an empty one is rejected", () => {
    expect(() => parseRecommendation('{"approach":"Check in."}')).toThrow(REJECTED);
    expect(() => parseRecommendation('{"approach":"","firstStep":"x","rationale":"y"}')).toThrow(REJECTED);
    expect(() => parseRecommendation('{"approach":"a","firstStep":"  ","rationale":"y"}')).toThrow(REJECTED);
  });

  test("an exact object is accepted bare or in one json fence, with surrounding whitespace", () => {
    expect(parseRecommendation(OBJECT)).toEqual(WANT);
    expect(parseRecommendation(`  \n\`\`\`json\n${OBJECT}\n\`\`\`\n  `)).toEqual(WANT);
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

  test("requests carry no thinking setting", async () => {
    requests = [];
    script = [FINAL];
    await model().turn({ system: "s", messages: [user], tools: [] });
    expect(requests.length).toBe(1);
    expect("thinking" in requests[0]!).toBe(false);
  });
});

describe("AnthropicModel in a full run", () => {
  test("notify_manager is answered as queued in the replayed history, and one notification goes out after the final answer", async () => {
    const store = seedStore();
    const event: MoodEvent = { employeeId: "e-003", mood: "stressed", at: "2026-01-15T09:00:00.000Z" };
    const lookups = [
      { type: "text", text: "Looking both up.", citations: null },
      { type: "tool_use", id: "toolu_e", name: "find_employee", input: { employeeId: "e-003" } },
      { type: "tool_use", id: "toolu_m", name: "find_manager", input: { employeeId: "e-003" } },
    ];
    const notifyTurn = [{ type: "tool_use", id: "toolu_n", name: "notify_manager", input: { managerId: "e-002", subject: "s", body: "proposed" } }];
    const answer = { approach: "Offer Priya a short check-in today.", firstStep: "Message her now.", rationale: "On call this week." };
    requests = [];
    script = [
      { stop_reason: "tool_use", content: lookups },
      { stop_reason: "tool_use", content: notifyTurn },
      { stop_reason: "end_turn", content: [{ type: "text", text: "```json\n" + JSON.stringify(answer) + "\n```", citations: null }] },
    ];
    const connection = await connectMemory(store);
    try {
      const result = await runAgent(event, { model: model(), connection });
      expect(result.decision.action.recommendation).toEqual(answer);
      expect(result.decision.action.notificationId).toBe(store.outbox[0]!.id);
    } finally {
      await connection.close();
    }

    expect(store.outbox.length).toBe(1);
    expect(store.outbox[0]!.body).not.toContain("proposed");
    // The last request replays both recorded turns as they came, each followed by its results.
    const sent = requests[2]!.messages;
    expect(sent[1]).toEqual({ role: "assistant", content: lookups });
    expect(sent[3]).toEqual({ role: "assistant", content: notifyTurn });
    const queued = (sent[4]!.content as Array<{ tool_use_id: string; content: string; is_error: boolean }>)[0]!;
    expect(queued.tool_use_id).toBe("toolu_n");
    expect(queued.is_error).toBe(false);
    expect(JSON.parse(queued.content)).toMatchObject({ status: "queued", managerId: "e-002" });
  });
});
