# What this build cost

Three numbers, all measured on 2026-09-29, from the records of the session that built this repository. Prices are Anthropic's published list prices.

## USD 58.63 to build it

What the AI agents spent building this repository, in tokens, priced at list: twelve agents (builders, reviewers, fixers) plus the session that directed them, 340 model calls in total. The work ran on a subscription seat, so the marginal cost was zero; 58.63 is what the same tokens cost on the API.

## USD 0.04 each time it runs

One click on the demo: the agent looks up the employee and the manager, writes the recommendation, notifies the manager. Three model calls, about seven seconds, four cents.

## About a week, if a person built it

Our estimate, not a measurement: a senior engineer takes 30 to 45 hours for a piece like this (the MCP server, the agent loop, the live model adapter, the page, 62 tests, three review rounds), plus the calendar time of a week. The agents built, reviewed and fixed it; a person directed it.

## What this sheet is not

- Not a quote and not a price.
- Not the cost of the seat: the subscription is a fixed monthly fee, and this build was one of several things it ran that day.
- Not exact to the cent on a re-run: a re-run makes different choices and spends different tokens. The order of magnitude is the claim.

## How it was checked

The build was written against a list of claims, each with the command that would prove it false; every claim closed on the output of that command, re-run by the directing session after the agents reported. Three in-house review passes and three cross-vendor audits ran before the merge. `EVIDENCE.md` in this repository is the public record; the page itself was verified in a real browser, locally and at the deployed address.

## Appendix: the raw numbers

Every assistant message in the session's transcripts, de-duplicated by message id, summed per model, priced at list (input, output, cache write, cache read).

| Tree | Model | Messages | Input | Output | Cache write | Cache read | USD at list |
|---|---|---:|---:|---:|---:|---:|---:|
| loose subagents | claude-opus-5-5 | 87 | 174 | 6,626 | 638,626 | 14,573,818 | $6.24 |
| main loop | claude-fable-5-1 | 132 | 3,668 | 223,226 | 601,372 | 51,547,368 | $36.11 |
| workflow agents | claude-fable-5-1 | 53 | 1,606 | 22,001 | 664,567 | 6,718,226 | $11.10 |
| workflow agents | claude-opus-5-5 | 68 | 136 | 9,054 | 703,391 | 7,394,129 | $5.18 |
| **total** | | 340 | 5,584 | 260,907 | 2,607,956 | 80,233,541 | **$58.63** |

- main loop: the directing session (Claude Fable 5.1).
- workflow agents: four builders, one integrator and one fixer on Claude Opus 5.5; three adversarial verifiers on Claude Fable 5.1.
- loose subagents: three fix rounds on Claude Opus 5.5, one per review round.
- Cross-vendor audits (OpenAI, three): $0.11 each, billed separately. Browser checks: no model tokens.

The live run: 3 requests, 5,051 input tokens, 601 output tokens, 0 cache, $0.04 at list, 7.5 s wall time, read from the page's own done row.

The measurement tool reads the transcripts and prints this table; it lives beside the build's record, and the numbers above are its output at 2026-09-29T21:04Z.
