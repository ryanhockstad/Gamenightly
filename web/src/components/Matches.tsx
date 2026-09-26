import { useState } from "react";
import type { MatchWindow, SessionView } from "../api";
import { formatRange, formatTime } from "../time";

const MINUTE = 60_000;
const TOP_N = 3;

interface Props {
  view: SessionView;
  zone: string;
  meId?: string;
  /** Present when the viewer is the organizer and the session is collecting. */
  onConfirm?: (startIso: string) => Promise<void>;
}

export function Matches({ view, zone, meId, onConfirm }: Props) {
  const { windows, responded_count, max_participants } = view.matches;
  const names = new Map(view.participants.map((p) => [p.id, p.display_name]));

  return (
    <section className="card">
      <div className="section-head">
        <h2>Best times</h2>
        <span className={`pill${responded_count < max_participants ? " pill-warn" : " pill-ok"}`}>
          {responded_count} of {max_participants} responded
        </span>
      </div>
      <ul className="roster" aria-label="Players">
        {view.participants.map((p) => (
          <li key={p.id} className={p.responded ? "roster-in" : "roster-waiting"} title={p.responded ? "Responded" : "Hasn't responded yet"}>
            <span className="dot" aria-hidden />
            {p.display_name}
            {p.id === meId && <span className="you"> (you)</span>}
          </li>
        ))}
        {view.max_participants > view.participants.length && (
          <li className="roster-open">
            {view.max_participants - view.participants.length} open spot{view.max_participants - view.participants.length === 1 ? "" : "s"}
          </li>
        )}
      </ul>

      {view.status === "collecting" && responded_count < max_participants && windows.length > 0 && (
        <p className="hint">Still waiting on some of the group, so these may change.</p>
      )}

      {windows.length === 0 ? (
        <p className="empty">
          {responded_count === 0 ? "No one has marked availability yet." : "No overlapping times yet."}
        </p>
      ) : (
        <ol className="matches">
          {windows.slice(0, TOP_N).map((w) => (
            <MatchRow
              key={w.first_start + w.available_ids.join()}
              w={w}
              view={view}
              zone={zone}
              names={names}
              onConfirm={onConfirm}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function MatchRow({
  w,
  view,
  zone,
  names,
  onConfirm,
}: {
  w: MatchWindow;
  view: SessionView;
  zone: string;
  names: Map<string, string>;
  onConfirm?: (startIso: string) => Promise<void>;
}) {
  const first = Date.parse(w.first_start);
  const last = Date.parse(w.last_start);
  const step = view.slot_step_minutes * MINUTE;
  const starts: number[] = [];
  for (let t = first; t <= last; t += step) starts.push(t);
  const [pick, setPick] = useState(first);
  const [busy, setBusy] = useState(false);

  const everyone = w.available_ids.length === view.max_participants;
  const label = everyone
    ? `All ${view.max_participants} free`
    : `${w.available_ids.length} of ${view.max_participants} free`;

  return (
    <li className={`match${everyone ? " match-full" : ""}`}>
      <div className="match-main">
        <div className="match-when">{formatRange(first, last + view.duration_minutes * MINUTE, zone)}</div>
        <div className="match-count">{label}</div>
      </div>
      <div className="match-people">
        {w.available_ids.map((id) => (
          <span key={id} className="chip chip-in">
            ✓ {names.get(id)}
          </span>
        ))}
        {w.missing_ids.map((id) => (
          <span key={id} className="chip chip-out">
            ✗ {names.get(id)}
          </span>
        ))}
      </div>
      {onConfirm && (
        <div className="match-confirm">
          {starts.length > 1 && (
            <select value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Start time">
              {starts.map((t) => (
                <option key={t} value={t}>
                  Start {formatTime(t, zone)}
                </option>
              ))}
            </select>
          )}
          <button
            className="btn btn-small btn-primary"
            aria-label={`Confirm ${formatTime(pick, zone)}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(new Date(pick).toISOString());
              } finally {
                setBusy(false);
              }
            }}
          >
            Confirm
          </button>
        </div>
      )}
    </li>
  );
}
