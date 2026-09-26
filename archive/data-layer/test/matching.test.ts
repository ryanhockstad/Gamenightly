import { describe, expect, it } from "vitest";
import { computeMatches, mergeBlocks, type Block } from "../src/matching.js";

const t = (iso: string) => new Date(iso);
const blk = (a: string, b: string): Block => ({ start: t(a), end: t(b) });

const session = {
  durationMinutes: 120,
  slotStepMinutes: 30,
  searchStartUtc: t("2026-10-01T00:00:00Z"),
  searchEndUtc: t("2026-10-02T00:00:00Z"),
  maxParticipants: 4,
};
const responded = t("2026-09-25T00:00:00Z");

describe("computeMatches", () => {
  it("collapses consecutive starts with the same set into one window", () => {
    const r = computeMatches({
      session,
      participants: [
        { id: "a", respondedAt: responded, blocks: [blk("2026-10-01T02:00:00Z", "2026-10-01T06:00:00Z")] },
        { id: "b", respondedAt: responded, blocks: [blk("2026-10-01T02:00:00Z", "2026-10-01T06:00:00Z")] },
      ],
    });
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0]).toEqual({
      firstStart: t("2026-10-01T02:00:00Z"),
      lastStart: t("2026-10-01T04:00:00Z"), // 04:00 + 2h = 06:00, the last full fit
      availableIds: ["a", "b"],
      missingIds: [],
    });
  });

  it("ranks by available count, then earliest start, and names who's missing", () => {
    const r = computeMatches({
      session,
      participants: [
        { id: "a", respondedAt: responded, blocks: [blk("2026-10-01T01:00:00Z", "2026-10-01T03:00:00Z"), blk("2026-10-01T10:00:00Z", "2026-10-01T12:00:00Z")] },
        { id: "b", respondedAt: responded, blocks: [blk("2026-10-01T10:00:00Z", "2026-10-01T12:00:00Z")] },
        { id: "c", respondedAt: null, blocks: [] },
      ],
    });
    expect(r.windows.map((w) => [w.firstStart.toISOString(), w.availableIds, w.missingIds])).toEqual([
      ["2026-10-01T10:00:00.000Z", ["a", "b"], ["c"]],
      ["2026-10-01T01:00:00.000Z", ["a"], ["b", "c"]],
    ]);
    expect(r).toMatchObject({ respondedCount: 2, joinedCount: 3, maxParticipants: 4 });
  });

  it("requires a block to cover the full duration", () => {
    const r = computeMatches({
      session,
      participants: [{ id: "a", respondedAt: responded, blocks: [blk("2026-10-01T01:00:00Z", "2026-10-01T02:30:00Z")] }],
    });
    expect(r.windows).toEqual([]);
  });

  it("ignores blocks of participants who haven't responded", () => {
    const r = computeMatches({
      session,
      participants: [{ id: "a", respondedAt: null, blocks: [blk("2026-10-01T01:00:00Z", "2026-10-01T05:00:00Z")] }],
    });
    expect(r.windows).toEqual([]);
    expect(r.respondedCount).toBe(0);
  });

  it("splits windows when the available set changes, and when there's a gap", () => {
    const r = computeMatches({
      session,
      participants: [
        { id: "a", respondedAt: responded, blocks: [blk("2026-10-01T00:00:00Z", "2026-10-01T06:00:00Z")] },
        { id: "b", respondedAt: responded, blocks: [blk("2026-10-01T02:00:00Z", "2026-10-01T04:00:00Z")] },
      ],
    });
    // a alone 00:00–01:30, both at 02:00, a alone 02:30–04:00
    expect(r.windows.map((w) => [w.firstStart.toISOString().slice(11, 16), w.lastStart.toISOString().slice(11, 16), w.availableIds.join()])).toEqual([
      ["02:00", "02:00", "a,b"],
      ["00:00", "01:30", "a"],
      ["02:30", "04:00", "a"],
    ]);
  });

  it("stays within the worst-case budget (14 days, 30-min steps, 4 people)", () => {
    const long = { ...session, searchEndUtc: t("2026-10-15T00:00:00Z") };
    const all = [blk("2026-10-01T00:00:00Z", "2026-10-15T00:00:00Z")];
    const r = computeMatches({
      session: long,
      participants: ["a", "b", "c", "d"].map((id) => ({ id, respondedAt: responded, blocks: all })),
    });
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0].lastStart).toEqual(t("2026-10-14T22:00:00Z"));
  });
});

describe("mergeBlocks", () => {
  it("merges overlapping and adjacent blocks, keeps gaps", () => {
    expect(
      mergeBlocks([
        blk("2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z"),
        blk("2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z"),
        blk("2026-10-01T02:00:00Z", "2026-10-01T03:00:00Z"),
        blk("2026-10-01T02:30:00Z", "2026-10-01T03:30:00Z"),
      ]),
    ).toEqual([blk("2026-10-01T01:00:00Z", "2026-10-01T03:30:00Z"), blk("2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z")]);
  });
});
