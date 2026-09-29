/**
 * A deterministic stand-in for the live model. It never calls the network.
 * It walks the same four steps a live model is asked to take, reading the
 * tool results back out of the transcript:
 *   turn 1 -> find_employee, turn 2 -> find_manager, turn 3 -> notify_manager,
 *   turn 4 -> final recommendation.
 * If a tool result is an error it stops early and finishes with what it has.
 */
import type { Employee, Model, ModelMessage, ModelTurn, Recommendation, ToolSpec } from "../types.ts";

export class StubModel implements Model {
  readonly name = "stub";

  async turn(input: { system: string; messages: ModelMessage[]; tools: ToolSpec[] }): Promise<ModelTurn> {
    const results = input.messages.filter((m) => m.role === "tool_result");
    const step = results.length + 1;
    const last = results[results.length - 1];
    const employeeId = findEmployeeId(input.messages);

    if (last?.isError) {
      return { kind: "final", recommendation: failed(last.content) };
    }
    if (step === 1) {
      return call(step, "find_employee", { employeeId });
    }
    const employee = asEmployee(results[0]?.content);
    if (step === 2) {
      return call(step, "find_manager", { employeeId });
    }
    const manager = asEmployee(results[1]?.content);
    if (!employee || !manager) {
      return { kind: "final", recommendation: failed("the tool results did not contain an employee and a manager") };
    }
    if (step === 3) {
      return call(step, "notify_manager", {
        managerId: manager.id,
        subject: `Check in with ${employee.name}`,
        body: notificationBody(employee, manager),
      });
    }
    return { kind: "final", recommendation: recommend(employee, manager) };
  }
}

function call(step: number, name: string, args: Record<string, unknown>): ModelTurn {
  return { kind: "tool_calls", calls: [{ id: `stub-${step}-${name}`, name, args }] };
}

/** The user message carries the event as JSON; the employee id is read from there. */
function findEmployeeId(messages: ModelMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const match = /"employeeId":"([^"]+)"/.exec(m.content);
    if (match?.[1]) return match[1];
  }
  return "";
}

function asEmployee(content: string | undefined): Employee | undefined {
  if (!content) return undefined;
  try {
    const value = JSON.parse(content) as Partial<Employee>;
    if (typeof value.id === "string" && typeof value.name === "string") return value as Employee;
  } catch {
    // not JSON: treated as missing
  }
  return undefined;
}

function firstName(e: Employee): string {
  return e.name.split(" ")[0] ?? e.name;
}

function facts(e: Employee): string {
  return e.notes.length > 0 ? e.notes.join(" ") : "No notes on file.";
}

function notificationBody(employee: Employee, manager: Employee): string {
  return [
    `Hi ${firstName(manager)},`,
    `${employee.name} (${employee.role}, ${employee.team}) marked "stressed" on the mood meter.`,
    `What the directory says: ${facts(employee)}`,
    `Suggestion: offer a short private check-in today, ask what would help this week, and be ready to move one deadline.`,
    `The mood click is a signal, not a verdict.`,
  ].join("\n");
}

function recommend(employee: Employee, manager: Employee): Recommendation {
  return {
    approach:
      `${firstName(manager)}, offer ${employee.name} a short, private check-in today. ` +
      `Ask how the week is going and what would make it lighter, listen more than you talk, ` +
      `and agree on one concrete change you can make this week, such as moving a deadline or taking one task off their plate.`,
    firstStep: `Send ${firstName(employee)} a direct message offering 15 minutes today or tomorrow, at a time that suits them.`,
    rationale:
      `${employee.name} clicked "stressed". The directory notes: ${facts(employee)} ` +
      `A quick, low-pressure conversation from their manager is the least intrusive way to find out whether the load needs to change.`,
  };
}

function failed(detail: string): Recommendation {
  return {
    approach: "The agent could not identify the employee and their manager, so no recommendation was made.",
    firstStep: "Check that the employee id in the event exists in the directory.",
    rationale: `A tool reported: ${detail}`,
  };
}
