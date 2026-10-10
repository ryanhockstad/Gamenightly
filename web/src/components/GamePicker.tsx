import { useEffect, useId, useState } from "react";
import { api, type Game } from "../api";

/** The game on a session: picked from search (igdbId set) or typed freely (igdbId null). */
export interface GameValue {
  name: string;
  igdbId: number | null;
  coverUrl: string | null;
}

/** Box art, or the game's first letter when there's no cover. */
export function GameCover({ name, url, className = "" }: { name: string; url: string | null; className?: string }) {
  return url ? (
    <img className={`game-cover ${className}`} src={url} alt="" loading="lazy" />
  ) : (
    <span className={`game-cover game-cover-blank ${className}`} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Game field with search-as-you-type. Picking a result links the session to that IGDB game;
 * anything else typed is kept as a plain name, so a missing game never blocks anyone. If search
 * fails, it quietly acts like a normal text field.
 */
export function GamePicker({ value, onChange }: { value: GameValue; onChange: (v: GameValue) => void }) {
  const listId = useId();
  const [results, setResults] = useState<Game[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState<string | null>(null); // null until the user types

  useEffect(() => {
    const q = query?.trim() ?? "";
    if (q.length < 2) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api
        .searchGames(q, ctrl.signal)
        .then((r) => {
          setResults(r.games);
          setActive(-1);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setResults([]);
        });
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  const shown = open && (query?.trim().length ?? 0) >= 2 && results.length > 0;

  function pick(g: Game) {
    onChange({ name: g.name, igdbId: g.igdb_id, coverUrl: g.cover_url });
    setOpen(false);
    setResults([]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!shown) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      // Cycles through the results and back to the input (-1).
      setActive((i) => {
        const next = i + step;
        return next >= results.length ? -1 : next < -1 ? results.length - 1 : next;
      });
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className={`game-picker${value.igdbId !== null ? " has-cover" : ""}`}>
      {value.igdbId !== null && <GameCover name={value.name} url={value.coverUrl} className="game-picker-cover" />}
      <input
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        maxLength={100}
        value={value.name}
        placeholder="Search games"
        onChange={(e) => {
          onChange({ name: e.target.value, igdbId: null, coverUrl: null });
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <div className="game-menu">
          <ul id={listId} role="listbox" aria-label="Games">
            {results.map((g, i) => (
              <li
                key={g.igdb_id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : undefined}
                onMouseDown={(e) => e.preventDefault()} // keep focus in the input
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(g)}
              >
                <GameCover name={g.name} url={g.cover_url} />
                <span className="game-option-name">{g.name}</span>
                {g.year && <span className="hint">{g.year}</span>}
              </li>
            ))}
          </ul>
          <p className="game-menu-credit">
            Game data from{" "}
            <a href="https://www.igdb.com" target="_blank" rel="noreferrer" tabIndex={-1} onMouseDown={(e) => e.preventDefault()}>
              IGDB.com
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
