/** Process-level host services the backend needs, shaped after the Electron APIs they replace. */

export type PlatformId = 'electron' | 'android';

export type PlatformPathName = 'userData' | 'documents';

export interface PlatformApp {
  readonly isPackaged: boolean;
  getPath(name: PlatformPathName): string;
  getVersion(): string;
  getLocale(): string;
  getLocaleCountryCode(): string;
}

export interface PlatformSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface PlatformShell {
  openExternal(url: string): Promise<void>;
}

export interface PlatformHost {
  readonly id: PlatformId;
  readonly app: PlatformApp;
  readonly safeStorage: PlatformSafeStorage;
  readonly shell: PlatformShell;
}
