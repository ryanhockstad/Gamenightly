# GameNightly

A when2meet-style scheduler for gaming sessions: the organizer picks dates and a time window, friends paint when they're free, and the group sees where they overlap.

## Layout

- `web/`: the front end (Vite + React), plus a stand-in API until the real backend exists.
  - `web/mock/core.ts`: the stand-in API. Local dev runs it in memory (`mock/server.ts`); Cloudflare runs it in a Worker with one Durable Object per session (`web/worker/index.ts`).
  - [`web/API.md`](web/API.md): the HTTP API the front end calls.
  - [`web/DATA-REQUIREMENTS.md`](web/DATA-REQUIREMENTS.md): what the backend must store, compute and enforce.
  - `web/mock/lib/`: the window and matching logic, which a backend can reuse.
- `archive/data-layer/`: an archived Postgres data layer. The front end doesn't use it; it's kept for reference.

## Run

```bash
cd web && npm install
npm run dev        # front end + mock API
npm run dev:real   # front end only; proxies /api to API_URL (default http://localhost:3000)
```

## Deploy (Cloudflare Workers)

Live test site: https://gamenightly.aaglidd.workers.dev

```bash
cd web
npm run preview:cf   # build and run locally in Cloudflare's runtime (http://localhost:8787)
npm run deploy       # build and deploy (needs `npx wrangler login` once)
```

Config is in `web/wrangler.jsonc`. Sessions are stored in Durable Objects, so they survive redeploys; each one deletes itself 30 days after its last date or confirmed time.
