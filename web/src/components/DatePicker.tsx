import { DateTime } from "luxon";
import { useEffect, useState } from "react";

interface Props {
  zone: string;
  value: Set<string>; // YYYY-MM-DD
  onChange: (next: Set<string>) => void;
  /** Max days from first to last selected date, inclusive. */
  maxSpanDays: number;
  weeks?: number;
}

/**
 * when2meet-style calendar: click a day to toggle it, or drag across days to select a block.
 * Starts at the current week (Monday first); past days are disabled.
 */
export function DatePicker({ zone, value, onChange, maxSpanDays, weeks = 5 }: Props) {
  const today = DateTime.now().setZone(zone).startOf("day");
  // Weeks run Monday → Sunday. Luxon weekday: Mon=1 … Sun=7.
  const firstDay = today.minus({ days: today.weekday - 1 });
  const days = Array.from({ length: weeks * 7 }, (_, i) => firstDay.plus({ days: i }));
  const [drag, setDrag] = useState<{ mode: "add" | "remove"; from: number; base: Set<string> } | null>(null);
  const [preview, setPreview] = useState<Set<string> | null>(null);
  const [tooWide, setTooWide] = useState(false);
  const shown = preview ?? value;

  const indexAt = (x: number, y: number): number | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-day]");
    return el ? Number(el.dataset.day) : null;
  };

  // Rectangle between the start day and the current day, like dragging on a calendar.
  const apply = (d: NonNullable<typeof drag>, to: number) => {
    const [r0, r1] = [Math.floor(d.from / 7), Math.floor(to / 7)].sort((a, b) => a - b);
    const [c0, c1] = [d.from % 7, to % 7].sort((a, b) => a - b);
    const next = new Set(d.base);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const day = days[r * 7 + c];
        if (day < today) continue;
        const iso = day.toISODate()!;
        if (d.mode === "add") next.add(iso);
        else next.delete(iso);
      }
    return next;
  };

  const span = (s: Set<string>) => {
    if (s.size < 2) return s.size;
    const sorted = [...s].sort();
    return DateTime.fromISO(sorted[sorted.length - 1]).diff(DateTime.fromISO(sorted[0]), "days").days + 1;
  };

  const finish = () => {
    if (!drag || !preview) return;
    if (span(preview) > maxSpanDays) setTooWide(true);
    else {
      setTooWide(false);
      onChange(preview);
    }
    setDrag(null);
    setPreview(null);
  };

  useEffect(() => {
    if (!drag) return;
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  });

  return (
    <div className="datepicker">
      <div
        className="dp-grid"
        role="grid"
        aria-label="Pick dates. Click or drag across days."
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const i = indexAt(e.clientX, e.clientY);
          if (i === null || days[i] < today) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const d = { mode: value.has(days[i].toISODate()!) ? ("remove" as const) : ("add" as const), from: i, base: value };
          setDrag(d);
          setPreview(apply(d, i));
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const i = indexAt(e.clientX, e.clientY);
          if (i !== null) setPreview(apply(drag, i));
        }}
        onKeyDown={(e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          const iso = (e.target as HTMLElement).dataset.iso;
          if (!iso) return;
          e.preventDefault();
          const next = new Set(value);
          if (next.has(iso)) next.delete(iso);
          else next.add(iso);
          if (span(next) > maxSpanDays) return setTooWide(true);
          setTooWide(false);
          onChange(next);
        }}
      >
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <div key={i} className="dp-dow" aria-hidden>
            {d}
          </div>
        ))}
        {days.map((day, i) => {
          const iso = day.toISODate()!;
          const past = day < today;
          const on = shown.has(iso);
          const newMonth = day.day === 1 || i === 0;
          return (
            <div
              key={iso}
              data-day={i}
              data-iso={iso}
              role="gridcell"
              aria-selected={on}
              aria-disabled={past}
              aria-label={day.toFormat("cccc, LLLL d")}
              tabIndex={past ? -1 : 0}
              className={`dp-day${on ? " dp-on" : ""}${past ? " dp-past" : ""}${day.hasSame(today, "day") ? " dp-today" : ""}`}
            >
              {newMonth && <span className="dp-month">{day.toFormat("LLL")}</span>}
              {day.day}
            </div>
          );
        })}
      </div>
      <p className={tooWide ? "error" : "hint"}>
        {tooWide
          ? `Pick dates within ${maxSpanDays} days of each other.`
          : value.size
            ? `${value.size} date${value.size === 1 ? "" : "s"} selected. Click or drag to change.`
            : "Click or drag to pick dates."}
      </p>
    </div>
  );
}
