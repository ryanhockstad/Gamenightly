// The GameNightly API (web/API.md) as one fetch-style handler. Runs in local dev (Vite
// middleware, in-memory store) and on Cloudflare (Worker + one Durable Object per session).
// A stand-in until the real backend exists; it doesn't send Discord notifications.
import { computeMatches, mergeBlocks } from "./lib/matching.ts";
import { dayWindows, isIsoDate, windowLengthMinutes, withinWindows, type DayWindow } from "./lib/windows.ts";
import { safeFilename } from "../src/filename.ts";
import { gameById, searchGames } from "./games.ts";

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

export interface Session {
  public_slug: string;
  organizer_hash: string;
  title: string;
  game: string | null;
  /** IGDB id when the game was picked from search. Missing on sessions stored before it existed. */
  game_igdb_id?: number | null;
  game_cover_url?: string | null;
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

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomB64url = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const token = () => randomB64url(32);
/** Share-link id: 8 random bytes, 11 URL-safe chars. */
export const newSlug = () => randomB64url(8);
export const SLUG_RE = /^[A-Za-z0-9_-]{11}$/;

async function hash(t: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where sessions live: a Map in local dev, a Durable Object on Cloudflare. */
export interface Store {
  get(slug: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
  /** Slug for a new session. */
  newSlug(): string;
}

/** 30 × 24 h after the later of the last window's end and the confirmed end. */
export function expiresAt(s: Session): number {
  const last = Math.max(s.search_end_utc.getTime(), s.confirmed_end_utc?.getTime() ?? 0);
  return last + 30 * 24 * 60 * MINUTE;
}

export class HttpError extends Error {
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

function bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

async function load(store: Store, slug: string): Promise<Session> {
  const s = await store.get(slug);
  if (!s || Date.now() > expiresAt(s)) return fail(404, "not_found", "Session not found");
  return s;
}

async function requireOrganizer(s: Session, req: Request) {
  const t = bearer(req);
  if (!t || (await hash(t)) !== s.organizer_hash) fail(403, "forbidden", "Invalid organizer link");
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
    game_igdb_id: s.game_igdb_id ?? null,
    game_cover_url: s.game_cover_url ?? null,
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

async function route(method: string, path: string, body: Body, req: Request, store: Store): Promise<[number, unknown, Extra?]> {
  if (method === "GET" && path === "/games/search") {
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
    if (q.length > 100) fail(400, "invalid", "Search must be 100 characters or fewer");
    return [200, { games: q.length < 2 ? [] : searchGames(q) }];
  }

  if (method === "POST" && path === "/sessions") {
    const title = String(body.title ?? "").trim();
    if (!title) fail(400, "invalid", "Title is required");
    if (title.length > 100) fail(400, "invalid", "Title must be 100 characters or fewer");
    if (body.game && String(body.game).trim().length > 100) fail(400, "invalid", "Game must be 100 characters or fewer");
    // A picked game: the name and cover come from the catalog, not the client.
    const picked =
      body.game_igdb_id == null
        ? null
        : (gameById(Number(body.game_igdb_id)) ?? fail(400, "invalid", "That game isn't in the game list. Pick it again or type the name."));
    const duration = Number(body.duration_minutes ?? 120);
    const max = Number(body.max_participants ?? 4);
    const earliest = Number(body.earliest_minute ?? 1020);
    const latest = Number(body.latest_minute ?? 120);
    const dates = [...new Set(Array.isArray(body.dates) ? body.dates.map(String) : [])].sort();
    if (!dates.length || !dates.every(isIsoDate)) fail(400, "invalid", "Pick at least one date");
    if (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0]) > 34 * 86_400_000)
      fail(400, "invalid", "Dates must fall within 35 days");
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
    const slug = store.newSlug();
    if (await store.get(slug)) fail(500, "invalid", "Please try again");
    await store.put({
      public_slug: slug,
      organizer_hash: await hash(orgToken),
      title,
      game: picked ? picked.name : body.game ? String(body.game).trim() || null : null,
      game_igdb_id: picked?.igdb_id ?? null,
      game_cover_url: picked?.cover_url ?? null,
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
  const s = await load(store, decodeURIComponent(m![1]));
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
    if (org !== undefined && (await hash(org)) !== s.organizer_hash) fail(403, "forbidden", "Invalid organizer link");
    if (org && s.participants.some((p) => p.is_organizer)) fail(400, "invalid", "Organizer has already joined");
    if (s.participants.length >= s.max_participants) fail(409, "session_full", "This session is full");
    if (s.participants.some((p) => p.display_name.toLowerCase() === name.toLowerCase()))
      fail(409, "name_taken", "Someone already has that name. Try another.");
    const edit = token();
    const p: Participant = {
      id: crypto.randomUUID(),
      display_name: name,
      timezone: body.timezone as string,
      is_organizer: !!org,
      edit_hash: await hash(edit),
      responded_at: null,
      blocks: [],
    };
    s.participants.push(p);
    await store.put(s);
    return [201, { participant_id: p.id, edit_token: edit }];
  }

  const av = rest.match(/^\/participants\/([^/]+)\/availability$/);
  if (method === "PUT" && av) {
    const p = s.participants.find((x) => x.id === decodeURIComponent(av[1])) ?? fail(404, "not_found", "Participant not found");
    const t = bearer(req);
    if (!t || (await hash(t)) !== p.edit_hash) fail(403, "forbidden", "Invalid edit link");
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
    await store.put(s);
    return [200, { blocks: p.blocks.map((b) => ({ start: iso(b.start), end: iso(b.end) })) }];
  }

  if (method === "POST" && rest === "/confirm") {
    await requireOrganizer(s, req);
    if (s.status !== "collecting") fail(409, "wrong_status", `This session is ${s.status}`);
    const start = new Date(String(body.start));
    const end = new Date(+start + s.duration_minutes * MINUTE);
    if (isNaN(+start) || !aligned(start, s.slot_step_minutes) || !withinWindows(mergeBlocks(s.windows), start, end))
      fail(400, "invalid", "Start time must be an aligned slot within the session's time windows");
    Object.assign(s, { status: "confirmed", confirmed_start_utc: start, confirmed_end_utc: end });
    await store.put(s);
    return [204, null];
  }

  if (method === "POST" && rest === "/reopen") {
    await requireOrganizer(s, req);
    if (s.status !== "confirmed") fail(409, "wrong_status", `This session is ${s.status}`);
    Object.assign(s, { status: "collecting", confirmed_start_utc: null, confirmed_end_utc: null });
    await store.put(s);
    return [204, null];
  }

  if (method === "POST" && rest === "/cancel") {
    await requireOrganizer(s, req);
    if (s.status === "canceled") fail(409, "wrong_status", "Already canceled");
    s.status = "canceled";
    await store.put(s);
    return [204, null];
  }

  return fail(404, "not_found", "No such endpoint");
}

/** attachment; ASCII fallback plus RFC 5987 UTF-8 name, so titles with emoji/accents survive. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function readBody(req: Request): Promise<Body> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return fail(400, "invalid", "Body must be JSON");
  }
}

/** Handle one API request. `base` is the path prefix to strip (e.g. "/api"). */
export async function handle(req: Request, store: Store, base = ""): Promise<Response> {
  try {
    const path = new URL(req.url).pathname.slice(base.length) || "/";
    const [status, data, extra] = await route(req.method, path, await readBody(req), req, store);
    if (status === 204) return new Response(null, { status });
    const headers: Record<string, string> = { "Content-Type": extra?.type ?? "application/json" };
    if (extra?.filename) headers["Content-Disposition"] = contentDisposition(extra.filename);
    return new Response(extra ? String(data) : JSON.stringify(data), { status, headers });
  } catch (err) {
    const e = err instanceof HttpError ? err : new HttpError(500, "invalid", "Server error");
    if (!(err instanceof HttpError)) console.error(err);
    return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  }
}
