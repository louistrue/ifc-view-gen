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
  const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

  // Build the redirect URI - must match EXACTLY what's configured in Airtable
  const redirectUri = `${request.nextUrl.origin}/api/auth/callback/airtable`;

  // Log for debugging (will be visible in server logs)
  console.log('OAuth Authorization Request:', {
    clientId: clientId.substring(0, 10) + '...',
    redirectUri,
    origin: request.nextUrl.origin,
  });

  // Build the authorization URL according to Airtable OAuth spec
  const authUrl = new URL('https://airtable.com/oauth2/v1/authorize');
  authUrl.searchParams.append('client_id', clientId);
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('state', state);

  // Scopes must match what's configured in your Airtable OAuth app
  // Using space-separated format as per OAuth 2.0 spec
  authUrl.searchParams.append('scope', 'data.records:read data.records:write');

  console.log('Authorization URL:', authUrl.toString());

  // Store the state in a cookie for verification in the callback
  const response = NextResponse.redirect(authUrl.toString());
  response.cookies.set('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 10, // 10 minutes
    path: '/',
  });

  return response;
}
