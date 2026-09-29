/**
 * The live model: Claude through the Messages API with client-side tools.
 *
 * The agent loop speaks `ModelMessage[]`; this class translates it into the
 * Messages API shape on every turn. The API requires each `tool_result` block
 * to answer a `tool_use` block from the assistant turn right before it, so the
 * class remembers the assistant content it received for every tool-calling
 * turn and sends it back unchanged (thinking blocks included), keyed by the
 * tool_use ids. That keeps the history append-only.
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

    const flush = () => {
      if (results.length > 0) out.push({ role: "user", content: results });
      results = [];
      currentTurn = undefined;
    };

    for (const m of messages) {
      if (m.role === "tool_result") {
        const id = m.toolCallId;
        if (!id) throw new Error("a tool_result message has no toolCallId");
        const turn = this.turnOf.get(id);
        if (results.length === 0 || turn !== currentTurn) {
          flush();
          out.push({ role: "assistant", content: this.assistantContent(id, turn) });
          currentTurn = turn;
        }
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

  private assistantContent(id: string, turn: number | undefined): Anthropic.ContentBlockParam[] {
    const recorded = turn === undefined ? undefined : this.turns[turn];
    if (recorded) return recorded;
    const call = this.calls.get(id);
    if (!call) throw new Error(`no tool call recorded for tool_use id ${id}`);
    return [{ type: "tool_use", id, name: call.name, input: call.args }];
  }
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
 * Reads {approach, firstStep, rationale} from the final text, fenced or not.
 * Well-formed prose with no JSON becomes the approach. Text that starts like a
 * JSON object but does not parse into the three fields is an error, because
 * sending it to a manager would send them a fragment.
 */
export function parseRecommendation(text: string): Recommendation {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const value: unknown = JSON.parse(candidate.slice(start, end + 1));
      if (
        isRecord(value) &&
        typeof value.approach === "string" &&
        typeof value.firstStep === "string" &&
        typeof value.rationale === "string"
      ) {
        return { approach: value.approach, firstStep: value.firstStep, rationale: value.rationale };
      }
    } catch {
      // fall through to the checks below
    }
  }
  // An unclosed fence (a cut-off answer) never matches the regex above, so strip
  // an opening fence before looking at the first character.
  if (candidate.replace(/^\s*```(?:json)?\s*/, "").startsWith("{")) {
    throw new Error("the model's final answer looked like JSON but was not a complete {approach, firstStep, rationale} object");
  }
  return { approach: text, firstStep: "see approach", rationale: "see approach" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
