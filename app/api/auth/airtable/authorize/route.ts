import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

// Generate a random code verifier for PKCE
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// Generate code challenge from verifier (SHA256 hash, base64url encoded)
function generateCodeChallenge(verifier: string): string {
  return crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
}

export async function GET(request: NextRequest) {
  const clientId = process.env.AIRTABLE_CLIENT_ID;

  if (!clientId) {
    return NextResponse.json(
      { error: 'Airtable OAuth is not configured. Please set AIRTABLE_CLIENT_ID.' },
      { status: 500 }
    );
  }

  // Check if this is a popup flow
  const isPopup = request.nextUrl.searchParams.get('popup') === 'true';

  // Generate a random state parameter for CSRF protection
  const state = crypto.randomBytes(16).toString('base64url');

  // Generate PKCE parameters (required by Airtable)
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Build the redirect URI - must match EXACTLY what's configured in Airtable
  const redirectUri = `${request.nextUrl.origin}/api/auth/callback/airtable`;

  // Log for debugging (will be visible in server logs)
  console.log('OAuth Authorization Request:', {
    clientId: clientId.substring(0, 10) + '...',
    redirectUri,
    origin: request.nextUrl.origin,
    hasPKCE: true,
    isPopup,
  });

  // Build the authorization URL according to Airtable OAuth spec with PKCE
  const authUrl = new URL('https://airtable.com/oauth2/v1/authorize');
  authUrl.searchParams.append('client_id', clientId);
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('state', state);
  authUrl.searchParams.append('code_challenge', codeChallenge);
  authUrl.searchParams.append('code_challenge_method', 'S256');

  // Scopes must match what's configured in your Airtable OAuth app
  authUrl.searchParams.append('scope', 'data.records:read data.records:write');

  console.log('Authorization URL:', authUrl.toString());

  // Store the state and code verifier in cookies for verification in the callback
  const response = NextResponse.redirect(authUrl.toString());

  response.cookies.set('oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 10, // 10 minutes
    path: '/',
  });

  response.cookies.set('oauth_code_verifier', codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 10, // 10 minutes
    path: '/',
  });

  // Store popup flag if this is a popup flow
  if (isPopup) {
    response.cookies.set('oauth_is_popup', 'true', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 10, // 10 minutes
      path: '/',
    });
  }

  return response;
}
