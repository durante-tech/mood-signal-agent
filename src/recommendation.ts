/**
 * The contract for the model's final answer. The live model's text goes
 * through `parseRecommendation`; the agent loop checks every answer, from any
 * model, with `toRecommendation` before anything is sent.
 */
import type { Recommendation } from "./types.ts";

const FIELDS = ["approach", "firstStep", "rationale"] as const;

const RULE =
  'the final answer must be exactly one JSON object whose only keys are "approach", "firstStep" and "rationale", each a non-empty string';

/** One optional ```json fence around the whole answer. */
const FENCE = /^```json\s*([\s\S]*?)\s*```$/;

/**
 * Reads the model's final text. After trimming and removing one optional
 * ```json fence, the whole text must be one JSON object with exactly the three
 * fields. Prose around the object, extra keys, a second object or a fragment
 * all throw, because a manager should never receive text nobody checked.
 */
export function parseRecommendation(text: string): Recommendation {
  const trimmed = text.trim();
  const body = FENCE.exec(trimmed)?.[1] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error(`${RULE}; the text is not a single JSON value`);
  }
  return toRecommendation(value);
}

/**
 * Checks a value against the answer contract and returns a copy holding only
 * the three fields. Throws with the reason when it does not hold.
 */
export function toRecommendation(value: unknown): Recommendation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${RULE}; got ${Array.isArray(value) ? "an array" : value === null ? "null" : typeof value}`);
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length > 0) throw new Error(`${RULE}; unexpected key(s): ${extra.join(", ")}`);
  for (const field of FIELDS) {
    const v = record[field];
    if (typeof v !== "string" || v.trim().length === 0) throw new Error(`${RULE}; "${field}" is missing or empty`);
  }
  return {
    approach: record.approach as string,
    firstStep: record.firstStep as string,
    rationale: record.rationale as string,
  };
}
