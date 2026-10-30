/**
 * Platform host — the backend reads app paths, version, locale and secret
 * storage through main/platform so the same modules run under Electron and
 * on Android. Electron stays the default and is resolved per call; an
 * installed host takes over every read.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

const Module = require('module');
const originalLoad = Module._load;
const electronDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-platform-electron-'));
const androidUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-platform-android-data-'));
const androidDocuments = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-platform-android-docs-'));

let electronVersion = 'electron-1';
const opened: string[] = [];

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: (name: string) => path.join(electronDir, name),
        getVersion: () => electronVersion,
        getLocale: () => 'en-US',
        getLocaleCountryCode: () => 'US',
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('unavailable');
        },
        decryptString: () => {
          throw new Error('unavailable');
        },
      },
      shell: { openExternal: async () => undefined },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  assertOrThrow,
  assertEqualOrThrow,
  initTestDb,
  closeDatabase,
} = require('./helpers/test-setup');
const platform = require('../main/platform');
const { createAndroidPlatformHost } = require('../main/platform/android-host');
const { createKeyedSafeStorage } = require('../main/platform/keyed-safe-storage');
const masterPin = require('../main/services/master-pin');
const { getLocalBackupDir } = require('../main/services/local-backup');
const { readCountryProvenance } = require('../main/services/country-provenance');

function run(): void {
  initTestDb();

  console.log('\n--- Electron remains the default host ---');
  assertEqualOrThrow(platform.platformId(), 'electron', 'no installed host means Electron');
  assertEqualOrThrow(platform.platformApp().getVersion(), 'electron-1', 'reads the Electron app');
  electronVersion = 'electron-2';
  assertEqualOrThrow(platform.platformApp().getVersion(), 'electron-2', 'Electron is resolved per call');
  assertEqualOrThrow(
    getLocalBackupDir(),
    path.join(electronDir, 'documents', 'FloCafe', 'Backups'),
    'local backups keep the Electron Documents path',
  );
  assertEqualOrThrow(masterPin.isMasterPinAvailable(), false, 'master PIN follows Electron safeStorage');

  console.log('\n--- Keyed secret storage ---');
  const key = randomBytes(32);
  const storage = createKeyedSafeStorage(key);
  const sealed = storage.encryptString('owner secret ✓');
  assertOrThrow(!sealed.includes(Buffer.from('owner secret')), 'ciphertext does not contain the plaintext');
  assertEqualOrThrow(storage.decryptString(sealed), 'owner secret ✓', 'round-trips UTF-8');
  assertOrThrow(
    !storage.encryptString('same').equals(storage.encryptString('same')),
    'each encryption uses a fresh IV',
  );
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 0xff;
  let tamperRejected = false;
  try {
    storage.decryptString(tampered);
  } catch {
    tamperRejected = true;
  }
  assertOrThrow(tamperRejected, 'tampered ciphertext is rejected');
  let wrongKeyRejected = false;
  try {
    createKeyedSafeStorage(randomBytes(32)).decryptString(sealed);
  } catch {
    wrongKeyRejected = true;
  }
  assertOrThrow(wrongKeyRejected, 'a different key cannot decrypt');
  let shortKeyRejected = false;
  try {
    createKeyedSafeStorage(randomBytes(16));
  } catch {
    shortKeyRejected = true;
  }
  assertOrThrow(shortKeyRejected, 'keys other than 32 bytes are refused');

  console.log('\n--- Installed Android host takes over ---');
  platform.setPlatformHost(
    createAndroidPlatformHost({
      userDataDir: androidUserData,
      documentsDir: androidDocuments,
      version: '3.13.0-android',
      locale: 'en-IN',
      countryCode: 'IN',
      secretKey: key,
      openExternal: async (url: string) => {
        opened.push(url);
      },
    }),
  );
  try {
    assertEqualOrThrow(platform.platformId(), 'android', 'installed host id');
    assertEqualOrThrow(platform.platformApp().isPackaged, true, 'Android builds count as packaged');
    assertEqualOrThrow(platform.platformApp().getVersion(), '3.13.0-android', 'version from the host');
    assertEqualOrThrow(
      getLocalBackupDir(),
      path.join(androidDocuments, 'FloCafe', 'Backups'),
      'local backups go to the host documents directory',
    );
    const provenance = readCountryProvenance();
    assertEqualOrThrow(provenance.osCountry, 'IN', 'country signal comes from the device locale');
    assertEqualOrThrow(provenance.osLocale, 'en-IN', 'locale signal comes from the device');

    assertEqualOrThrow(masterPin.isMasterPinAvailable(), true, 'master PIN uses the keyed storage');
    masterPin.setMasterPin('4321');
    const pinFile = path.join(androidUserData, 'master-pin.enc');
    assertOrThrow(fs.existsSync(pinFile), 'master PIN is written under the host userData');
    assertOrThrow(
      JSON.parse(storage.decryptString(fs.readFileSync(pinFile))).hash.startsWith('$2'),
      'master PIN blob is sealed with the host key',
    );
    assertEqualOrThrow(masterPin.verifyMasterPin('4321'), true, 'master PIN verifies');
    assertEqualOrThrow(masterPin.verifyMasterPin('1111'), false, 'wrong master PIN fails');

    void platform.platformShell().openExternal('https://example.com/auth');
    assertEqualOrThrow(opened[0], 'https://example.com/auth', 'openExternal goes to the host');
  } finally {
    platform.resetPlatformHost();
  }
  assertEqualOrThrow(platform.platformId(), 'electron', 'reset restores Electron');
}

try {
  run();
  console.log('\nplatform-host: all assertions passed');
} finally {
  closeDatabase();
  Module._load = originalLoad;
  for (const dir of [electronDir, androidUserData, androidDocuments]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
