// Thin REST client for @pokechamps/server. Module-level config holder so
// callers don't have to thread a context through every fetch. Auth state is
// mirrored to localStorage so a refresh keeps you signed in; the loader at
// the bottom hydrates the holder on import.
//
// Only the endpoints needed for Phase 4.1 (auth + matches list/get) are
// wrapped. Phase 4.2 will add the WebSocket subscription for live battles.
import type { MatchSummary } from '@pokechamps/core/storage/types.js';
import type { Match } from '@pokechamps/core/domain/types.js';

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthResult {
  token: string;
  user: AuthUser;
}

interface ApiConfig {
  baseUrl: string;
  token: string | null;
  user: AuthUser | null;
}

const STORAGE_KEY = 'pokechamps.auth.v1';
const DEFAULT_BASE_URL = 'http://localhost:3000';

const config: ApiConfig = {
  baseUrl: DEFAULT_BASE_URL,
  token: null,
  user: null,
};

interface PersistedAuth {
  baseUrl: string;
  token: string;
  user: AuthUser;
}

function loadPersisted(): PersistedAuth | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedAuth>;
    if (
      typeof parsed.baseUrl === 'string' &&
      typeof parsed.token === 'string' &&
      parsed.user &&
      typeof parsed.user.id === 'string' &&
      typeof parsed.user.email === 'string'
    ) {
      return { baseUrl: parsed.baseUrl, token: parsed.token, user: parsed.user };
    }
  } catch {
    // fall through — corrupt entry, treat as signed out
  }
  return null;
}

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  if (config.token && config.user) {
    const payload: PersistedAuth = {
      baseUrl: config.baseUrl,
      token: config.token,
      user: config.user,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

const persisted = loadPersisted();
if (persisted) {
  config.baseUrl = persisted.baseUrl;
  config.token = persisted.token;
  config.user = persisted.user;
}

export function getBaseUrl(): string {
  return config.baseUrl;
}

export function setBaseUrl(url: string): void {
  config.baseUrl = url.replace(/\/$/, '');
}

export function getCurrentUser(): AuthUser | null {
  return config.user;
}

export function getToken(): string | null {
  return config.token;
}

export function isAuthenticated(): boolean {
  return config.token !== null && config.user !== null;
}

export function signOut(): void {
  config.token = null;
  config.user = null;
  persist();
}

interface ApiErrorBody {
  error?: string;
  issues?: { path: string; message: string }[];
}

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody | null;
  constructor(status: number, message: string, body: ApiErrorBody | null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (init.auth !== false && config.token) {
    headers.set('authorization', `Bearer ${config.token}`);
  }
  const res = await fetch(`${config.baseUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // non-json error body — leave as null
    }
    const msg = body?.error ?? `request failed: ${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function applyAuthResult(result: AuthResult): AuthResult {
  config.token = result.token;
  config.user = result.user;
  persist();
  return result;
}

export async function register(email: string, password: string): Promise<AuthResult> {
  const result = await request<AuthResult>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    auth: false,
  });
  return applyAuthResult(result);
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const result = await request<AuthResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    auth: false,
  });
  return applyAuthResult(result);
}

export function listMatches(): Promise<MatchSummary[]> {
  return request<MatchSummary[]>('/matches');
}

export function getMatch(id: string): Promise<Match> {
  return request<Match>(`/matches/${encodeURIComponent(id)}`);
}

// Mint a single-use ticket for the live WebSocket. We use this so the
// long-lived JWT never appears in a URL (which would leak it to access
// logs / browser history / Referer headers).
export function getLiveTicket(id: string): Promise<{ ticket: string; expiresInMs: number }> {
  return request<{ ticket: string; expiresInMs: number }>(
    `/matches/${encodeURIComponent(id)}/live-ticket`,
    { method: 'POST' },
  );
}
