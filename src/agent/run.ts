/**
 * The agent loop. One mood event in, one Decision out, with a trace entry for
 * every step so a UI can show the work as it happens.
 *
 * The model decides; the loop sends. The model's notify_manager call is its
 * decision that the manager should be told. The loop does not execute it: it
 * answers with a "queued" result naming the manager the loop confirmed for the
 * event's own employee, and ignores the subject and body the model proposed.
 * A second such call gets the same answer.
 *
 * The one notification goes out at the end of the run, and only when all of
 * this holds:
 *   - the model's final answer passes `toRecommendation`;
 *   - the loop has confirmed the event's employee and their manager, with
 *     find_employee and find_manager called on `event.employeeId` (by the model
 *     or, if it did not, by the loop);
 *   - the answer's approach and first step name no other employee the run
 *     looked up.
 * Its body is built by the loop from the approach, the first step and the
 * confirmed employee's name. If any check fails, nothing is sent and the run
 * ends in an error entry. An employee with no manager ends the run the same
 * way, as soon as the loop learns it.
 *
 * The caller owns the MCP connection: runAgent uses it and never closes it.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { toolSpecs } from "../mcp/connect.ts";
import { toRecommendation } from "../recommendation.ts";
import type {
  Decision,
  Employee,
  Model,
  ModelMessage,
  MoodEvent,
  Notification,
  Recommendation,
  RunResult,
  TraceEntry,
} from "../types.ts";
import { SYSTEM_PROMPT, userMessage } from "./prompt.ts";

const MAX_TURNS = 8;

/** The status the loop puts in its answer to the model's notify_manager call. */
export const QUEUED = "queued";

/** True for the loop's answer to a notify_manager call. */
export function isQueuedAnswer(result: unknown): boolean {
  return isRecord(result) && result.status === QUEUED;
}

export async function runAgent(
  event: MoodEvent,
  opts: {
    model: Model;
    connection: { client: Client; close(): Promise<void> };
    onTrace?: (e: TraceEntry) => void;
    now?: () => string;
  },
): Promise<RunResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const trace: TraceEntry[] = [];
  const emit = (e: TraceEntry) => {
    trace.push(e);
    opts.onTrace?.(e);
  };
  const { client } = opts.connection;

  // What lookups for the event's own employee returned. Lookups of anyone else
  // go back to the model and are never used for the notification.
  let employee: Employee | undefined;
  let manager: Employee | undefined;
  // Every employee record any lookup returned, by id, for the name check.
  const seen = new Map<string, Employee>();
  // Tool errors keyed by tool name and arguments: the same failing call is not
  // repeated, while the same tool with other arguments still runs.
  const failures = new Map<string, string>();
  // Set once the loop has confirmed who is notified; reused by every later call.
  let confirmed: { employee: Employee; manager: Employee } | undefined;

  /** Runs one lookup tool, records the trace, and remembers what it returned. */
  const lookup = async (name: string, args: Record<string, unknown>) => {
    const { result, isError } = await callTool(client, name, args);
    emit({ kind: "tool_result", at: now(), name, result, isError });
    if (isError) {
      failures.set(callKey(name, args), describe(result));
      return { result, isError };
    }
    const found = asEmployee(result);
    if (found) seen.set(found.id, found);
    if (found && args.employeeId === event.employeeId) {
      if (name === "find_employee" && found.id === event.employeeId) employee = found;
      if (name === "find_manager") manager = found;
    }
    return { result, isError };
  };

  /** The loop's own lookup on the event's employee, unless the same call already failed. */
  const need = async (name: "find_employee" | "find_manager"): Promise<Employee> => {
    const args = { employeeId: event.employeeId };
    const known = failures.get(callKey(name, args));
    if (known !== undefined) throw new Error(`${name} failed for ${event.employeeId}: ${known}; nothing was sent`);
    emit({ kind: "tool_call", at: now(), name, args });
    const { result, isError } = await lookup(name, args);
    if (isError) throw new Error(`${name} failed for ${event.employeeId}: ${describe(result)}; nothing was sent`);
    const found = name === "find_employee" ? employee : manager;
    if (!found) throw new Error(`${name} returned no employee record for ${event.employeeId}: ${describe(result)}`);
    return found;
  };

  /** The event's employee and their manager, looked up by the loop where the model did not. */
  const confirm = async (): Promise<{ employee: Employee; manager: Employee }> => {
    if (confirmed) return confirmed;
    const who = employee ?? (await need("find_employee"));
    if (who.managerId === null) {
      throw new Error(`employee ${event.employeeId} has no manager, so there is nobody to notify; nothing was sent`);
    }
    const boss = manager ?? (await need("find_manager"));
    if (boss.id !== who.managerId) {
      throw new Error(
        `find_manager returned ${boss.id} for ${event.employeeId}, but their record names ${who.managerId}; nothing was sent`,
      );
    }
    confirmed = { employee: who, manager: boss };
    return confirmed;
  };

  /** One model tool call: notify_manager is queued, anything else runs. */
  const invoke = async (name: string, args: Record<string, unknown>) => {
    emit({ kind: "tool_call", at: now(), name, args });
    if (name !== "notify_manager") return lookup(name, args);
    const { manager: boss } = await confirm();
    const result = {
      status: QUEUED,
      managerId: boss.id,
      message:
        `Not sent yet. One notification to manager ${boss.id} is queued and will be sent after your final answer, ` +
        `built from its approach and first step. The subject and body you proposed are not used. ` +
        `Finish with the JSON answer.`,
    };
    emit({ kind: "tool_result", at: now(), name, result, isError: false });
    return { result: result as unknown, isError: false };
  };

  emit({ kind: "event", at: now(), event });
  try {
    const tools = await toolSpecs(client);
    const messages: ModelMessage[] = [{ role: "user", content: userMessage(event) }];
    let answer: Recommendation | undefined;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const out = await opts.model.turn({ system: SYSTEM_PROMPT, messages, tools });
      if (out.kind === "final") {
        answer = out.recommendation;
        break;
      }
      if (out.calls.length === 0) throw new Error("the model returned neither tool calls nor a final answer");
      messages.push({ role: "assistant", content: JSON.stringify({ tool_calls: out.calls }) });
      for (const call of out.calls) {
        const { result, isError } = await invoke(call.name, call.args);
        messages.push({ role: "tool_result", content: JSON.stringify(result), toolCallId: call.id, isError });
      }
    }
    if (!answer) throw new Error(`the model did not finish within ${MAX_TURNS} turns`);

    let recommendation: Recommendation;
    try {
      recommendation = toRecommendation(answer);
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}; nothing was sent`);
    }
    emit({ kind: "model", at: now(), model: opts.model.name, recommendation });

    const { employee: who, manager: boss } = await confirm();
    const stranger = otherEmployeeNamed(recommendation, [...seen.values()], [who, boss]);
    if (stranger) {
      throw new Error(
        `the final answer names ${stranger.name} (${stranger.id}), who is not ${who.name}, the employee in this event; nothing was sent`,
      );
    }

    const notification = await send(client, boss, who, recommendation);
    emit({ kind: "notification", at: now(), notification });

    const decision: Decision = {
      id: `d-${crypto.randomUUID().slice(0, 8)}`,
      event,
      action: { kind: "notify_manager", notificationId: notification.id, recommendation },
      analysis: null,
      reflection: null,
      decidedAt: now(),
    };
    emit({ kind: "done", at: now(), decision });
    return { decision, trace, answeredBy: opts.model.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ kind: "error", at: now(), message });
    throw err instanceof Error ? err : new Error(message);
  }
}

/** The one send of a run: the loop's own notify_manager call, built from the checked answer. */
async function send(client: Client, manager: Employee, employee: Employee, rec: Recommendation): Promise<Notification> {
  const args = {
    managerId: manager.id,
    subject: `Check in with ${employee.name}`,
    body: [
      `${employee.name} clicked "stressed" on the team mood meter.`,
      "",
      `Approach: ${rec.approach}`,
      "",
      `First step: ${rec.firstStep}`,
    ].join("\n"),
  };
  const { result, isError } = await callTool(client, "notify_manager", args);
  if (isError) throw new Error(`notify_manager failed: ${describe(result)}`);
  const sent = asNotification(result);
  if (!sent || sent.toEmployeeId !== manager.id) {
    throw new Error(`notify_manager returned no notification for ${manager.id}: ${describe(result)}`);
  }
  return sent;
}

/**
 * The first looked-up employee, other than `allowed`, whose full name or first
 * name appears as a whole word in the approach or first step. A first name
 * shared with an allowed person is not checked.
 */
function otherEmployeeNamed(rec: Recommendation, seen: Employee[], allowed: Employee[]): Employee | undefined {
  const allowedIds = new Set(allowed.map((e) => e.id));
  const allowedNames = new Set(allowed.flatMap((e) => [e.name, firstName(e)]));
  const text = `${rec.approach}\n${rec.firstStep}`;
  for (const other of seen) {
    if (allowedIds.has(other.id)) continue;
    const names = [other.name, firstName(other)].filter((n) => n.length > 0 && !allowedNames.has(n));
    if (names.some((n) => containsWord(text, n))) return other;
  }
  return undefined;
}

function firstName(e: Employee): string {
  return e.name.trim().split(/\s+/)[0] ?? "";
}

function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
}

/**
 * Calls an MCP tool and reads its first text block as JSON (raw text if it is
 * not JSON). A thrown call, such as an unknown tool name, becomes an error
 * result so the model can see it and recover.
 */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; isError: boolean }> {
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = Array.isArray(res.content) ? (res.content as Array<{ type: string; text?: string }>) : [];
    const text = content.find((c) => c.type === "text")?.text ?? "";
    let result: unknown = text;
    try {
      result = JSON.parse(text);
    } catch {
      // keep the raw text
    }
    return { result, isError: res.isError === true };
  } catch (err) {
    return { result: { error: err instanceof Error ? err.message : String(err) }, isError: true };
  }
}

/** One key per tool and argument set, independent of key order. */
function callKey(name: string, args: Record<string, unknown>): string {
  return `${name} ${canonical(args)}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** An employee record: string id and name, and a managerId that is a string or null. */
function asEmployee(value: unknown): Employee | undefined {
  if (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.managerId === null || typeof value.managerId === "string")
  ) {
    return value as unknown as Employee;
  }
  return undefined;
}

function asNotification(value: unknown): Notification | undefined {
  if (isRecord(value) && typeof value.id === "string" && typeof value.toEmployeeId === "string") {
    return value as unknown as Notification;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}
