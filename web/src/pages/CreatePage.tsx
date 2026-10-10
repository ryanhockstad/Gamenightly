import { DateTime } from "luxon";
import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { DatePicker } from "../components/DatePicker";
import { GamePicker, type GameValue } from "../components/GamePicker";
import { SavedSessions } from "../components/SavedSessions";
import { saveIdentity } from "../identity";
import { allTimezones, detectTimezone, durationLabel, minuteLabel } from "../time";

const DURATIONS = [60, 90, 120, 150, 180, 240, 300, 360];
const HOURS = Array.from({ length: 24 }, (_, h) => h * 60);
const MAX_SPAN_DAYS = 35;

/** Details carried over when an organizer cancels and starts again. */
export interface Prefill {
  title: string;
  game: GameValue | null;
  durationMinutes: number;
  maxParticipants: number;
  timezone: string;
  earliestMinute?: number;
  latestMinute?: number;
}

function nextDays(zone: string, n: number): Set<string> {
  const today = DateTime.now().setZone(zone).startOf("day");
  return new Set(Array.from({ length: n }, (_, i) => today.plus({ days: i }).toISODate()!));
}

export function CreatePage() {
  const navigate = useNavigate();
  const { state } = useLocation() as { state: { prefill?: Prefill; canceledTitle?: string } | null };
  const prefill = state?.prefill;
  const [tz, setTz] = useState(() => prefill?.timezone ?? detectTimezone());
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [game, setGame] = useState<GameValue>(prefill?.game ?? { name: "", igdbId: null, coverUrl: null });
  const [dates, setDates] = useState(() => nextDays(prefill?.timezone ?? detectTimezone(), 7));
  const [earliest, setEarliest] = useState(prefill?.earliestMinute ?? 17 * 60);
  const [latest, setLatest] = useState(prefill?.latestMinute ?? 2 * 60);
  const [duration, setDuration] = useState(prefill?.durationMinutes ?? 120);
  const [players, setPlayers] = useState(prefill?.maxParticipants ?? 4);
  const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => allTimezones(), []);

  const windowMinutes = latest > earliest ? latest - earliest : 1440 - earliest + latest;
  const tooShort = duration > windowMinutes;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dates.size) return setError("Pick at least one date.");
    if (tooShort) return setError("The session is longer than the time window.");
    setError(null);
    setBusy(true);
    try {
      const res = await api.createSession({
        title: title.trim(),
        game: game.name.trim() || null,
        game_igdb_id: game.igdbId,
        duration_minutes: duration,
        dates: [...dates].sort(),
        earliest_minute: earliest,
        latest_minute: latest,
        organizer_timezone: tz,
        max_participants: players,
        discord_webhook_url: webhook.trim() || null,
      });
      saveIdentity(res.public_slug, { organizerToken: res.organizer_token, displayZone: tz });
      navigate(`/s/${res.public_slug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <h1>
        Find a time to <span className="accent">play</span>
      </h1>
      {state?.canceledTitle && (
        <p className="banner banner-bad">“{state.canceledTitle}” was canceled. Pick new dates to try again.</p>
      )}

      <form className="card form" onSubmit={submit}>
        <label>
          <span className="field-label">Session name</span>
          <input required maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Friday raid" autoFocus />
        </label>

        <div className="row">
          <label>
            <span className="field-label">
              Game <span className="optional">optional</span>
            </span>
            <GamePicker value={game} onChange={setGame} />
          </label>
          <label>
            <span className="field-label">Play for</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {durationLabel(d)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label>
          <span className="field-label">Players</span>
          <select value={players} onChange={(e) => setPlayers(Number(e.target.value))}>
            {[2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n} including you
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span className="field-label">What dates might work?</span>
          <DatePicker zone={tz} value={dates} onChange={setDates} maxSpanDays={MAX_SPAN_DAYS} />
        </div>

        <div className="field">
          <span className="field-label">What times might work?</span>
          <div className="row">
            <label>
              <span className="hint">No earlier than</span>
              <select value={earliest} onChange={(e) => setEarliest(Number(e.target.value))}>
                {HOURS.map((m) => (
                  <option key={m} value={m}>
                    {minuteLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="hint">No later than</span>
              <select value={latest} onChange={(e) => setLatest(Number(e.target.value))}>
                {HOURS.map((m) => (
                  <option key={m} value={m}>
                    {minuteLabel(m)}
                    {m <= earliest ? " (next day)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className={tooShort ? "error" : "hint"}>
            {tooShort
              ? `That window is shorter than a ${durationLabel(duration)} session.`
              : `Times in ${tz.replace(/_/g, " ")}. Players see them in their own time zone.`}
          </p>
        </div>

        <details className="more">
          <summary>More options</summary>
          <div className="more-body">
            <label>
              <span className="field-label">Your time zone</span>
              <select value={tz} onChange={(e) => setTz(e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">Discord webhook URL</span>
              <input
                type="url"
                value={webhook}
                onChange={(e) => setWebhook(e.target.value)}
                placeholder="https://discord.com/api/webhooks/…"
              />
              <span className="hint">Posts updates to a channel. Find it under Channel settings → Integrations → Webhooks.</span>
            </label>
          </div>
        </details>

        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Creating…" : "Create session"}
        </button>
      </form>

      <SavedSessions />
    </main>
  );
}
