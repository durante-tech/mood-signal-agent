/**
 * Command-line demo: one "stressed" click, run end to end over a real stdio
 * MCP server in a child process.
 *
 *   bun run src/demo.ts [--live] [--employee e-003]
 *
 * Without --live it uses the deterministic stub model and needs no key.
 * With --live it calls Claude and needs ANTHROPIC_API_KEY.
 */
import { isQueuedAnswer, runAgent } from "./agent/run.ts";
import { connectStdio } from "./mcp/connect.ts";
import { AnthropicModel } from "./models/anthropic.ts";
import { StubModel } from "./models/stub.ts";
import type { Model, MoodEvent, TraceEntry } from "./types.ts";

function parseArgs(argv: string[]): { live: boolean; employeeId: string } {
  let live = false;
  let employeeId = "e-003";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") live = true;
    else if (arg === "--employee") employeeId = argv[++i] ?? employeeId;
    else if (arg?.startsWith("--employee=")) employeeId = arg.slice("--employee=".length);
  }
  return { live, employeeId };
}

/** One line per trace entry. */
export function formatEntry(e: TraceEntry): string {
  switch (e.kind) {
    case "event":
      return `[event] ${e.event.employeeId} clicked "${e.event.mood}"`;
    case "tool_call":
      return `[tool_call] ${e.name} ${JSON.stringify(e.args)}`;
    case "tool_result":
      return `[tool_result] ${e.name}${e.isError ? " ERROR" : isQueuedAnswer(e.result) ? " QUEUED" : ""} ${JSON.stringify(e.result)}`;
    case "model":
      return `[model] ${e.model}: ${e.recommendation.firstStep}`;
    case "notification":
      return `[notification] ${e.notification.id} to ${e.notification.toEmployeeId}: ${e.notification.subject}`;
    case "done":
      return `[done] decision ${e.decision.id}`;
    case "error":
      return `[error] ${e.message}`;
  }
}

async function main(): Promise<number> {
  const { live, employeeId } = parseArgs(process.argv.slice(2));
  const key = process.env.ANTHROPIC_API_KEY;
  if (live && !key) {
    console.error("--live needs ANTHROPIC_API_KEY in the environment. Run without --live to use the stub model.");
    return 2;
  }
  const model: Model = live && key ? new AnthropicModel(key) : new StubModel();
  const event: MoodEvent = { employeeId, mood: "stressed", at: new Date().toISOString() };

  const connection = await connectStdio();
  try {
    const result = await runAgent(event, {
      model,
      connection,
      onTrace: (e) => console.log(formatEntry(e)),
    });
    console.log(`answered by: ${result.answeredBy}`);
    if (model.usage) console.log(`model usage: ${JSON.stringify(model.usage)}`);
    console.log(JSON.stringify(result.decision, null, 2));
    return 0;
  } catch {
    // runAgent already printed the error entry through onTrace.
    return 1;
  } finally {
    await connection.close();
  }
}

if (import.meta.main) {
  process.exit(await main());
}
