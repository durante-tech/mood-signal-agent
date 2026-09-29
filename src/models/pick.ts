/**
 * Chooses the model for one run: the live model when a key is set and the
 * limiter allows it, otherwise the stub, with the reason.
 */
import type { Model } from "../types.ts";
import { AnthropicModel } from "./anthropic.ts";
import { StubModel } from "./stub.ts";

export function pickModel(
  env: Record<string, string | undefined>,
  limiter?: { take(): boolean },
): { model: Model; live: boolean; reason: string } {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { model: new StubModel(), live: false, reason: "no key" };
  if (limiter && !limiter.take()) return { model: new StubModel(), live: false, reason: "rate limit" };
  const model = new AnthropicModel(key);
  return { model, live: true, reason: `live model ${model.name}` };
}
