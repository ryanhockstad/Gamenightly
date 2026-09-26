// Overlap scale from the deck palette: 1 person free = purple → orange → everyone = gold.
const STOPS: [number, number, number][] = [
  [0x8c, 0x52, 0xff],
  [0xff, 0xac, 0x33],
  [0xff, 0xcc, 0x4d],
];

export function heatColor(free: number, groupSize: number): string {
  const r = groupSize <= 1 ? 1 : Math.min(1, Math.max(0, (free - 1) / (groupSize - 1)));
  const x = r * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [STOPS[i], STOPS[i + 1]];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(", ")})`;
}
