import { expect, test } from "bun:test";
import { RollingLimiter } from "../src/ratelimit.ts";

test("allows max takes per window, refuses the next, and recovers after the window", () => {
  let t = 0;
  const limiter = new RollingLimiter(20, 1_000, () => t);
  expect(limiter.remaining()).toBe(20);
  for (let i = 0; i < 20; i++) expect(limiter.take()).toBe(true);
  expect(limiter.remaining()).toBe(0);
  expect(limiter.take()).toBe(false);

  t = 500;
  expect(limiter.take()).toBe(false);

  t = 1_001;
  expect(limiter.take()).toBe(true);
  expect(limiter.remaining()).toBe(19);
});

test("the window rolls: early takes expire before later ones", () => {
  let t = 0;
  const limiter = new RollingLimiter(2, 1_000, () => t);
  expect(limiter.take()).toBe(true);
  t = 600;
  expect(limiter.take()).toBe(true);
  expect(limiter.take()).toBe(false);
  t = 1_001; // the first take has left the window, the second has not
  expect(limiter.take()).toBe(true);
  expect(limiter.take()).toBe(false);
});
