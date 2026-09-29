/**
 * The agent loop. One mood event in, one Decision out, with a trace entry for
 * every step so a UI can show the work as it happens.
 *
 * The loop, not the model, decides whether a notification goes out. A
 * notify_manager call runs only when it is addressed to the manager that
 * find_manager returned for the event's own employee, and only once per run.
 * Any other notify_manager call is refused with an error result the model can
 * read, and nothing is sent. If the model finishes without a notification, the
 * loop looks up the event's employee and manager itself and sends one.
 *
 * The caller owns the MCP connection: runAgent uses it and never closes it.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { toolSpecs } from "../mcp/connect.ts";
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

  // What the loop has confirmed about the event's own employee. Lookups of
  // anyone else go back to the model but are never used for the notification.
  let employee: Employee | undefined;
  let manager: Employee | undefined;
  // The one notification this run sent. It is the only id a Decision may carry.
  let notification: Notification | undefined;
  // Tool errors keyed by tool name and arguments: the same failing call is not
  // repeated, while the same tool with other arguments still runs.
  const failures = new Map<string, string>();

  /** Why a notify_manager call must not run, or undefined when it may. */
  const refusal = (args: Record<string, unknown>): string | undefined => {
    if (notification) {
      return `Not sent: already notified, ${notification.id}. A run sends one notification.`;
    }
    if (!manager || args.managerId !== manager.id) {
      return (
        `Not sent: the recipient must be the manager of employee ${event.employeeId}. ` +
        `Call find_manager with employeeId "${event.employeeId}" first and address notify_manager to the id it returns.`
      );
    }
    return undefined;
  };

  /** Calls one tool, records the trace, and remembers what it confirmed. */
  const invoke = async (name: string, args: Record<string, unknown>) => {
    emit({ kind: "tool_call", at: now(), name, args });
    const refused = name === "notify_manager" ? refusal(args) : undefined;
    if (refused) {
      const result = { error: refused };
      emit({ kind: "tool_result", at: now(), name, result, isError: true });
      return { result: result as unknown, isError: true };
    }

    const { result, isError } = await callTool(client, name, args);
    emit({ kind: "tool_result", at: now(), name, result, isError });
    if (isError) {
      failures.set(callKey(name, args), describe(result));
      return { result, isError };
    }

    const forEvent = args.employeeId === event.employeeId;
    if (name === "find_employee" && forEvent) {
      const found = asEmployee(result);
      if (found?.id === event.employeeId) employee = found;
    }
    if (name === "find_manager" && forEvent) manager = asEmployee(result) ?? manager;
    if (name === "notify_manager") {
      const sent = asNotification(result);
      // The tool says it sent something; without an id there is nothing to
      // record, and sending again could reach the manager twice.
      if (!sent) throw new Error(`notify_manager reported success but returned no notification: ${describe(result)}`);
      notification = sent;
      emit({ kind: "notification", at: now(), notification: sent });
    }
    return { result, isError };
  };

  emit({ kind: "event", at: now(), event });
  try {
    const tools = await toolSpecs(client);
    const messages: ModelMessage[] = [{ role: "user", content: userMessage(event) }];
    let recommendation: Recommendation | undefined;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const out = await opts.model.turn({ system: SYSTEM_PROMPT, messages, tools });
      if (out.kind === "final") {
        recommendation = out.recommendation;
        emit({ kind: "model", at: now(), model: opts.model.name, recommendation });
        break;
      }
      if (out.calls.length === 0) throw new Error("the model returned neither tool calls nor a final answer");
      messages.push({ role: "assistant", content: JSON.stringify({ tool_calls: out.calls }) });
      for (const call of out.calls) {
        const { result, isError } = await invoke(call.name, call.args);
        messages.push({ role: "tool_result", content: JSON.stringify(result), toolCallId: call.id, isError });
      }
    }
    if (!recommendation) throw new Error(`the model did not finish within ${MAX_TURNS} turns`);

    // The manager is always notified: if the model did not do it, the loop
    // does, using the event's own employee id and never anyone the model chose.
    if (!notification) {
      const need = async (name: "find_employee" | "find_manager"): Promise<Employee> => {
        const args = { employeeId: event.employeeId };
        const known = failures.get(callKey(name, args));
        if (known !== undefined) throw new Error(`${name} failed for ${event.employeeId}: ${known}`);
        const { result, isError } = await invoke(name, args);
        if (isError) throw new Error(`${name} failed for ${event.employeeId}: ${describe(result)}`);
        const found = name === "find_employee" ? employee : manager;
        if (!found) throw new Error(`${name} returned no employee record for ${event.employeeId}: ${describe(result)}`);
        return found;
      };
      const who = employee ?? (await need("find_employee"));
      const boss = manager ?? (await need("find_manager"));
      const sent = await invoke("notify_manager", {
        managerId: boss.id,
        subject: `Check in with ${who.name}`,
        body: recommendation.approach,
      });
      if (sent.isError) throw new Error(`notify_manager failed: ${describe(sent.result)}`);
    }
    if (!notification) throw new Error("notify_manager returned no notification");

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

function asEmployee(value: unknown): Employee | undefined {
  if (isRecord(value) && typeof value.id === "string" && typeof value.name === "string") {
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
