// Per-session secrets remembered in this browser. Links carry them in the URL fragment
// (never sent to the server): organizer "#org=TOKEN", personal edit "#p=ID&t=TOKEN".

export interface Identity {
  participantId?: string;
  editToken?: string;
  organizerToken?: string;
  displayZone?: string;
  /** When this browser first created or joined the session; orders the home-page list. */
  savedAt?: number;
}

const PREFIX = "gamenightly:";
const key = (slug: string) => `${PREFIX}${slug}`;

export function loadIdentity(slug: string): Identity {
  try {
    return JSON.parse(localStorage.getItem(key(slug)) ?? "{}");
  } catch {
    return {};
  }
}

export function saveIdentity(slug: string, patch: Partial<Identity>): Identity {
  const prev = loadIdentity(slug);
  const next = { ...prev, ...patch, savedAt: prev.savedAt ?? Date.now() };
  try {
    localStorage.setItem(key(slug), JSON.stringify(next));
  } catch {
    // Private mode etc.: the personal link still works for this visit.
  }
  return next;
}

/** Sessions this browser created or joined, newest first. */
export function savedSessions(): { slug: string; identity: Identity }[] {
  const out: { slug: string; identity: Identity }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const slug = k.slice(PREFIX.length);
      const identity = loadIdentity(slug);
      if (identity.organizerToken || identity.participantId) out.push({ slug, identity });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => (b.identity.savedAt ?? 0) - (a.identity.savedAt ?? 0));
}

export function forgetSession(slug: string): void {
  try {
    localStorage.removeItem(key(slug));
  } catch {
    // ignore
  }
}

/** Absorb secrets from the URL fragment into storage, then strip them from the address bar. */
export function absorbHash(slug: string): Identity {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const patch: Partial<Identity> = {};
  if (params.get("org")) patch.organizerToken = params.get("org")!;
  if (params.get("p") && params.get("t")) {
    patch.participantId = params.get("p")!;
    patch.editToken = params.get("t")!;
  }
  if (Object.keys(patch).length) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return saveIdentity(slug, patch);
  }
  return loadIdentity(slug);
}

const origin = () => window.location.origin;
export const shareLink = (slug: string) => `${origin()}/s/${slug}`;
export const organizerLink = (slug: string, token: string) => `${shareLink(slug)}#org=${token}`;
export const editLink = (slug: string, participantId: string, token: string) =>
  `${shareLink(slug)}#p=${participantId}&t=${token}`;
