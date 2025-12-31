import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const clientId = process.env.AIRTABLE_CLIENT_ID;

  if (!clientId) {
    return NextResponse.json(
      { error: 'Airtable OAuth is not configured. Please set AIRTABLE_CLIENT_ID.' },
      { status: 500 }
    );
  }

  // Generate a random state parameter for CSRF protection
  const state = Math.random().toString(36).substring(2, 15);

  // Build the authorization URL
  const authUrl = new URL('https://airtable.com/oauth2/v1/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', `${request.nextUrl.origin}/api/auth/callback/airtable`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);

  // Request the scopes configured in your Airtable OAuth app
  authUrl.searchParams.set('scope', 'data.records:read data.records:write');

  // Store the state in a cookie for verification in the callback
  const response = NextResponse.redirect(authUrl.toString());
  response.cookies.set('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 10, // 10 minutes
  });

  return response;
}
