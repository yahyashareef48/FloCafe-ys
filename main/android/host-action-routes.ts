/**
 * The actions behind the Android `electronAPI` shim. The shim reaches them only
 * through the shell's WebView message channel and the UID- and token-checked
 * native bridge, so LAN clients of the POS servers can never call these
 * Master-PIN-level actions.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  applyDatabaseSafeFixes,
  backupDatabase,
  databaseHealthCheck,
  getRendererSettings,
  initializeDatabase,
  kdsInfo,
  listPrinters,
  logTail,
  masterPinStatus,
  openWhatsAppShare,
  pickRestoreFile,
  postHogBootstrap,
  reportRendererError,
  restoreDatabaseBackup,
  setRendererSetting,
  whatsAppStatus,
  type HostDialogs,
} from '../host-actions';
import { platformApp } from '../platform';
import { callNative } from './native-bridge';

/** Folder for manual backups; the shell then offers to copy the file anywhere the operator picks. */
export function manualBackupDir(): string {
  return path.join(platformApp().getPath('documents'), 'FloCafe', 'Manual Backups');
}

export function androidHostDialogs(): HostDialogs {
  return {
    async chooseBackupDestination(defaultFileName) {
      const dir = manualBackupDir();
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, defaultFileName);
    },
    async chooseRestoreFile() {
      const picked = await callNative<{ path?: string } | null>(
        'pickFile',
        { purpose: 'restore' },
        { timeoutMs: 0 },
      );
      return picked?.path ?? null;
    },
    async confirmSchemaMismatch(backupVersion, currentVersion) {
      const answer = await callNative<{ confirmed?: boolean } | null>(
        'confirm',
        {
          title: 'Schema Version Mismatch',
          message: `Backup was created with Schema v${backupVersion}`,
          detail: `Current database uses Schema v${currentVersion}.\n\nRestoring will import data only (common fields) to preserve new database structure.\n\nDo you want to continue?`,
          confirmLabel: 'Restore Anyway',
          cancelLabel: 'Cancel',
        },
        { timeoutMs: 0 },
      );
      return answer?.confirmed === true;
    },
  };
}

type HostActionBody = Record<string, unknown>;
export type HostActionHandler = (route: string, body: unknown) => Promise<unknown>;

export function createHostActionHandler(options: {
  dialogs: HostDialogs;
  shutdownSignal?: AbortSignal;
  appInfo: () => Record<string, unknown>;
}): HostActionHandler {
  const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const routes: Record<string, (body: HostActionBody) => unknown> = {
    '/pick-restore-file': () => pickRestoreFile(options.dialogs),
    '/backup': (b) => backupDatabase(str(b.pin), options.dialogs, options.shutdownSignal),
    '/restore': (b) =>
      restoreDatabaseBackup(str(b.pin), str(b.backupPath), options.dialogs, options.shutdownSignal),
    '/health-check': () => databaseHealthCheck(),
    '/safe-fixes': (b) =>
      applyDatabaseSafeFixes(
        str(b.pin),
        Array.isArray(b.findingIds)
          ? b.findingIds.filter((id): id is string => typeof id === 'string')
          : undefined,
      ),
    '/master-pin-status': () => masterPinStatus(),
    '/initialize': (b) =>
      initializeDatabase(
        { pin: str(b.pin), confirmationPhrase: str(b.confirmationPhrase) },
        options.shutdownSignal,
      ),
    '/settings': () => getRendererSettings(),
    '/set-setting': (b) => setRendererSetting(b.key as string, b.value as string),
    '/whatsapp-status': () => whatsAppStatus(),
    '/whatsapp-share': (b) => openWhatsAppShare(b.url),
    '/kds-info': () => kdsInfo(),
    '/app-info': () => options.appInfo(),
    '/log-tail': () => logTail(),
    '/report-renderer-error': () => reportRendererError(),
    '/posthog-bootstrap': () => postHogBootstrap(),
    '/printers': () => listPrinters(),
  };
  return async (route, body) => {
    const action = Object.prototype.hasOwnProperty.call(routes, route) ? routes[route] : undefined;
    if (!action) throw new Error(`Unknown host action ${route}`);
    const payload = body && typeof body === 'object' ? (body as HostActionBody) : {};
    return (await action(payload)) ?? null;
  };
}

export function createAndroidHostActionHandler(shutdownSignal?: AbortSignal): HostActionHandler {
  return createHostActionHandler({
    dialogs: androidHostDialogs(),
    shutdownSignal,
    appInfo: () => ({
      version: platformApp().getVersion(),
      name: 'Al Baik POS',
      node: process.versions.node,
      platform: 'android',
    }),
  });
}
