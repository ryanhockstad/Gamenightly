import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, type SessionView } from "../api";
import { AvailabilityGrid } from "../components/AvailabilityGrid";
import { heatColor } from "../heat";
import { CopyButton } from "../components/CopyButton";
import { GameCover } from "../components/GamePicker";
import { Matches } from "../components/Matches";
import type { Prefill } from "./CreatePage";
import { absorbHash, editLink, organizerLink, saveIdentity, shareLink, type Identity } from "../identity";
import {
  allTimezones,
  blocksToSlots,
  buildGrid,
  detectTimezone,
  durationLabel,
  formatRange,
  slotsToBlocks,
  zoneLabel,
} from "../time";

const POLL_MS = 15_000;
const SAVE_DELAY_MS = 400;

export function SessionPage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<Identity>(() => absorbHash(slug));
  const [view, setView] = useState<SessionView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await api.getSession(slug));
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError) setLoadError(err);
    }
  }, [slug]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => document.visibilityState === "visible" && refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const me = view?.participants.find((p) => p.id === identity.participantId);
  const zone = identity.displayZone ?? me?.timezone ?? detectTimezone();
  const isOrganizer = !!identity.organizerToken;

  const update = (patch: Partial<Identity>) => setIdentity(saveIdentity(slug, patch));

  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Something went wrong.");
    }
    await refresh();
  };

  if (loadError?.code === "not_found")
    return (
      <main className="page narrow">
        <h1>Session not found</h1>
        <p className="lede">This link may be mistyped, or the session expired.</p>
        <Link className="btn" to="/">
          Start a new session
        </Link>
      </main>
    );
  if (!view)
    return (
      <main className="page narrow">
        {loadError ? <p className="error">{loadError.message}</p> : <p className="empty">Loading…</p>}
      </main>
    );

  const collecting = view.status === "collecting";
  const full = view.participants.length >= view.max_participants;

  const cancel = async () => {
    if (!confirm("Cancel this session for everyone?")) return;
    setActionError(null);
    try {
      await api.cancel(slug, identity.organizerToken!);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Something went wrong.");
      return;
    }
    // Restart the flow: back to create, prefilled with this session's details.
    const prefill: Prefill = {
      title: view.title,
      game: view.game ? { name: view.game, igdbId: view.game_igdb_id ?? null, coverUrl: view.game_cover_url ?? null } : null,
      durationMinutes: view.duration_minutes,
      maxParticipants: view.max_participants,
      timezone: view.organizer_timezone,
      earliestMinute: view.earliest_minute,
      latestMinute: view.latest_minute,
    };
    navigate("/", { state: { prefill, canceledTitle: view.title } });
  };

  return (
    <main className="page">
      <header className="session-head">
        <h1>{view.title}</h1>
        <p className="meta">
          {view.game && (
            <span className="meta-game">
              {view.game_igdb_id != null && <GameCover name={view.game} url={view.game_cover_url} />}
              {view.game}
            </span>
          )}
          <span>{durationLabel(view.duration_minutes)}</span>
          <ZoneInline zone={zone} onChange={(z) => update({ displayZone: z })} />
        </p>
      </header>

      <StatusBanner view={view} zone={zone} />
      {actionError && <p className="error">{actionError}</p>}

      {isOrganizer && (
        <ShareBar
          view={view}
          token={identity.organizerToken!}
          onReopen={() => run(() => api.reopen(slug, identity.organizerToken!))}
          onCancel={cancel}
        />
      )}

      <div className="layout">
        <div className="layout-main">
          {me ? (
            <MyAvailability key={me.id} view={view} zone={zone} identity={identity} onSaved={refresh} />
          ) : collecting && !full ? (
            <JoinForm
              isOrganizer={isOrganizer}
              onJoin={async (name) => {
                const res = await api.join(slug, { display_name: name, timezone: zone }, identity.organizerToken);
                update({ participantId: res.participant_id, editToken: res.edit_token, displayZone: zone });
                await refresh();
              }}
            />
          ) : (
            <section className="card">
              <p className="empty">
                {!collecting
                  ? "This session is no longer collecting availability."
                  : `This session is full (${view.max_participants} players).`}
              </p>
            </section>
          )}
        </div>

        {view.status !== "canceled" && (
          <aside className="layout-side">
            <Matches
              view={view}
              zone={zone}
              meId={identity.participantId}
              onConfirm={
                isOrganizer && collecting ? (start) => run(() => api.confirm(slug, identity.organizerToken!, start)) : undefined
              }
            />
          </aside>
        )}
      </div>
    </main>
  );
}

// ---------- pieces ----------

function StatusBanner({ view, zone }: { view: SessionView; zone: string }) {
  if (view.status === "confirmed") {
    const when = formatRange(Date.parse(view.confirmed_start_utc!), Date.parse(view.confirmed_end_utc!), zone);
    return (
      <section className="banner banner-ok">
        <div>
          <strong>Game on.</strong> {when}
        </div>
        <a className="btn btn-small" href={api.icsUrl(view.public_slug)} download={api.icsFilename(view.title)}>
          Add to calendar (.ics)
        </a>
      </section>
    );
  }
  if (view.status === "canceled") {
    return (
      <section className="banner banner-bad">
        <div>
          <strong>Canceled.</strong> The organizer canceled this session.
        </div>
        <Link className="btn btn-small" to="/">
          Start a new session
        </Link>
      </section>
    );
  }
  return null;
}

/** Organizer's one-line bar: the share link front and center, everything else in a menu. */
function ShareBar({
  view,
  token,
  onReopen,
  onCancel,
}: {
  view: SessionView;
  token: string;
  onReopen: () => void;
  onCancel: () => void;
}) {
  const share = shareLink(view.public_slug);
  const canceled = view.status === "canceled";
  const menu = useRef<HTMLDetailsElement>(null);

  // Close the ⋯ menu on any click outside it (clicks inside keep it open so "Copied ✓" shows).
  useEffect(() => {
    const close = (e: MouseEvent) => {
      const el = menu.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  const waiting = view.status === "collecting" && view.participants.length <= 1;
  const when =
    view.status === "confirmed"
      ? ` We're on for ${formatRange(Date.parse(view.confirmed_start_utc!), Date.parse(view.confirmed_end_utc!), view.organizer_timezone)} (${zoneLabel(view.organizer_timezone)}).`
      : "";
  const message =
    view.status === "confirmed"
      ? `GameNightly${view.game ? `: ${view.game}` : ""}!${when} Details and calendar invite: ${share}`
      : `GameNightly${view.game ? `: ${view.game}` : ""}! Mark when you're free: ${share}`;

  return (
    <section className={`share-bar${waiting ? " share-first" : ""}`}>
      <span className="share-label">{waiting ? "Send this link to your group" : "Share link"}</span>
      <code>{share}</code>
      {!canceled && <CopyButton text={share} label="Copy link" primary={waiting} />}
      {!canceled && !view.has_webhook && <CopyButton text={message} label="Copy invite" />}
      <details className="menu" ref={menu}>
        <summary className="btn btn-small" aria-label="Organizer options">
          ⋯
        </summary>
        <div className="menu-list">
          <CopyButton text={organizerLink(view.public_slug, token)} label="Copy organizer link" plain />
          {view.status === "confirmed" && (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                menu.current?.removeAttribute("open");
                onReopen();
              }}
            >
              Reschedule
            </button>
          )}
          {!canceled && (
            <button type="button" className="menu-item menu-danger" onClick={onCancel}>
              Cancel session
            </button>
          )}
        </div>
      </details>
    </section>
  );
}

function JoinForm({ isOrganizer, onJoin }: { isOrganizer: boolean; onJoin: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="card form join"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onJoin(name.trim());
        } catch (err) {
          setError(err instanceof ApiError ? err.message : "Something went wrong.");
          setBusy(false);
        }
      }}
    >
      <h2>{isOrganizer ? "Add your availability" : "Join this session"}</h2>
      <div className="join-row">
        <input
          required
          maxLength={32}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          autoFocus
        />
        <button className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy ? "Joining…" : "Continue"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** Paint grid that saves itself a moment after each change. */
function MyAvailability({
  view,
  zone,
  identity,
  onSaved,
}: {
  view: SessionView;
  zone: string;
  identity: Identity;
  onSaved: () => Promise<void>;
}) {
  const me = view.participants.find((p) => p.id === identity.participantId)!;
  const step = view.slot_step_minutes;
  const [selected, setSelected] = useState(() => blocksToSlots(me.blocks, step));
  const [state, setState] = useState<"idle" | "pending" | "saving" | "saved" | "error">(me.responded ? "saved" : "idle");
  const [error, setError] = useState<string | null>(null);
  const grid = useMemo(() => buildGrid(view, zone), [view, zone]);
  const locked = view.status !== "collecting";

  // Who else is free at each slot, for the overlap heat. Refreshes with each poll.
  const others = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const p of view.participants) {
      if (p.id === me.id || !p.responded) continue;
      for (const t of blocksToSlots(p.blocks, step)) map.set(t, [...(map.get(t) ?? []), p.display_name]);
    }
    return map;
  }, [view.participants, me.id, step]);

  const pending = useRef<Set<number> | null>(null);
  const inflight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Saves the latest grid state; keeps going while newer changes arrive mid-save.
  const flush = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setError(null);
    try {
      while (pending.current) {
        const toSave = pending.current;
        pending.current = null;
        setState("saving");
        try {
          await api.saveAvailability(view.public_slug, me.id, identity.editToken!, slotsToBlocks(toSave, step));
        } catch (err) {
          pending.current ??= toSave;
          setState("error");
          setError(err instanceof ApiError ? err.message : "Couldn't save.");
          return;
        }
      }
      setState("saved");
    } finally {
      inflight.current = false;
    }
    // Refresh matches after releasing the lock, so edits made meanwhile save on their own timer.
    await onSaved();
  }, [view.public_slug, me.id, identity.editToken, step, onSaved]);

  const change = (next: Set<number>) => {
    setSelected(next);
    pending.current = next;
    setState("pending");
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
  };

  // Warn before leaving while a save is pending.
  useEffect(() => {
    if (state !== "pending" && state !== "saving" && state !== "error") return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [state]);

  return (
    <section className="card">
      <div className="section-head">
        <h2>{locked ? "Your availability" : "When are you free?"}</h2>
        {!locked && (
          <span className={`save-state${state === "error" ? " error" : ""}`} aria-live="polite">
            {state === "pending" || state === "saving" ? "Saving…" : state === "saved" ? "Saved ✓" : state === "error" ? "Not saved" : ""}
          </span>
        )}
      </div>
      <p className="hint">
        {locked
          ? view.status === "confirmed"
            ? "Locked because the time is confirmed. The organizer can reopen it to reschedule."
            : ""
          : `Tap or drag across the times you could play, ${me.display_name}.`}
      </p>

      <AvailabilityGrid
        grid={grid}
        selected={selected}
        onChange={change}
        disabled={locked}
        others={others}
        groupSize={view.max_participants}
      />
      <HeatLegend groupSize={view.max_participants} />

      {error && (
        <p className="error">
          {error}{" "}
          <button type="button" className="link-btn" onClick={() => void flush()}>
            Try again
          </button>
        </p>
      )}
      {!locked && !me.responded && selected.size === 0 && state === "idle" && (
        <button type="button" className="link-btn" onClick={() => change(new Set())}>
          None of these times work for me
        </button>
      )}

      <div className="link-row subtle">
        <span className="hint">Editing from another device? Use your personal link.</span>
        <CopyButton text={editLink(view.public_slug, me.id, identity.editToken!)} label="Copy my link" />
      </div>
    </section>
  );
}

function HeatLegend({ groupSize }: { groupSize: number }) {
  const stops = Array.from({ length: groupSize }, (_, i) => heatColor(i + 1, groupSize));
  return (
    <div className="heat-legend" aria-hidden>
      <span className="heat-scale">
        Just you
        <span className="heat-bar" style={{ background: `linear-gradient(90deg, ${stops.join(", ")})` }} />
        All {groupSize} free
      </span>
      <span className="heat-faint">
        <i style={{ background: `color-mix(in srgb, ${heatColor(1, groupSize)} 38%, var(--cell))` }} />
        Others free, not you
      </span>
    </div>
  );
}

/** "Times in America/Los Angeles (PDT)" with the zone name as an inline picker. */
function ZoneInline({ zone, onChange }: { zone: string; onChange: (z: string) => void }) {
  const zones = useMemo(() => allTimezones(), []);
  return (
    <label className="zone-inline">
      <span>Times in</span>
      <select value={zone} onChange={(e) => onChange(e.target.value)} aria-label="Time zone">
        {!zones.includes(zone) && <option value={zone}>{zone}</option>}
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </label>
  );
}
