import type { PlatformHost, PlatformPrinters, PlatformRasterRenderer } from './types';
import { createKeyedSafeStorage } from './keyed-safe-storage';

export interface AndroidHostOptions {
  userDataDir: string;
  documentsDir: string;
  version: string;
  locale: string;
  countryCode: string;
  secretKey: Buffer;
  openExternal(url: string): Promise<void>;
  printers?: PlatformPrinters;
  rasterRenderer?: PlatformRasterRenderer;
}

export function createAndroidPlatformHost(options: AndroidHostOptions): PlatformHost {
  return {
    id: 'android',
    app: {
      isPackaged: true,
      getPath: (name) => (name === 'documents' ? options.documentsDir : options.userDataDir),
      getVersion: () => options.version,
      getLocale: () => options.locale,
      getLocaleCountryCode: () => options.countryCode,
    },
    safeStorage: createKeyedSafeStorage(options.secretKey),
    shell: { openExternal: options.openExternal },
    printers: options.printers,
    rasterRenderer: options.rasterRenderer,
  };
}
