/**
 * Loopback-only HTTP endpoint behind the Android `electronAPI` shim. It binds
 * 127.0.0.1 on an ephemeral port and requires the per-launch token, so LAN
 * clients of the POS servers can never reach these Master-PIN-level actions.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
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

export const HOST_TOKEN_HEADER = 'x-flo-host-token';

export interface ActionServer {
  port: number;
  token: string;
  close(): Promise<void>;
}

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

function tokenMatches(expected: Buffer, received: unknown): boolean {
  if (typeof received !== 'string') return false;
  const candidate = Buffer.from(received);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function createActionApp(options: {
  token: string;
  allowedOrigins: string[];
  dialogs: HostDialogs;
  shutdownSignal?: AbortSignal;
  appInfo: () => Record<string, unknown>;
}) {
  const expected = Buffer.from(options.token);
  const app = express();
  app.disable('x-powered-by');
  app.use(
    cors({
      origin: options.allowedOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['content-type', HOST_TOKEN_HEADER],
    }),
  );
  app.use((req, res, next) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (req.method === 'OPTIONS') {
      next();
      return;
    }
    if (!tokenMatches(expected, req.get(HOST_TOKEN_HEADER))) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  const route =
    (handler: (body: Record<string, unknown>) => unknown) =>
    async (req: Request, res: Response) => {
      try {
        const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
        res.json((await handler(body)) ?? null);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    };
  const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

  app.post('/pick-restore-file', route(() => pickRestoreFile(options.dialogs)));
  app.post('/backup', route((b) => backupDatabase(str(b.pin), options.dialogs, options.shutdownSignal)));
  app.post(
    '/restore',
    route((b) =>
      restoreDatabaseBackup(str(b.pin), str(b.backupPath), options.dialogs, options.shutdownSignal),
    ),
  );
  app.post('/health-check', route(() => databaseHealthCheck()));
  app.post(
    '/safe-fixes',
    route((b) =>
      applyDatabaseSafeFixes(
        str(b.pin),
        Array.isArray(b.findingIds) ? b.findingIds.filter((id): id is string => typeof id === 'string') : undefined,
      ),
    ),
  );
  app.post('/master-pin-status', route(() => masterPinStatus()));
  app.post(
    '/initialize',
    route((b) =>
      initializeDatabase({ pin: str(b.pin), confirmationPhrase: str(b.confirmationPhrase) }, options.shutdownSignal),
    ),
  );
  app.post('/settings', route(() => getRendererSettings()));
  app.post('/set-setting', route((b) => setRendererSetting(b.key as string, b.value as string)));
  app.post('/whatsapp-status', route(() => whatsAppStatus()));
  app.post('/whatsapp-share', route((b) => openWhatsAppShare(b.url)));
  app.post('/kds-info', route(() => kdsInfo()));
  app.post('/app-info', route(() => options.appInfo()));
  app.post('/log-tail', route(() => logTail()));
  app.post('/report-renderer-error', route(() => reportRendererError()));
  app.post('/posthog-bootstrap', route(() => postHogBootstrap()));
  app.post('/printers', route(() => listPrinters()));
  return app;
}

export function startActionServer(options: {
  serverPort: number;
  shutdownSignal?: AbortSignal;
}): Promise<ActionServer> {
  const token = randomBytes(32).toString('base64url');
  const app = createActionApp({
    token,
    allowedOrigins: [`http://127.0.0.1:${options.serverPort}`, `http://localhost:${options.serverPort}`],
    dialogs: androidHostDialogs(),
    shutdownSignal: options.shutdownSignal,
    appInfo: () => ({
      version: platformApp().getVersion(),
      name: 'Al Baik POS',
      node: process.versions.node,
      platform: 'android',
    }),
  });
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        token,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
