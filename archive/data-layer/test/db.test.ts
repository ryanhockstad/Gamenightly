import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cancelSession,
  confirmSession,
  createPool,
  createSession,
  decryptWebhook,
  getSessionView,
  joinSession,
  reopenSession,
  replaceAvailability,
  type CreateSessionInput,
} from "../src/index.js";
import { migrate } from "../src/migrate.js";

process.env.GAMENIGHTLY_WEBHOOK_KEY ??= randomBytes(32).toString("base64");
const db = createPool(process.env.DATABASE_URL ?? "postgres://localhost/gamenightly_test");

const t = (iso: string) => new Date(iso);
const HOUR = 3_600_000;
const WEBHOOK = "https://discord.com/api/webhooks/123/abc";

// A search range in the future so reminders get scheduled.
const day0 = new Date(Math.ceil(Date.now() / (24 * HOUR)) * 24 * HOUR + 2 * 24 * HOUR);
const at = (hours: number) => new Date(day0.getTime() + hours * HOUR);

function dayList(from: Date, n: number): string[] {
  return Array.from({ length: n }, (_, i) => new Date(from.getTime() + i * 24 * HOUR).toISOString().slice(0, 10));
}

function baseInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    title: "Helldivers night",
    game: "Helldivers 2",
    // 7 full UTC days (midnight to midnight), so the windows merge into one range: day0 … day0+7d.
    dates: dayList(day0, 7),
    earliestMinute: 0,
    latestMinute: 0,
    organizerTimezone: "UTC",
    ...overrides,
  };
}

async function outbox(sessionId: string) {
  const { rows } = await db.query(
    `select type, scheduled_for, canceled_at from notification_outbox where session_id = $1 order by type, scheduled_for`,
    [sessionId],
  );
  return rows as { type: string; scheduled_for: Date; canceled_at: Date | null }[];
}

beforeAll(async () => {
  await db.query("drop schema public cascade; create schema public;");
  await migrate(db);
});
beforeEach(async () => {
  await db.query("truncate sessions cascade");
});
afterAll(() => db.end());

describe("sessions", () => {
  it("creates with defaults; view has no secrets; expires 30 days after range", async () => {
    const { publicSlug, organizerToken } = await createSession(db, baseInput());
    expect(organizerToken).toHaveLength(43); // 32 bytes base64url
    const v = await getSessionView(db, publicSlug);
    expect(v).toMatchObject({
      durationMinutes: 120,
      slotStepMinutes: 30,
      earliestMinute: 0,
      latestMinute: 0,
      maxParticipants: 4,
      status: "collecting",
      hasWebhook: false,
    });
    expect(v.windows).toHaveLength(7);
    expect([v.searchStartUtc, v.searchEndUtc]).toEqual([day0, at(7 * 24)]);
    expect(v.expiresAt).toEqual(new Date(at(7 * 24).getTime() + 30 * 24 * HOUR));
    expect(JSON.stringify(v)).not.toMatch(/token|webhook_url/i);
  });

  it("stores only the token hash and an encrypted webhook", async () => {
    const { sessionId, organizerToken } = await createSession(db, baseInput({ discordWebhookUrl: WEBHOOK }));
    const { rows } = await db.query(`select organizer_token_hash, discord_webhook_url_enc from sessions where id = $1`, [sessionId]);
    expect(rows[0].organizer_token_hash).not.toContain(organizerToken);
    expect(rows[0].discord_webhook_url_enc.toString()).not.toContain("discord.com");
    expect(decryptWebhook(rows[0].discord_webhook_url_enc)).toBe(WEBHOOK);
    expect((await outbox(sessionId)).map((r) => r.type)).toEqual(["created"]);
  });

  it("enqueues nothing without a webhook", async () => {
    const { sessionId } = await createSession(db, baseInput());
    expect(await outbox(sessionId)).toEqual([]);
  });

  it.each([
    ["dates over 14 days", { dates: [dayList(day0, 1)[0], dayList(at(14 * 24), 1)[0]] }],
    ["no dates", { dates: [] }],
    ["bad date", { dates: ["2026-02-30"] }],
    ["off-step time", { earliestMinute: 1030 }],
    ["session longer than the window", { earliestMinute: 1200, latestMinute: 1260 }],
    ["duration too short", { durationMinutes: 15 }],
    ["too many participants", { maxParticipants: 5 }],
    ["unknown time zone", { organizerTimezone: "Mars/Olympus" }],
    ["non-Discord webhook", { discordWebhookUrl: "https://evil.example/hook" }],
    ["blank title", { title: "   " }],
  ])("rejects %s", async (_, overrides) => {
    await expect(createSession(db, baseInput(overrides))).rejects.toMatchObject({ code: "invalid" });
  });

  it("hides expired sessions", async () => {
    const { sessionId, publicSlug } = await createSession(db, baseInput());
    // Push the whole range into the past; the trigger recomputes expires_at.
    await db.query(
      `update sessions set search_start_utc = now() - interval '40 days', search_end_utc = now() - interval '35 days' where id = $1`,
      [sessionId],
    );
    await expect(getSessionView(db, publicSlug)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("participants", () => {
  it("caps at max_participants, including under concurrent joins", async () => {
    const { publicSlug } = await createSession(db, baseInput({ maxParticipants: 3 }));
    const results = await Promise.allSettled(
      ["a", "b", "c", "d", "e", "f"].map((n) => joinSession(db, publicSlug, { displayName: n, timezone: "UTC" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results.filter((r) => r.status === "rejected"))
      expect((r as PromiseRejectedResult).reason.code).toBe("session_full");
    expect((await getSessionView(db, publicSlug)).participants).toHaveLength(3);
  });

  it("rejects duplicate names case-insensitively", async () => {
    const { publicSlug } = await createSession(db, baseInput());
    await joinSession(db, publicSlug, { displayName: "Aaron", timezone: "UTC" });
    await expect(joinSession(db, publicSlug, { displayName: " aaron ", timezone: "UTC" })).rejects.toMatchObject({ code: "name_taken" });
  });

  it("marks the organizer only with a valid organizer token, once", async () => {
    const { publicSlug, organizerToken } = await createSession(db, baseInput());
    await expect(joinSession(db, publicSlug, { displayName: "X", timezone: "UTC", organizerToken: "nope" })).rejects.toMatchObject({ code: "forbidden" });
    await joinSession(db, publicSlug, { displayName: "Org", timezone: "UTC", organizerToken });
    await expect(joinSession(db, publicSlug, { displayName: "Org2", timezone: "UTC", organizerToken })).rejects.toMatchObject({ code: "invalid" });
    expect((await getSessionView(db, publicSlug)).participants[0]).toMatchObject({ displayName: "Org", isOrganizer: true });
  });

  it("rejects bad display names", async () => {
    const { publicSlug } = await createSession(db, baseInput());
    await expect(joinSession(db, publicSlug, { displayName: "", timezone: "UTC" })).rejects.toMatchObject({ code: "invalid" });
    await expect(joinSession(db, publicSlug, { displayName: "x".repeat(33), timezone: "UTC" })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("availability", () => {
  it("merges on write and replaces the whole set on each save", async () => {
    const { publicSlug } = await createSession(db, baseInput());
    const { participantId, editToken } = await joinSession(db, publicSlug, { displayName: "A", timezone: "UTC" });

    const r1 = await replaceAvailability(db, publicSlug, participantId, editToken, [
      { start: at(1), end: at(2) },
      { start: at(2), end: at(3) }, // adjacent
      { start: at(2.5), end: at(4) }, // overlapping
      { start: at(10), end: at(11) },
    ]);
    expect(r1.blocks).toEqual([{ start: at(1), end: at(4) }, { start: at(10), end: at(11) }]);

    await replaceAvailability(db, publicSlug, participantId, editToken, [{ start: at(20), end: at(22) }]);
    const { rows } = await db.query(`select lower(period) s, upper(period) e from availability_blocks where participant_id = $1`, [participantId]);
    expect(rows).toEqual([{ s: at(20), e: at(22) }]);
  });

  it("an empty save still counts as a response", async () => {
    const { publicSlug } = await createSession(db, baseInput());
    const { participantId, editToken } = await joinSession(db, publicSlug, { displayName: "A", timezone: "UTC" });
    await replaceAvailability(db, publicSlug, participantId, editToken, []);
    expect((await getSessionView(db, publicSlug)).participants[0].responded).toBe(true);
  });

  it.each([
    ["misaligned", { start: new Date(at(1).getTime() + 60_000), end: at(2) }],
    ["before range", { start: at(-1), end: at(1) }],
    ["after range", { start: at(7 * 24 - 1), end: at(7 * 24 + 1) }],
    ["empty", { start: at(1), end: at(1) }],
  ])("rejects %s blocks", async (_, block) => {
    const { publicSlug } = await createSession(db, baseInput());
    const { participantId, editToken } = await joinSession(db, publicSlug, { displayName: "A", timezone: "UTC" });
    await expect(replaceAvailability(db, publicSlug, participantId, editToken, [block])).rejects.toMatchObject({ code: "invalid" });
  });

  it("requires the participant's own edit token", async () => {
    const { publicSlug } = await createSession(db, baseInput());
    const a = await joinSession(db, publicSlug, { displayName: "A", timezone: "UTC" });
    const b = await joinSession(db, publicSlug, { displayName: "B", timezone: "UTC" });
    await expect(replaceAvailability(db, publicSlug, a.participantId, b.editToken, [])).rejects.toMatchObject({ code: "forbidden" });
  });

  it("enqueues all_responded once, when every slot has responded", async () => {
    const { sessionId, publicSlug } = await createSession(db, baseInput({ maxParticipants: 2, discordWebhookUrl: WEBHOOK }));
    const a = await joinSession(db, publicSlug, { displayName: "A", timezone: "UTC" });
    const b = await joinSession(db, publicSlug, { displayName: "B", timezone: "UTC" });
    await replaceAvailability(db, publicSlug, a.participantId, a.editToken, []);
    expect((await outbox(sessionId)).map((r) => r.type)).toEqual(["created"]);
    await replaceAvailability(db, publicSlug, b.participantId, b.editToken, []);
    await replaceAvailability(db, publicSlug, b.participantId, b.editToken, []);
    expect((await outbox(sessionId)).map((r) => r.type)).toEqual(["created", "all_responded"]);
  });

  it("schema rejects overlapping blocks and mismatched session ids", async () => {
    const s1 = await createSession(db, baseInput());
    const s2 = await createSession(db, baseInput());
    const { participantId } = await joinSession(db, s1.publicSlug, { displayName: "A", timezone: "UTC" });
    const ins = (sessionId: string, a: Date, b: Date) =>
      db.query(`insert into availability_blocks (participant_id, session_id, period) values ($1, $2, tstzrange($3, $4, '[)'))`, [participantId, sessionId, a, b]);
    await ins(s1.sessionId, at(1), at(3));
    await expect(ins(s1.sessionId, at(2), at(4))).rejects.toMatchObject({ code: "23P01" });
    await expect(ins(s2.sessionId, at(5), at(6))).rejects.toMatchObject({ code: "23503" });
  });
});

describe("confirm / reopen / cancel", () => {
  async function setup() {
    const s = await createSession(db, baseInput({ discordWebhookUrl: WEBHOOK }));
    const p = await joinSession(db, s.publicSlug, { displayName: "A", timezone: "UTC" });
    await replaceAvailability(db, s.publicSlug, p.participantId, p.editToken, [{ start: at(3), end: at(8) }]);
    return { ...s, ...p };
  }

  it("confirms, locks availability, schedules the reminder, extends expiry", async () => {
    const s = await setup();
    await expect(confirmSession(db, s.publicSlug, "wrong", at(4))).rejects.toMatchObject({ code: "forbidden" });
    await confirmSession(db, s.publicSlug, s.organizerToken, at(4));

    const v = await getSessionView(db, s.publicSlug);
    expect(v).toMatchObject({ status: "confirmed", confirmedStartUtc: at(4), confirmedEndUtc: at(6) });
    expect(v.expiresAt).toEqual(new Date(at(7 * 24).getTime() + 30 * 24 * HOUR));

    const ob = await outbox(s.sessionId);
    expect(ob.find((r) => r.type === "reminder")?.scheduled_for).toEqual(at(3));
    expect(ob.map((r) => r.type).sort()).toEqual(["confirmed", "created", "reminder"]);

    await expect(replaceAvailability(db, s.publicSlug, s.participantId, s.editToken, [])).rejects.toMatchObject({ code: "wrong_status" });
    await expect(confirmSession(db, s.publicSlug, s.organizerToken, at(5))).rejects.toMatchObject({ code: "wrong_status" });
  });

  it("rejects confirm outside the range or misaligned", async () => {
    const s = await setup();
    await expect(confirmSession(db, s.publicSlug, s.organizerToken, at(7 * 24 - 1))).rejects.toMatchObject({ code: "invalid" });
    await expect(confirmSession(db, s.publicSlug, s.organizerToken, new Date(at(4).getTime() + 60_000))).rejects.toMatchObject({ code: "invalid" });
  });

  it("reopen clears times, keeps blocks, cancels the reminder, posts rescheduled", async () => {
    const s = await setup();
    await confirmSession(db, s.publicSlug, s.organizerToken, at(4));
    await reopenSession(db, s.publicSlug, s.organizerToken);

    const v = await getSessionView(db, s.publicSlug);
    expect(v).toMatchObject({ status: "collecting", confirmedStartUtc: null, confirmedEndUtc: null });
    expect(v.matches.windows).toHaveLength(1); // blocks kept

    const ob = await outbox(s.sessionId);
    expect(ob.find((r) => r.type === "reminder")?.canceled_at).not.toBeNull();
    expect(ob.map((r) => r.type)).toContain("rescheduled");

    // Can edit and confirm again; the new reminder is a fresh row.
    await replaceAvailability(db, s.publicSlug, s.participantId, s.editToken, [{ start: at(10), end: at(12) }]);
    await confirmSession(db, s.publicSlug, s.organizerToken, at(10));
    const reminders = (await outbox(s.sessionId)).filter((r) => r.type === "reminder");
    expect(reminders.map((r) => [r.scheduled_for, r.canceled_at === null])).toEqual([[at(3), false], [at(9), true]]);
  });

  it("cancel keeps confirmed times, cancels the reminder, blocks joins and edits", async () => {
    const s = await setup();
    await confirmSession(db, s.publicSlug, s.organizerToken, at(4));
    await cancelSession(db, s.publicSlug, s.organizerToken);

    const v = await getSessionView(db, s.publicSlug);
    expect(v).toMatchObject({ status: "canceled", confirmedStartUtc: at(4) });
    const ob = await outbox(s.sessionId);
    expect(ob.find((r) => r.type === "reminder")?.canceled_at).not.toBeNull();
    expect(ob.map((r) => r.type)).toContain("canceled");

    await expect(cancelSession(db, s.publicSlug, s.organizerToken)).rejects.toMatchObject({ code: "wrong_status" });
    await expect(reopenSession(db, s.publicSlug, s.organizerToken)).rejects.toMatchObject({ code: "wrong_status" });
    await expect(joinSession(db, s.publicSlug, { displayName: "B", timezone: "UTC" })).rejects.toMatchObject({ code: "wrong_status" });
  });
});

describe("time zones", () => {
  // US DST ends 2026-11-01 02:00 local. 8 PM Los Angeles is 03:00Z on Oct 31 and 04:00Z on Nov 2.
  const la = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" }).format(d);

  it("matches the same local evening on both sides of a DST change, across midnight", async () => {
    const { publicSlug } = await createSession(db, {
      title: "DST",
      dates: ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"],
      earliestMinute: 17 * 60, // 5 PM
      latestMinute: 2 * 60, // 2 AM next day
      organizerTimezone: "America/Los_Angeles",
      durationMinutes: 180,
    });
    const la1 = await joinSession(db, publicSlug, { displayName: "LA", timezone: "America/Los_Angeles" });
    const ind = await joinSession(db, publicSlug, { displayName: "IN", timezone: "Asia/Kolkata" });

    // LA free 8 PM–1 AM local, Fri Oct 30 (PDT) and Mon Nov 2 (PST).
    await replaceAvailability(db, publicSlug, la1.participantId, la1.editToken, [
      { start: t("2026-10-31T03:00:00Z"), end: t("2026-10-31T08:00:00Z") },
      { start: t("2026-11-03T04:00:00Z"), end: t("2026-11-03T09:00:00Z") },
    ]);
    // India (+5:30) free 8:30 AM–1:30 PM local on the matching mornings: 03:00Z and 04:00Z starts.
    await replaceAvailability(db, publicSlug, ind.participantId, ind.editToken, [
      { start: t("2026-10-31T03:00:00Z"), end: t("2026-10-31T08:00:00Z") },
      { start: t("2026-11-03T03:00:00Z"), end: t("2026-11-03T08:00:00Z") },
    ]);

    const { matches, windows } = await getSessionView(db, publicSlug);
    // Every window is 5 PM–2 AM LA wall time, so the UTC start shifts by an hour after DST ends.
    expect(windows.map((w) => la(w.start))).toEqual(["Fri 5:00 PM", "Sat 5:00 PM", "Sun 5:00 PM", "Mon 5:00 PM", "Tue 5:00 PM"]);
    expect(windows.map((w) => la(w.end))).toEqual(["Sat 2:00 AM", "Sun 2:00 AM", "Mon 2:00 AM", "Tue 2:00 AM", "Wed 2:00 AM"]);
    expect(windows[0].start).toEqual(t("2026-10-31T00:00:00Z"));
    expect(windows[3].start).toEqual(t("2026-11-03T01:00:00Z"));

    const full = matches.windows.filter((w) => w.availableIds.length === 2);
    expect(full.map((w) => [la(w.firstStart), la(w.lastStart)])).toEqual([
      ["Fri 8:00 PM", "Fri 10:00 PM"], // 10 PM + 3h ends 1 AM Saturday
      ["Mon 8:00 PM", "Mon 9:00 PM"], // capped by India's block ending at 08:00Z
    ]);
  });

  it("rejects availability and confirmations outside the daily window", async () => {
    const { publicSlug, organizerToken } = await createSession(db, {
      title: "Window",
      dates: ["2026-10-06", "2026-10-08"],
      earliestMinute: 18 * 60,
      latestMinute: 23 * 60,
      organizerTimezone: "America/New_York", // EDT, UTC-4: windows 22:00Z–03:00Z
    });
    const p = await joinSession(db, publicSlug, { displayName: "A", timezone: "UTC" });
    const save = (a: string, b: string) => replaceAvailability(db, publicSlug, p.participantId, p.editToken, [{ start: t(a), end: t(b) }]);

    await save("2026-10-06T22:00:00Z", "2026-10-07T03:00:00Z"); // the whole Oct 6 window
    await expect(save("2026-10-06T21:30:00Z", "2026-10-06T23:00:00Z")).rejects.toMatchObject({ code: "invalid" }); // before 6 PM
    await expect(save("2026-10-07T22:00:00Z", "2026-10-07T23:00:00Z")).rejects.toMatchObject({ code: "invalid" }); // Oct 7 not picked
    await expect(save("2026-10-06T22:00:00Z", "2026-10-09T03:00:00Z")).rejects.toMatchObject({ code: "invalid" }); // spans the gap

    await expect(confirmSession(db, publicSlug, organizerToken, t("2026-10-07T02:00:00Z"))).rejects.toMatchObject({ code: "invalid" }); // 10 PM + 2h > 11 PM
    await confirmSession(db, publicSlug, organizerToken, t("2026-10-07T01:00:00Z")); // 9–11 PM
  });
});
