# What this build cost

Measured, not estimated. Every number below was read from the transcripts of the session that built this repository, on 2026-09-29, with the command named at the end. Prices are Anthropic's published API list prices per million tokens as of 2026-09-24. The tokens were spent on a Claude subscription seat, so the dollar column is what the same tokens would cost on the API, and the marginal cost on the seat was zero beyond the subscription.

## The build, in tokens and dollars at list price

| Tree | Model | Messages | Input | Output | Cache write | Cache read | USD at list |
|---|---|---:|---:|---:|---:|---:|---:|
| loose subagents | claude-opus-5-5 | 87 | 174 | 6,626 | 638,626 | 14,573,818 | $6.24 |
| main loop | claude-fable-5-1 | 132 | 3,668 | 223,226 | 601,372 | 51,547,368 | $36.11 |
| workflow agents | claude-fable-5-1 | 53 | 1,606 | 22,001 | 664,567 | 6,718,226 | $11.10 |
| workflow agents | claude-opus-5-5 | 68 | 136 | 9,054 | 703,391 | 7,394,129 | $5.18 |
| **total** | | 340 | 5,584 | 260,907 | 2,607,956 | 80,233,541 | **$58.63** |

What the rows are:

- **main loop**: the orchestrating session (Claude Fable 5.1) that scoped the work, wrote the shared types, briefed the builders, re-ran every check itself, drove the review rounds and wrote this file.
- **workflow agents**: nine agents launched in one orchestrated run: four builders with disjoint files, one integrator and one fixer on Claude Opus 5.5, three adversarial verifiers on Claude Fable 5.1.
- **loose subagents**: three fix rounds on Claude Opus 5.5, one per review round.

Cache read is the bulk of the tokens: every agent re-reads the same repository and contracts on each turn, and Anthropic bills a cache read at a tenth of an input token.

## Reviews, priced separately

| Review | Who | Cost |
|---|---|---:|
| Three pre-PR review passes | a panel of Claude Opus 5.5 and OpenAI Codex, each pass one reading of the branch diff | Claude on the seat above; Codex on a Codex subscription (not metered here) |
| Three cross-vendor audits | OpenAI gpt-5.6-sol through the API | $0.11 each, reported by the audit tool |
| Browser verification | a real Chrome instance driven over DevTools, five runs | no model tokens |

## Work

| Measure | Value |
|---|---:|
| Tests at the measured head | 62, all green |
| Review rounds before this head | 3 in-house passes, 3 cross-vendor audits, 3 fix rounds |
| Design decisions taken by the operator | direction, scope, the recipient and body rules, the approvals |

The operator's part was the direction (what to build, for whom, which decisions), the approvals, and reading the results. The code was written, tested, reviewed and fixed by the agents. The elapsed time is kept in the build's own record and is not the point: what changes the economics is the token column above, not the clock.

## The live run

The live path (`AnthropicModel`, `claude-sonnet-5-5`) reports its own usage on every run: the demo prints it, the page shows it in the done row, and the SSE `done` event carries it. One live run of the deployed demo, read from that done row, priced at the same list prices:

| Run | Requests | Input | Output | Cache | USD at list | Wall time |
|---|---:|---:|---:|---:|---:|---:|
| one `stressed` click, employee e-003, deployed page | 3 | 5,051 | 601 | 0 | $0.04 | 7.5 s |

So a run of the finished agent costs about four cents at list price and answers in under ten seconds. The build above is the one-time cost; this row is the running cost.

## What this is not

- Not a quote and not a price. It is the measured token cost of one build of one proof of concept.
- Not the whole cost of the seat: the subscription is a fixed monthly fee, and this build was one of several things it ran that day.
- Not reproducible to the cent: a re-run makes different choices and spends different tokens. The order of magnitude is the claim.

## How to re-measure

The session's own transcripts, de-duplicated by message id, summed per model and priced with the published list prices:

```
bun cost-sheet.ts --session <session id> --started <run start, ISO 8601>
```

The tool lives beside the build's record; the numbers above are its output at 2026-09-29T21:04Z, after the live run and the three review rounds.
