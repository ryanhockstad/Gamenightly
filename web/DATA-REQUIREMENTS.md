# GameNightly: data requirements

What the backend has to store, compute and enforce for the front end to work. It describes what's needed, not how: the database, schema, stack and hosting are Ryan's call. The endpoints are in [API.md](API.md).

**Reference code:**
- **Stand-in API:** `web/mock/core.ts` implements the API. Locally it keeps data in memory. On the Cloudflare test deployment (`web/worker/sessions.ts`), each session is a Durable Object that deletes itself when it expires. Neither version sends Discord notifications.
- **Shared logic:** `web/mock/lib/windows.ts` (daily windows) and `web/mock/lib/matching.ts` (matching) can be copied as-is.
- **Archived Postgres version:** `archive/data-layer/` is no longer used, but it has tested ideas worth borrowing: race-safe joins, DST tests, token hashing.

## Principles

- **The session is the unit.** No accounts, users or groups in the MVP. Everything belongs to one session.
- **Identity is a link plus a secret.** An organizer secret per session and an edit secret per participant, both 32 random bytes. Store only a hash (e.g. SHA-256) and compare in constant time.
- **Store times in UTC.** Time zones (IANA names) are kept only to compute windows and label things; the front end handles each viewer's display.
- **Fixed slot size of 30 minutes,** aligned to UTC. Every stored time is on a 30-minute boundary.
- **Small scale by design.** At most 4 participants and 35 dates of up to 48 slots each. Computing matches on every read is cheap, so there's no need to store them.

## What to store

### Session

| Field | Type / rule | Why the front end needs it |
|---|---|---|
| `public_slug` | Unique, short, random, URL-safe (e.g. 8 random bytes in base64url, 11 chars) | The share link `/s/:slug` |
| organizer secret | Hash only | Confirm, reopen, cancel; organizer join |
| `title` | 1–100 chars | Header, invite text, `.ics` name |
| `game` | Optional, ≤ 100 chars | Header, invite text, `.ics` summary |
| `game_igdb_id` | Optional IGDB game id; null for a typed name | Links the session to a game; prefill on cancel |
| `game_cover_url` | Optional, from IGDB at create time | Cover next to the game name |
| `duration_minutes` | 30–720, default 120 | Match length; confirm end = start + duration |
| `dates` | Set of 1–35 dates (organizer's zone), span ≤ 35 days | Grid columns; prefill on cancel |
| `earliest_minute`, `latest_minute` | 0–1439, multiples of 30; defaults 1020 / 120 | Daily window; prefill on cancel |
| `organizer_timezone` | IANA zone | Window computation; invite text |
| `max_participants` | 2–4, default 4 | Cap, "N of M responded", heat scale (all M free = gold) |
| Discord webhook URL | Optional; encrypted at rest; never returned | Notifications; the API exposes only `has_webhook` |
| `status` | `collecting` \| `confirmed` \| `canceled` | Which controls and banners to show |
| `confirmed_start_utc`, `confirmed_end_utc` | Set together; required while `confirmed` | "Game on" banner, `.ics` |
| `created_at` | timestamp | Metrics (time to confirm) |
| `expires_at` | See "Retention" | Hide old sessions |

### Participant

| Field | Type / rule | Why |
|---|---|---|
| `id` | Opaque id (UUID is fine) | Edit links, match results |
| `display_name` | Trimmed, 1–32 chars, unique per session ignoring case | Roster, match chips, hover lists |
| `timezone` | IANA zone (from the browser) | Default display zone when they return |
| edit secret | Hash only | Saving availability |
| is organizer | At most one per session | Enforce one organizer; not returned |
| `responded_at` | Set on first save (an empty save counts) | `responded` flag, response counts, "all responded" |
| `created_at` | timestamp | Roster order (join order) |

### Availability

For each participant, a set of UTC time ranges `[start, end)`:

- **Replaced whole on every save.** The front end always sends its complete state.
- **Stored merged:** no overlapping or touching ranges per participant, sorted by start.
- **Always valid:** on 30-minute boundaries and inside the session's daily windows (enforced on write).

Any storage works: rows per range, a range type with an overlap constraint, or a JSON array per participant. The API only needs to return each participant's merged list.

### Notifications (backend only)

The front end never calls these, but the product depends on them. When a session has a webhook, post to Discord on these events:

| Event | When | Notes |
|---|---|---|
| `created` | Session created | |
| `all_responded` | Responses reach `max_participants` | Once per session |
| `confirmed` | Confirm | |
| `reminder` | `confirmed_start_utc − lead time` | Default 1 hour (open question). Canceled by reopen or cancel. |
| `rescheduled` | Reopen | |
| `canceled` | Cancel | |

Recommended: write these to an outbox inside the same transaction as the state change, send them from a worker with retries, and make them idempotent per session, event and scheduled time. If Discord answers `404`, the webhook was deleted: stop retrying and clear it. Without a webhook the front end offers a "Copy invite" message instead, so nothing needs storing.

## What to compute

### Daily windows

For each date `d` in `dates`, in `organizer_timezone`:

1. **Start:** `d` at the wall-clock time `earliest_minute`.
2. **End:** if `latest_minute > earliest_minute`, `d` at `latest_minute`. Otherwise it's the next day at `latest_minute`, running past midnight; equal times mean 24 hours.
3. **Snap** start and end to the nearest 30-minute UTC boundary. This only matters for zones with a :45 offset, like Nepal (+5:45).

Set the wall-clock hour and minute directly. Don't add minutes to midnight: on DST days that drifts by an hour, so a 5 PM window would start at 4 PM on the night clocks fall back. The mock's `windows.ts` gets this right and is tested across the US DST change.

Return one window per date as `windows: [{ date, start, end }]`, in date order. For validation, merge windows that touch (e.g. back-to-back 24-hour days) into continuous ranges.

The window must be at least `duration_minutes` long, or creation fails.

### Matching (`matches`)

Let D = `duration_minutes` and step = 30 minutes. Use only participants who have responded.

1. **Candidate starts:** for each merged window, every `s` from the window start to window end − D, in 30-minute steps.
2. **Who's free:** `available(s)` = the responded participants with one merged block covering all of `[s, s + D)`.
3. **Drop** candidates where nobody is available.
4. **Collapse** consecutive candidates (exactly one step apart) with the same available set into `{ first_start, last_start, available_ids, missing_ids }`. `missing_ids` = every joined participant not in `available_ids`, including those who haven't responded.
5. **Sort** by the number available (most first), then by `first_start` (earliest first).
6. **Return** `{ windows, responded_count, max_participants }`.

Worst case is about 35 × 48 candidates × 4 participants, under 7,000 checks. Compute it on each `GET`.

The front end shows the top 3 windows. It uses `first_start`–`last_start` to offer start times, and treats a window as a full match when `available_ids.length == max_participants`.

### Response state

- **`responded`:** `responded_at` is set.
- **`responded_count`:** how many participants have responded.
- **`has_webhook`:** a webhook URL is stored.

## Rules to enforce

### Status

```
collecting ──confirm──▶ confirmed ──reopen──▶ collecting
     │                      │
     └────────cancel────────┴──────────────▶ canceled (final)
```

| Action | Allowed in | Effect |
|---|---|---|
| Join | `collecting` | Adds a participant, subject to the cap |
| Save availability | `collecting` | Replaces blocks; sets `responded_at` on first save |
| Confirm | `collecting` | Sets the confirmed times; queues `confirmed` and `reminder` |
| Reopen | `confirmed` | Clears the confirmed times; **keeps** all availability; cancels the pending reminder; queues `rescheduled` |
| Cancel | `collecting`, `confirmed` | Final; **keeps** the confirmed times (for the notice); cancels the pending reminder; queues `canceled` |

### Concurrency

- **Join cap:** the count-then-insert must be atomic. Two people joining at once must not push past `max_participants` (e.g. lock the session row, or use a conditional insert).
- **Save vs. confirm:** a save must not land after a confirm. Serialize them per session, or re-check the status inside the write.
- **Auto-save bursts:** a player painting quickly sends saves every few hundred milliseconds. Each save is a full replacement, so the last write wins.

### Retention

`expires_at` = 30 days after the later of the last window's end and `confirmed_end_utc`. Recompute it on confirm and reopen. After that time, return `not_found` for the session and all its endpoints; deleting the data can happen later in a background job. Use an exact 30 × 24 hours: date math in the server's time zone can drift by an hour across DST.

## Not needed for the MVP

- **Accounts, profiles, groups, recurring availability.** The PRD rules these out for now. If they come later, a nullable `user_id` on participants and `group_id` on sessions leave room.
- **Stored match results.** Compute them on read.
- **Email.** Discord is the only notification channel.
- **Per-date time ranges.** One earliest/latest pair covers all dates, as in when2meet.

## Open questions

1. **Reminder timing:** the PRD suggests one reminder 1 hour before. Should the organizer be able to change it?
2. **Lost edit links:** can the organizer remove or reset a player who lost theirs?
3. **Live updates:** polling every 15 seconds is enough for the MVP. Server-sent events or a websocket would make the overlap heat update instantly.
