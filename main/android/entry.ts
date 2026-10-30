/**
 * Node entry for the Android main tablet. The shell starts it inside its
 * foreground service with the environment read by ./bootstrap.
 */
import log from 'electron-log';
import { installAndroidRuntime } from './bootstrap';
import { connectNativeBridge, notifyNative, onNativeRequest } from './native-bridge';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const runtime = installAndroidRuntime();
  await connectNativeBridge(runtime.bridgeSocket, runtime.bridgeToken);

  process.on('uncaughtException', (error) => log.error('[Android] Uncaught exception:', error));
  process.on('unhandledRejection', (reason) => log.error('[Android] Unhandled rejection:', reason));

  // Backend modules read the platform host at import time, so they load only after it is installed.
  const services = await import('./services');
  const hostActions = services.androidHostActions();
  onNativeRequest('hostAction', (params) => {
    const { route, body } = (params ?? {}) as { route?: unknown; body?: unknown };
    return hostActions(String(route), body);
  });
  onNativeRequest('shutdown', async () => {
    await services.stopAndroidServices();
    return { stopped: true };
  });

  try {
    const info = await services.startAndroidServices();
    log.info('[Android] Runtime is ready', info);
    notifyNative('ready', info);
  } catch (error) {
    log.error('[Android] Runtime failed to start:', error);
    notifyNative('failed', { message: describe(error) });
    await services.stopAndroidServices().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('[Android] Fatal startup error:', error);
});
