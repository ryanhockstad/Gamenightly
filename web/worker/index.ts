// Cloudflare Worker: serves the built front end (static assets) and the API under /api.
// Each session lives in its own Durable Object, which handles one request at a time,
// so the join cap and save-vs-confirm can't race. A stand-in until the real backend exists.
import { DurableObject } from "cloudflare:workers";
import { expiresAt, handle, newSlug, SLUG_RE, type Session } from "../mock/core.ts";

interface Env {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace<SessionStore>;
}

const notFound = () =>
  Response.json({ error: { code: "not_found", message: "Session not found" } }, { status: 404 });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    // Route to the session's Durable Object; a new session gets a fresh slug.
    const path = url.pathname.slice(4);
    let slug: string;
    if (req.method === "POST" && path === "/sessions") slug = newSlug();
    else {
      const m = path.match(/^\/s\/([^/]+)/);
      if (!m || !SLUG_RE.test(m[1])) return notFound();
      slug = m[1];
    }
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(slug));
    const forwarded = new Request(req);
    forwarded.headers.set("x-session-slug", slug);
    return stub.fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;

export class SessionStore extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const slug = req.headers.get("x-session-slug")!;
    return this.ctx.blockConcurrencyWhile(() =>
      handle(
        req,
        {
          get: async () => this.ctx.storage.get<Session>("session"),
          put: async (s) => {
            await this.ctx.storage.put("session", s);
            await this.ctx.storage.setAlarm(expiresAt(s)); // delete after the retention period
          },
          newSlug: () => slug,
        },
        "/api",
      ),
    );
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
