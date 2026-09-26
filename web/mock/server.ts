// DEV ONLY: in-memory implementation of web/API.md so the front end runs without a backend.
// Mirrors the data layer's rules closely enough to exercise every UI state. Data resets on restart.
// Ryan's real API replaces this; set VITE_API_BASE or run `vite --mode real` to bypass it.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { computeMatches, mergeBlocks } from "./lib/matching.ts";
import { dayWindows, isIsoDate, windowLengthMinutes, withinWindows, type DayWindow } from "./lib/windows.ts";
import { safeFilename } from "../src/filename.ts";

const MINUTE = 60_000;

interface Participant {
  id: string;
  display_name: string;
  timezone: string;
  is_organizer: boolean;
  edit_hash: string;
  responded_at: Date | null;
  blocks: { start: Date; end: Date }[];
}

interface Session {
  public_slug: string;
  organizer_hash: string;
  title: string;
  game: string | null;
  duration_minutes: number;
  dates: string[];
  earliest_minute: number;
  latest_minute: number;
  windows: DayWindow[];
  search_start_utc: Date;
  search_end_utc: Date;
  organizer_timezone: string;
  slot_step_minutes: number;
  max_participants: number;
  has_webhook: boolean;
  status: "collecting" | "confirmed" | "canceled";
  confirmed_start_utc: Date | null;
  confirmed_end_utc: Date | null;
  participants: Participant[];
}

const sessions = new Map<string, Session>();
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const token = () => randomBytes(32).toString("base64url");

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message);
};

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

function load(slug: string): Session {
  return sessions.get(slug) ?? fail(404, "not_found", "Session not found");
}

function requireOrganizer(s: Session, req: IncomingMessage) {
  const t = bearer(req);
  if (!t || hash(t) !== s.organizer_hash) fail(403, "forbidden", "Invalid organizer link");
}

const aligned = (d: Date, step: number) => d.getTime() % (step * MINUTE) === 0;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function view(s: Session) {
  const m = computeMatches({
    session: {
      durationMinutes: s.duration_minutes,
      slotStepMinutes: s.slot_step_minutes,
      searchStartUtc: s.search_start_utc,
      searchEndUtc: s.search_end_utc,
      maxParticipants: s.max_participants,
    },
    participants: s.participants.map((p) => ({ id: p.id, respondedAt: p.responded_at, blocks: p.blocks })),
  });
  return {
    public_slug: s.public_slug,
    title: s.title,
    game: s.game,
    duration_minutes: s.duration_minutes,
    organizer_timezone: s.organizer_timezone,
    dates: s.dates,
    earliest_minute: s.earliest_minute,
    latest_minute: s.latest_minute,
    windows: s.windows.map((w) => ({ date: w.date, start: iso(w.start), end: iso(w.end) })),
    slot_step_minutes: s.slot_step_minutes,
    max_participants: s.max_participants,
    has_webhook: s.has_webhook,
    status: s.status,
    confirmed_start_utc: iso(s.confirmed_start_utc),
    confirmed_end_utc: iso(s.confirmed_end_utc),
    participants: s.participants.map((p) => ({
      id: p.id,
      display_name: p.display_name,
      timezone: p.timezone,
      responded: p.responded_at !== null,
      blocks: p.blocks.map((b) => ({ start: iso(b.start), end: iso(b.end) })),
    })),
    matches: {
      windows: m.windows.map((w) => ({
        first_start: iso(w.firstStart),
        last_start: iso(w.lastStart),
        available_ids: w.availableIds,
        missing_ids: w.missingIds,
      })),
      responded_count: m.respondedCount,
      max_participants: m.maxParticipants,
    },
  };
}

function validTz(tz: unknown): tz is string {
  if (typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function ics(s: Session): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (t: string) => t.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//GameNightly//MVP//EN",
    "BEGIN:VEVENT",
    `UID:${s.public_slug}@gamenightly`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(s.confirmed_start_utc!)}`,
    `DTEND:${fmt(s.confirmed_end_utc!)}`,
    `SUMMARY:${esc(s.game ? `${s.title} (${s.game})` : s.title)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

type Body = Record<string, unknown>;

type Extra = { type: string; filename?: string };

async function route(method: string, path: string, body: Body, req: IncomingMessage): Promise<[number, unknown, Extra?]> {
  if (method === "POST" && path === "/sessions") {
    const title = String(body.title ?? "").trim();
    if (!title) fail(400, "invalid", "Title is required");
    if (title.length > 100) fail(400, "invalid", "Title must be 100 characters or fewer");
    if (body.game && String(body.game).trim().length > 100) fail(400, "invalid", "Game must be 100 characters or fewer");
    const duration = Number(body.duration_minutes ?? 120);
    const max = Number(body.max_participants ?? 4);
    const earliest = Number(body.earliest_minute ?? 1020);
    const latest = Number(body.latest_minute ?? 120);
    const dates = [...new Set(Array.isArray(body.dates) ? body.dates.map(String) : [])].sort();
    if (!dates.length || !dates.every(isIsoDate)) fail(400, "invalid", "Pick at least one date");
    if (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0]) > 13 * 86_400_000)
      fail(400, "invalid", "Dates must fall within 14 days");
    for (const m of [earliest, latest])
      if (!Number.isInteger(m) || m < 0 || m > 1439 || m % 30 !== 0) fail(400, "invalid", "Times must be on 30-minute steps");
    if (!(duration >= 30 && duration <= 720)) fail(400, "invalid", "Duration must be 30 minutes to 12 hours");
    if (duration > windowLengthMinutes(earliest, latest))
      fail(400, "invalid", "The session is longer than the time window. Widen the window or shorten the session.");
    if (!(max >= 2 && max <= 4)) fail(400, "invalid", "Players must be 2 to 4");
    if (!validTz(body.organizer_timezone)) fail(400, "invalid", "Unknown time zone");
    const windows = dayWindows({
      dates,
      earliestMinute: earliest,
      latestMinute: latest,
      timezone: body.organizer_timezone as string,
      stepMinutes: 30,
    });
    const hook = body.discord_webhook_url ? String(body.discord_webhook_url) : null;
    if (hook && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(hook))
      fail(400, "invalid", "That doesn't look like a Discord webhook URL");

    const orgToken = token();
    const slug = randomBytes(8).toString("base64url");
    sessions.set(slug, {
      public_slug: slug,
      organizer_hash: hash(orgToken),
      title,
      game: body.game ? String(body.game).trim() || null : null,
      duration_minutes: duration,
      dates,
      earliest_minute: earliest,
      latest_minute: latest,
      windows,
      search_start_utc: windows[0].start,
      search_end_utc: windows[windows.length - 1].end,
      organizer_timezone: body.organizer_timezone as string,
      slot_step_minutes: 30,
      max_participants: max,
      has_webhook: !!hook,
      status: "collecting",
      confirmed_start_utc: null,
      confirmed_end_utc: null,
      participants: [],
    });
    return [201, { public_slug: slug, organizer_token: orgToken }];
  }

  const m = path.match(/^\/s\/([^/]+)(\/.*)?$/);
  if (!m) fail(404, "not_found", "No such endpoint");
  const s = load(decodeURIComponent(m![1]));
  const rest = m![2] ?? "";

  if (method === "GET" && rest === "") return [200, view(s)];

  if (method === "GET" && rest === "/event.ics") {
    if (s.status !== "confirmed") fail(404, "not_found", "Session isn't confirmed");
    return [200, ics(s), { type: "text/calendar; charset=utf-8", filename: `${safeFilename(s.title)}.ics` }];
  }

  if (method === "POST" && rest === "/participants") {
    const name = String(body.display_name ?? "").trim();
    if (name.length < 1 || name.length > 32) fail(400, "invalid", "Name must be 1–32 characters");
    if (!validTz(body.timezone)) fail(400, "invalid", "Unknown time zone");
    if (s.status !== "collecting") fail(409, "wrong_status", `This session is ${s.status}`);
    const org = bearer(req);
    if (org !== undefined && hash(org) !== s.organizer_hash) fail(403, "forbidden", "Invalid organizer link");
    if (org && s.participants.some((p) => p.is_organizer)) fail(400, "invalid", "Organizer has already joined");
    if (s.participants.length >= s.max_participants) fail(409, "session_full", "This session is full");
    if (s.participants.some((p) => p.display_name.toLowerCase() === name.toLowerCase()))
      fail(409, "name_taken", "Someone already has that name. Try another.");
    const edit = token();
    const p: Participant = {
      id: randomUUID(),
      display_name: name,
      timezone: body.timezone as string,
      is_organizer: !!org,
      edit_hash: hash(edit),
      responded_at: null,
      blocks: [],
    };
    s.participants.push(p);
    return [201, { participant_id: p.id, edit_token: edit }];
  }

  const av = rest.match(/^\/participants\/([^/]+)\/availability$/);
  if (method === "PUT" && av) {
    const p = s.participants.find((x) => x.id === decodeURIComponent(av[1])) ?? fail(404, "not_found", "Participant not found");
    const t = bearer(req);
    if (!t || hash(t) !== p.edit_hash) fail(403, "forbidden", "Invalid edit link");
    if (s.status !== "collecting") fail(409, "wrong_status", "Availability is locked. The organizer must reopen the session.");
    const raw = Array.isArray(body.blocks) ? (body.blocks as { start: string; end: string }[]) : [];
    const blocks = raw.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    for (const b of blocks) {
      if (!(b.start < b.end) || !aligned(b.start, s.slot_step_minutes) || !aligned(b.end, s.slot_step_minutes))
        fail(400, "invalid", "Blocks must be aligned slots");
    }
    const merged = mergeBlocks(blocks);
    const windows = mergeBlocks(s.windows);
    if (!merged.every((b) => withinWindows(windows, b.start, b.end)))
      fail(400, "invalid", "Availability must be within the session's time windows");
    p.blocks = merged;
    p.responded_at ??= new Date();
    return [200, { blocks: p.blocks.map((b) => ({ start: iso(b.start), end: iso(b.end) })) }];
  }

  if (method === "POST" && rest === "/confirm") {
    requireOrganizer(s, req);
    if (s.status !== "collecting") fail(409, "wrong_status", `This session is ${s.status}`);
    const start = new Date(String(body.start));
    const end = new Date(+start + s.duration_minutes * MINUTE);
    if (isNaN(+start) || !aligned(start, s.slot_step_minutes) || !withinWindows(mergeBlocks(s.windows), start, end))
      fail(400, "invalid", "Start time must be an aligned slot within the session's time windows");
    Object.assign(s, { status: "confirmed", confirmed_start_utc: start, confirmed_end_utc: end });
    return [204, null];
  }

  if (method === "POST" && rest === "/reopen") {
    requireOrganizer(s, req);
    if (s.status !== "confirmed") fail(409, "wrong_status", `This session is ${s.status}`);
    Object.assign(s, { status: "collecting", confirmed_start_utc: null, confirmed_end_utc: null });
    return [204, null];
  }

  if (method === "POST" && rest === "/cancel") {
    requireOrganizer(s, req);
    if (s.status === "canceled") fail(409, "wrong_status", "Already canceled");
    s.status = "canceled";
    return [204, null];
  }

  return fail(404, "not_found", "No such endpoint");
}

/** attachment; ASCII fallback plus RFC 5987 UTF-8 name, so titles with emoji/accents survive. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function readBody(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail(400, "invalid", "Body must be JSON");
  }
}

export function mockApi(): Plugin {
  return {
    name: "gamenightly-mock-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const [status, data, extra] = await route(req.method ?? "GET", url.pathname, await readBody(req), req);
          res.statusCode = status;
          if (status === 204) return res.end();
          res.setHeader("Content-Type", extra?.type ?? "application/json");
          if (extra?.filename) res.setHeader("Content-Disposition", contentDisposition(extra.filename));
          res.end(extra ? String(data) : JSON.stringify(data));
        } catch (err) {
          const e = err instanceof HttpError ? err : new HttpError(500, "invalid", "Mock server error");
          if (!(err instanceof HttpError)) console.error(err);
          res.statusCode = e.status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: e.code, message: e.message } }));
        }
      });
    },
  };
}
