/**
 * Database, settings, and diagnostics actions behind the renderer's `electronAPI`.
 * The Electron IPC layer and the Android shell both call these, supplying their
 * own native dialogs, so backup, restore, and reset behave the same on both.
 */
import * as fs from 'fs';
import log from 'electron-log';
import { randomUUID } from 'crypto';
import {
  getDatabase,
  createBackup,
  restoreBackup,
  now,
  getCurrentSchemaVersion,
  getSchemaVersionFromBackup,
  resetDatabaseWithBackup,
  withDatabaseMaintenanceLock,
  withDatabaseRequest,
  isManagedBackupFile,
} from './db';
import { clearInMemoryRevokedTokens, clearUserAuthCache } from './middleware/security';
import { getLocalIP } from './server';
import { clearJWTSecretCache } from './security/jwt-secret';
import { getKdsPort } from './kds-server';
import { authorizeMasterPin, isMasterPinAvailable, isMasterPinSet } from './services/master-pin';
import {
  clearRestoreFileSelection,
  rememberRestoreFileSelection,
} from './services/restore-file-selection';
import { runHealthCheck, applySafeFixes } from './services/schema-health';
import { getStatus as getWhatsAppStatus, sanitizeLogText } from './services/whatsapp';
import { isThemeMode } from './title-bar-theme';
import { isOrdersLayout } from './routes/settings';
import { googleDrive } from './services/google-drive';
import { isSafeWhatsAppShareUrl } from './security/url-allowlist';
import { cloudSync } from './services/cloud-sync';
import {
  isLocalBackupEnabled,
  retainBackupLocally,
  setLocalBackupEnabled,
} from './services/local-backup';
import { readPostHogBootstrap } from './services/posthog';
import { platformShell } from './platform';

// Cap on the log content attached to a support ticket (most recent bytes only).
const LOG_TAIL_MAX_BYTES = 200_000;
// Prefer excluding log lines older than this from a support-ticket attachment.
const LOG_TAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Matches electron-log's default line prefix, e.g. "[2026-09-13 10:15:30.123] [info] ...".
const LOG_LINE_TIMESTAMP_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;

// Settings keys the renderer may write without a permission check.
// Everything else (currency, country, tax_scheme, business profile, ...) is
// permission-gated on the HTTP API and must stay there.
const ALLOWED_IPC_KEYS = new Set(['theme_mode', 'orders_layout']);

const SENSITIVE_SETTING_KEYS = new Set([
  'jwt_secret',
  'cloud_api_key',
  'cloud_device_secret',
  'cloud_deletion_status_token',
  'cloud_last_error',
]);

function maskSetting(key: string, value: string): string {
  if (key === 'cloud_last_error') return value ? 'Cloud service request failed' : '';
  if (!SENSITIVE_SETTING_KEYS.has(key)) return value;
  return value ? `****${value.slice(-4)}` : '';
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Native file and confirmation dialogs a host shell supplies. `null` means the operator cancelled. */
export interface HostDialogs {
  chooseBackupDestination(defaultFileName: string): Promise<string | null>;
  chooseRestoreFile(): Promise<string | null>;
  confirmSchemaMismatch(backupVersion: number, currentVersion: number): Promise<boolean>;
}

// Opens the native picker for "Restore from a file...". It only chooses a
// path; the restore itself is authorised over HTTP by the session that holds
// database.manage, so this performs no destructive step and is not Master-PIN
// gated. The picked path is bound to a single-use token.
export async function pickRestoreFile(dialogs: HostDialogs) {
  const filePath = await dialogs.chooseRestoreFile();
  if (!filePath) return { canceled: true };
  const selection = rememberRestoreFileSelection(filePath);
  return { canceled: false, path: selection.path, token: selection.token };
}

export async function backupDatabase(
  pin: string | undefined,
  dialogs: HostDialogs,
  shutdownSignal?: AbortSignal,
) {
  const auth = authorizeMasterPin(pin, 'ipc:backup');
  if (!auth.ok) return { success: false, error: auth.error };

  try {
    console.log('[IPC] backup-database: Starting...');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = await dialogs.chooseBackupDestination(`flo-backup-${timestamp}.db`);

    if (!destination) {
      return { success: false, error: 'Cancelled' };
    }

    const { path: backupPath, schemaVersion } = await createBackup(destination, shutdownSignal);

    console.log('[IPC] backup-database: Complete:', backupPath);
    return {
      success: true,
      path: backupPath,
      schemaVersion,
      message: `Backup saved (Schema v${schemaVersion})`,
    };
  } catch (error: unknown) {
    console.error('[IPC] backup-database: Error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function restoreDatabaseBackup(
  pin: string | undefined,
  presetBackupPath: string | undefined,
  dialogs: HostDialogs,
  shutdownSignal?: AbortSignal,
) {
  clearRestoreFileSelection();
  const auth = authorizeMasterPin(pin, 'ipc:restore');
  if (!auth.ok) return { success: false, error: auth.error };

  try {
    // A specific backup (e.g. picked from the Backup History list, #120)
    // skips the native file picker entirely.
    let backupPath = presetBackupPath;
    if (!backupPath) {
      const picked = await dialogs.chooseRestoreFile();
      if (!picked) {
        return { success: false, error: 'Cancelled' };
      }
      backupPath = picked;
    } else if (!fs.existsSync(backupPath)) {
      return { success: false, error: 'Backup file no longer exists' };
    } else if (!isManagedBackupFile(backupPath)) {
      return { success: false, error: 'Restore source must be an Al Baik POS backup file' };
    }

    const backupVersion = getSchemaVersionFromBackup(backupPath);

    if (backupVersion === null) {
      return {
        success: false,
        error:
          'Invalid backup file: missing schema version metadata. This backup may have been created with an older version of Al Baik POS.',
      };
    }

    const versionMismatch = backupVersion !== getCurrentSchemaVersion();

    if (versionMismatch) {
      if (!(await dialogs.confirmSchemaMismatch(backupVersion, getCurrentSchemaVersion()))) {
        return { success: false, error: 'Cancelled' };
      }
    }

    await googleDrive.prepareForDatabaseRestore();
    try {
      if (versionMismatch) {
        const restoreResult = await withDatabaseMaintenanceLock(
          (signal) => restoreBackup(backupPath, false, signal),
          shutdownSignal,
        );
        const cleanup = restoreResult.success ? googleDrive.completeDatabaseRestore() : null;
        clearUserAuthCache();
        clearInMemoryRevokedTokens();
        clearJWTSecretCache();
        const cleanupPending =
          restoreResult.cleanupPending === true || cleanup?.cleanupPending === true;
        return {
          success: restoreResult.success,
          mode: restoreResult.mode,
          backupVersion,
          currentVersion: getCurrentSchemaVersion(),
          tablesRestored: restoreResult.tablesRestored,
          message: restoreResult.success
            ? `Restored ${restoreResult.tablesRestored} tables (data-only mode due to version mismatch)`
            : `Restore failed: ${restoreResult.error}`,
          error: restoreResult.error,
          cleanupPending,
        };
      }

      const restoreResult = await withDatabaseMaintenanceLock(
        (signal) => restoreBackup(backupPath, true, signal),
        shutdownSignal,
      );
      const cleanup = restoreResult.success ? googleDrive.completeDatabaseRestore() : null;
      clearUserAuthCache();
      clearInMemoryRevokedTokens();
      clearJWTSecretCache();
      const cleanupPending =
        restoreResult.cleanupPending === true || cleanup?.cleanupPending === true;
      return {
        success: restoreResult.success,
        mode: restoreResult.mode,
        backupVersion,
        currentVersion: getCurrentSchemaVersion(),
        tablesRestored: restoreResult.tablesRestored,
        message: restoreResult.success
          ? 'Database restored successfully'
          : `Restore failed: ${restoreResult.error}`,
        error: restoreResult.error,
        cleanupPending,
      };
    } finally {
      googleDrive.releaseDatabaseRestore();
    }
  } catch (error: unknown) {
    console.error('[IPC] restore-backup: Error:', error);
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function databaseHealthCheck() {
  return withDatabaseRequest(async () => {
    try {
      return runHealthCheck();
    } catch (error: unknown) {
      return { error: getErrorMessage(error) };
    }
  });
}

export async function applyDatabaseSafeFixes(pin?: string, findingIds?: string[]) {
  const auth = authorizeMasterPin(pin, 'ipc:apply-safe-fixes');
  if (!auth.ok) return { success: false, error: auth.error };
  return withDatabaseRequest(async () => {
    try {
      return applySafeFixes(findingIds);
    } catch (error: unknown) {
      return { applied: [], skipped: [], errors: [{ id: 'all', error: getErrorMessage(error) }] };
    }
  });
}

export function masterPinStatus() {
  return { available: isMasterPinAvailable(), isSet: isMasterPinSet() };
}

export async function initializeDatabase(
  { pin, confirmationPhrase }: { pin?: string; confirmationPhrase?: string },
  shutdownSignal?: AbortSignal,
) {
  const auth = authorizeMasterPin(pin, 'ipc:initialize');
  if (!auth.ok) return { success: false, error: auth.error };
  if (confirmationPhrase !== 'INITIALIZE') {
    return { success: false, error: 'Confirmation phrase does not match' };
  }

  let restorePrepared = false;
  try {
    // The owner's typed INITIALIZE may discard a Drive restore boundary that can
    // never resolve on its own; the reset invalidates Drive state either way.
    await googleDrive.prepareForDatabaseRestore({ discardUnresolvedBoundary: true });
    restorePrepared = true;
    const keepLocalBackup = isLocalBackupEnabled();
    const { backupPath } = await resetDatabaseWithBackup(shutdownSignal);
    let localBackupFailed = false;
    if (keepLocalBackup) {
      localBackupFailed = retainBackupLocally(backupPath) === null;
    } else {
      setLocalBackupEnabled(false);
    }
    const cleanup = googleDrive.completeDatabaseRestore();
    clearUserAuthCache();
    clearInMemoryRevokedTokens();
    clearJWTSecretCache();
    return {
      success: true,
      backupPath,
      cleanupPending: cleanup.cleanupPending,
      localBackupFailed,
    };
  } catch (error: unknown) {
    console.error('[IPC] db-initialize: Error:', error);
    return { success: false, error: getErrorMessage(error) };
  } finally {
    if (restorePrepared) googleDrive.releaseDatabaseRestore();
  }
}

export async function getRendererSettings() {
  return withDatabaseRequest(async () => {
    try {
      const db = getDatabase();
      const rows = db.prepare('SELECT key, value FROM settings').all() as {
        key: string;
        value: string;
      }[];
      const settings: Record<string, string> = {};
      rows.forEach((row) => {
        settings[row.key] = maskSetting(row.key, row.value);
      });
      return settings;
    } catch (error: unknown) {
      return { error: getErrorMessage(error) };
    }
  });
}

export async function setRendererSetting(key: string, value: string) {
  return withDatabaseRequest(async () => {
    try {
      if (typeof key !== 'string' || typeof value !== 'string' || value.length > 10_000) {
        return { success: false, error: 'Invalid setting value' };
      }
      if (!ALLOWED_IPC_KEYS.has(key)) {
        return { success: false, error: 'Setting not allowed via IPC' };
      }
      if (key === 'theme_mode' && !isThemeMode(value)) {
        return { success: false, error: 'Invalid theme_mode value' };
      }
      if (key === 'orders_layout' && !isOrdersLayout(value)) {
        return { success: false, error: 'orders_layout must be "split" or "cards"' };
      }
      const db = getDatabase();
      db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        key,
        value,
        now(),
      );
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
}

export async function whatsAppStatus() {
  return withDatabaseRequest(async () => {
    try {
      return getWhatsAppStatus();
    } catch (err: unknown) {
      return { error: getErrorMessage(err) };
    }
  });
}

export async function openWhatsAppShare(rawUrl: unknown) {
  if (typeof rawUrl !== 'string' || !isSafeWhatsAppShareUrl(rawUrl)) {
    return { success: false, error: 'Invalid WhatsApp share URL' };
  }
  try {
    await platformShell().openExternal(rawUrl);
    return { success: true };
  } catch (error: unknown) {
    console.error('[IPC] WhatsApp share open failed:', sanitizeLogText(error));
    return { success: false, error: 'Failed to open WhatsApp' };
  }
}

export function kdsInfo() {
  const localIP = getLocalIP();
  const port = getKdsPort();
  return {
    url: `http://${localIP}:${port}/kds`,
    wsUrl: `ws://${localIP}:${port}/kds`,
    localIP,
    port,
  };
}

// Tail of the current session's log file, for attaching to support tickets.
export function logTail() {
  try {
    // electron-log rotates main.log at ~1MB, so reading it whole is cheap.
    const logFilePath = log.transports.file.getFile().path;
    const content = fs.readFileSync(logFilePath, 'utf8');
    const lines = content.split('\n');

    // Cut at the first line whose timestamp is within the window (a byte
    // cut wouldn't line up with "recent enough" for a quiet store's log).
    const cutoff = Date.now() - LOG_TAIL_MAX_AGE_MS;
    let cutIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(LOG_LINE_TIMESTAMP_RE);
      if (!match) continue;
      const ts = new Date(match[1].replace(' ', 'T')).getTime();
      if (Number.isFinite(ts) && ts >= cutoff) {
        cutIndex = i;
        break;
      }
    }
    const filtered = cutIndex === -1 ? lines : lines.slice(cutIndex);
    const filteredText = filtered.join('\n');

    // Byte cap stays as a backstop in case even the time-windowed content
    // is still large (e.g. a very chatty week).
    const buffer = Buffer.from(filteredText, 'utf8');
    const overCap = buffer.length > LOG_TAIL_MAX_BYTES;
    const text = overCap ? buffer.subarray(-LOG_TAIL_MAX_BYTES).toString('utf8') : filteredText;
    return { text, truncated: overCap || cutIndex > 0 };
  } catch (error: unknown) {
    return { error: getErrorMessage(error) };
  }
}

// Renderer failures are classified locally; message, stack, digest and route
// can contain business data and are never sent automatically.
export function reportRendererError() {
  cloudSync.captureOperationFailure({
    capture_point: 'fc.electron.renderer.exception',
    outcome: 'unknown',
    correlation_id: randomUUID(),
  });
  return { success: true };
}

export function postHogBootstrap() {
  try {
    return readPostHogBootstrap();
  } catch {
    return { enabled: false };
  }
}

export async function listPrinters() {
  return withDatabaseRequest(async () => {
    try {
      const db = getDatabase();
      const printers = db.prepare('SELECT * FROM printers ORDER BY name').all();
      return printers;
    } catch (error: unknown) {
      return { error: getErrorMessage(error) };
    }
  });
}
