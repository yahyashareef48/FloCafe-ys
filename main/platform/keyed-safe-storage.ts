import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { PlatformSafeStorage } from './types';

const MAGIC = Buffer.from('FLK1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM storage keyed by a 32-byte key the native host keeps in its OS keystore. */
export function createKeyedSafeStorage(key: Buffer, backend = 'android_keystore'): PlatformSafeStorage {
  if (key.length !== 32) throw new Error('Secret storage key must be 32 bytes');
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString(plainText: string): Buffer {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
    },
    decryptString(encrypted: Buffer): string {
      if (encrypted.length < MAGIC.length + IV_BYTES + TAG_BYTES || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('Unrecognized secret storage payload');
      }
      const iv = encrypted.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
      const tag = encrypted.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    },
  };
}
