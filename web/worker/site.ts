// The site Worker ("gamenightly"): serves the built front end and forwards /api/* to the
// sessions Worker over a service binding. Defines no Durable Object, so Cloudflare can create
// preview URLs for its branch builds. Previews share the live session data.
interface Env {
  ASSETS: Fetcher;
  API: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    return url.pathname.startsWith("/api/") ? env.API.fetch(req) : env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
