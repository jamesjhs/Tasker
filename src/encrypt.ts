import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;
const PREFIX = 'enc:';

function getKey(): Buffer | null {
  const raw = process.env['ENCRYPTION_KEY'];
  if (!raw) return null;
  if (raw.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    console.warn('[Tasker] ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Field encryption disabled.');
    return null;
  }
  return Buffer.from(raw, 'hex');
}

export function encryptField(value: string | null | undefined): string | null {
  if (value == null) return null;
  const key = getKey();
  if (!key) return value;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + encrypted.toString('base64');
}

export function decryptField(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!value.startsWith(PREFIX)) return value; // plaintext — return as-is
  const key = getKey();
  if (!key) {
    // Value is encrypted but no key is configured — return null and warn
    console.warn('[Tasker] Encrypted field found but ENCRYPTION_KEY is not set. Returning null.');
    return null;
  }
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return null; // malformed — do not expose raw ciphertext
  try {
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const encrypted = Buffer.from(parts[2], 'base64');
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) return null;
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
  } catch {
    return null; // decryption failed — do not expose raw ciphertext
  }
}
