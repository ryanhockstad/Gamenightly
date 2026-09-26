# GameNightly

A when2meet-style scheduler for gaming sessions: the organizer picks dates and a time window, friends paint when they're free, and the group sees where they overlap.

## Layout

- `web/`: the front end (Vite + React). Runs against an in-memory mock API.
  - [`web/API.md`](web/API.md): the HTTP API the front end calls.
  - [`web/DATA-REQUIREMENTS.md`](web/DATA-REQUIREMENTS.md): what the backend must store, compute and enforce.
  - `web/mock/`: the dev-only mock API. `mock/lib/` holds the window and matching logic, which a backend can reuse.
- `archive/data-layer/`: an archived Postgres data layer. The front end doesn't use it; it's kept for reference.

## Run

```bash
cd web && npm install
npm run dev        # front end + mock API
npm run dev:real   # front end only; proxies /api to API_URL (default http://localhost:3000)
```
