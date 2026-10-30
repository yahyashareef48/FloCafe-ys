/** Process-level host services the backend needs, shaped after the Electron APIs they replace. */
import type { RasterRenderRequest, RasterRenderResult } from '../../shared/print/raster';

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

/** A printer the host itself can reach (USB or Bluetooth), addressed by its display name. */
export interface PlatformPrinterInfo {
  name: string;
  make: string;
  model: string;
  connectionType: 'usb' | 'bluetooth';
  deviceUri: string;
}

/** Raw ESC/POS transport for hosts without an operating-system print spooler. */
export interface PlatformPrinters {
  list(signal?: AbortSignal): Promise<PlatformPrinterInfo[]>;
  send(printerName: string, data: Buffer, signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }>;
}

/** Renders raster print units for hosts without an Electron offscreen window. */
export interface PlatformRasterRenderer {
  render(request: RasterRenderRequest): Promise<RasterRenderResult>;
}

export interface PlatformHost {
  readonly id: PlatformId;
  readonly app: PlatformApp;
  readonly safeStorage: PlatformSafeStorage;
  readonly shell: PlatformShell;
  /** Replaces the OS spooler for `usb` printers when present. */
  readonly printers?: PlatformPrinters;
  /** Replaces the Electron raster surface when present. */
  readonly rasterRenderer?: PlatformRasterRenderer;
}
