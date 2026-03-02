import { SessionOptions } from 'iron-session';

export interface SessionData {
  airtableAccessToken?: string;
  airtableBaseId?: string;
  airtableTableName?: string;
  isAuthenticated: boolean;
}

export const defaultSession: SessionData = {
  isAuthenticated: false,
};

export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long_for_security',
  cookieName: 'door-view-creator-session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 8, // 8 hours
  },
};
