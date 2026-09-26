// Daily availability windows: the organizer picks dates plus "no earlier than" / "no later than"
// times (organizer's zone), like when2meet. A latest time at or before the earliest time means the
// window runs past midnight into the next day (equal times = a full 24 hours).
import { DateTime } from "luxon";
import { mergeBlocks, type Block } from "./matching.js";

const MINUTE = 60_000;

export interface WindowSpec {
  dates: string[]; // YYYY-MM-DD in the organizer's zone
  earliestMinute: number; // 0–1439, minutes after local midnight
  latestMinute: number; // 0–1439
  timezone: string;
  stepMinutes: number;
}

export interface DayWindow extends Block {
  date: string;
}

const snap = (ms: number, step: number) => Math.round(ms / (step * MINUTE)) * step * MINUTE;

/** One UTC window per date, in date order. Ends are computed in wall time, so DST is handled. */
export function dayWindows(spec: WindowSpec): DayWindow[] {
  const crosses = spec.latestMinute <= spec.earliestMinute;
  return [...spec.dates].sort().map((date) => {
    const day = DateTime.fromISO(date, { zone: spec.timezone }).startOf("day");
    // Set wall-clock times; adding minutes to midnight would drift by an hour on DST days.
    const at = (d: DateTime, minute: number) => d.set({ hour: Math.floor(minute / 60), minute: minute % 60 });
    const start = at(day, spec.earliestMinute);
    const end = at(crosses ? day.plus({ days: 1 }) : day, spec.latestMinute);
    // Snap to the slot step so zones like +5:45 still line up with UTC slots.
    return {
      date,
      start: new Date(snap(start.toMillis(), spec.stepMinutes)),
      end: new Date(snap(end.toMillis(), spec.stepMinutes)),
    };
  });
}

/** Windows merged where they touch (e.g. consecutive 24-hour days). */
export function mergedWindows(spec: WindowSpec): Block[] {
  return mergeBlocks(dayWindows(spec));
}

/** True when [start, end) lies entirely inside one merged window. */
export function withinWindows(windows: Block[], start: Date, end: Date): boolean {
  return windows.some((w) => w.start <= start && end <= w.end);
}

export function windowLengthMinutes(earliestMinute: number, latestMinute: number): number {
  return latestMinute > earliestMinute ? latestMinute - earliestMinute : 1440 - earliestMinute + latestMinute;
}

export const isIsoDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s, { zone: "UTC" }).isValid;
