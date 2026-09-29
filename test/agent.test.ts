import { describe, expect, test } from "bun:test";
import { seedStore } from "../src/mcp/data.ts";
import { connectMemory } from "../src/mcp/connect.ts";
import { runAgent } from "../src/agent/run.ts";
import { StubModel } from "../src/models/stub.ts";
import type { Model, ModelTurn, MoodEvent, TraceEntry } from "../src/types.ts";

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
