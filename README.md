# mood-signal-agent

A proof of concept in TypeScript. When an employee clicks "stressed" on a mood meter, an agent looks up the employee and their manager through MCP tools, then sends the manager a recommendation they can act on today.

## What this is not

Read this first. It is a small demo, not a product.

- **Synthetic data.** The employees, teams and notes are invented and seeded in memory (`src/mcp/data.ts`). No HR system is connected.
- **No auth.** Anyone who can reach the HTTP server can send an event for any employee and read the trace.
- **No persistence.** Nothing is saved. The HTTP server builds a fresh in-memory store for every request, so the outbox is empty again on the next click.
- **No real delivery.** "Notify the manager" appends to an in-memory outbox. No email, chat message or push is sent.
- **One scenario.** Only the `stressed` mood starts the agent. The other four moods are echoed back as an event; nothing is stored and no agent runs. An unknown employee id gets a 404 whatever the mood.
- **The Decision seam is unfilled.** Each run produces a `Decision` with `action` filled in and `analysis` and `reflection` left as `null` on purpose (`src/types.ts`). Those are the places for the next iteration.
- **The recommendation is not advice.** Without an API key the agent runs a deterministic stub model that builds its text from the seeded notes. With a key, a live model writes it, and its output is not reviewed by anyone before it reaches the outbox.

## What it shows

1. **An event arrives.** A mood-meter click: `{ employeeId, mood, at }`.
2. **The agent finds the employee.** It calls the `find_employee` MCP tool.
3. **The agent finds the manager.** It calls `find_manager`.
4. **The agent notifies the manager.** It calls `notify_manager` with a subject and a body, then returns a recommendation: an approach, a first step, and the rationale behind them.

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

`runAgent` (`src/agent/run.ts`) gives the model the system prompt, one user message describing the event, and the list of MCP tools. It then runs up to eight turns. On each turn the model either asks for tool calls or returns its final recommendation. Tool calls go to the MCP server, and their results go back to the model as the next messages. When the model finishes, the loop records a `Decision` pointing at the notification that was sent.

The loop, not the model, decides whether a notification goes out. A `notify_manager` call runs only when it is addressed to the manager that `find_manager` returned for the event's own employee, and only once per run. Any other `notify_manager` call is not executed: the model gets an error result saying why, and nothing is sent.

If the model finishes without a notification, the loop looks up the event's employee and manager itself, by the event's employee id, and sends the notification with the recommendation's approach as the body, so the manager is always told. The trace shows when that happens.

The live model's final answer must be a JSON object with non-empty `approach`, `firstStep` and `rationale` strings. Anything else fails the run instead of reaching a manager.

The loop does not know which model it holds. The stub and the live model implement the same `Model` interface (`src/types.ts`), which is how the tests run the whole path with no key.

## Cost

See [COST.md](COST.md).
