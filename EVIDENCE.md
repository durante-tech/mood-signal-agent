# How this was built and checked

This repository was built in one afternoon (2026-09-29) by a fleet of AI agents under one orchestrating session, against a written statement of what "done" means. Each claim below was stated before the code existed, names the check that would prove it false, and was closed only on the output of that check, re-run by the orchestrator itself after the agents reported. The record behind this page (the full statement, the agents' returns, the review rounds, the screenshots and the cost measurement) is kept with the build; this page is the public-safe rendering of it.

## What the build was asked for, verbatim

> A public POC repo of the mood-signal agent, fleet-built through the Workflow tool, plus its measured build cost sheet.

## What must not happen

- No dependency on the builder: exactly three runtime packages, no framework, nothing that phones home. Checked by reading `package.json` and by a search of every file for the builder's names, paths and hosts (one hit allowed: the copyright line in `LICENSE`).
- No real people and no real messages: the directory is invented and the outbox is in memory, reset on every run.
- No notification the loop did not send itself, and never more than one per run.

## Claims and how each was checked

| # | Claim | The check | Result |
|---|---|---|---|
| 1 | The repo stands on bun with strict TypeScript, MIT, and exactly three runtime dependencies. | `bunx tsc --noEmit`; `jq .dependencies package.json` | exit 0; `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `zod` |
| 2 | An MCP server exposes `find_employee`, `find_manager`, `notify_manager` over in-memory data, standalone over stdio or in-process. | `bun test` (server and stdio suites); `bun run src/demo.ts` over stdio | green; the demo prints the three calls and one notification |
| 3 | The agent loop takes a `stressed` event, runs the model over the MCP tools, validates the final answer, and sends the manager one notification; a stub model drives the same loop without a key. | `bun test` (agent suite); `curl -N` over the SSE endpoint | green; the stream carries event, three tool calls, the queued notify, the recommendation, one notification, the decision, done |
| 4 | The live model (Anthropic Messages API, tool use) completes one run and reports its own token usage. | one live run with an API key set; the usage line in the done row | pending: the build machine held no API key at the time of writing; the line lands here when it runs |
| 5 | A single-file page shows the four steps as they happen. | a real Chrome instance driven over DevTools: click `stressed`, read the trace; a full-page screenshot | 11 trace rows, every step green, screenshot kept with the record |
| 6 | Live runs are rate-limited to 20 per rolling hour per process and cheap (`max_tokens` 600); the stub answers otherwise and the page says which answered. | `bun test` (limiter and picker suites); the done row on the page | green; "Answered by: stub (stub model, deterministic), Why: no key" on the key-less deploy |
| 7 | The demo is reachable at a public URL. | `curl` of the page, the health endpoint and one run over the wire; the same browser check against the public URL | 200, `{"ok":true,"live":false,"remaining":20}`, full trace, screenshot kept |
| 8 | `COST.md` carries the measured build cost from the session's own transcripts, priced at published list prices. | the measuring tool's JSON kept with the record; every figure in `COST.md` copied from it | see `COST.md` |
| 9 | This page renders the claims in a public-safe form. | the same search as the "no dependency on the builder" check, over this file | no hit |
| 10 | The README states the limits before the value. | the first section after the title | "What this is not" |
| 11 | The branch went through the ladder: deterministic gates, three in-house review passes, three cross-vendor audits, then a pull request with its own review round. | the gate tables, the review pages and the audit files kept with the record; the pull request | three review rounds found one design flaw each time on the same seam (the notification), fixed by restructuring twice; the pull request carries the head sha |

## What the reviews found, in one paragraph

The first build trusted whatever `notify_manager` call the model made. Review round one showed the recipient was unchecked; the fix bound it to the event. Round two showed the body and the timing were still the model's; the fix moved the send into the loop, once, after the answer validates. Round three showed a lexical guard over the answer's text was an overclaim; it was removed and the limit stated instead. That is the shape of the current code: the model decides what to say, the loop decides who is told and when.

## Who did what

| Role | Model |
|---|---|
| Orchestration, contracts, every re-check, this page | Claude Fable 5.1 |
| Four builders, one integrator, three fix rounds | Claude Opus 5.5 |
| Three adversarial verifiers | Claude Fable 5.1 |
| Three in-house review passes | a panel of Claude Opus 5.5 and OpenAI Codex |
| Three cross-vendor audits | OpenAI gpt-5.6-sol |
| Browser checks | a real Chrome instance, no model |
| Direction, approvals, the send | the operator |
