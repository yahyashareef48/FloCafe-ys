/** Starts and stops the Android main-tablet runtime in the same order as the Electron shell. */
import {
  beginDatabaseShutdown,
  closeDatabase,
  initDatabase,
  waitForDatabaseRequests,
} from '../db';
import { startServer, stopServer } from '../server';
import { getServerPort } from '../server-state';
import { getKdsPort, startKdsServer, stopKdsServer } from '../kds-server';
import { getServerAppPort, startServerApp, stopServerApp } from '../server-app';
import { cloudSync } from '../services/cloud-sync';
import { googleDrive } from '../services/google-drive';
import { localBackup } from '../services/local-backup';
import {
  requestShutdown as requestWhatsAppShutdown,
  shutdown as shutdownWhatsApp,
} from '../services/whatsapp';
import { initPrinter } from '../printers/thermal';
import { createShutdownCoordinator, waitForHttpShutdownWork } from '../shutdown';
import { startActionServer, type ActionServer } from './action-server';

export interface AndroidRuntimeInfo {
  serverPort: number;
  kdsPort: number;
  serverAppPort: number;
  actionPort: number;
  actionToken: string;
}

const shutdownController = new AbortController();
let actionServer: ActionServer | null = null;

const cleanup = createShutdownCoordinator(() => [
  { name: 'action server', run: () => actionServer?.close() },
  { name: 'Server App', run: () => stopServerApp(), blocksDatabase: true },
  { name: 'Main server', run: () => stopServer(), blocksDatabase: true },
  { name: 'KDS server', run: () => stopKdsServer(), blocksDatabase: true },
  { name: 'cloud sync', run: () => cloudSync.shutdown(), blocksDatabase: true },
  { name: 'Google Drive', run: () => googleDrive.stop(), blocksDatabase: true },
  { name: 'local backup', run: () => localBackup.stop(), blocksDatabase: true },
  { name: 'WhatsApp', run: () => shutdownWhatsApp(), blocksDatabase: true },
  { name: 'HTTP handler cleanup', run: () => waitForHttpShutdownWork(), blocksDatabase: true },
  { name: 'database admission', run: () => beginDatabaseShutdown(), blocksDatabase: true },
  { name: 'database requests', run: () => waitForDatabaseRequests(), blocksDatabase: true },
  { name: 'database', run: () => closeDatabase(), databaseClose: true },
]);

export function isAndroidShutdownRequested(): boolean {
  return shutdownController.signal.aborted;
}

function throwIfShutdownRequested(): void {
  if (shutdownController.signal.aborted) {
    throw Object.assign(new Error('Android runtime startup cancelled during shutdown'), {
      code: 'ERR_SHUTDOWN_ABORTED',
    });
  }
}

// Mirrors the Electron initialize() order. Telemetry and PostHog are never started on Android.
export async function startAndroidServices(): Promise<AndroidRuntimeInfo> {
  initDatabase();
  throwIfShutdownRequested();
  await startServer();
  throwIfShutdownRequested();
  cloudSync.start();
  googleDrive.start();
  localBackup.start();
  await startKdsServer();
  throwIfShutdownRequested();
  await startServerApp();
  throwIfShutdownRequested();
  await initPrinter();
  actionServer = await startActionServer({
    serverPort: getServerPort(),
    shutdownSignal: shutdownController.signal,
  });
  return {
    serverPort: getServerPort(),
    kdsPort: getKdsPort(),
    serverAppPort: getServerAppPort(),
    actionPort: actionServer.port,
    actionToken: actionServer.token,
  };
}

export async function stopAndroidServices(): Promise<void> {
  if (!shutdownController.signal.aborted) {
    requestWhatsAppShutdown();
    shutdownController.abort();
  }
  await cleanup();
}
