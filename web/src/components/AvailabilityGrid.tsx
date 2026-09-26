import { useEffect, useState } from "react";
import { heatColor } from "../heat";
import type { Grid } from "../time";

interface Props {
  grid: Grid;
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
  disabled?: boolean;
  /** Other players free at each slot (UTC ms → names). Drives the overlap heat. */
  others?: Map<number, string[]>;
  /** Intended group size; everyone free = full gold. */
  groupSize: number;
}

/**
 * Paint-to-select grid. Press on a cell and drag: every in-range cell in the rectangle between the
 * start cell and the current cell is painted. If the start cell was free you paint "free",
 * otherwise you erase. Works with mouse and touch. Cells are keyed by UTC slot start.
 */
export function AvailabilityGrid({ grid, selected, onChange, disabled, others, groupSize }: Props) {
  const [drag, setDrag] = useState<{ mode: "add" | "remove"; col: number; row: number } | null>(null);
  const [preview, setPreview] = useState<Set<number> | null>(null);
  const shown = preview ?? selected;

  const cellAt = (x: number, y: number): { col: number; row: number } | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-col]");
    return el ? { col: Number(el.dataset.col), row: Number(el.dataset.row) } : null;
  };

  const paint = (d: { mode: "add" | "remove"; col: number; row: number }, to: { col: number; row: number }) => {
    const next = new Set(selected);
    const [c0, c1] = [Math.min(d.col, to.col), Math.max(d.col, to.col)];
    const [r0, r1] = [Math.min(d.row, to.row), Math.max(d.row, to.row)];
    for (let c = c0; c <= c1; c++)
      for (let r = r0; r <= r1; r++) {
        const cell = grid.columns[c].cells[r];
        if (!cell.inRange) continue;
        if (d.mode === "add") next.add(cell.start);
        else next.delete(cell.start);
      }
    return next;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    const at = cellAt(e.clientX, e.clientY);
    if (!at) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const start = grid.columns[at.col].cells[at.row].start;
    const d = { mode: selected.has(start) ? ("remove" as const) : ("add" as const), ...at };
    setDrag(d);
    setPreview(paint(d, at));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const at = cellAt(e.clientX, e.clientY);
    if (at) setPreview(paint(drag, at));
  };

  const finish = () => {
    if (!drag) return;
    if (preview) onChange(preview);
    setDrag(null);
    setPreview(null);
  };

  // Keyboard: Space/Enter toggles the focused cell.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || (e.key !== " " && e.key !== "Enter")) return;
    const slot = (e.target as HTMLElement).dataset.slot;
    if (!slot) return;
    e.preventDefault();
    const t = Number(slot);
    const next = new Set(selected);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    onChange(next);
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

  const rows = grid.rowLabels.length;

  return (
    <div className="grid-scroll">
      <div
        className={`grid${disabled ? " grid-disabled" : ""}`}
        style={{ gridTemplateColumns: `4.5rem repeat(${grid.columns.length}, minmax(2.75rem, 1fr))` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
        role="grid"
        aria-label="Availability. Press or drag across cells to mark when you're free."
      >
        <div className="grid-corner" />
        {grid.columns.map((c) => (
          <div key={c.key} className="grid-head" role="columnheader">
            <span className="grid-weekday">{c.weekday}</span>
            <span className="grid-date">{c.date}</span>
          </div>
        ))}
        {Array.from({ length: rows }, (_, i) => (
          <Row key={i} i={i} grid={grid} shown={shown} disabled={disabled} others={others} groupSize={groupSize} />
        ))}
      </div>
    </div>
  );
}

function Row({
  i,
  grid,
  shown,
  disabled,
  others,
  groupSize,
}: {
  i: number;
  grid: Grid;
  shown: Set<number>;
  disabled?: boolean;
  others?: Map<number, string[]>;
  groupSize: number;
}) {
  return (
    <>
      <div className={`grid-label${i % 2 === 0 ? " grid-label-hour" : ""}`}>{grid.rowLabels[i]}</div>
      {grid.columns.map((c, col) => {
        const cell = c.cells[i];
        if (!cell.inRange) return <div key={c.key} className="cell cell-out" aria-hidden />;
        const on = shown.has(cell.start);
        const names = others?.get(cell.start) ?? [];
        const free = names.length + (on ? 1 : 0);
        // Yours: solid heat color. Others only: a faint tint of theirs, so you can see where to join.
        const style = on
          ? { "--c": heatColor(free, groupSize) }
          : names.length
            ? { "--c": `color-mix(in srgb, ${heatColor(names.length, groupSize)} 38%, var(--cell))` }
            : undefined;
        const who = [...(on ? ["You"] : []), ...names];
        return (
          <div
            key={c.key}
            role="gridcell"
            aria-selected={on}
            aria-label={`${cell.title}${who.length ? `, free: ${who.join(", ")}` : ""}`}
            title={who.length ? `${cell.title}\nFree: ${who.join(", ")}` : cell.title}
            tabIndex={disabled ? -1 : 0}
            data-slot={cell.start}
            data-col={col}
            data-row={i}
            style={style as React.CSSProperties | undefined}
            className={`cell${on ? " cell-on" : names.length ? " cell-others" : ""}${i % 2 === 0 ? " cell-hour" : ""}`}
          />
        );
      })}
    </>
  );
}
