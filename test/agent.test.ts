import { describe, expect, test } from "bun:test";
import { seedStore } from "../src/mcp/data.ts";
import { connectMemory } from "../src/mcp/connect.ts";
import { runAgent } from "../src/agent/run.ts";
import { SYSTEM_PROMPT } from "../src/agent/prompt.ts";
import { StubModel } from "../src/models/stub.ts";
import type { Model, ModelMessage, ModelTurn, MoodEvent, Recommendation, TraceEntry } from "../src/types.ts";

// Seeded ids used below: e-001 Marta Oliveira has no manager; e-003 Priya Raman
// reports to e-002 Daniel Okafor; e-007 Hannah Weber reports to e-006.
const AT = "2026-01-15T09:00:00.000Z";
const REC: Recommendation = {
  approach: "Offer a short one-to-one today.",
  firstStep: "Send an invite for this afternoon.",
  rationale: "Test.",
};
const INVALID_ANSWER = /^the final answer must be exactly one JSON object/;

function toolCalls(trace: TraceEntry[]): string[] {
  return trace.flatMap((e) => (e.kind === "tool_call" ? [e.name] : []));
}

function calls(trace: TraceEntry[]): Array<{ name: string; args: Record<string, unknown> }> {
  return trace.flatMap((e) => (e.kind === "tool_call" ? [{ name: e.name, args: e.args }] : []));
}

function kinds(trace: TraceEntry[]): string[] {
  return trace.map((e) => e.kind);
}

function resultFor(messages: ModelMessage[], id: string): ModelMessage | undefined {
  return messages.find((m) => m.role === "tool_result" && m.toolCallId === id);
}

type Step = Array<{ name: string; args: Record<string, unknown> }>;

/**
 * Plays one list of tool calls per turn, then finishes with `final`. Records
 * the messages it saw and the outbox size at the start of each turn.
 */
function scripted(
  steps: Step[],
  final: unknown = REC,
): Model & { seen: ModelMessage[][]; outboxAtTurn: number[]; watch(outbox: unknown[]): void } {
  const seen: ModelMessage[][] = [];
  const outboxAtTurn: number[] = [];
  let outbox: unknown[] = [];
  return {
    name: "scripted",
    seen,
    outboxAtTurn,
    watch(o) {
      outbox = o;
    },
    async turn(input): Promise<ModelTurn> {
      seen.push([...input.messages]);
      outboxAtTurn.push(outbox.length);
      const step = steps[seen.length - 1];
      if (!step) return { kind: "final", recommendation: final as Recommendation };
      return { kind: "tool_calls", calls: step.map((c, i) => ({ id: `t${seen.length}-${i}`, ...c })) };
    },
  };
}

/** Runs one event on a fresh store. Never throws: the error, if any, is returned. */
async function run(model: Model & { watch?(outbox: unknown[]): void }, employeeId: string) {
  const store = seedStore();
  model.watch?.(store.outbox);
  const connection = await connectMemory(store);
  const trace: TraceEntry[] = [];
  try {
    const result = await runAgent(
      { employeeId, mood: "stressed", at: AT },
      { model, connection, now: () => AT, onTrace: (e) => trace.push(e) },
    );
    return { store, trace, result, error: undefined as Error | undefined };
  } catch (err) {
    return { store, trace, result: undefined, error: err as Error };
  } finally {
    await connection.close();
  }
}

const find = (employeeId: string) => [
  { name: "find_employee", args: { employeeId } },
  { name: "find_manager", args: { employeeId } },
];
const notify = (managerId: string, body = "b") => ({ name: "notify_manager", args: { managerId, subject: "s", body } });

describe("runAgent with the stub model", () => {
  test("finds the employee and the manager; the model's notify_manager call is queued, never executed, and the loop sends one notification", async () => {
    const store = seedStore();
    const connection = await connectMemory(store);
    const event: MoodEvent = { employeeId: "e-003", mood: "stressed", at: AT };
    const seen: TraceEntry[] = [];
    try {
      const result = await runAgent(event, { model: new StubModel(), connection, onTrace: (e) => seen.push(e), now: () => AT });

      expect(toolCalls(result.trace)).toEqual(["find_employee", "find_manager", "notify_manager"]);
      const queued = result.trace.find((e) => e.kind === "tool_result" && e.name === "notify_manager");
      expect(queued).toMatchObject({ isError: false, result: { status: "queued", managerId: "e-002" } });
      expect(kinds(result.trace).slice(-3)).toEqual(["model", "notification", "done"]);
      expect(result.trace[0]!.kind).toBe("event");
      expect(result.answeredBy).toBe("stub");

      expect(store.outbox.length).toBe(1);
      const sent = store.outbox[0]!;
      expect(sent.toEmployeeId).toBe("e-002");
      expect(result.decision.action.kind).toBe("notify_manager");
      expect(result.decision.action.notificationId).toBe(sent.id);
      expect(result.decision.event).toEqual(event);
      expect(result.decision.id).toMatch(/^d-/);
      expect(result.decision.analysis).toBeNull();
      expect(result.decision.reflection).toBeNull();

      const rec = result.decision.action.recommendation;
      expect(Object.keys(rec).sort()).toEqual(["approach", "firstStep", "rationale"]);
      expect(sent.body).toContain(rec.approach);
      expect(sent.body).toContain(rec.firstStep);

      // The callback sees the trace as it happens, ending in done.
      expect(seen).toEqual(result.trace);
    } finally {
      await connection.close();
    }
  });

  test("the loop sends the notification regardless: one to the confirmed manager when the model finishes without calling notify_manager", async () => {
    const model = scripted([find("e-003")]);
    const { store, trace, result } = await run(model, "e-003");

    expect(toolCalls(trace)).toEqual(["find_employee", "find_manager"]);
    expect(store.outbox.length).toBe(1);
    const sent = store.outbox[0]!;
    expect(sent.toEmployeeId).toBe("e-002");
    expect(sent.subject).toBe("Check in with Priya Raman");
    expect(result!.decision.action.notificationId).toBe(sent.id);
  });

  test("a model error emits an error entry and rejects", async () => {
    const broken: Model = {
      name: "broken",
      async turn(): Promise<ModelTurn> {
        throw new Error("model unavailable");
      },
    };
    const { store, trace, error } = await run(broken, "e-003");
    expect(error?.message).toBe("model unavailable");
    expect(trace.at(-1)!.kind).toBe("error");
    expect(store.outbox.length).toBe(0);
  });
});

describe("the loop notifies the confirmed manager exactly once after every validated answer; the model's notify_manager call is only queued", () => {
  test("sent exactly once and only after the final answer, even when the model calls notify_manager early and twice", async () => {
    const model = scripted([
      [notify("e-006")], // before any lookup, and addressed to the wrong manager
      find("e-003"),
      [notify("e-002")],
    ]);
    const { store, trace, result } = await run(model, "e-003");

    // Nothing had been sent at the start of any model turn, the final one included.
    expect(model.outboxAtTurn).toEqual([0, 0, 0, 0]);
    expect(store.outbox.map((n) => n.toEmployeeId)).toEqual(["e-002"]);
    expect(trace.filter((e) => e.kind === "notification").length).toBe(1);
    expect(kinds(trace).indexOf("notification")).toBeGreaterThan(kinds(trace).indexOf("model"));
    expect(result!.decision.action.notificationId).toBe(store.outbox[0]!.id);

    // Both notify calls got the same non-error queued answer, naming the confirmed manager.
    const last = model.seen.at(-1)!;
    const first = resultFor(last, "t1-0")!;
    const second = resultFor(last, "t3-0")!;
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.content)).toMatchObject({ status: "queued", managerId: "e-002" });
    const told = JSON.parse(first.content).message as string;
    expect(told).toContain("never executed");
    expect(told).toContain("whether or not notify_manager was called");
    expect(second.content).toBe(first.content);
    expect(second.isError).toBe(false);
  });

  test("the body comes from the validated recommendation and the confirmed employee, never from the model's proposed body", async () => {
    const proposed = "PROPOSED BODY: Hannah Weber needs a week off.";
    const model = scripted([find("e-003"), [notify("e-002", proposed)]]);
    const { store } = await run(model, "e-003");

    expect(store.outbox.length).toBe(1);
    const sent = store.outbox[0]!;
    expect(sent.subject).toBe("Check in with Priya Raman");
    expect(sent.body).toContain("Priya Raman");
    expect(sent.body).toContain(REC.approach);
    expect(sent.body).toContain(REC.firstStep);
    expect(sent.body).not.toContain("PROPOSED");
    expect(sent.body).not.toContain("Hannah");
  });

  test("an invalid final answer sends nothing and ends in an error entry", async () => {
    const invalid: unknown[] = [
      { ...REC, extra: "not allowed" },
      { ...REC, approach: "   " },
      { approach: REC.approach, firstStep: REC.firstStep },
    ];
    for (const answer of invalid) {
      const model = scripted([find("e-003"), [notify("e-002")]], answer);
      const { store, trace, error } = await run(model, "e-003");
      expect(error?.message).toMatch(INVALID_ANSWER);
      expect(error?.message).toContain("nothing was sent");
      expect(store.outbox.length).toBe(0);
      expect(kinds(trace)).not.toContain("notification");
      expect(kinds(trace)).not.toContain("model");
      expect(trace.at(-1)!.kind).toBe("error");
    }
  });

  test("the loop does not check what the text says: an approach about another employee the run looked up is still sent to the confirmed manager", async () => {
    // The text is the model's. The loop validates its shape, confirms the
    // recipient and sends it; it does not check whom the text is about.
    const aboutHannah: Recommendation = { ...REC, approach: "Offer Hannah Weber a short one-to-one today." };
    const model = scripted([[{ name: "find_employee", args: { employeeId: "e-007" } }], find("e-003"), [notify("e-002")]], aboutHannah);
    const { store, trace, result, error } = await run(model, "e-003");

    expect(error).toBeUndefined();
    expect(store.outbox.map((n) => n.toEmployeeId)).toEqual(["e-002"]);
    expect(store.outbox[0]!.subject).toBe("Check in with Priya Raman");
    expect(store.outbox[0]!.body).toContain(aboutHannah.approach);
    expect(kinds(trace).slice(-3)).toEqual(["model", "notification", "done"]);
    expect(result!.decision.action.notificationId).toBe(store.outbox[0]!.id);
  });

  test("a model that chased another employee: the event's employee's manager gets a body naming the event's employee", async () => {
    const model = scripted([find("e-007"), [notify("e-006", "About Hannah Weber.")]]);
    const { store, trace, result } = await run(model, "e-003");

    expect(store.outbox.map((n) => n.toEmployeeId)).toEqual(["e-002"]);
    const sent = store.outbox[0]!;
    expect(sent.body).toContain("Priya Raman");
    expect(sent.body).not.toContain("Hannah");
    // The loop confirmed e-003's manager itself when the model asked to notify.
    expect(calls(trace).slice(2)).toEqual([
      { name: "notify_manager", args: { managerId: "e-006", subject: "s", body: "About Hannah Weber." } },
      { name: "find_employee", args: { employeeId: "e-003" } },
      { name: "find_manager", args: { employeeId: "e-003" } },
    ]);
    expect(JSON.parse(resultFor(model.seen.at(-1)!, "t2-0")!.content)).toMatchObject({ status: "queued", managerId: "e-002" });
    expect(result!.decision.action.notificationId).toBe(sent.id);
  });

  test("an employee with no manager ends the run in an error entry, with an empty outbox", async () => {
    const NO_MANAGER = /^employee e-001 has no manager, so there is nobody to notify; nothing was sent$/;

    // The stub looks both up, finds no manager, and finishes; the loop does not repeat the failed call.
    const stub = await run(new StubModel(), "e-001");
    expect(stub.error?.message).toMatch(NO_MANAGER);
    expect(toolCalls(stub.trace)).toEqual(["find_employee", "find_manager"]);
    expect(stub.trace.at(-1)).toMatchObject({ kind: "error" });
    expect(stub.store.outbox.length).toBe(0);

    // A model that asks to notify first ends the run at that call: there is no second turn.
    const eager = scripted([[notify("e-002")]]);
    const early = await run(eager, "e-001");
    expect(early.error?.message).toMatch(NO_MANAGER);
    expect(eager.seen.length).toBe(1);
    expect(early.store.outbox.length).toBe(0);
    expect(kinds(early.trace)).not.toContain("notification");
  });

  test("failures are remembered per tool and arguments, so the loop still looks up the event's ids", async () => {
    const model = scripted([
      [{ name: "find_employee", args: { employeeId: "E-003" } }],
      [{ name: "find_manager", args: { employeeId: "e-999" } }],
    ]);
    const { store, trace } = await run(model, "e-003");

    expect(calls(trace).slice(2).map((c) => [c.name, c.args.employeeId])).toEqual([
      ["find_employee", "e-003"],
      ["find_manager", "e-003"],
    ]);
    expect(store.outbox.map((n) => n.toEmployeeId)).toEqual(["e-002"]);
  });

  test("a lookup that failed with the event's own id is not repeated", async () => {
    const { store, trace, error } = await run(new StubModel(), "e-999");
    expect(error?.message).toMatch(/^find_employee failed for e-999/);
    expect(toolCalls(trace)).toEqual(["find_employee"]);
    expect(store.outbox.length).toBe(0);
  });
});

describe("the system prompt", () => {
  test("tells the model its notify call is queued and never executed, and the loop sends exactly once regardless", () => {
    expect(SYSTEM_PROMPT).toContain("The call is acknowledged as queued and never executed.");
    expect(SYSTEM_PROMPT).toContain(
      "After every final answer that passes validation, the system notifies the confirmed manager of the employee in the event exactly once, whether or not you called notify_manager.",
    );
    expect(SYSTEM_PROMPT).not.toMatch(/decid/i);
    expect(SYSTEM_PROMPT).not.toContain("should be told");
  });

  test("states that the text is not checked, and still asks for text only about the event's employee", () => {
    expect(SYSTEM_PROMPT).toContain(
      "the system validates the answer's shape (below), confirms the recipient and sends it, and does not check what the text says about whom.",
    );
    expect(SYSTEM_PROMPT).toContain("Write the approach and first step only about the employee in the event");
    expect(SYSTEM_PROMPT).not.toMatch(/names someone else/);
  });

  test("tells the model the final answer is one exact JSON object", () => {
    expect(SYSTEM_PROMPT).toContain("The subject and body you pass to notify_manager are not used.");
    expect(SYSTEM_PROMPT).toContain("The final answer must be exactly one JSON object and nothing else");
    expect(SYSTEM_PROMPT).toContain("No text before or after it, no other keys");
  });
});
