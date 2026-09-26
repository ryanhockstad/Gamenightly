import { DateTime } from "luxon";
import type { Block, SessionView } from "./api";

const MINUTE = 60_000;

export function detectTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function allTimezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [detectTimezone()];
  }
}


// ---------- grid ----------

export interface GridCell {
  start: number; // UTC ms
  inRange: boolean;
  title: string; // full local date/time, for tooltips
}

export interface GridColumn {
  key: string;
  weekday: string;
  date: string;
  cells: GridCell[];
}

export interface Grid {
  columns: GridColumn[];
  rowLabels: (string | null)[];
}

/**
 * Build the paint grid in the viewer's zone: one column per organizer date, rows covering only
 * that date's window (the organizer's "no earlier than" to "no later than"). Rows are keyed by
 * local wall time from the column's first day, so a DST shift in one column leaves a gap
 * instead of mislabeling rows, and times past midnight stay in the evening's column.
 */
export function buildGrid(view: SessionView, zone: string): Grid {
  const step = view.slot_step_minutes * MINUTE;

  const cols = view.windows.map((w) => {
    const start = Date.parse(w.start);
    const end = Date.parse(w.end);
    const first = DateTime.fromMillis(start, { zone });
    const firstDay = first.startOf("day");
    const byKey = new Map<number, number>();
    for (let t = start; t < end; t += step) {
      const local = DateTime.fromMillis(t, { zone });
      let key = Math.round(local.startOf("day").diff(firstDay, "days").days) * 1440 + local.hour * 60 + local.minute;
      while (byKey.has(key)) key += 1; // repeated hour when clocks fall back
      byKey.set(key, t);
    }
    return { key: w.date, weekday: first.toFormat("ccc"), date: first.toFormat("LLL d"), byKey };
  });

  const keys = [...new Set(cols.flatMap((c) => [...c.byKey.keys()]))].sort((a, b) => a - b);

  const columns: GridColumn[] = cols.map((c) => ({
    key: c.key,
    weekday: c.weekday,
    date: c.date,
    cells: keys.map((k) => {
      const t = c.byKey.get(k);
      return t === undefined
        ? { start: -k, inRange: false, title: "" }
        : { start: t, inRange: true, title: DateTime.fromMillis(t, { zone }).toFormat("ccc LLL d, h:mm a") };
    }),
  }));

  const anyOnHour = keys.some((k) => k % 60 === 0);
  const rowLabels = keys.map((k, i) => {
    if (anyOnHour ? k % 60 !== 0 : i % 2 !== 0) return null;
    const t = DateTime.fromObject({ hour: Math.floor((k % 1440) / 60), minute: k % 60 });
    return t.toFormat(t.minute === 0 ? "h a" : "h:mm a");
  });

  return { columns, rowLabels };
}

// ---------- slots ⇄ blocks ----------

export function blocksToSlots(blocks: Block[], stepMin: number): Set<number> {
  const out = new Set<number>();
  for (const b of blocks) {
    for (let t = Date.parse(b.start); t < Date.parse(b.end); t += stepMin * MINUTE) out.add(t);
  }
  return out;
}

export function slotsToBlocks(slots: Set<number>, stepMin: number): Block[] {
  const sorted = [...slots].sort((a, b) => a - b);
  const blocks: Block[] = [];
  let start: number | null = null;
  let prev = 0;
  for (const t of sorted) {
    if (start === null) start = t;
    else if (t !== prev + stepMin * MINUTE) {
      blocks.push({ start: new Date(start).toISOString(), end: new Date(prev + stepMin * MINUTE).toISOString() });
      start = t;
    }
    prev = t;
  }
  if (start !== null) blocks.push({ start: new Date(start).toISOString(), end: new Date(prev + stepMin * MINUTE).toISOString() });
  return blocks;
}

// ---------- formatting ----------

/** "Tue Oct 6, 8:00 – 11:00 PM" or "Tue Oct 6, 10:00 PM – Wed 1:00 AM". */
export function formatRange(startMs: number, endMs: number, zone: string): string {
  const a = DateTime.fromMillis(startMs, { zone });
  const b = DateTime.fromMillis(endMs, { zone });
  if (a.hasSame(b, "day")) {
    return a.toFormat("a") === b.toFormat("a")
      ? `${a.toFormat("ccc LLL d, h:mm")} – ${b.toFormat("h:mm a")}`
      : `${a.toFormat("ccc LLL d, h:mm a")} – ${b.toFormat("h:mm a")}`;
  }
  return `${a.toFormat("ccc LLL d, h:mm a")} – ${b.toFormat("ccc h:mm a")}`;
}

export function formatTime(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat("ccc LLL d, h:mm a");
}

export function zoneLabel(zone: string, atMs = Date.now()): string {
  const abbr = DateTime.fromMillis(atMs, { zone }).toFormat("ZZZZ");
  return `${zone.replace(/_/g, " ")} (${abbr})`;
}

/** "5 PM", "12 AM", "5:30 PM" for minutes after midnight. */
export function minuteLabel(minute: number): string {
  const t = DateTime.fromObject({ hour: Math.floor(minute / 60) % 24, minute: minute % 60 });
  return t.toFormat(t.minute === 0 ? "h a" : "h:mm a");
}

export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} hr` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}
