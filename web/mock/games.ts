// Stand-in for IGDB game search (API.md, "GET /api/games/search"). A fixed list of popular
// multiplayer games so the picker works offline. The ids are placeholders, not real IGDB ids,
// and there are no covers; the real backend gets both from IGDB.

export interface Game {
  igdb_id: number;
  name: string;
  year: number | null;
  cover_url: string | null;
}

const CATALOG: [number, string, number][] = [
  [1, "Helldivers 2", 2024],
  [2, "Helldivers", 2015],
  [3, "Deep Rock Galactic", 2020],
  [4, "Lethal Company", 2023],
  [5, "Valheim", 2021],
  [6, "Baldur's Gate 3", 2023],
  [7, "It Takes Two", 2021],
  [8, "Split Fiction", 2025],
  [9, "Phasmophobia", 2020],
  [10, "Left 4 Dead 2", 2009],
  [11, "Left 4 Dead", 2008],
  [12, "Destiny 2", 2017],
  [13, "Monster Hunter: World", 2018],
  [14, "Monster Hunter Wilds", 2025],
  [15, "Minecraft", 2011],
  [16, "Stardew Valley", 2016],
  [17, "Terraria", 2011],
  [18, "Overcooked! 2", 2018],
  [19, "Sea of Thieves", 2018],
  [20, "Borderlands 3", 2019],
  [21, "Borderlands 2", 2012],
  [22, "Diablo IV", 2023],
  [23, "Path of Exile 2", 2024],
  [24, "Elden Ring", 2022],
  [25, "Elden Ring Nightreign", 2025],
  [26, "Grounded", 2022],
  [27, "Risk of Rain 2", 2020],
  [28, "Payday 3", 2023],
  [29, "Payday 2", 2013],
  [30, "Warhammer: Vermintide 2", 2018],
  [31, "Warhammer 40,000: Darktide", 2022],
  [32, "Remnant II", 2023],
  [33, "Palworld", 2024],
  [34, "Enshrouded", 2024],
  [35, "R.E.P.O.", 2025],
  [36, "Peak", 2025],
  [37, "Among Us", 2018],
  [38, "Fortnite", 2017],
  [39, "Apex Legends", 2019],
  [40, "Valorant", 2020],
  [41, "Counter-Strike 2", 2023],
  [42, "Rocket League", 2015],
  [43, "Overwatch 2", 2022],
  [44, "Call of Duty: Warzone", 2020],
  [45, "Halo Infinite", 2021],
  [46, "Mario Kart 8 Deluxe", 2017],
  [47, "Super Smash Bros. Ultimate", 2018],
  [48, "Don't Starve Together", 2016],
  [49, "Satisfactory", 2024],
  [50, "Raft", 2022],
];

const GAMES: Game[] = CATALOG.map(([igdb_id, name, year]) => ({ igdb_id, name, year, cover_url: null }));

/** Lowercase, no accents or punctuation: "Baldur's Gate" → "baldurs gate". */
const norm = (s: string) =>
  s.normalize("NFKD").toLowerCase().replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Up to `limit` games whose name has every word of `q` as a word prefix; name prefixes first. */
export function searchGames(q: string, limit = 8): Game[] {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  const hits = GAMES.filter((g) => {
    const name = norm(g.name).split(" ");
    return words.every((w) => name.some((n) => n.startsWith(w)));
  });
  const starts = (g: Game) => (norm(g.name).startsWith(words.join(" ")) ? 0 : 1);
  return hits.sort((a, b) => starts(a) - starts(b) || (b.year ?? 0) - (a.year ?? 0)).slice(0, limit);
}

export const gameById = (id: number): Game | undefined => GAMES.find((g) => g.igdb_id === id);
