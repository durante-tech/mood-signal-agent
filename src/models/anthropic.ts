/**
 * The live model: Claude through the Messages API with client-side tools.
 *
 * The agent loop speaks `ModelMessage[]`; this class translates it into the
 * Messages API shape on every turn. The API requires each `tool_result` block
 * to answer a `tool_use` block from the assistant turn right before it, so the
 * class remembers the assistant content it received for every tool-calling
 * turn and sends it back unchanged, keyed by the tool_use ids. That keeps the
 * history append-only. A recorded turn is replayed when its tool_use blocks
 * and the results that follow match one to one, which is the normal case;
 * otherwise the turn is rebuilt from the recorded calls. Extended thinking is
 * off, so a rebuilt turn, which carries only tool_use blocks, is a valid turn.
 */
import Anthropic from "@anthropic-ai/sdk";
import { parseRecommendation } from "../recommendation.ts";
import type { Model, ModelMessage, ModelTurn, ToolSpec } from "../types.ts";

export { parseRecommendation };

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
   * or doubly answered tool_use. A rebuilt turn carries no text blocks.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
