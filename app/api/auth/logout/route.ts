import { NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { sessionOptions, SessionData } from '@/lib/session';

export async function POST() {
  const session = await getIronSession<SessionData>(await cookies(), sessionOptions);

  // Clear all session data
  session.destroy();

  return NextResponse.json({ success: true, message: 'Logged out successfully' });
}
