/**
 * The agent loop. One mood event in, one Decision out, with a trace entry for
 * every step so a UI can show the work as it happens.
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

  // What the tools have told us so far; the fallback notification needs it.
  const seen: { employee?: Employee; manager?: Employee; notification?: Notification } = {};
  const failures = new Map<string, string>();

  /** Calls one tool, records the trace, and remembers what it learned. */
  const invoke = async (name: string, args: Record<string, unknown>) => {
    emit({ kind: "tool_call", at: now(), name, args });
    const { result, isError } = await callTool(client, name, args);
    emit({ kind: "tool_result", at: now(), name, result, isError });
    if (isError) failures.set(name, describe(result));
    else {
      if (name === "find_employee") seen.employee = result as Employee;
      if (name === "find_manager") seen.manager = result as Employee;
      if (name === "notify_manager") {
        seen.notification = result as Notification;
        emit({ kind: "notification", at: now(), notification: seen.notification });
      }
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

    // The manager is always notified: if the model never did it, the agent does.
    if (!seen.notification) {
      const need = async (name: string): Promise<Employee> => {
        const known = failures.get(name);
        if (known) throw new Error(`${name} failed for ${event.employeeId}: ${known}`);
        const { result, isError } = await invoke(name, { employeeId: event.employeeId });
        if (isError) throw new Error(`${name} failed for ${event.employeeId}: ${describe(result)}`);
        return result as Employee;
      };
      const who = seen.employee ?? (await need("find_employee"));
      const boss = seen.manager ?? (await need("find_manager"));
      const sent = await invoke("notify_manager", {
        managerId: boss.id,
        subject: `Check in with ${who.name}`,
        body: recommendation.approach,
      });
      if (sent.isError) throw new Error(`notify_manager failed: ${describe(sent.result)}`);
    }
    const notification = seen.notification;
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

function describe(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}
