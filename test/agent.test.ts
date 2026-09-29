import { describe, expect, test } from "bun:test";
import { seedStore } from "../src/mcp/data.ts";
import { connectMemory } from "../src/mcp/connect.ts";
import { runAgent } from "../src/agent/run.ts";
import { StubModel } from "../src/models/stub.ts";
import type { Model, ModelMessage, ModelTurn, MoodEvent, Recommendation, TraceEntry } from "../src/types.ts";

const AT = "2026-01-15T09:00:00.000Z";

function setup() {
  const store = seedStore();
  const employee = [...store.employees.values()].find((e) => e.managerId !== null)!;
  const event: MoodEvent = { employeeId: employee.id, mood: "stressed", at: AT };
  return { store, employee, event };
}

function toolCalls(trace: TraceEntry[]): string[] {
  return trace.flatMap((e) => (e.kind === "tool_call" ? [e.name] : []));
}

describe("runAgent with the stub model", () => {
  test("finds the employee, then the manager, then notifies the manager", async () => {
    const { store, employee, event } = setup();
    const connection = await connectMemory(store);
    const seen: TraceEntry[] = [];
    try {
      const result = await runAgent(event, {
        model: new StubModel(),
        connection,
        onTrace: (e: TraceEntry) => seen.push(e),
        now: () => AT,
      });

      expect(toolCalls(result.trace)).toEqual(["find_employee", "find_manager", "notify_manager"]);
      expect(result.trace[0]!.kind).toBe("event");
      expect(result.trace.at(-1)!.kind).toBe("done");
      expect(result.trace.some((e: TraceEntry) => e.kind === "model")).toBe(true);
      expect(result.answeredBy).toBe("stub");

      expect(store.outbox.length).toBe(1);
      const sent = store.outbox[0]!;
      expect(sent.toEmployeeId).toBe(employee.managerId!);
      expect(result.decision.action.kind).toBe("notify_manager");
      expect(result.decision.action.notificationId).toBe(sent.id);
      expect(result.decision.event).toEqual(event);
      expect(result.decision.id).toMatch(/^d-/);
      expect(result.decision.analysis).toBeNull();
      expect(result.decision.reflection).toBeNull();

      const rec = result.decision.action.recommendation;
      expect(rec.approach.length).toBeGreaterThan(0);
      expect(rec.firstStep.length).toBeGreaterThan(0);
      expect(rec.rationale.length).toBeGreaterThan(0);

      // The callback sees the trace as it happens, ending in done.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.at(-1)!.kind).toBe("done");
    } finally {
      await connection.close();
    }
  });

  test("notifies the manager itself when the model finishes without doing so", async () => {
    const { store, employee, event } = setup();
    let turns = 0;
    const quiet: Model = {
      name: "quiet",
      async turn(): Promise<ModelTurn> {
        turns += 1;
        if (turns === 1) {
          return { kind: "tool_calls", calls: [{ id: "c1", name: "find_employee", args: { employeeId: employee.id } }] };
        }
        if (turns === 2) {
          return { kind: "tool_calls", calls: [{ id: "c2", name: "find_manager", args: { employeeId: employee.id } }] };
        }
        return {
          kind: "final",
          recommendation: {
            approach: "Offer a short one-to-one today.",
            firstStep: "Send an invite.",
            rationale: "Test.",
          },
        };
      },
    };
    const connection = await connectMemory(store);
    try {
      const result = await runAgent(event, { model: quiet, connection, now: () => AT });
      expect(toolCalls(result.trace)).toContain("notify_manager");
      expect(result.answeredBy).toBe("quiet");
      expect(store.outbox.length).toBe(1);
      const sent = store.outbox[0]!;
      expect(sent.toEmployeeId).toBe(employee.managerId!);
      expect(sent.subject).toBe(`Check in with ${employee.name}`);
      expect(sent.body).toContain("Offer a short one-to-one today.");
      expect(result.decision.action.notificationId).toBe(sent.id);
    } finally {
      await connection.close();
    }
  });

  test("a model error emits an error entry and rejects", async () => {
    const { store, event } = setup();
    const broken: Model = {
      name: "broken",
      async turn(): Promise<ModelTurn> {
        throw new Error("model unavailable");
      },
    };
    const connection = await connectMemory(store);
    const seen: TraceEntry[] = [];
    try {
      await expect(runAgent(event, { model: broken, connection, onTrace: (e: TraceEntry) => seen.push(e) })).rejects.toThrow();
      expect(seen.some((e) => e.kind === "error")).toBe(true);
      expect(store.outbox.length).toBe(0);
    } finally {
      await connection.close();
    }
  });
});

// Seeded ids used below: e-003 Priya Raman reports to e-002; e-007 Hannah Weber reports to e-006.
const REC: Recommendation = { approach: "Offer a short one-to-one today.", firstStep: "Send an invite.", rationale: "Test." };
type Step = Array<{ name: string; args: Record<string, unknown> }>;

// Plays one list of tool calls per turn, then finishes with REC. Records what it saw each turn.
function scripted(steps: Step[]): Model & { seen: ModelMessage[][] } {
  const seen: ModelMessage[][] = [];
  return {
    name: "scripted",
    seen,
    async turn(input): Promise<ModelTurn> {
      seen.push([...input.messages]);
      const step = steps[seen.length - 1];
      if (!step) return { kind: "final", recommendation: REC };
      return { kind: "tool_calls", calls: step.map((c, i) => ({ id: `t${seen.length}-${i}`, ...c })) };
    },
  };
}

function resultFor(messages: ModelMessage[], id: string): ModelMessage | undefined {
  return messages.find((m) => m.role === "tool_result" && m.toolCallId === id);
}

function calls(trace: TraceEntry[]): Array<{ name: string; args: Record<string, unknown> }> {
  return trace.flatMap((e) => (e.kind === "tool_call" ? [{ name: e.name, args: e.args }] : []));
}

async function run(model: Model, employeeId: string) {
  const store = seedStore();
  const connection = await connectMemory(store);
  try {
    const result = await runAgent({ employeeId, mood: "stressed", at: AT }, { model, connection, now: () => AT });
    return { store, result };
  } finally {
    await connection.close();
  }
}

describe("runAgent is the authority for the notification", () => {
  test("a notify_manager to someone other than the event employee's manager is refused and not executed", async () => {
    const model = scripted([
      [{ name: "find_employee", args: { employeeId: "e-003" } }],
      [{ name: "find_manager", args: { employeeId: "e-003" } }],
      [{ name: "notify_manager", args: { managerId: "e-006", subject: "Wrong", body: "Wrong manager." } }],
      [{ name: "notify_manager", args: { managerId: "e-002", subject: "Right", body: "Right manager." } }],
    ]);
    const { store, result } = await run(model, "e-003");

    expect(store.outbox.map((n) => n.toEmployeeId)).toEqual(["e-002"]);
    const refusal = resultFor(model.seen.at(-1)!, "t3-0")!;
    expect(refusal.isError).toBe(true);
    expect(refusal.content).toContain("manager of employee e-003");
    expect(refusal.content).toContain("find_manager");
    expect(result.trace.filter((e) => e.kind === "notification").length).toBe(1);
    expect(result.decision.action.notificationId).toBe(store.outbox[0]!.id);
  });

  test("a notify_manager before find_manager confirmed the recipient is refused, even with the right id", async () => {
    const store = seedStore();
    const outboxAtTurn: number[] = [];
    let seenLast: ModelMessage[] = [];
    const eager: Model = {
      name: "eager",
      async turn(input): Promise<ModelTurn> {
        outboxAtTurn.push(store.outbox.length);
        seenLast = input.messages;
        if (outboxAtTurn.length === 1) {
          return { kind: "tool_calls", calls: [{ id: "c1", name: "notify_manager", args: { managerId: "e-002", subject: "s", body: "b" } }] };
        }
        return { kind: "final", recommendation: REC };
      },
    };
    const connection = await connectMemory(store);
    try {
      const result = await runAgent({ employeeId: "e-003", mood: "stressed", at: AT }, { model: eager, connection, now: () => AT });
      expect(outboxAtTurn).toEqual([0, 0]);
      expect(resultFor(seenLast, "c1")!.isError).toBe(true);
      // The loop then sends the one notification itself.
      expect(toolCalls(result.trace)).toEqual(["notify_manager", "find_employee", "find_manager", "notify_manager"]);
      expect(store.outbox.length).toBe(1);
      expect(store.outbox[0]!.toEmployeeId).toBe("e-002");
    } finally {
      await connection.close();
    }
  });

  test("a second notify_manager is refused with the first notification's id", async () => {
    const note = { name: "notify_manager", args: { managerId: "e-002", subject: "s", body: "b" } };
    const model = scripted([
      [{ name: "find_employee", args: { employeeId: "e-003" } }],
      [{ name: "find_manager", args: { employeeId: "e-003" } }],
      [note],
      [note],
    ]);
    const { store, result } = await run(model, "e-003");

    expect(store.outbox.map((n) => n.id)).toEqual(["n-1"]);
    const second = resultFor(model.seen.at(-1)!, "t4-0")!;
    expect(second.isError).toBe(true);
    expect(second.content).toContain("already notified, n-1");
    expect(result.decision.action.notificationId).toBe("n-1");
  });

  test("the fallback uses the event's employee even after the model chased someone else", async () => {
    const model = scripted([
      [{ name: "find_employee", args: { employeeId: "e-007" } }],
      [{ name: "find_manager", args: { employeeId: "e-007" } }],
      [{ name: "notify_manager", args: { managerId: "e-006", subject: "s", body: "b" } }],
    ]);
    const { store, result } = await run(model, "e-003");

    expect(store.outbox.length).toBe(1);
    const sent = store.outbox[0]!;
    expect(sent.toEmployeeId).toBe("e-002");
    expect(sent.subject).toBe("Check in with Priya Raman");
    expect(sent.body).toContain(REC.approach);
    expect(calls(result.trace).slice(3)).toEqual([
      { name: "find_employee", args: { employeeId: "e-003" } },
      { name: "find_manager", args: { employeeId: "e-003" } },
      { name: "notify_manager", args: { managerId: "e-002", subject: "Check in with Priya Raman", body: REC.approach } },
    ]);
    expect(result.decision.action.notificationId).toBe(sent.id);
  });

  test("failures are remembered per tool and arguments, so the fallback retries with the event's ids", async () => {
    const model = scripted([
      [{ name: "find_employee", args: { employeeId: "E-003" } }],
      [{ name: "find_manager", args: { employeeId: "e-999" } }],
    ]);
    const { store, result } = await run(model, "e-003");

    expect(calls(result.trace).slice(2).map((c) => [c.name, c.args.employeeId ?? c.args.managerId])).toEqual([
      ["find_employee", "e-003"],
      ["find_manager", "e-003"],
      ["notify_manager", "e-002"],
    ]);
    expect(store.outbox.map((n) => n.toEmployeeId)).toEqual(["e-002"]);
  });

  test("a call that failed with the event's own ids is not repeated by the fallback", async () => {
    // The top of the tree has no manager: the stub's find_manager fails, and the
    // fallback reports that failure instead of calling find_manager again.
    const store = seedStore();
    const connection = await connectMemory(store);
    const seen: TraceEntry[] = [];
    try {
      const run = runAgent(
        { employeeId: "e-001", mood: "stressed", at: AT },
        { model: new StubModel(), connection, onTrace: (e) => seen.push(e), now: () => AT },
      );
      await expect(run).rejects.toThrow(/find_manager failed for e-001/);
      expect(toolCalls(seen)).toEqual(["find_employee", "find_manager"]);
      expect(store.outbox.length).toBe(0);
    } finally {
      await connection.close();
    }
  });
});
