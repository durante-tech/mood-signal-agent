/**
 * HTTP server for the demo UI.
 *
 * Limits first: no auth, no persistence, and every POST /api/event gets a
 * fresh in-memory HR store, so notifications do not survive between runs.
 *
 * Routes:
 *   GET  /              the single-file UI (ui/index.html)
 *   GET  /api/health    { ok, live, remaining }
 *   GET  /api/employees the seeded employees who have a manager (id, name, role, team)
 *   POST /api/event     { employeeId, mood } -> text/event-stream of TraceEntry,
 *                       then a named "done" event with { answeredBy, live, reason, store };
 *                       404 for an unknown employeeId, whatever the mood
 */
import { join } from "node:path";
import { runAgent } from "./agent/run.ts";
import { connectMemory } from "./mcp/connect.ts";
import { seedStore } from "./mcp/data.ts";
import { pickModel } from "./models/pick.ts";
import { RollingLimiter } from "./ratelimit.ts";
import type { Mood, MoodEvent, TraceEntry } from "./types.ts";

const MOODS: readonly Mood[] = ["great", "good", "okay", "low", "stressed"];
const UI_PATH = join(import.meta.dir, "..", "ui", "index.html");
const STORE_NOTE = "in-memory store, fresh per request; nothing persists between runs";

/** What the final SSE "done" event carries. */
export interface DoneSummary {
  answeredBy: string | null;
  live: boolean;
  reason: string;
  store: string;
  error?: string;
}

export interface HandlerOptions {
  /** Environment to read the API key from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Limiter for live runs. Defaults to one shared 20-per-hour limiter. */
  limiter?: RollingLimiter;
}

/** One limiter per process: at most 20 live runs in any rolling hour. */
const sharedLimiter = new RollingLimiter(20, 3_600_000);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function sseFrame(data: unknown, event?: string): string {
  const head = event ? `event: ${event}\n` : "";
  return `${head}data: ${JSON.stringify(data)}\n\n`;
}

function sseHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-store": "fresh-per-request",
  };
}

async function readEvent(req: Request): Promise<{ employeeId: string; mood: Mood } | string> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return "body must be JSON";
  }
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const { employeeId, mood } = body as Record<string, unknown>;
  if (typeof employeeId !== "string" || employeeId.length === 0) return "employeeId must be a non-empty string";
  if (typeof mood !== "string" || !MOODS.includes(mood as Mood)) return `mood must be one of ${MOODS.join(", ")}`;
  return { employeeId, mood: mood as Mood };
}

/** A stream that runs `work`, handing it a `send` that is a no-op once the client has gone. */
function sseStream(work: (send: (data: unknown, event?: string) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: unknown, event?: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(data, event)));
        } catch {
          open = false;
        }
      };
      try {
        await work(send);
      } finally {
        if (open) {
          open = false;
          controller.close();
        }
      }
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

async function handleEvent(req: Request, opts: Required<HandlerOptions>): Promise<Response> {
  const parsed = await readEvent(req);
  if (typeof parsed === "string") return json({ error: parsed }, 400);

  const event: MoodEvent = { ...parsed, at: new Date().toISOString() };

  // Every mood names an employee, so an unknown one is a 404 whatever the mood.
  const store = seedStore();
  if (!store.employees.has(event.employeeId)) {
    return json({ error: `unknown employeeId "${event.employeeId}"` }, 404);
  }

  if (event.mood !== "stressed") {
    return sseStream(async (send) => {
      const entry: TraceEntry = { kind: "event", at: event.at, event };
      send(entry);
      const done: DoneSummary = {
        answeredBy: null,
        live: false,
        reason: `mood "${event.mood}" does not trigger the agent; only "stressed" does, so no agent ran`,
        store: STORE_NOTE,
      };
      send(done, "done");
    });
  }

  const connection = await connectMemory(store);

  // Picked only for stressed events, so other moods never spend the live budget.
  const picked = pickModel(opts.env, opts.limiter);

  return sseStream(async (send) => {
    // Set once the model has returned its final answer, so a failure after that
    // point still says which model answered.
    let modelAnswered = false;
    try {
      const result = await runAgent(event, {
        model: picked.model,
        connection,
        onTrace: (entry) => {
          if (entry.kind === "model") modelAnswered = true;
          send(entry);
        },
      });
      const done: DoneSummary = {
        answeredBy: result.answeredBy,
        live: picked.live,
        reason: picked.reason,
        store: STORE_NOTE,
      };
      send(done, "done");
    } catch (err) {
      // runAgent has already emitted an "error" trace entry; the summary repeats it.
      const done: DoneSummary = {
        answeredBy: modelAnswered ? picked.model.name : null,
        live: picked.live,
        reason: picked.reason,
        store: STORE_NOTE,
        error: err instanceof Error ? err.message : String(err),
      };
      send(done, "done");
    } finally {
      await connection.close();
    }
  });
}

/** The fetch handler. Exported so tests can serve it on port 0. */
export function createHandler(options: HandlerOptions = {}): (req: Request) => Promise<Response> {
  const opts: Required<HandlerOptions> = {
    env: options.env ?? process.env,
    limiter: options.limiter ?? sharedLimiter,
  };

  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);

    if (req.method === "GET" && pathname === "/") {
      const file = Bun.file(UI_PATH);
      if (!(await file.exists())) return new Response("ui/index.html not found", { status: 500 });
      return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (req.method === "GET" && pathname === "/api/health") {
      return json({ ok: true, live: Boolean(opts.env.ANTHROPIC_API_KEY), remaining: opts.limiter.remaining() });
    }

    if (req.method === "GET" && pathname === "/api/employees") {
      // Only employees who have a manager: the scenario notifies a manager, so the top of
      // the tree has nobody to notify and is left out of the picker on purpose.
      const employees = [...seedStore().employees.values()]
        .filter((e) => e.managerId !== null)
        .map(({ id, name, role, team }) => ({ id, name, role, team }));
      return json(employees);
    }

    if (pathname === "/api/event") {
      if (req.method !== "POST") return json({ error: "use POST" }, 405);
      return handleEvent(req, opts);
    }

    return json({ error: "not found" }, 404);
  };
}

/** Start the server. Port 0 picks a free port (useful in tests). */
export function startServer(port: number = Number(process.env.PORT ?? 3000), options: HandlerOptions = {}) {
  // A live model turn can take longer than Bun's 10 s default idle timeout.
  return Bun.serve({ port, idleTimeout: 120, fetch: createHandler(options) });
}

if (import.meta.main) {
  const server = startServer();
  const mode = process.env.ANTHROPIC_API_KEY ? "live model available" : "stub model (no ANTHROPIC_API_KEY)";
  console.log(`listening on http://localhost:${server.port} (${mode})`);
}
