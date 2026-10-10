// The stand-in API as its own Worker ("gamenightly-sessions"). Each session lives in one Durable
// Object, which handles one request at a time, so the join cap and save-vs-confirm can't race.
// It has no public URL: the site Worker reaches it through a service binding. Kept separate from
// the site because Cloudflare doesn't create preview URLs for Workers that define a Durable Object.
import { DurableObject } from "cloudflare:workers";
import { expiresAt, handle, newSlug, SLUG_RE, type Session, type Store } from "../mock/core.ts";

interface Env {
  SESSIONS: DurableObjectNamespace<SessionStore>;
}

const notFound = () =>
  Response.json({ error: { code: "not_found", message: "Session not found" } }, { status: 404 });

const noStore: Store = {
  get: async () => undefined,
  put: async () => {},
  newSlug,
};

export default {
  /** Expects /api/... paths (forwarded unchanged by the site Worker). */
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/^\/api/, "");
    // Game search doesn't touch a session, so it skips the Durable Objects.
    if (path === "/games/search") return handle(req, noStore, "/api");
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
