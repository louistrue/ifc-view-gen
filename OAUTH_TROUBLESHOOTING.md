# Airtable OAuth Troubleshooting Guide

## Quick Debug Steps

### 1. Check Your Configuration

Visit `/api/auth/debug` in your browser (e.g., `https://door-view-creator.vercel.app/api/auth/debug`)

This will show you:
- Whether environment variables are set
- What redirect URI the app is using
- Configuration status

### 2. Common "invalid_request" Errors

This error usually means one of the following:

#### A. Missing PKCE Parameters (FIXED)
**Problem:** Airtable requires PKCE (Proof Key for Code Exchange) for OAuth.

**Status:** ✅ This has been fixed in the latest version. The app now automatically includes `code_challenge` and `code_challenge_method` parameters.

**If you still see this error:** Make sure you've deployed the latest version of the code.

#### B. Redirect URI Mismatch
**Problem:** The redirect URI in your Airtable OAuth app doesn't match exactly what the app is sending.

**Solution:**
1. Go to https://airtable.com/create/oauth
2. Find your OAuth integration
3. Check the "OAuth redirect URL" field
4. It MUST match exactly: `https://door-view-creator.vercel.app/api/auth/callback/airtable`
   - **Important:** No trailing slash
   - **Important:** Must be `https://` not `http://`
   - **Important:** Domain must match your deployment

**How to verify:**
- Visit `/api/auth/debug` and copy the `redirectUri` value
- Paste it exactly into Airtable's OAuth redirect URL field

#### C. Missing Environment Variables
**Problem:** `AIRTABLE_CLIENT_ID` is not set in Vercel.

**Solution:**
1. Go to your Vercel project settings
2. Navigate to "Environment Variables"
3. Add `AIRTABLE_CLIENT_ID` with the value from Airtable
4. Redeploy your application

#### D. Invalid Client ID
**Problem:** The Client ID copied from Airtable is incorrect or has extra whitespace.

**Solution:**
1. Go to https://airtable.com/create/oauth
2. Copy the Client ID again (make sure no spaces)
3. Update in Vercel environment variables
4. Redeploy

### 3. Check Server Logs

When you click "Connect to Airtable", check your Vercel logs for:

```
OAuth Authorization Request: {
  clientId: 'xxxxxxxx...',
  redirectUri: 'https://...',
  origin: 'https://...'
}
Authorization URL: https://airtable.com/oauth2/v1/authorize?...
```

This shows:
- The Client ID being used (first 10 characters)
- The redirect URI being sent
- The full authorization URL

### 4. Airtable OAuth App Configuration Checklist

Go to https://airtable.com/create/oauth and verify:

- [ ] **Name**: Set to something like "Türbilder" or "Door View Creator"
- [ ] **Redirect URL**: `https://door-view-creator.vercel.app/api/auth/callback/airtable`
- [ ] **Scopes**:
  - [ ] `data.records:read` - ✓ checked
  - [ ] `data.records:write` - ✓ checked
- [ ] **Support Email**: Added (required for production)
- [ ] **Privacy Policy URL**: `https://door-view-creator.vercel.app/privacy-policy`
- [ ] **Terms of Service URL**: `https://door-view-creator.vercel.app/terms-of-service`

### 5. Environment Variables Checklist

In Vercel (or `.env.local` for local development):

- [ ] `AIRTABLE_CLIENT_ID` - Set to your Client ID from Airtable
- [ ] `AIRTABLE_CLIENT_SECRET` - (Optional) Set if you generated one
- [ ] `SESSION_SECRET` - Set to a random 32+ character string
- [ ] `BLOB_READ_WRITE_TOKEN` - (Optional) For image uploads

**Generate SESSION_SECRET:**
```bash
openssl rand -base64 32
```

### 6. Testing Locally

To test locally (with ngrok or similar):

1. Start your local server: `npm run dev`
2. Use ngrok to expose it: `ngrok http 3000`
3. Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)
4. Update Airtable OAuth redirect URL to: `https://abc123.ngrok.io/api/auth/callback/airtable`
5. Set environment variable: `NEXT_PUBLIC_APP_URL=https://abc123.ngrok.io`
6. Test the OAuth flow

### 7. Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `invalid_request` | Redirect URI mismatch or missing client_id | Check redirect URI matches exactly in Airtable |
| `invalid_client` | Client ID or Secret is wrong | Re-copy Client ID from Airtable |
| `unauthorized_client` | Client not authorized for this grant type | Ensure OAuth app is configured correctly |
| `invalid_scope` | Requested scopes don't match configured scopes | Check scopes in Airtable match `data.records:read data.records:write` |
| `token_exchange_failed` | Failed to exchange code for token | Check server logs for details |

### 8. Advanced Debugging

#### Enable Detailed Logging

Check your Vercel function logs for these messages:

1. **Authorization Request:**
   ```
   OAuth Authorization Request: { clientId, redirectUri, origin }
   Authorization URL: https://airtable.com/oauth2/v1/authorize?...
   ```

2. **Callback:**
   ```
   OAuth Callback: { hasCode, hasState, error, errorDescription }
   ```

3. **Token Exchange:**
   ```
   Token Exchange Request: { tokenUrl, redirectUri, hasClientSecret }
   ```

#### Test Authorization URL Manually

1. Check server logs for the "Authorization URL"
2. Copy the full URL
3. Paste it in a new browser tab
4. You should see the Airtable authorization page
5. If you see an error, note the exact error message

### 9. Still Having Issues?

If you're still getting `invalid_request`:

1. **Screenshot the error** from Airtable's authorization page
2. **Check server logs** in Vercel for the exact authorization URL being generated
3. **Verify** the redirect URI in the logs matches EXACTLY what's in Airtable
4. **Try removing and re-adding** the OAuth integration in Airtable
5. **Ensure** you've redeployed after changing environment variables

### 10. Contact Support

If none of the above works, gather:
- Screenshot of the error
- Server logs from `/api/auth/airtable/authorize`
- Your Airtable OAuth app configuration (screenshot)
- Output from `/api/auth/debug`

This will help identify the exact issue.
