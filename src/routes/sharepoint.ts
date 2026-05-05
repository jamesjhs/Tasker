import { Router, Request, Response } from 'express';
import { getDb, getSetting } from '../db';
import { decryptField } from '../encrypt';
import { requireAuth, requirePasswordChange, requireActivation } from '../middleware/index';

const router = Router();
router.use(requireAuth);
router.use(requirePasswordChange);
router.use(requireActivation);

// ── In-memory token cache ─────────────────────────────────────────────────────
// Expire the token 60 seconds early to avoid using a token that expires mid-request
const TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

let _cachedToken: string | null = null;
let _tokenExpiry = 0;

export function clearSpTokenCache(): void {
  _cachedToken = null;
  _tokenExpiry = 0;
}

async function getAccessToken(): Promise<string | null> {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  const tenantId = getSetting('sp_tenant_id');
  const clientId = getSetting('sp_client_id');
  const rawSecret = getSetting('sp_client_secret');
  const clientSecret = rawSecret ? decryptField(rawSecret) : null;

  if (!tenantId || !clientId || !clientSecret) return null;

  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }).toString(),
      },
    );
    if (!res.ok) return null;
    const data = await res.json() as { access_token: string; expires_in: number };
    if (!data.access_token) return null;
    _cachedToken = data.access_token;
    _tokenExpiry = Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS;
    return _cachedToken;
  } catch {
    return null;
  }
}

// GET /api/sharepoint/dirs — list enabled directories
router.get('/dirs', (_req: Request, res: Response) => {
  const dirs = getDb().prepare(
    'SELECT id, name, drive_id FROM sharepoint_directories WHERE enabled=1 ORDER BY name',
  ).all();
  res.json({ dirs });
});

// GET /api/sharepoint/browse?driveId=...&itemId=...
router.get('/browse', async (req: Request, res: Response) => {
  const driveId = (req.query['driveId'] as string | undefined) || '';
  const itemId  = (req.query['itemId']  as string | undefined) || '';

  if (!driveId) { res.status(400).json({ error: 'driveId is required.' }); return; }

  // Validate driveId is one of the configured, enabled directories
  const dir = getDb().prepare(
    'SELECT id FROM sharepoint_directories WHERE drive_id=? AND enabled=1',
  ).get(driveId);
  if (!dir) { res.status(404).json({ error: 'Directory not found or not enabled.' }); return; }

  const token = await getAccessToken();
  if (!token) {
    res.status(503).json({ error: 'SharePoint credentials are not configured or are invalid.' });
    return;
  }

  const safeDriveId = encodeURIComponent(driveId);
  const graphUrl = itemId
    ? `https://graph.microsoft.com/v1.0/drives/${safeDriveId}/items/${encodeURIComponent(itemId)}/children`
    : `https://graph.microsoft.com/v1.0/drives/${safeDriveId}/root/children`;

  try {
    const graphRes = await fetch(graphUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!graphRes.ok) {
      const errData = await graphRes.json() as { error?: { message?: string } };
      res.status(502).json({ error: errData?.error?.message || 'Failed to fetch from SharePoint.' });
      return;
    }
    const data = await graphRes.json() as { value: Record<string, unknown>[] };
    const items = (data.value || []).map((item) => ({
      id: item['id'],
      name: item['name'],
      isFolder: !!(item['folder']),
      webUrl: item['webUrl'],
      size: (item['size'] != null ? item['size'] : null),
      lastModified: item['lastModifiedDateTime'],
    }));
    // Folders first, then files, both alphabetically
    items.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });
    res.json({ items });
  } catch {
    res.status(502).json({ error: 'Failed to connect to SharePoint.' });
  }
});

export default router;
