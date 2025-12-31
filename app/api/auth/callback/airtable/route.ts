import { NextRequest, NextResponse } from 'next/server';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';
import { sessionOptions, SessionData } from '@/lib/session';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  // Log all callback parameters for debugging
  console.log('OAuth Callback:', {
    hasCode: !!code,
    hasState: !!state,
    error,
    errorDescription,
    allParams: Object.fromEntries(searchParams.entries()),
  });

  // Check for OAuth errors
  if (error) {
    const errorMessage = errorDescription
      ? `${error}: ${errorDescription}`
      : error;
    console.error('OAuth Error from Airtable:', errorMessage);
    return NextResponse.redirect(
      `${request.nextUrl.origin}/?error=${encodeURIComponent(errorMessage)}`
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(
      `${request.nextUrl.origin}/?error=missing_parameters`
    );
  }

  // Verify state parameter for CSRF protection
  const cookieStore = await cookies();
  const storedState = cookieStore.get('oauth_state')?.value;

  if (!storedState || storedState !== state) {
    return NextResponse.redirect(
      `${request.nextUrl.origin}/?error=invalid_state`
    );
  }

  // Exchange authorization code for access token
  const clientId = process.env.AIRTABLE_CLIENT_ID;
  const clientSecret = process.env.AIRTABLE_CLIENT_SECRET;

  if (!clientId) {
    return NextResponse.redirect(
      `${request.nextUrl.origin}/?error=oauth_not_configured`
    );
  }

  try {
    // Build the token request
    const tokenUrl = 'https://airtable.com/oauth2/v1/token';
    const redirectUri = `${request.nextUrl.origin}/api/auth/callback/airtable`;

    // Prepare the request body
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    // Prepare headers
    const headers: HeadersInit = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    // Add client_id and client_secret based on whether secret exists
    if (clientSecret) {
      // Use Basic Auth if client secret exists
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    } else {
      // Otherwise, include client_id in the body
      body.append('client_id', clientId);
    }

    console.log('Token Exchange Request:', {
      tokenUrl,
      redirectUri,
      hasClientSecret: !!clientSecret,
      bodyKeys: Array.from(body.keys()),
    });

    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json().catch(() => ({}));
      console.error('Token exchange failed:', {
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        errorData,
      });
      return NextResponse.redirect(
        `${request.nextUrl.origin}/?error=token_exchange_failed&details=${encodeURIComponent(JSON.stringify(errorData))}`
      );
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Store the access token in the session
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
    session.airtableAccessToken = accessToken;
    session.isAuthenticated = true;
    await session.save();

    // Clear the state cookie
    const response = NextResponse.redirect(`${request.nextUrl.origin}/?oauth=success`);
    response.cookies.set('oauth_state', '', { maxAge: 0 });

    return response;
  } catch (error) {
    console.error('OAuth callback error:', error);
    return NextResponse.redirect(
      `${request.nextUrl.origin}/?error=unexpected_error`
    );
  }
}
