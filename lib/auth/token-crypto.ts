import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ENTRA_TOKEN_ENCRYPTION_KEY } from './config';

const ENC_PREFIX = 'enc:v1';
const AES_ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

let cachedKey: Buffer | null = null;

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) {
    return false;
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }

  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value;
}

function getEncryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const keyBase64 = ENTRA_TOKEN_ENCRYPTION_KEY.trim();
  if (!isStrictBase64(keyBase64)) {
    throw new Error(
      '[auth/token-crypto] ENTRA_TOKEN_ENCRYPTION_KEY must be canonical base64'
    );
  }

  const key = Buffer.from(keyBase64, 'base64');

  if (key.length !== 32) {
    throw new Error(
      '[auth/token-crypto] ENTRA_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64)'
    );
  }

  cachedKey = key;
  return key;
}

function encodePart(data: Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

function decodePart(part: string, fieldName: string): Buffer {
  try {
    return Buffer.from(part, 'base64url');
  } catch {
    throw new Error(`[auth/token-crypto] Invalid encrypted token ${fieldName} encoding`);
  }
}

export function encryptToken(plainText: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(AES_ALGO, key, iv, { authTagLength: AUTH_TAG_LEN });

  const encrypted = Buffer.concat([
    cipher.update(plainText, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${ENC_PREFIX}:${encodePart(iv)}:${encodePart(authTag)}:${encodePart(encrypted)}`;
}

export function decryptToken(encryptedToken: string): string {
  if (!encryptedToken.startsWith(`${ENC_PREFIX}:`)) {
    throw new Error('[auth/token-crypto] Token is not encrypted with supported format (enc:v1)');
  }

  const parts = encryptedToken.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('[auth/token-crypto] Invalid encrypted token format');
  }

  const key = getEncryptionKey();
  const iv = decodePart(parts[2], 'iv');
  const authTag = decodePart(parts[3], 'auth tag');
  const ciphertext = decodePart(parts[4], 'ciphertext');

  if (iv.length !== IV_LEN) {
    throw new Error('[auth/token-crypto] Invalid encrypted token IV length');
  }
  if (authTag.length !== AUTH_TAG_LEN) {
    throw new Error('[auth/token-crypto] Invalid encrypted token auth tag length');
  }

  try {
    const decipher = createDecipheriv(AES_ALGO, key, iv, { authTagLength: AUTH_TAG_LEN });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('[auth/token-crypto] Failed to decrypt token (invalid key or corrupted data)');
  }
}
