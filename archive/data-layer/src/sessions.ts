import { encryptWebhook, hashToken, newSlug, newToken, tokenMatches } from "./crypto.js";
import { DomainError, withTransaction, type Db, type Tx } from "./db.js";
import { computeMatches, mergeBlocks, type Block, type MatchResult } from "./matching.js";
import { dayWindows, isIsoDate, windowLengthMinutes, withinWindows, type DayWindow } from "./windows.js";

const MINUTE = 60_000;

// PRD open question 3 proposes one reminder 1 hour before start. Not yet organizer-configurable.
export const REMINDER_LEAD_MINUTES = 60;

export type SessionStatus = "collecting" | "confirmed" | "canceled";
export type NotificationType =
  | "created"
  | "all_responded"
  | "confirmed"
  | "reminder"
  | "rescheduled"
  | "canceled";

export interface CreateSessionInput {
  title: string;
  game?: string | null;
  durationMinutes?: number;
  /** YYYY-MM-DD dates in the organizer's zone, spanning at most 14 days. */
  dates: string[];
  /** "No earlier than", minutes after local midnight. Default 1020 (5:00 PM). */
  earliestMinute?: number;
  /** "No later than". At or before earliest = past midnight. Default 120 (2:00 AM). */
  latestMinute?: number;
  organizerTimezone: string;
  slotStepMinutes?: number;
  maxParticipants?: number;
  discordWebhookUrl?: string | null;
}

export interface SessionView {
  id: string;
  publicSlug: string;
  title: string;
  game: string | null;
  durationMinutes: number;
  dates: string[];
  earliestMinute: number;
  latestMinute: number;
  /** One UTC window per date: the only times players can mark and the grid shows. */
  windows: DayWindow[];
  searchStartUtc: Date;
  searchEndUtc: Date;
  organizerTimezone: string;
  slotStepMinutes: number;
  maxParticipants: number;
  hasWebhook: boolean;
  status: SessionStatus;
  confirmedStartUtc: Date | null;
  confirmedEndUtc: Date | null;
  expiresAt: Date;
  participants: {
    id: string;
    displayName: string;
    timezone: string;
    isOrganizer: boolean;
    responded: boolean;
  }[];
  matches: MatchResult;
}

// ---------- validation helpers (shared with participants.ts) ----------

export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new DomainError("invalid", `Unknown time zone: ${tz}`);
  }
}

export function isAligned(d: Date, stepMinutes: number): boolean {
  return d.getTime() % (stepMinutes * MINUTE) === 0;
}

const WEBHOOK_PREFIXES = ["https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/"];

/** Map constraint violations to domain errors; rethrow anything else. */
export function mapPgError(err: unknown): never {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === "23514" || e.code === "23P01") throw new DomainError("invalid", e.message ?? "invalid");
  if (e.code === "23505" && e.constraint === "participants_session_name_uniq")
    throw new DomainError("name_taken", "That name is already taken in this session");
  throw err;
}

// ---------- row loading ----------

export interface SessionRow {
  id: string;
  public_slug: string;
  organizer_token_hash: string;
  title: string;
  game: string | null;
  duration_minutes: number;
  search_start_utc: Date;
  search_end_utc: Date;
  organizer_timezone: string;
  dates: string[];
  earliest_minute: number;
  latest_minute: number;
  slot_step_minutes: number;
  max_participants: number;
  has_webhook: boolean;
  status: SessionStatus;
  confirmed_start_utc: Date | null;
  confirmed_end_utc: Date | null;
  expires_at: Date;
}

const SESSION_COLS = `id, public_slug, organizer_token_hash, title, game, duration_minutes,
  search_start_utc, search_end_utc, organizer_timezone, array(select to_char(d, 'YYYY-MM-DD') from unnest(dates) d order by d) as dates, earliest_minute, latest_minute,
  slot_step_minutes, max_participants, discord_webhook_url_enc is not null as has_webhook,
  status, confirmed_start_utc, confirmed_end_utc, expires_at`;

/** The session's daily windows (UTC), from its dates and earliest/latest times. */
export function sessionWindows(s: SessionRow): DayWindow[] {
  return dayWindows({
    dates: s.dates,
    earliestMinute: s.earliest_minute,
    latestMinute: s.latest_minute,
    timezone: s.organizer_timezone,
    stepMinutes: s.slot_step_minutes,
  });
}

/** Loads a live (unexpired) session by slug. With `lock`, takes a row lock for the transaction. */
export async function loadSession(q: Db | Tx, slug: string, lock = false): Promise<SessionRow> {
  const { rows } = await q.query<SessionRow>(
    `select ${SESSION_COLS} from sessions
     where public_slug = $1 and expires_at > now()${lock ? " for update" : ""}`,
    [slug],
  );
  if (!rows[0]) throw new DomainError("not_found", "Session not found");
  return rows[0];
}

async function loadForOrganizer(tx: Tx, slug: string, organizerToken: string): Promise<SessionRow> {
  const s = await loadSession(tx, slug, true);
  if (!tokenMatches(organizerToken, s.organizer_token_hash))
    throw new DomainError("forbidden", "Invalid organizer token");
  return s;
}

/** Enqueue a notification. No-op when the session has no webhook; idempotent on (session, type, time). */
export async function enqueue(tx: Tx, sessionId: string, type: NotificationType, scheduledFor: Date) {
  await tx.query(
    `insert into notification_outbox (session_id, type, scheduled_for)
     select id, $2, $3 from sessions where id = $1 and discord_webhook_url_enc is not null
     on conflict do nothing`,
    [sessionId, type, scheduledFor],
  );
}

async function cancelPendingReminders(tx: Tx, sessionId: string) {
  await tx.query(
    `update notification_outbox set canceled_at = now()
     where session_id = $1 and type = 'reminder' and sent_at is null and canceled_at is null`,
    [sessionId],
  );
}

// ---------- public API ----------

export async function createSession(
  db: Db,
  input: CreateSessionInput,
): Promise<{ sessionId: string; publicSlug: string; organizerToken: string }> {
  const title = input.title.trim();
  if (!title) throw new DomainError("invalid", "Title is required");
  assertTimezone(input.organizerTimezone);
  const step = input.slotStepMinutes ?? 30;
  const earliest = input.earliestMinute ?? 1020;
  const latest = input.latestMinute ?? 120;
  const duration = input.durationMinutes ?? 120;
  const dates = [...new Set(input.dates)].sort();
  if (dates.length === 0 || !dates.every(isIsoDate)) throw new DomainError("invalid", "Pick at least one date");
  if (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0]) > 13 * 86_400_000)
    throw new DomainError("invalid", "Dates must fall within 14 days");
  for (const m of [earliest, latest])
    if (!Number.isInteger(m) || m < 0 || m > 1439 || m % step !== 0)
      throw new DomainError("invalid", `Times must be on ${step}-minute steps`);
  if (duration > windowLengthMinutes(earliest, latest))
    throw new DomainError("invalid", "Session length is longer than the daily time window");
  const windows = dayWindows({ dates, earliestMinute: earliest, latestMinute: latest, timezone: input.organizerTimezone, stepMinutes: step });
  const searchStart = windows[0].start;
  const searchEnd = windows[windows.length - 1].end;

  let webhookEnc: Buffer | null = null;
  if (input.discordWebhookUrl) {
    if (!WEBHOOK_PREFIXES.some((p) => input.discordWebhookUrl!.startsWith(p)))
      throw new DomainError("invalid", "Not a Discord webhook URL");
    webhookEnc = encryptWebhook(input.discordWebhookUrl);
  }

  const organizerToken = newToken();
  const publicSlug = newSlug();

  return withTransaction(db, async (tx) => {
    const { rows } = await tx
      .query<{ id: string }>(
        `insert into sessions (public_slug, organizer_token_hash, title, game, duration_minutes,
           search_start_utc, search_end_utc, organizer_timezone, dates, earliest_minute,
           latest_minute, slot_step_minutes, max_participants, discord_webhook_url_enc)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date[], $10, $11, $12, coalesce($13, 4), $14)
         returning id`,
        [
          publicSlug,
          hashToken(organizerToken),
          title,
          input.game?.trim() || null,
          duration,
          searchStart,
          searchEnd,
          input.organizerTimezone,
          dates,
          earliest,
          latest,
          step,
          input.maxParticipants ?? null,
          webhookEnc,
        ],
      )
      .catch(mapPgError);
    const sessionId = rows[0].id;
    await enqueue(tx, sessionId, "created", new Date());
    return { sessionId, publicSlug, organizerToken };
  });
}

/** Everything the share page needs: session, participants (no secrets), and computed matches. */
export async function getSessionView(db: Db, slug: string): Promise<SessionView> {
  const s = await loadSession(db, slug);
  const { rows: people } = await db.query<{
    id: string;
    display_name: string;
    timezone: string;
    is_organizer: boolean;
    responded_at: Date | null;
  }>(
    `select id, display_name, timezone, is_organizer, responded_at
     from participants where session_id = $1 order by created_at, id`,
    [s.id],
  );
  const { rows: blocks } = await db.query<{ participant_id: string; start: Date; end: Date }>(
    `select participant_id, lower(period) as start, upper(period) as end
     from availability_blocks where session_id = $1 order by lower(period)`,
    [s.id],
  );

  const blocksBy = new Map<string, Block[]>();
  for (const b of blocks) {
    const list = blocksBy.get(b.participant_id) ?? [];
    list.push({ start: b.start, end: b.end });
    blocksBy.set(b.participant_id, list);
  }

  const matches = computeMatches({
    session: {
      durationMinutes: s.duration_minutes,
      slotStepMinutes: s.slot_step_minutes,
      searchStartUtc: s.search_start_utc,
      searchEndUtc: s.search_end_utc,
      maxParticipants: s.max_participants,
    },
    participants: people.map((p) => ({
      id: p.id,
      respondedAt: p.responded_at,
      blocks: blocksBy.get(p.id) ?? [],
    })),
  });

  return {
    id: s.id,
    publicSlug: s.public_slug,
    title: s.title,
    game: s.game,
    durationMinutes: s.duration_minutes,
    searchStartUtc: s.search_start_utc,
    searchEndUtc: s.search_end_utc,
    organizerTimezone: s.organizer_timezone,
    dates: s.dates,
    earliestMinute: s.earliest_minute,
    latestMinute: s.latest_minute,
    windows: sessionWindows(s),
    slotStepMinutes: s.slot_step_minutes,
    maxParticipants: s.max_participants,
    hasWebhook: s.has_webhook,
    status: s.status,
    confirmedStartUtc: s.confirmed_start_utc,
    confirmedEndUtc: s.confirmed_end_utc,
    expiresAt: s.expires_at,
    participants: people.map((p) => ({
      id: p.id,
      displayName: p.display_name,
      timezone: p.timezone,
      isOrganizer: p.is_organizer,
      responded: p.responded_at !== null,
    })),
    matches,
  };
}

/** Organizer locks in a start time. End = start + duration. */
export async function confirmSession(db: Db, slug: string, organizerToken: string, startUtc: Date) {
  return withTransaction(db, async (tx) => {
    const s = await loadForOrganizer(tx, slug, organizerToken);
    if (s.status !== "collecting") throw new DomainError("wrong_status", `Session is ${s.status}`);
    const end = new Date(startUtc.getTime() + s.duration_minutes * MINUTE);
    if (!isAligned(startUtc, s.slot_step_minutes) || !withinWindows(mergeBlocks(sessionWindows(s)), startUtc, end))
      throw new DomainError("invalid", "Start time must be an aligned slot within the session's time windows");

    await tx.query(
      `update sessions set status = 'confirmed', confirmed_start_utc = $2, confirmed_end_utc = $3
       where id = $1`,
      [s.id, startUtc, end],
    );
    await enqueue(tx, s.id, "confirmed", new Date());
    const remindAt = new Date(startUtc.getTime() - REMINDER_LEAD_MINUTES * MINUTE);
    if (remindAt > new Date()) await enqueue(tx, s.id, "reminder", remindAt);
    return { confirmedStartUtc: startUtc, confirmedEndUtc: end };
  });
}

/** Back to collecting: confirmed times cleared, blocks kept, pending reminder canceled. */
export async function reopenSession(db: Db, slug: string, organizerToken: string) {
  return withTransaction(db, async (tx) => {
    const s = await loadForOrganizer(tx, slug, organizerToken);
    if (s.status !== "confirmed") throw new DomainError("wrong_status", `Session is ${s.status}`);
    await tx.query(
      `update sessions set status = 'collecting', confirmed_start_utc = null, confirmed_end_utc = null
       where id = $1`,
      [s.id],
    );
    await cancelPendingReminders(tx, s.id);
    await enqueue(tx, s.id, "rescheduled", new Date());
  });
}

/** Cancel from collecting or confirmed. Confirmed times are kept so the notice can mention them. */
export async function cancelSession(db: Db, slug: string, organizerToken: string) {
  return withTransaction(db, async (tx) => {
    const s = await loadForOrganizer(tx, slug, organizerToken);
    if (s.status === "canceled") throw new DomainError("wrong_status", "Session is already canceled");
    await tx.query(`update sessions set status = 'canceled' where id = $1`, [s.id]);
    await cancelPendingReminders(tx, s.id);
    await enqueue(tx, s.id, "canceled", new Date());
  });
}
