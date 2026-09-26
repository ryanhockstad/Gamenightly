// DEV ONLY: serves the API from mock/core.ts inside the Vite dev server, with an in-memory store.
// Data resets when the dev server restarts. `npm run dev:real` bypasses it.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { handle, newSlug, type Session, type Store } from "./core.ts";

const sessions = new Map<string, Session>();
const store: Store = {
  get: async (slug) => sessions.get(slug),
  put: async (s) => void sessions.set(s.public_slug, s),
  newSlug,
};

// One request at a time, like a Durable Object, so the join cap can't race.
let queue: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const method = req.method ?? "GET";
  return new Request(`http://localhost${req.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" || !chunks.length ? undefined : Buffer.concat(chunks),
  });
}

export function mockApi(): Plugin {
  return {
    name: "gamenightly-mock-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req: IncomingMessage, res: ServerResponse) => {
        const request = await toRequest(req);
        const response = await serialized(() => handle(request, store));
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    },
  };
}
