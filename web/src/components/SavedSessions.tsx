import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type SessionView } from "../api";
import { forgetSession, savedSessions } from "../identity";
import { detectTimezone, formatRange } from "../time";

interface Row {
  slug: string;
  role: "Organizer" | "Player";
  view: SessionView;
}

/** Sessions this browser created or joined. Expired or deleted sessions are dropped from storage. */
export function SavedSessions() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    const saved = savedSessions();
    Promise.all(
      saved.map(async ({ slug, identity }) => {
        try {
          const view = await api.getSession(slug);
          return { slug, role: identity.organizerToken ? "Organizer" : "Player", view } as Row;
        } catch (err) {
          if (err instanceof ApiError && err.code === "not_found") forgetSession(slug);
          return null;
        }
      }),
    ).then((r) => setRows(r.filter((x): x is Row => x !== null)));
  }, []);

  if (!rows?.length) return null;
  const zone = detectTimezone();

  return (
    <section className="card">
      <h2>Your sessions</h2>
      <ul className="saved">
        {rows.map(({ slug, role, view }) => (
          <li key={slug} className={view.status === "canceled" ? "saved-dim" : undefined}>
            <Link to={`/s/${slug}`} className="saved-link">
              <span className="saved-title">
                {view.title}
                {view.game && <span className="hint"> · {view.game}</span>}
              </span>
              <span className="hint">
                {view.status === "confirmed"
                  ? formatRange(Date.parse(view.confirmed_start_utc!), Date.parse(view.confirmed_end_utc!), zone)
                  : view.status === "canceled"
                    ? "Canceled"
                    : `${view.matches.responded_count} of ${view.max_participants} responded`}
              </span>
            </Link>
            <span className={`pill${view.status === "confirmed" ? " pill-ok" : view.status === "collecting" ? " pill-warn" : ""}`}>
              {view.status === "collecting" ? "Picking a time" : view.status === "confirmed" ? "Confirmed" : "Canceled"}
            </span>
            <span className="tag">{role}</span>
          </li>
        ))}
      </ul>
      <p className="hint">Saved in this browser only.</p>
    </section>
  );
}
