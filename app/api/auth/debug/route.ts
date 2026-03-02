import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const clientId = process.env.AIRTABLE_CLIENT_ID;
  const clientSecret = process.env.AIRTABLE_CLIENT_SECRET;
  const sessionSecret = process.env.SESSION_SECRET;

  const redirectUri = `${request.nextUrl.origin}/api/auth/callback/airtable`;

  return NextResponse.json({
    environment: process.env.NODE_ENV,
    origin: request.nextUrl.origin,
    redirectUri,
    config: {
      hasClientId: !!clientId,
      clientIdPrefix: clientId ? clientId.substring(0, 8) + '...' : 'NOT SET',
      hasClientSecret: !!clientSecret,
      hasSessionSecret: !!sessionSecret,
      sessionSecretLength: sessionSecret?.length || 0,
    },
    requiredSteps: [
      '1. Go to https://airtable.com/create/oauth',
      '2. Set OAuth redirect URL to: ' + redirectUri,
      '3. Set scopes to: data.records:read data.records:write',
      '4. Copy Client ID to AIRTABLE_CLIENT_ID environment variable',
      '5. (Optional) Copy Client Secret to AIRTABLE_CLIENT_SECRET',
    ],
  });
}
