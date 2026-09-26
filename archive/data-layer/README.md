> **Archived 2026-09-26.** This Postgres data layer is no longer used by the front end. The front end runs against the API contract in `web/API.md` and the requirements in `web/DATA-REQUIREMENTS.md`. The backend (Ryan) will design its own data model. Kept for reference: schema ideas, the DST and time-zone tests, and the transactional patterns (join cap under a row lock, replace-and-merge availability).

# gamenightly

Data layer for the GameNightly web MVP: Postgres schema, transactional write paths, and the matching engine. Spec: `Game Night — MVP Data Model.md` in the GameNight/Archive Drive folder.

## Setup

```bash
brew services start postgresql@17
createdb gamenightly_test
npm install
npm test
```

Apply migrations to another database with `DATABASE_URL=postgres://... npm run migrate`. Set `GAMENIGHTLY_WEBHOOK_KEY` (32 bytes, base64) to encrypt Discord webhook URLs.

## Layout

- `migrations/001_init.sql`: tables, constraints, and the `expires_at` trigger
- `src/sessions.ts`: create, view (with matches), confirm, reopen, cancel
- `src/participants.ts`: join (capped under a row lock) and replace-availability (merged on write)
- `src/matching.ts`: pure matching engine, computed on read
- `src/windows.ts`: turns picked dates plus the "no earlier / no later than" times into UTC windows (DST-safe); shared with the mock API

## Web front end (`web/`)

Vite + React. It talks to the backend only through `web/src/api.ts`, following the contract in [`web/API.md`](web/API.md).

```bash
cd web && npm install
npm run dev        # in-memory mock API (web/mock/server.ts), no database needed
npm run dev:real   # no mock; proxies /api to API_URL (default http://localhost:3000)
```

The mock is dev-only and resets on restart. It reuses `src/matching.ts`, so results match the real engine.
