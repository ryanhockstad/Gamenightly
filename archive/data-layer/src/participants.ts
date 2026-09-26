import { hashToken, newToken, tokenMatches } from "./crypto.js";
import { DomainError, withTransaction, type Db } from "./db.js";
import { mergeBlocks, type Block } from "./matching.js";
import { withinWindows } from "./windows.js";
import { assertTimezone, enqueue, isAligned, loadSession, mapPgError, sessionWindows } from "./sessions.js";

export interface JoinInput {
  displayName: string;
  timezone: string;
  /** Present when the organizer joins from their organizer link; marks is_organizer. */
  organizerToken?: string;
}

/**
 * Join a session. Locks the session row and counts participants against max_participants,
 * so concurrent joins can't exceed the cap.
 */
export async function joinSession(
  db: Db,
  slug: string,
  input: JoinInput,
): Promise<{ participantId: string; editToken: string }> {
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 32)
    throw new DomainError("invalid", "Display name must be 1–32 characters");
  assertTimezone(input.timezone);

  return withTransaction(db, async (tx) => {
    const s = await loadSession(tx, slug, true);
    if (s.status !== "collecting") throw new DomainError("wrong_status", `Session is ${s.status}`);

    let isOrganizer = false;
    if (input.organizerToken !== undefined) {
      if (!tokenMatches(input.organizerToken, s.organizer_token_hash))
        throw new DomainError("forbidden", "Invalid organizer token");
      isOrganizer = true;
    }

    const { rows } = await tx.query<{ n: number }>(
      `select count(*)::int as n from participants where session_id = $1`,
      [s.id],
    );
    if (rows[0].n >= s.max_participants) throw new DomainError("session_full", "Session is full");

    const editToken = newToken();
    const inserted = await tx
      .query<{ id: string }>(
        `insert into participants (session_id, display_name, timezone, edit_token_hash, is_organizer)
         values ($1, $2, $3, $4, $5) returning id`,
        [s.id, displayName, input.timezone, hashToken(editToken), isOrganizer],
      )
      .catch((err) => {
        if (err.code === "23505" && err.constraint === "participants_one_organizer")
          throw new DomainError("invalid", "Organizer has already joined");
        mapPgError(err);
      });
    return { participantId: inserted!.rows[0].id, editToken };
  });
}

/**
 * Replace a participant's availability with `blocks` (the grid's full state).
 * Blocks must align to the session's step and fall within its daily time windows; overlapping or
 * adjacent blocks are merged. Blocked once the session is no longer collecting.
 */
export async function replaceAvailability(
  db: Db,
  slug: string,
  participantId: string,
  editToken: string,
  blocks: Block[],
): Promise<{ blocks: Block[] }> {
  return withTransaction(db, async (tx) => {
    // Lock the session so a save can't interleave with confirm.
    const s = await loadSession(tx, slug, true);
    const { rows } = await tx.query<{ edit_token_hash: string }>(
      `select edit_token_hash from participants where id = $1 and session_id = $2`,
      [participantId, s.id],
    );
    if (!rows[0]) throw new DomainError("not_found", "Participant not found");
    if (!tokenMatches(editToken, rows[0].edit_token_hash))
      throw new DomainError("forbidden", "Invalid edit token");
    if (s.status !== "collecting")
      throw new DomainError("wrong_status", "Availability is locked; the organizer must reopen the session");

    for (const b of blocks) {
      if (!(b.start < b.end) || !isAligned(b.start, s.slot_step_minutes) || !isAligned(b.end, s.slot_step_minutes))
        throw new DomainError("invalid", "Blocks must be aligned slots");
    }
    const merged = mergeBlocks(blocks);
    const windows = mergeBlocks(sessionWindows(s));
    if (!merged.every((b) => withinWindows(windows, b.start, b.end)))
      throw new DomainError("invalid", "Availability must be within the session's time windows");

    await tx.query(`delete from availability_blocks where participant_id = $1`, [participantId]);
    if (merged.length > 0) {
      await tx.query(
        `insert into availability_blocks (participant_id, session_id, period)
         select $1, $2, tstzrange(s, e, '[)') from unnest($3::timestamptz[], $4::timestamptz[]) as t(s, e)`,
        [participantId, s.id, merged.map((b) => b.start), merged.map((b) => b.end)],
      );
    }
    await tx.query(
      `update participants set responded_at = coalesce(responded_at, now()), updated_at = now()
       where id = $1`,
      [participantId],
    );

    // All intended participants have responded → notify once.
    const { rows: counts } = await tx.query<{ n: number }>(
      `select count(*)::int as n from participants where session_id = $1 and responded_at is not null`,
      [s.id],
    );
    if (counts[0].n === s.max_participants) {
      const { rowCount } = await tx.query(
        `select 1 from notification_outbox where session_id = $1 and type = 'all_responded'`,
        [s.id],
      );
      if (!rowCount) await enqueue(tx, s.id, "all_responded", new Date());
    }

    return { blocks: merged };
  });
}
