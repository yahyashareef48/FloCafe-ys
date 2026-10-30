import type {
  PlatformApp,
  PlatformHost,
  PlatformId,
  PlatformPrinters,
  PlatformRasterRenderer,
  PlatformSafeStorage,
  PlatformShell,
} from './types';

export type * from './types';

let installedHost: PlatformHost | null = null;

/** Installs a non-Electron host; must run before any backend module reads paths or secrets. */
export function setPlatformHost(host: PlatformHost): void {
  installedHost = host;
}

export function resetPlatformHost(): void {
  installedHost = null;
}

// Resolved per call, not cached: test suites stub `require('electron')` per file.
function electronModule(): Partial<Pick<PlatformHost, 'app' | 'safeStorage' | 'shell'>> {
  return require('electron') as Partial<Pick<PlatformHost, 'app' | 'safeStorage' | 'shell'>>;
}

export function platformId(): PlatformId {
  return installedHost?.id ?? 'electron';
}

export function platformApp(): PlatformApp {
  return installedHost ? installedHost.app : (electronModule()?.app as PlatformApp);
}

export function platformSafeStorage(): PlatformSafeStorage {
  return installedHost ? installedHost.safeStorage : (electronModule()?.safeStorage as PlatformSafeStorage);
}

export function platformShell(): PlatformShell {
  return installedHost ? installedHost.shell : (electronModule()?.shell as PlatformShell);
}

/** The host's own printer transport, or null where the OS spooler is used. */
export function platformPrinters(): PlatformPrinters | null {
  return installedHost?.printers ?? null;
}

/** The host's raster renderer, or null where the Electron raster surface is used. */
export function platformRasterRenderer(): PlatformRasterRenderer | null {
  return installedHost?.rasterRenderer ?? null;
}
