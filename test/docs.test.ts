import { describe, expect, test } from "bun:test";

// The README and the loop's header comment are the places a reader learns what
// the loop does and does not check. These tests keep their wording honest.

const root = new URL("..", import.meta.url).pathname;
const readme = await Bun.file(`${root}README.md`).text();
const loopHeader = (await Bun.file(`${root}src/agent/run.ts`).text()).split("import ")[0]!;
const flat = (text: string) => text.replace(/\s*\n\s*\*?\s*/g, " ");

describe("README.md", () => {
  test("states that the loop does not check what the recommendation says", () => {
    expect(readme).toContain(
      "The recommendation text is the model's. The loop validates its shape, confirms the recipient and sends it, and does not check what the text says about whom.",
    );
    expect(readme).not.toContain("names another employee");
  });

  test("states that the loop notifies exactly once whether or not the model called notify_manager", () => {
    expect(readme).toContain(
      "The loop notifies the confirmed manager exactly once after every validated recommendation, whether or not the model called `notify_manager`.",
    );
    expect(readme).toContain("The model's `notify_manager` call is acknowledged as queued and never executed");
    expect(readme).not.toMatch(/model decides|decides to notify/i);
  });

  test("states the per-run request bound as turns, each one request plus up to 2 retries", () => {
    expect(readme).toContain("A run makes at most 8 model turns, each one request plus up to 2 SDK retries on transport errors");
    expect(readme).not.toContain("at most 8 model calls");
  });
});

describe("the agent loop's header comment", () => {
  test("states the notification rule and the limit, and never says the model decides", () => {
    const text = flat(loopHeader);
    expect(text).toContain(
      "The loop notifies the confirmed manager exactly once after every validated recommendation, whether or not the model called notify_manager.",
    );
    expect(text).toContain("notify_manager call is acknowledged as queued and never executed");
    expect(text).toContain("it does not check what the text says about whom.");
    expect(text).not.toMatch(/model decides/i);
    expect(text).not.toContain("name no other employee");
  });
});
