import { SessionOptions } from 'iron-session';

export interface SessionData {
  airtableAccessToken?: string;
  airtableBaseId?: string;
  airtableBaseName?: string;  // display name of the authorized base (for UI link)
  airtableTableName?: string; // first table in the base (auto-discovered via OAuth)
  isAuthenticated: boolean;
}

export const defaultSession: SessionData = {
  isAuthenticated: false,
};

const sessionSecret =
  process.env.SESSION_SECRET ??
  (process.env.NODE_ENV === 'production'
    ? undefined
    : 'dev-only-session-secret-please-change-in-production');

if (!sessionSecret) {
  throw new Error('SESSION_SECRET environment variable is not set. Cannot start the application.');
}

export const sessionOptions: SessionOptions = {
  password: sessionSecret,
  cookieName: 'door-view-creator-session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 8, // 8 hours
  },
};
