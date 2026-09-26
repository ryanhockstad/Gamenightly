# GameNightly API

The HTTP API the web front end calls. The storage and rules behind it are in [DATA-REQUIREMENTS.md](DATA-REQUIREMENTS.md).

- **Types:** `web/src/api.ts` is the only front-end module that calls the API.
- **Reference implementation:** `web/mock/core.ts` implements every endpoint and error below. `npm run dev` serves it at `/api` from memory. The test deployment at https://gamenightly.aaglidd.workers.dev runs the same code on Cloudflare, with one Durable Object per session (`web/worker/sessions.ts`).

## Conventions

- **Base path:** `/api`. The front end can point elsewhere with `VITE_API_BASE`. `npm run dev:real` proxies `/api` to `API_URL` (default `http://localhost:3000`).
- **Format:** JSON request and response bodies with snake_case keys.
- **Times:** ISO 8601 UTC strings, e.g. `2026-10-03T02:00:00.000Z`. Time ranges are `[start, end)`.
- **Dates:** `YYYY-MM-DD`, in the organizer's time zone.
- **Time zones:** IANA names, e.g. `America/Los_Angeles`.
- **Slot size:** a fixed 30 minutes (`slot_step_minutes: 30`). Every time the front end sends is on a 30-minute boundary in UTC.
- **Auth:** there are no accounts. Secrets go in `Authorization: Bearer <token>`.
  - **Organizer token:** confirm, reopen and cancel, and joining as the organizer.
  - **Edit token:** saving your own availability.
  - **Where the front end keeps them:** in localStorage, and in URL fragments (`#org=…` for the organizer link, `#p=<id>&t=<token>` for a player's personal link). Fragments are never sent to the server, so tokens stay out of access logs. No cookies are needed.
- **CORS:** if the API is on a different origin from the site, allow the site's origin and the `Authorization` and `Content-Type` headers.

### Errors

Every error response looks like this:

```json
{ "error": { "code": "name_taken", "message": "Someone already has that name. Try another." } }
```

The front end shows `message` to users as-is, so write it in plain language. It branches on `code`:

| code | HTTP | When |
|---|---|---|
| `invalid` | 400 | Validation failed (see each endpoint) |
| `forbidden` | 403 | Wrong or missing organizer or edit token |
| `not_found` | 404 | Unknown or expired session, unknown participant, or `.ics` before confirmation |
| `session_full` | 409 | Joining past `max_participants` |
| `name_taken` | 409 | Display name already in use in this session (case-insensitive) |
| `wrong_status` | 409 | Action not allowed in the current status, e.g. editing after confirmation |

## Endpoints

| Method | Path | Auth | Success |
|---|---|---|---|
| `POST` | `/api/sessions` | none | `201 { public_slug, organizer_token }` |
| `GET` | `/api/s/:slug` | none | `200 SessionView` |
| `POST` | `/api/s/:slug/participants` | optional organizer token | `201 { participant_id, edit_token }` |
| `PUT` | `/api/s/:slug/participants/:id/availability` | edit token | `200 { blocks }` |
| `POST` | `/api/s/:slug/confirm` | organizer token | `204` |
| `POST` | `/api/s/:slug/reopen` | organizer token | `204` |
| `POST` | `/api/s/:slug/cancel` | organizer token | `204` |
| `GET` | `/api/s/:slug/event.ics` | none | `200 text/calendar` |

### `POST /api/sessions`: create a session

```json
{
  "title": "Weekend raid",
  "game": "Helldivers 2",
  "duration_minutes": 120,
  "dates": ["2026-10-02", "2026-10-03"],
  "earliest_minute": 1140,
  "latest_minute": 0,
  "organizer_timezone": "America/Los_Angeles",
  "max_participants": 4,
  "discord_webhook_url": null
}
```

| Field | Rules |
|---|---|
| `title` | Required. Trimmed. 1–100 characters. |
| `game` | Optional. Trimmed. Empty becomes `null`. Up to 100 characters. |
| `duration_minutes` | 30–720. Default 120. Must not exceed the daily window's length. |
| `dates` | 1–14 unique valid dates. Last minus first ≤ 13 days (a 14-day span). |
| `earliest_minute` | "No earlier than", in minutes after local midnight. 0–1439, a multiple of 30. Default 1020 (5 PM). |
| `latest_minute` | "No later than". 0–1439, a multiple of 30. Default 120 (2 AM). If it's ≤ `earliest_minute`, the window ends the next day; equal means 24 hours. |
| `organizer_timezone` | Valid IANA zone. |
| `max_participants` | 2–4, organizer included. Default 4. |
| `discord_webhook_url` | Optional. Must start with `https://discord.com/api/webhooks/` or `https://discordapp.com/api/webhooks/`. Never returned. |

→ `201 { "public_slug": "QWdrL6lDPrA", "organizer_token": "<43-char base64url>" }`

The front end saves the token and goes straight to `/s/:slug`. It builds every link itself, so return only the slug and the token.

### `GET /api/s/:slug`: everything the session page needs

This is public; anyone with the link can call it. It must never include token hashes or the webhook URL. The front end polls it every 15 seconds while the tab is visible, and again after every action.

```json
{
  "public_slug": "QWdrL6lDPrA",
  "title": "Weekend raid",
  "game": "Helldivers 2",
  "duration_minutes": 120,
  "dates": ["2026-10-02", "2026-10-03"],
  "earliest_minute": 1140,
  "latest_minute": 0,
  "windows": [
    { "date": "2026-10-02", "start": "2026-10-03T02:00:00.000Z", "end": "2026-10-03T07:00:00.000Z" },
    { "date": "2026-10-03", "start": "2026-10-04T02:00:00.000Z", "end": "2026-10-04T07:00:00.000Z" }
  ],
  "organizer_timezone": "America/Los_Angeles",
  "slot_step_minutes": 30,
  "max_participants": 4,
  "has_webhook": false,
  "status": "collecting",
  "confirmed_start_utc": null,
  "confirmed_end_utc": null,
  "participants": [
    {
      "id": "8cd443bc-…",
      "display_name": "Aaron",
      "timezone": "America/Los_Angeles",
      "responded": true,
      "blocks": [{ "start": "2026-10-03T02:00:00.000Z", "end": "2026-10-03T05:00:00.000Z" }]
    }
  ],
  "matches": {
    "windows": [
      {
        "first_start": "2026-10-03T03:00:00.000Z",
        "last_start": "2026-10-03T03:00:00.000Z",
        "available_ids": ["8cd443bc-…", "…"],
        "missing_ids": ["…"]
      }
    ],
    "responded_count": 3,
    "max_participants": 4
  }
}
```

What the front end does with each part:

- **`windows`:** builds the paint grid, one column per date and rows only inside that window. It's shown in each viewer's own time zone. How to compute it: DATA-REQUIREMENTS.md, "Daily windows".
- **`participants[].blocks`:** your own blocks fill in your grid. Everyone else's become the overlap heat and the hover lists of who's free. Return the merged blocks, sorted.
- **`participants`:** in join order.
- **`matches`:** ranked best to worst. The front end shows the top 3. How to compute it: DATA-REQUIREMENTS.md, "Matching".
- **`confirmed_start_utc` / `confirmed_end_utc`:** set while `confirmed`. Cleared on reopen. Kept on cancel.

### `POST /api/s/:slug/participants`: join

Body: `{ "display_name": "Ryan", "timezone": "America/New_York" }`. The time zone is detected from the browser.

- **Name:** trimmed, 1–32 characters, unique per session ignoring case (else `name_taken`).
- **Organizer:** if a Bearer organizer token is sent, it must be valid (else `forbidden`), and the participant becomes the organizer. Only one organizer per session (else `invalid`).
- **Status:** allowed only while `collecting` (else `wrong_status`).
- **Capacity:** rejected with `session_full` once `max_participants` have joined. This must hold even when two people join at the same moment.

→ `201 { "participant_id": "…", "edit_token": "…" }`

### `PUT /api/s/:slug/participants/:id/availability`: save your grid

Bearer edit token for that participant (else `forbidden`). Body: `{ "blocks": [{ "start": "…", "end": "…" }] }`.

- **Full replacement:** the body is the participant's complete availability and replaces what's stored. The front end saves automatically about 400 ms after each change, so saves must be idempotent.
- **An empty list is valid.** It means "none of these times work" and still counts as a response.
- **Rules:** each block has `start < end`, both on 30-minute boundaries. After merging overlapping or touching blocks, each must fit inside one daily window (windows that touch count as one). Else `invalid`.
- **Status:** allowed only while `collecting` (else `wrong_status`).
- **Response:** the first save sets the participant's `responded` flag.

→ `200 { "blocks": [...] }`, the merged, sorted set as stored.

### `POST /api/s/:slug/confirm`: lock in a time

Bearer organizer token. Body: `{ "start": "2026-10-03T03:00:00.000Z" }`. The end is `start + duration_minutes`.

- **Status:** only while `collecting` (else `wrong_status`).
- **Slot:** `start` must be on a 30-minute boundary, and the whole slot must fit inside one daily window (else `invalid`). It doesn't have to be one of the returned matches.

→ `204`

### `POST /api/s/:slug/reopen`: reschedule

Bearer organizer token. Only while `confirmed` (else `wrong_status`). Returns the session to `collecting`, clears the confirmed times and keeps everyone's availability. → `204`

### `POST /api/s/:slug/cancel`

Bearer organizer token. Allowed from `collecting` or `confirmed` (else `wrong_status`). Canceled is final: no joins, edits or reopen. The front end then sends the organizer to the create page, prefilled with the old details. → `204`

### `GET /api/s/:slug/event.ics`: calendar file

`404 not_found` unless `confirmed`. Returns a single `VEVENT` with the confirmed start and end in UTC, the summary `"<title> (<game>)"` or just `"<title>"`, and a stable `UID` per session (e.g. `<slug>@gamenightly`).

Headers:

```
Content-Type: text/calendar; charset=utf-8
Content-Disposition: attachment; filename="Weekend raid.ics"; filename*=UTF-8''Weekend%20raid.ics
```

The file must be named after the session title. Strip `\ / : * ? " < > |` and control characters, collapse whitespace, cap at 80 characters, and fall back to `GameNightly event` if nothing is left (same rule as `web/src/filename.ts`). Put an ASCII-only copy in `filename` and the UTF-8 original in `filename*`. The link also sets a `download` name, but browsers ignore it when the API is on another origin, so the header is what counts.
