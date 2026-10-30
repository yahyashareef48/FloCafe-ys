import { ipcMain, dialog, app, BrowserWindow, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getServerPort } from './server-state';
import { getKdsPort } from './kds-server';
import { createKdsWindow, applyWindowControlAction } from './window-options';
import {
  isApplicationMenuSender,
  listApplicationMenuEntries,
  openApplicationMenuSubmenu,
} from './application-menu';
import {
  isCurrentRendererFrame,
  markWindowRendererReady,
  registerRendererDocument,
} from './window-readiness';
import { appendThemeQueryParam } from './title-bar-theme';
import { getLocalIP } from './server';
import { rasterizeKotDocumentForWebUsb, rasterizePrintDocumentForWebUsb } from './printers/thermal';
import { isKotDocument, isPrintDocument } from '../shared/print/document';
import {
  applyDatabaseSafeFixes,
  backupDatabase,
  databaseHealthCheck,
  getErrorMessage,
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
} from './host-actions';

// Cap on renderer-built print HTML accepted for PDF export.
const MAX_PDF_HTML_BYTES = 2_000_000;

const MIN_RASTER_COLUMNS = 32;
const MAX_RASTER_COLUMNS = 48;

function isValidRasterColumns(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_RASTER_COLUMNS &&
    value <= MAX_RASTER_COLUMNS
  );
}

const TRUSTED_LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Verifies that a URL has http: scheme, no credentials, loopback host, and matches the configured port. */
export function isTrustedLoopbackUrl(rawUrl: string, port: number): boolean {
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port <= 0) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password) {
      return false;
    }
    const parsedPort = parsed.port ? Number(parsed.port) : 80;
    if (parsedPort !== port) {
      return false;
    }
    return TRUSTED_LOOPBACK_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Verifies that IPC sender origin is the localhost-served POS renderer. */
export function isTrustedSender(event: Pick<Electron.IpcMainInvokeEvent, 'sender'>): boolean {
  try {
    const url = new URL(event.sender?.getURL?.() ?? '');
    if (url.protocol !== 'http:' || url.username || url.password) return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

type MainWindowGetter = () => BrowserWindow | null;
type IpcHandler<Args extends unknown[] = unknown[]> = (
  event: Electron.IpcMainInvokeEvent,
  ...args: Args
) => unknown | Promise<unknown>;

let activeMainWindowGetter: MainWindowGetter | undefined;

/** Verifies that IPC sender is the active main BrowserWindow, current top-level frame, and exact local app origin. */
export function isTrustedMainWindowSender(
  event: Pick<Electron.IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  mainWindowOrGetter:
    | BrowserWindow
    | null
    | (() => BrowserWindow | null)
    | undefined = activeMainWindowGetter,
  port: number = getServerPort(),
  browserWindowClass: {
    fromWebContents: (sender: Electron.WebContents) => BrowserWindow | null;
  } = BrowserWindow,
): boolean {
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port <= 0) {
    return false;
  }

  const mainWindow =
    typeof mainWindowOrGetter === 'function' ? mainWindowOrGetter() : mainWindowOrGetter;
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (!event || !event.sender) {
    return false;
  }

  let senderWindow: BrowserWindow | null = null;
  try {
    senderWindow = browserWindowClass.fromWebContents(event.sender);
  } catch {
    return false;
  }
  if (!senderWindow || senderWindow !== mainWindow) {
    return false;
  }

  let currentFrame: Electron.WebFrameMain | null = null;
  try {
    currentFrame = event.sender.mainFrame;
  } catch {
    return false;
  }
  if (!isCurrentRendererFrame(event.senderFrame, currentFrame)) {
    return false;
  }

  const senderUrl = event.sender?.getURL?.() ?? '';
  if (!isTrustedLoopbackUrl(senderUrl, port)) {
    return false;
  }

  const frameUrl = (event.senderFrame as { url?: string } | null | undefined)?.url;
  if (typeof frameUrl === 'string' && !isTrustedLoopbackUrl(frameUrl, port)) {
    return false;
  }

  return true;
}

/** Preload origin check before Chromium has committed localhost URL. */
function isEarlyMainWindowSender(
  event: Pick<Electron.IpcMainEvent, 'sender'>,
  getMainWindow?: MainWindowGetter,
): boolean {
  if (!getMainWindow) return false;
  try {
    const url = event.sender?.getURL?.() ?? '';
    if (url !== '' && url !== 'about:blank') return false;
    const expectedWindow = getMainWindow();
    return Boolean(
      expectedWindow &&
      !expectedWindow.isDestroyed() &&
      BrowserWindow.fromWebContents(event.sender) === expectedWindow,
    );
  } catch {
    return false;
  }
}

function electronHostDialogs(): HostDialogs {
  return {
    async chooseBackupDestination(defaultFileName) {
      const result = await dialog.showSaveDialog({
        defaultPath: path.join(app.getPath('documents'), defaultFileName),
        filters: [{ name: 'SQLite Database', extensions: ['db'] }],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    async chooseRestoreFile() {
      const result = await dialog.showOpenDialog({
        filters: [{ name: 'SQLite Database', extensions: ['db'] }],
        properties: ['openFile'],
      });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    },
    async confirmSchemaMismatch(backupVersion, currentVersion) {
      const confirmResult = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Restore Anyway', 'Cancel'],
        defaultId: 1,
        title: 'Schema Version Mismatch',
        message: `Backup was created with Schema v${backupVersion}`,
        detail: `Current database uses Schema v${currentVersion}.\n\nRestoring will import data only (common fields) to preserve new database structure.\n\nDo you want to continue?`,
      });
      return confirmResult.response === 0;
    },
  };
}

function handle<Args extends unknown[]>(channel: string, listener: IpcHandler<Args>): void {
  ipcMain.handle(channel, (event: Electron.IpcMainInvokeEvent, ...args: Args) => {
    if (!isTrustedMainWindowSender(event)) return { error: 'Unauthorized sender' };
    return listener(event, ...args);
  });
}

export function registerIpcHandlers(
  shutdownSignal?: AbortSignal,
  getMainWindow?: MainWindowGetter,
  showMainWindow: (window: BrowserWindow) => boolean = () => false,
  getCurrentEffectiveIsDark?: () => boolean,
): void {
  activeMainWindowGetter = getMainWindow;
  ipcMain.on('window-document', (event, documentNonce: unknown) => {
    let currentFrame: Electron.WebFrameMain | null = null;
    try {
      currentFrame = event.sender.mainFrame;
    } catch {
      event.returnValue = { success: false, error: 'Invalid document registration' };
      return;
    }
    if (!isCurrentRendererFrame(event.senderFrame, currentFrame)) {
      event.returnValue = { success: false, error: 'Invalid document registration' };
      return;
    }
    if (!isTrustedSender(event) && !isEarlyMainWindowSender(event, getMainWindow)) {
      event.returnValue = { error: 'Unauthorized sender' };
      return;
    }
    event.returnValue = registerRendererDocument(documentNonce)
      ? { success: true }
      : { success: false, error: 'Invalid document nonce' };
  });

  const dialogs = electronHostDialogs();

  // Opens the native picker for "Restore from a file..."; see pickRestoreFile.
  handle('pick-restore-file', async () => pickRestoreFile(dialogs));

  // Database backup/restore
  handle('backup-database', async (event, pin?: string) =>
    backupDatabase(pin, dialogs, shutdownSignal),
  );

  handle('restore-backup', async (event, pin?: string, presetBackupPath?: string) =>
    restoreDatabaseBackup(pin, presetBackupPath, dialogs, shutdownSignal),
  );

  // DB health check / master PIN / initialize (menu + tray triggered)
  handle('db-health-check', async () => databaseHealthCheck());

  handle('db-apply-safe-fixes', async (event, pin?: string, findingIds?: string[]) =>
    applyDatabaseSafeFixes(pin, findingIds),
  );

  handle('master-pin-status', async () => masterPinStatus());

  handle(
    'db-initialize',
    async (event, payload: { pin?: string; confirmationPhrase?: string }) =>
      initializeDatabase(payload, shutdownSignal),
  );

  // Window-control surface for renderer title bar HTML fallback controls.
  handle('window-action', (event, action: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { error: 'Window unavailable' };
    return applyWindowControlAction(win, action);
  });

  // Application menu for the frameless Windows/Linux title bar. Electron does
  // not draw a menu bar on a frameless window, so the renderer renders the
  // top-level labels and main pops the matching submenu from the same Menu
  // object createMenu() already applied (accelerators keep working). macOS
  // keeps its authoritative native menu bar and has no title-bar menu.
  handle('get-application-menu', () => {
    if (process.platform === 'darwin') return { entries: [] };
    const menu = Menu.getApplicationMenu() ?? null;
    return { entries: menu ? listApplicationMenuEntries(menu.items) : [] };
  });

  handle('open-application-menu', (event, key: unknown, x: unknown, y: unknown) => {
    if (process.platform === 'darwin') return { error: 'Application menu is native on macOS' };
    // Bind the popup to the main window's own current renderer frame.
    let currentFrame: Electron.WebFrameMain | null = null;
    try {
      currentFrame = event.sender.mainFrame;
    } catch {
      return { error: 'Unauthorized sender' };
    }
    const mainWindow = getMainWindow?.() ?? null;
    if (
      !isApplicationMenuSender(mainWindow, {
        window: BrowserWindow.fromWebContents(event.sender),
        currentFrame,
        senderFrame: event.senderFrame,
      })
    ) {
      return { error: 'Unauthorized sender' };
    }
    return openApplicationMenuSubmenu(Menu.getApplicationMenu() ?? null, key, mainWindow, x, y);
  });

  handle('get-window-state', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { isMaximized: false, isFullScreen: false };
    return {
      isMaximized: win.isMaximized(),
      isFullScreen: win.isFullScreen(),
    };
  });

  handle('window-ready', (event, payload: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { error: 'Window unavailable' };
    let currentFrame: Electron.WebFrameMain | null = null;
    try {
      currentFrame = event.sender.mainFrame;
    } catch {
      return { success: false, error: 'Stale or invalid readiness report' };
    }
    if (!isCurrentRendererFrame(event.senderFrame, currentFrame)) {
      return { success: false, error: 'Stale or invalid readiness report' };
    }
    // Verify readiness report epoch/nonce before showing window.
    const reported = payload as { epoch?: unknown; documentNonce?: unknown } | null | undefined;
    if (!markWindowRendererReady(reported?.epoch, reported?.documentNonce)) {
      return { success: false, error: 'Stale or invalid readiness report' };
    }
    showMainWindow(win);
    return { success: true };
  });

  // Settings
  handle('get-settings', async () => getRendererSettings());

  handle('set-setting', async (event, key: string, value: string) =>
    setRendererSetting(key, value),
  );

  // WhatsApp status snapshot for renderer polling on app focus
  handle('whatsapp-get-status', async () => whatsAppStatus());

  handle('whatsapp-open-share', async (_event, rawUrl: unknown) => openWhatsAppShare(rawUrl));

  // Module-level reference to ensure single instance
  let activeKdsWindow: BrowserWindow | null = null;

  // KDS info
  handle('get-kds-info', async () => kdsInfo());

  // Window management
  handle('open-kds-window', async () => {
    if (activeKdsWindow && !activeKdsWindow.isDestroyed()) {
      activeKdsWindow.focus();
      return;
    }

    const port = getKdsPort();
    const localIP = getLocalIP();
    const kdsOrigin = `http://${localIP}:${port}`;

    activeKdsWindow = createKdsWindow(BrowserWindow);

    activeKdsWindow.on('closed', () => {
      activeKdsWindow = null;
    });

    // Confine KDS window to its own origin and deny external navigation/windows.
    activeKdsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    activeKdsWindow.webContents.on('will-navigate', (event, url) => {
      let allowed = false;
      try {
        allowed = new URL(url).origin === kdsOrigin;
      } catch {
        allowed = false;
      }
      if (!allowed) event.preventDefault();
    });

    // KDS window has no preload; learns palette from URL param.
    const kdsUrl = appendThemeQueryParam(
      `${kdsOrigin}/kds`,
      getCurrentEffectiveIsDark ? getCurrentEffectiveIsDark() : false,
    );
    activeKdsWindow.loadURL(kdsUrl);
  });

  handle('get-app-info', async () => {
    return {
      version: app.getVersion(),
      name: app.getName(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
    };
  });

  handle('get-log-tail', async () => logTail());

  handle('report-renderer-error', async () => reportRendererError());

  handle('get-posthog-bootstrap', async () => postHogBootstrap());

  // Printers
  handle('get-printers', async () => listPrinters());

  // Saves renderer-built print HTML (the menu, and future documents) as a PDF
  // through an offscreen window, so a merchant can share it without a printer.
  handle('save-html-as-pdf', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object')
      return { success: false, error: 'Invalid PDF request' };
    const { html, defaultFileName, pageSize } = payload as {
      html?: unknown;
      defaultFileName?: unknown;
      pageSize?: unknown;
    };
    if (typeof html !== 'string' || html.length === 0) {
      return { success: false, error: 'Invalid PDF request' };
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_PDF_HTML_BYTES) {
      return { success: false, error: 'Document too large to export' };
    }
    const resolvedPageSize = pageSize === 'Letter' ? 'Letter' : 'A4';
    const requestedName = typeof defaultFileName === 'string' ? defaultFileName.trim() : '';
    const baseName = requestedName.replace(/[^\w.\- ]+/g, '-').slice(0, 80) || 'document.pdf';
    const saveResult = await dialog.showSaveDialog({
      defaultPath: path.join(
        app.getPath('documents'),
        baseName.endsWith('.pdf') ? baseName : `${baseName}.pdf`,
      ),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return { success: false, canceled: true };

    const pdfWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: false,
      },
    });
    try {
      await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdfData = await pdfWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: resolvedPageSize,
      });
      await fs.promises.writeFile(saveResult.filePath, pdfData);
      return { success: true, path: saveResult.filePath };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    } finally {
      if (!pdfWindow.isDestroyed()) pdfWindow.destroy();
    }
  });

  handle('rasterize-print-document', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object')
      return { ok: false, error: 'Invalid raster document request' };
    const request = payload as {
      document?: unknown;
      template?: unknown;
      profileId?: unknown;
      options?: unknown;
    };
    if (
      !isPrintDocument(request.document) ||
      (request.template !== 'classic' && request.template !== 'compact') ||
      typeof request.profileId !== 'string' ||
      request.profileId.length === 0 ||
      !request.options ||
      typeof request.options !== 'object'
    ) {
      return { ok: false, error: 'Invalid raster document request' };
    }
    const options = request.options as Record<string, unknown>;
    if (
      !isValidRasterColumns(options.columns) ||
      typeof options.language !== 'string' ||
      typeof options.locale !== 'string' ||
      typeof options.currency !== 'string' ||
      typeof options.currencySymbol !== 'string' ||
      typeof options.trimDecimals !== 'boolean' ||
      typeof options.useUnicode !== 'boolean' ||
      typeof options.arabicShaping !== 'boolean' ||
      (options.timezone !== undefined && typeof options.timezone !== 'string')
    ) {
      return { ok: false, error: 'Invalid raster document options' };
    }
    try {
      return await rasterizePrintDocumentForWebUsb(
        request.document as Parameters<typeof rasterizePrintDocumentForWebUsb>[0],
        request.template,
        request.profileId,
        options as Parameters<typeof rasterizePrintDocumentForWebUsb>[3],
      );
    } catch (error: unknown) {
      return { ok: false, error: getErrorMessage(error) };
    }
  });

  handle('rasterize-kot-document', async (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object')
      return { ok: false, error: 'Invalid raster KOT request' };
    const request = payload as {
      document?: unknown;
      profileId?: unknown;
      options?: unknown;
    };
    if (
      !isKotDocument(request.document) ||
      typeof request.profileId !== 'string' ||
      request.profileId.length === 0 ||
      !request.options ||
      typeof request.options !== 'object'
    ) {
      return { ok: false, error: 'Invalid raster KOT request' };
    }
    const options = request.options as Record<string, unknown>;
    if (
      !isValidRasterColumns(options.columns) ||
      typeof options.language !== 'string' ||
      typeof options.locale !== 'string' ||
      (options.timezone !== undefined && typeof options.timezone !== 'string') ||
      typeof options.useUnicode !== 'boolean' ||
      typeof options.arabicShaping !== 'boolean'
    ) {
      return { ok: false, error: 'Invalid raster KOT options' };
    }
    try {
      return await rasterizeKotDocumentForWebUsb(
        request.document,
        request.profileId,
        options as Parameters<typeof rasterizeKotDocumentForWebUsb>[2],
      );
    } catch (error: unknown) {
      return { ok: false, error: getErrorMessage(error) };
    }
  });

  console.log('[IPC] Handlers registered');
}
