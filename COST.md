# What this build cost

Measured, not estimated. Every number below was read from the transcripts of the session that built this repository, on 2026-09-29, with the command named at the end. Prices are Anthropic's published API list prices per million tokens as of 2026-09-24. The tokens were spent on a Claude subscription seat, so the dollar column is what the same tokens would cost on the API, and the marginal cost on the seat was zero beyond the subscription.

## The build, in tokens and dollars at list price

| Tree | Model | Messages | Input | Output | Cache write | Cache read | USD at list |
|---|---|---:|---:|---:|---:|---:|---:|
| loose subagents | claude-opus-5-5 | 87 | 174 | 6,626 | 638,626 | 14,573,818 | $6.24 |
| main loop | claude-fable-5-1 | 101 | 2,794 | 173,544 | 479,682 | 34,013,212 | $26.80 |
| workflow agents | claude-fable-5-1 | 53 | 1,606 | 22,001 | 664,567 | 6,718,226 | $11.10 |
| workflow agents | claude-opus-5-5 | 68 | 136 | 9,054 | 703,391 | 7,394,129 | $5.18 |
| **total** | | 309 | 4,710 | 211,225 | 2,486,266 | 62,699,385 | **$49.32** |

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

## Time

| Measure | Value |
|---|---:|
| Wall-clock, from the run's start to this measurement | 99 min |
| The operator's typed turns in the pane | 12 |
| The operator's span in the pane, first to last typed turn | 100 min |
| Tests at the measured head | 62, all green |
| Review rounds before this head | 3 in-house passes, 3 cross-vendor audits, 3 fix rounds |

The operator's turns were the direction (what to build, for whom, which decisions), the approvals, and reading the results. The code was written, tested, reviewed and fixed by the agents.

## The live run

The live path (`AnthropicModel`, `claude-sonnet-5-5`) reports its own usage on every run: the demo prints it, the page shows it in the done row, and the SSE `done` event carries it. The one live run for this sheet is pending an API key on the build machine; its usage line lands here when it runs. Until then every run shown was the stub model, which spends no tokens.

## What this is not

- Not a quote and not a price. It is the measured cost of one afternoon's build of one proof of concept.
- Not the whole cost of the seat: the subscription is a fixed monthly fee, and this build was one of several things it ran that day.
- Not reproducible to the cent: a re-run makes different choices and spends different tokens. The order of magnitude is the claim.

## How to re-measure

The session's own transcripts, de-duplicated by message id, summed per model and priced with the published list prices:

```
bun cost-sheet.ts --session <session id> --started <run start, ISO 8601>
```

The tool lives beside the build's record; the numbers above are its output at 2026-09-29T20:39Z.
