import { expect, test } from "bun:test";
import { pickModel } from "../src/models/pick.ts";
import { LIVE_MODEL_ID } from "../src/models/anthropic.ts";

// None of these tests call the network: they only read the chosen model's name.

test("no key picks the stub", () => {
  const picked = pickModel({});
  expect(picked.live).toBe(false);
  expect(picked.reason).toBe("no key");
  expect(picked.model.name).toBe("stub");
});

test("a key with the limiter exhausted picks the stub", () => {
  const picked = pickModel({ ANTHROPIC_API_KEY: "test-key-not-real" }, { take: () => false });
  expect(picked.live).toBe(false);
  expect(picked.reason).toBe("rate limit");
  expect(picked.model.name).toBe("stub");
});

test("a key with the limiter open picks the live model", () => {
  const picked = pickModel({ ANTHROPIC_API_KEY: "test-key-not-real" }, { take: () => true });
  expect(picked.live).toBe(true);
  expect(picked.model.name).toBe(LIVE_MODEL_ID);
});

test("a key with no limiter picks the live model", () => {
  const picked = pickModel({ ANTHROPIC_API_KEY: "test-key-not-real" });
  expect(picked.live).toBe(true);
  expect(picked.model.name).toBe(LIVE_MODEL_ID);
});
