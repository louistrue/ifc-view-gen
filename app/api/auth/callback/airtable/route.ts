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

  // Log non-sensitive callback indicators for debugging
  console.log('OAuth Callback:', {
    hasCode: !!code,
    hasState: !!state,
    error,
    errorDescription,
  });

  // Verify state parameter for CSRF protection
  const cookieStore = await cookies();
  const storedState = cookieStore.get('oauth_state')?.value;
  const codeVerifier = cookieStore.get('oauth_code_verifier')?.value;
  const isPopup = cookieStore.get('oauth_is_popup')?.value === 'true';

  // Helper to create error redirect URL
  const errorRedirect = (errorMsg: string) => {
    const baseUrl = isPopup ? '/oauth-popup' : '/';
    return `${request.nextUrl.origin}${baseUrl}?error=${encodeURIComponent(errorMsg)}`;
  };

  // Check for OAuth errors
  if (error) {
    const errorMessage = errorDescription
      ? `${error}: ${errorDescription}`
      : error;
    console.error('OAuth Error from Airtable:', errorMessage);
    return NextResponse.redirect(errorRedirect(errorMessage));
  }

  if (!code || !state) {
    return NextResponse.redirect(errorRedirect('missing_parameters'));
  }

  if (!storedState || storedState !== state) {
    console.error('State mismatch:', { storedState, receivedState: state });
    return NextResponse.redirect(errorRedirect('invalid_state'));
  }

  if (!codeVerifier) {
    console.error('Code verifier not found in cookies');
    return NextResponse.redirect(errorRedirect('missing_code_verifier'));
  }

  // Exchange authorization code for access token
  const clientId = process.env.AIRTABLE_CLIENT_ID;
  const clientSecret = process.env.AIRTABLE_CLIENT_SECRET;

  if (!clientId) {
    return NextResponse.redirect(errorRedirect('oauth_not_configured'));
  }

  try {
    // Build the token request
    const tokenUrl = 'https://airtable.com/oauth2/v1/token';
    const redirectUri = `${request.nextUrl.origin}/api/auth/callback/airtable`;

    // Prepare the request body with PKCE code_verifier
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier, // Required for PKCE
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
      return NextResponse.redirect(errorRedirect('token_exchange_failed'));
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken || typeof accessToken !== 'string') {
      console.error('Token exchange succeeded but access_token is missing or invalid');
      return NextResponse.redirect(errorRedirect('invalid_token_response'));
    }

    // Fetch the list of bases the user authorized — pure OAuth, no env vars needed
    // Discover the base and first table — pure OAuth, no env vars needed
    let baseId:    string | null = null;
    let baseName:  string | null = null;
    let tableName: string | null = null;

    try {
      const basesRes = await fetch('https://api.airtable.com/v0/meta/bases', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (basesRes.ok) {
        const basesData = await basesRes.json();
        const firstBase = basesData.bases?.[0];
        if (firstBase) {
          baseId   = firstBase.id;
          baseName = firstBase.name;
          console.log(`Auto-discovered base: "${baseName}" (${baseId})`);

          // Discover the first table name
          try {
            const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (tablesRes.ok) {
              const tablesData = await tablesRes.json();
              const firstTable = tablesData.tables?.[0];
              if (firstTable) {
                tableName = firstTable.name;
                console.log(`Auto-discovered table: "${tableName}"`);
              }
            } else {
              console.warn('Could not fetch tables:', await tablesRes.text());
            }
          } catch (e) {
            console.warn('Failed to fetch tables for base:', e);
          }
        }
      } else {
        console.warn('Could not fetch bases:', await basesRes.text());
      }
    } catch (e) {
      console.warn('Failed to fetch authorized bases:', e);
    }

    // ALWAYS overwrite every session field — never leave stale data from a previous session.
    const session = await getIronSession<SessionData>(await cookies(), sessionOptions);
    session.airtableAccessToken = accessToken;
    session.isAuthenticated     = true;
    session.airtableBaseId      = baseId    ?? undefined;
    session.airtableBaseName    = baseName  ?? undefined;
    session.airtableTableName   = tableName ?? undefined;
    await session.save();

    console.log('OAuth flow completed successfully');

    // Check if this is a popup flow (will have opener_popup cookie)
    const isPopup = cookieStore.get('oauth_is_popup')?.value === 'true';

    // Clear the state and code verifier cookies
    const redirectUrl = isPopup
      ? `${request.nextUrl.origin}/oauth-popup?oauth=success`
      : `${request.nextUrl.origin}/?oauth=success`;

    const response = NextResponse.redirect(redirectUrl);
    response.cookies.set('oauth_state', '', { maxAge: 0 });
    response.cookies.set('oauth_code_verifier', '', { maxAge: 0 });
    response.cookies.set('oauth_is_popup', '', { maxAge: 0 });

    return response;
  } catch (error) {
    console.error('OAuth callback error:', error);
    return NextResponse.redirect(
      `${request.nextUrl.origin}/?error=unexpected_error`
    );
  }
}
