// Matching engine (reference for the backend; see web/DATA-REQUIREMENTS.md). Pure function.

export interface Block {
  start: Date;
  end: Date; // exclusive
}

export interface MatchInput {
  session: {
    durationMinutes: number;
    slotStepMinutes: number;
    searchStartUtc: Date;
    searchEndUtc: Date;
    maxParticipants: number;
  };
  participants: { id: string; respondedAt: Date | null; blocks: Block[] }[];
}

export interface MatchWindow {
  firstStart: Date;
  lastStart: Date;
  availableIds: string[];
  missingIds: string[];
}

export interface MatchResult {
  windows: MatchWindow[];
  respondedCount: number;
  joinedCount: number;
  maxParticipants: number;
}

const MINUTE = 60_000;

export function computeMatches({ session, participants }: MatchInput): MatchResult {
  const D = session.durationMinutes * MINUTE;
  const step = session.slotStepMinutes * MINUTE;
  const responded = participants.filter((p) => p.respondedAt !== null);
  const allIds = participants.map((p) => p.id);

  const windows: MatchWindow[] = [];
  let current: { first: number; last: number; key: string; ids: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    windows.push({
      firstStart: new Date(current.first),
      lastStart: new Date(current.last),
      availableIds: current.ids,
      missingIds: allIds.filter((id) => !current!.ids.includes(id)),
    });
    current = null;
  };

  const lastCandidate = session.searchEndUtc.getTime() - D;
  for (let s = session.searchStartUtc.getTime(); s <= lastCandidate; s += step) {
    const e = s + D;
    const ids = responded
      .filter((p) => p.blocks.some((b) => b.start.getTime() <= s && b.end.getTime() >= e))
      .map((p) => p.id);

    if (ids.length === 0) {
      flush();
      continue;
    }
    const key = ids.join(",");
    if (current && current.key === key && current.last + step === s) {
      current.last = s;
    } else {
      flush();
      current = { first: s, last: s, key, ids };
    }
  }
  flush();

  windows.sort(
    (a, b) =>
      b.availableIds.length - a.availableIds.length || a.firstStart.getTime() - b.firstStart.getTime(),
  );

  return {
    windows,
    respondedCount: responded.length,
    joinedCount: participants.length,
    maxParticipants: session.maxParticipants,
  };
}

/** Sort and merge overlapping or adjacent blocks. */
export function mergeBlocks(blocks: Block[]): Block[] {
  const sorted = [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Block[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start.getTime() <= last.end.getTime()) {
      if (b.end.getTime() > last.end.getTime()) last.end = new Date(b.end.getTime());
    } else {
      out.push({ start: new Date(b.start.getTime()), end: new Date(b.end.getTime()) });
    }
  }
  return out;
}
