/**
 * Cloudflare Turnstile CAPTCHA verification utility.
 * Verifies client-side Turnstile tokens by making a server-side API call to Cloudflare.
 */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileVerifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  error_codes?: string[];
  'error-codes'?: string[];
}

/**
 * Verify a Turnstile token with Cloudflare's API.
 * @param token The token from the client-side Turnstile widget
 * @returns Promise resolving to verification result
 */
export async function verifyTurnstileToken(token: string): Promise<TurnstileVerifyResponse> {
  const secretKey = process.env['TURNSTILE_SECRET_KEY'];

  // If Turnstile is not configured, allow the request to proceed
  if (!secretKey) {
    return { success: true };
  }

  // If no token was provided, fail the verification
  if (!token) {
    return { success: false, 'error-codes': ['missing-token'] };
  }

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: secretKey,
        response: token,
      }),
    });

    if (!response.ok) {
      console.error(`[Turnstile] Verification API returned ${response.status}`);
      return { success: false, 'error-codes': ['api-error'] };
    }

    const result = (await response.json()) as TurnstileVerifyResponse;
    return result;
  } catch (error) {
    console.error('[Turnstile] Verification error:', error);
    return { success: false, 'error-codes': ['network-error'] };
  }
}
