/**
 * The live model: Claude through the Messages API with client-side tools.
 *
 * The agent loop speaks `ModelMessage[]`; this class translates it into the
 * Messages API shape on every turn. The API requires each `tool_result` block
 * to answer a `tool_use` block from the assistant turn right before it, so the
 * class remembers the assistant content it received for every tool-calling
 * turn and sends it back unchanged (thinking blocks included), keyed by the
 * tool_use ids. That keeps the history append-only. A recorded turn is only
 * replayed when its tool_use blocks and the results that follow match one to
 * one; otherwise the turn is rebuilt from the recorded calls.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Model, ModelMessage, ModelTurn, Recommendation, ToolSpec } from "../types.ts";

export const LIVE_MODEL_ID = "claude-sonnet-5-5";

export class AnthropicModel implements Model {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  /** tool_use id -> the call, for rebuilding a turn if its raw content is missing. */
  private readonly calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  /** tool_use id -> index into `turns`. */
  private readonly turnOf = new Map<string, number>();
  /** The assistant content of each tool-calling turn, as the API returned it. */
  private readonly turns: Anthropic.ContentBlockParam[][] = [];

  constructor(apiKey: string, opts: { model?: string; maxTokens?: number } = {}) {
    this.name = opts.model ?? LIVE_MODEL_ID;
    this.maxTokens = opts.maxTokens ?? 600;
    this.client = new Anthropic({ apiKey });
  }

  async turn(input: { system: string; messages: ModelMessage[]; tools: ToolSpec[] }): Promise<ModelTurn> {
    const response = await this.client.messages.create({
      model: this.name,
      max_tokens: this.maxTokens,
      system: input.system,
      messages: this.toApiMessages(input.messages),
      tools: input.tools.map(toApiTool),
      tool_choice: { type: "auto" },
      // Sonnet 5.5's lowest thinking setting: no extended thinking, so the small
      // max_tokens goes to the answer. Other models reject this value.
      ...(this.name === LIVE_MODEL_ID ? { thinking: { type: "between_tools" as const } } : {}),
    });

    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unspecified";
      throw new Error(`the model declined this request (category: ${category})`);
    }
    // A cut-off answer is a fragment, not a recommendation: fail the run rather
    // than send the manager half a sentence or half a JSON object.
    if (response.stop_reason === "max_tokens") {
      throw new Error(`the model ran out of tokens (max_tokens ${this.maxTokens}) before finishing its answer`);
    }

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length > 0) {
      const index = this.turns.push(response.content as Anthropic.ContentBlockParam[]) - 1;
      const calls = toolUses.map((b) => {
        const args = isRecord(b.input) ? b.input : {};
        this.calls.set(b.id, { name: b.name, args });
        this.turnOf.set(b.id, index);
        return { id: b.id, name: b.name, args };
      });
      return { kind: "tool_calls", calls };
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) throw new Error(`the model returned no text and no tool call (stop_reason: ${response.stop_reason})`);
    return { kind: "final", recommendation: parseRecommendation(text) };
  }

  /**
   * user -> user text; tool_result messages -> the assistant turn that asked for
   * them, then one user message holding all of that turn's tool_result blocks.
   * Assistant messages from the loop are markers only: the real assistant turn
   * is the one recorded from the API response.
   */
  private toApiMessages(messages: ModelMessage[]): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];
    let results: Anthropic.ToolResultBlockParam[] = [];
    let currentTurn: number | undefined;

    // Sends the assistant turn that asked for the gathered results, then the results.
    const flush = () => {
      if (results.length > 0) {
        const { assistant, answers } = this.pairTurn(currentTurn, results);
        out.push({ role: "assistant", content: assistant }, { role: "user", content: answers });
      }
      results = [];
      currentTurn = undefined;
    };

    for (const m of messages) {
      if (m.role === "tool_result") {
        const id = m.toolCallId;
        if (!id) throw new Error("a tool_result message has no toolCallId");
        const turn = this.turnOf.get(id);
        if (results.length > 0 && turn !== currentTurn) flush();
        currentTurn = turn;
        results.push({ type: "tool_result", tool_use_id: id, content: m.content, is_error: m.isError ?? false });
      } else if (m.role === "user") {
        flush();
        out.push({ role: "user", content: m.content });
      } else {
        flush();
      }
    }
    flush();
    return out;
  }

  /**
   * The assistant turn to send before `results`, and the results to send after
   * it. The recorded turn goes back unchanged when every tool_use in it has
   * exactly one result here and no result answers anything else. When that
   * does not hold, the turn is rebuilt from the recorded calls: one tool_use
   * per answered id, each answered once, so the API never sees an unanswered
   * or doubly answered tool_use. A rebuilt turn carries no text or thinking
   * blocks.
   */
  private pairTurn(
    turn: number | undefined,
    results: Anthropic.ToolResultBlockParam[],
  ): { assistant: Anthropic.ContentBlockParam[]; answers: Anthropic.ToolResultBlockParam[] } {
    const recorded = turn === undefined ? undefined : this.turns[turn];
    if (recorded && answersEachOnce(recorded, results)) return { assistant: recorded, answers: results };

    const answers: Anthropic.ToolResultBlockParam[] = [];
    const ids = new Set<string>();
    for (const r of results) {
      if (ids.has(r.tool_use_id)) continue;
      ids.add(r.tool_use_id);
      answers.push(r);
    }
    const assistant = answers.map((r): Anthropic.ContentBlockParam => {
      const call = this.calls.get(r.tool_use_id);
      if (!call) throw new Error(`no tool call recorded for tool_use id ${r.tool_use_id}`);
      return { type: "tool_use", id: r.tool_use_id, name: call.name, input: call.args };
    });
    return { assistant, answers };
  }
}

/** True when the tool_use ids in `content` and the result ids match one to one. */
function answersEachOnce(content: Anthropic.ContentBlockParam[], results: Anthropic.ToolResultBlockParam[]): boolean {
  const asked = content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
  const answered = results.map((r) => r.tool_use_id);
  if (asked.length !== answered.length || new Set(answered).size !== answered.length) return false;
  const askedIds = new Set(asked);
  return answered.every((id) => askedIds.has(id));
}

function toApiTool(spec: ToolSpec): Anthropic.Tool {
  // The MCP schema may carry a "$schema" key; the API does not need it.
  const { $schema: _ignored, ...schema } = spec.inputSchema;
  return {
    name: spec.name,
    description: spec.description,
    input_schema: { ...schema, type: "object" },
  };
}

/**
 * Reads {approach, firstStep, rationale} from the model's final text. The
 * object may stand alone, sit in a fenced block, or be surrounded by prose:
 * every balanced {...} in the text is tried in order, and the first one that
 * parses with all three fields as non-empty strings is the answer. Anything
 * else is an error, because a manager should never receive prose nobody
 * checked or half of a JSON object.
 */
export function parseRecommendation(text: string): Recommendation {
  let sawObject = false;
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const end = closingBrace(text, start);
    if (end === -1) continue;
    const value = parseJson(text.slice(start, end + 1));
    if (!isRecord(value)) continue;
    sawObject = true;
    const { approach, firstStep, rationale } = value;
    if (isFilled(approach) && isFilled(firstStep) && isFilled(rationale)) return { approach, firstStep, rationale };
  }
  const found = sawObject ? "no JSON object in it had all three" : "no complete JSON object was found in it";
  throw new Error(
    `the model's final answer must be a JSON object with non-empty "approach", "firstStep" and "rationale" strings; ${found}`,
  );
}

/** Index of the brace that closes the one at `start`, skipping braces inside strings; -1 if none. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
