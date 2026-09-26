// The only module that talks to the backend. Contract: web/API.md.
import { safeFilename } from "./filename";

const BASE = import.meta.env.VITE_API_BASE ?? "/api";

export type Status = "collecting" | "confirmed" | "canceled";

export interface Block {
  start: string; // ISO 8601 UTC
  end: string; // exclusive
}

export interface Participant {
  id: string;
  display_name: string;
  timezone: string;
  responded: boolean;
  blocks: Block[];
}

export interface MatchWindow {
  first_start: string;
  last_start: string;
  available_ids: string[];
  missing_ids: string[];
}

export interface SessionView {
  public_slug: string;
  title: string;
  game: string | null;
  duration_minutes: number;
  dates: string[]; // YYYY-MM-DD, organizer's zone
  earliest_minute: number; // "no earlier than", minutes after local midnight
  latest_minute: number; // "no later than"; <= earliest means past midnight
  /** One UTC window per date. Players can only mark times inside these. */
  windows: { date: string; start: string; end: string }[];
  organizer_timezone: string;
  slot_step_minutes: number;
  max_participants: number;
  has_webhook: boolean;
  status: Status;
  confirmed_start_utc: string | null;
  confirmed_end_utc: string | null;
  participants: Participant[];
  matches: {
    windows: MatchWindow[];
    responded_count: number;
    max_participants: number;
  };
}

export interface CreateSessionBody {
  title: string;
  game?: string | null;
  duration_minutes: number;
  dates: string[];
  earliest_minute: number;
  latest_minute: number;
  organizer_timezone: string;
  max_participants: number;
  discord_webhook_url?: string | null;
}

export type ErrorCode = "not_found" | "forbidden" | "invalid" | "session_full" | "name_taken" | "wrong_status";

export class ApiError extends Error {
  code: ErrorCode | "network";
  status: number;
  constructor(code: ErrorCode | "network", message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(method: string, path: string, opts: { body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError("network", "Couldn't reach the server. Check your connection and try again.", 0);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(err?.code ?? "invalid", err?.message ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

const s = (slug: string) => `/s/${encodeURIComponent(slug)}`;

export const api = {
  createSession: (body: CreateSessionBody) =>
    request<{ public_slug: string; organizer_token: string }>("POST", "/sessions", { body }),

  getSession: (slug: string) => request<SessionView>("GET", s(slug)),

  join: (slug: string, body: { display_name: string; timezone: string }, organizerToken?: string) =>
    request<{ participant_id: string; edit_token: string }>("POST", `${s(slug)}/participants`, {
      body,
      token: organizerToken,
    }),

  saveAvailability: (slug: string, participantId: string, editToken: string, blocks: Block[]) =>
    request<{ blocks: Block[] }>("PUT", `${s(slug)}/participants/${encodeURIComponent(participantId)}/availability`, {
      body: { blocks },
      token: editToken,
    }),

  confirm: (slug: string, organizerToken: string, start: string) =>
    request<void>("POST", `${s(slug)}/confirm`, { body: { start }, token: organizerToken }),

  reopen: (slug: string, organizerToken: string) => request<void>("POST", `${s(slug)}/reopen`, { token: organizerToken }),

  cancel: (slug: string, organizerToken: string) => request<void>("POST", `${s(slug)}/cancel`, { token: organizerToken }),

  icsUrl: (slug: string) => `${BASE}${s(slug)}/event.ics`,

  /** Download name for the .ics, e.g. "Saturday Squad.ics". Mirrors the API's Content-Disposition. */
  icsFilename: (title: string) => `${safeFilename(title)}.ics`,
};
