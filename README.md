# mood-signal-agent

A proof of concept in TypeScript. When an employee clicks "stressed" on a mood meter, an agent looks up the employee and their manager through MCP tools, then sends the manager a recommendation they can act on today.

## What this is not

Read this first. It is a small demo, not a product.

- **Synthetic data.** The employees, teams and notes are invented and seeded in memory (`src/mcp/data.ts`). No HR system is connected.
- **No auth.** Anyone who can reach the HTTP server can send an event for any employee and read the trace.
- **No persistence.** Nothing is saved. The HTTP server builds a fresh in-memory store for every request, so the outbox is empty again on the next click.
- **No real delivery.** "Notify the manager" appends to an in-memory outbox. No email, chat message or push is sent.
- **No manager, no notification.** An employee with no manager, the top of the tree, has nobody to notify. A `stressed` event for them ends in an error and nothing is sent. The page's picker leaves them out.
- **One scenario.** Only the `stressed` mood starts the agent. The other four moods are echoed back as an event; nothing is stored and no agent runs. An unknown employee id gets a 404 whatever the mood.
- **The Decision seam is unfilled.** Each run produces a `Decision` with `action` filled in and `analysis` and `reflection` left as `null` on purpose (`src/types.ts`). Those are the places for the next iteration.
- **The recommendation is not advice.** Without an API key the agent runs a deterministic stub model that builds its text from the seeded notes. With a key, a live model writes it, and its output is not reviewed by anyone before it reaches the outbox.

## What it shows

1. **An event arrives.** A mood-meter click: `{ employeeId, mood, at }`.
2. **The agent finds the employee.** It calls the `find_employee` MCP tool.
3. **The agent finds the manager.** It calls `find_manager`.
4. **The agent decides to notify the manager.** It calls `notify_manager`. The loop queues that call instead of running it, and the agent returns its recommendation: an approach, a first step, and the rationale behind them.
5. **The loop notifies the manager.** Once the recommendation passes its checks, the loop sends one notification to the manager it confirmed.

Every step is written to a trace. The web page streams that trace as it happens, so you can watch each tool call and its result.

## Run it

You need [Bun](https://bun.sh) 1.x.

```sh
bun install
bun test
bun run serve        # then open http://localhost:3000
```

The tests need no API key and make no network calls.

From the command line, without the web page:

```sh
bun run demo                         # stub model, no key needed
bun run demo --employee e-003        # a specific employee
ANTHROPIC_API_KEY=... bun run demo --live
```

`--live` without `ANTHROPIC_API_KEY` exits with code 2 and says why. The HTTP server goes live on its own when `ANTHROPIC_API_KEY` is set in its environment. A limiter caps live agent runs at 20 per rolling hour, per process, and a run makes at most 8 model calls. Once the 20 runs are spent, the stub answers until the window frees up. The page says which model answered and why.

The MCP server also runs on its own over stdio, for use with any MCP client:

```sh
bun run src/mcp/main.ts
```

With Docker:

```sh
docker build -t mood-signal-agent .
docker run --rm -p 3000:3000 mood-signal-agent
docker run --rm -p 3000:3000 -e ANTHROPIC_API_KEY mood-signal-agent   # live
```

## Own it

Fork it and change anything. It is MIT licensed (`LICENSE`), it has no upstream service, no account and no telemetry on the stub path, and it depends on three runtime packages: `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk` and `zod`. The `--live` path calls the Anthropic Messages API with your own key; that is the one outside dependency, and you can swap the model behind the `Model` interface for any other.

Where each piece lives:

| Path | What it does |
|---|---|
| `src/types.ts` | The shared types. Every module builds against these. |
| `src/recommendation.ts` | The rule for the model's final answer, and its parser. |
| `src/mcp/data.ts` | The seeded employees and the outbox. Replace this with your HR source. |
| `src/mcp/server.ts` | The MCP server and its three tools. |
| `src/mcp/main.ts` | Runs the MCP server over stdio. |
| `src/mcp/connect.ts` | Connects a client in-process (tests, HTTP) or over stdio (demo). |
| `src/agent/prompt.ts` | The system prompt and the user message built from an event. |
| `src/agent/run.ts` | The agent loop. |
| `src/models/stub.ts` | The deterministic model used without a key. |
| `src/models/anthropic.ts` | The live model over the Anthropic Messages API. |
| `src/models/pick.ts` | Chooses live or stub, and says why. |
| `src/ratelimit.ts` | The rolling-window limit on live runs. |
| `src/server.ts` | The HTTP server: the page, the employee list, the event stream. |
| `src/demo.ts` | The command-line demo. |
| `ui/index.html` | The page. One file, no build step, no framework. |
| `test/` | The test suite (`bun test`). |

To connect real data, replace `seedStore()` with a loader for your system and keep the three tool contracts. To deliver for real, change `notify_manager` to send through your own channel.

## How the agent loop works

`runAgent` (`src/agent/run.ts`) gives the model the system prompt, one user message describing the event, and the list of MCP tools. It then runs up to eight turns. On each turn the model either asks for tool calls or returns its final recommendation. Lookup calls go to the MCP server, and their results go back to the model as the next messages. When the run ends, the loop records a `Decision` pointing at the notification it sent.

The model decides, and the loop sends. The model's `notify_manager` call never runs: the model gets a `queued` answer naming the manager the loop confirmed, and the subject and body it proposed are dropped. After the final answer passes its checks, the loop sends one notification to the manager of the event's own employee, looking them up itself if the model did not. The loop writes the body from the approach, the first step and the employee's name. If a check fails, nothing is sent and the run ends in an error. The checks refuse an invalid answer, an answer that names another employee the run looked up, and an employee with no manager.

The final answer must be exactly one JSON object with the keys `approach`, `firstStep` and `rationale` and no others, each a non-empty string. One ```` ```json ```` fence around it is allowed. Text around the object, extra keys or a cut-off object fail the run.

The loop does not know which model it holds. The stub and the live model implement the same `Model` interface (`src/types.ts`), which is how the tests run the whole path with no key.

## Cost

See [COST.md](COST.md).
