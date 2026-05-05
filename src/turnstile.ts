import https from 'https';

const TURNSTILE_HOSTNAME = 'challenges.cloudflare.com';
const TURNSTILE_PATH     = '/turnstile/v0/siteverify';

/** Returns true when both env vars are set and Turnstile should be enforced. */
export function isTurnstileEnabled(): boolean {
  return Boolean(process.env['TURNSTILE_SITE_KEY'] && process.env['TURNSTILE_SECRET_KEY']);
}

/**
 * Verifies a Cloudflare Turnstile token with the server-side API.
 * Returns true when the token is valid (or when Turnstile is not configured).
 * Returns false on invalid token, network error, or timeout.
 */
export function verifyTurnstileToken(token: string, remoteip?: string): Promise<boolean> {
  if (!isTurnstileEnabled()) return Promise.resolve(true);
  if (!token) return Promise.resolve(false);

  const secret = process.env['TURNSTILE_SECRET_KEY'] as string;
  const params = new URLSearchParams({ secret, response: token });
  if (remoteip) params.append('remoteip', remoteip);
  const body = params.toString();

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: TURNSTILE_HOSTNAME,
        path: TURNSTILE_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data) as { success: boolean };
            resolve(json.success === true);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}
