/**
 * First module the Android entry loads: installs the platform host and the log
 * file location before any backend module reads paths, secrets, or logs.
 */
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import { setPlatformHost } from '../platform';
import { createAndroidPlatformHost } from '../platform/android-host';
import { callNative } from './native-bridge';

export interface AndroidRuntimeEnv {
  userDataDir: string;
  documentsDir: string;
  version: string;
  locale: string;
  countryCode: string;
  secretKey: Buffer;
  bridgeSocket: string;
  bridgeToken: string;
}

const SECRET_ENV_KEYS = ['FLO_ANDROID_SECRET_KEY', 'FLO_ANDROID_BRIDGE_TOKEN'];

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Android runtime is missing ${key}`);
  return value;
}

export function readAndroidRuntimeEnv(env: NodeJS.ProcessEnv = process.env): AndroidRuntimeEnv {
  const secretKey = Buffer.from(required(env, 'FLO_ANDROID_SECRET_KEY'), 'base64');
  if (secretKey.length !== 32) throw new Error('FLO_ANDROID_SECRET_KEY must decode to 32 bytes');
  return {
    userDataDir: required(env, 'FLO_ANDROID_USER_DATA'),
    documentsDir: required(env, 'FLO_ANDROID_DOCUMENTS'),
    version: required(env, 'FLO_ANDROID_VERSION'),
    locale: env.FLO_ANDROID_LOCALE ?? '',
    countryCode: env.FLO_ANDROID_COUNTRY ?? '',
    secretKey,
    bridgeSocket: required(env, 'FLO_ANDROID_BRIDGE_SOCKET'),
    bridgeToken: required(env, 'FLO_ANDROID_BRIDGE_TOKEN'),
  };
}

export function installAndroidRuntime(env: NodeJS.ProcessEnv = process.env): AndroidRuntimeEnv {
  const runtime = readAndroidRuntimeEnv(env);
  for (const key of SECRET_ENV_KEYS) delete env[key];

  fs.mkdirSync(runtime.userDataDir, { recursive: true });
  fs.mkdirSync(runtime.documentsDir, { recursive: true });
  const logFile = path.join(runtime.userDataDir, 'logs', 'main.log');
  log.transports.file.resolvePathFn = () => logFile;

  setPlatformHost(
    createAndroidPlatformHost({
      userDataDir: runtime.userDataDir,
      documentsDir: runtime.documentsDir,
      version: runtime.version,
      locale: runtime.locale,
      countryCode: runtime.countryCode,
      secretKey: runtime.secretKey,
      openExternal: async (url: string) => {
        await callNative('openExternal', { url });
      },
    }),
  );
  return runtime;
}
