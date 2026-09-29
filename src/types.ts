/**
 * Shared types for the mood-signal agent. Every module builds against these;
 * nothing else in the repo is a contract.
 */

/** A mood-meter click. `stressed` is the one the agent acts on. */
export type Mood = "great" | "good" | "okay" | "low" | "stressed";

export interface MoodEvent {
  /** The employee who clicked. */
  employeeId: string;
  mood: Mood;
  /** ISO-8601 instant of the click. */
  at: string;
}

export interface Employee {
  id: string;
  name: string;
  role: string;
  team: string;
  /** Employee id of the manager, or null at the top of the tree. */
  managerId: string | null;
  /** Free-text facts an agent may read (tenure, recent load, time zone). */
  notes: string[];
}

export interface Notification {
  id: string;
  toEmployeeId: string;
  subject: string;
  body: string;
  sentAt: string;
}

/** What the model produced for the manager. */
export interface Recommendation {
  /** One paragraph a manager can act on today. */
  approach: string;
  /** The concrete first step, one sentence. */
  firstStep: string;
  /** Why, in the model's words, grounded in the tool results it saw. */
  rationale: string;
}

/**
 * The seam for the next iteration: action, analysis, reflection.
 * The POC fills `action` and leaves the other two as typed nulls on purpose.
 */
export interface Decision {
  id: string;
  event: MoodEvent;
  action: {
    kind: "notify_manager";
    notificationId: string;
    recommendation: Recommendation;
  };
  analysis: null;
  reflection: null;
  decidedAt: string;
}

/** One line of the trace the UI renders as the agent works. */
export type TraceEntry =
  | { kind: "event"; at: string; event: MoodEvent }
  | { kind: "tool_call"; at: string; name: string; args: Record<string, unknown> }
  | { kind: "tool_result"; at: string; name: string; result: unknown; isError: boolean }
  | { kind: "model"; at: string; model: string; recommendation: Recommendation }
  | { kind: "notification"; at: string; notification: Notification }
  | { kind: "done"; at: string; decision: Decision }
  | { kind: "error"; at: string; message: string };

/** A tool as the model sees it: name, description, JSON schema for its input. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a model turn returns: either more tool calls, or a final recommendation. */
export type ModelTurn =
  | { kind: "tool_calls"; calls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
  | { kind: "final"; recommendation: Recommendation };

export interface ModelMessage {
  role: "user" | "assistant" | "tool_result";
  /** For user/assistant: text. For tool_result: the JSON of the result. */
  content: string;
  /** For tool_result: which call this answers. */
  toolCallId?: string;
  /** For tool_result: whether the tool reported an error. */
  isError?: boolean;
}

/**
 * The model behind the agent. `StubModel` (tests, no key) and `AnthropicModel`
 * (live) both implement this; the agent loop never knows which one it holds.
 */
export interface Model {
  readonly name: string;
  /** One turn: given the transcript and the tools, decide to call tools or finish. */
  turn(input: { system: string; messages: ModelMessage[]; tools: ToolSpec[] }): Promise<ModelTurn>;
  /** Tokens spent so far by this model instance, when the model reports them. Absent on the stub. */
  readonly usage?: ModelUsage;
}

/** What a live model reported spending, summed over the requests of one instance. */
export interface ModelUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** The in-process record of what the agent did for one event. */
export interface RunResult {
  decision: Decision;
  trace: TraceEntry[];
  /** Which model answered: "stub" when no key or rate-limited, else the live model name. */
  answeredBy: string;
}
