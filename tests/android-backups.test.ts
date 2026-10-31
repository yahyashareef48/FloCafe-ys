/**
 * Android backups — the Android app keeps no backups and makes no cloud connections: scheduled,
 * manual and pre-migration backups are refused or skipped, a reset deletes its own copy once it
 * commits, backups an earlier build kept are removed, and Offline mode cannot be switched off.
 * Without the Android host the same code still publishes backups on storage without hard links
 * (shared and network volumes on desktop).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-android-backups-'));
const userData = path.join(testDir, 'data');
const documents = path.join(testDir, 'documents');
fs.mkdirSync(userData, { recursive: true });
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => userData, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const {
  assertOrThrow,
  assertEqualOrThrow,
  initTestDb,
  closeDatabase,
  getDatabase,
} = require('./helpers/test-setup');
const platform = require('../main/platform');
const { createAndroidPlatformHost } = require('../main/platform/android-host');
const { createKeyedSafeStorage } = require('../main/platform/keyed-safe-storage');
const db = require('../main/db');
const localBackupModule = require('../main/services/local-backup');
const {
  setAutomaticBackupsEnabled,
  areAutomaticBackupsEnabled,
} = require('../main/services/automatic-backups');
const { isOfflineMode, isOfflineModeLocked } = require('../main/services/offline-mode');
const hostActions = require('../main/host-actions');
const { androidHostDialogs } = require('../main/android/host-action-routes');

const { localBackup, getLocalBackupDir, listLocalBackups, retainBackupLocally } = localBackupModule;
const key = randomBytes(32);
const privateBackups = path.join(userData, 'backups');

const keptBackups = () =>
  fs.existsSync(privateBackups)
    ? fs.readdirSync(privateBackups).filter((name) => /^flo-backup-.*\.db$/.test(name))
    : [];

function isValidDatabase(file: string): boolean {
  const check = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (
      check
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'orders'")
        .get().n === 1
    );
  } finally {
    check.close();
  }
}

async function main(): Promise<void> {
  platform.setPlatformHost(
    createAndroidPlatformHost({
      userDataDir: userData,
      documentsDir: documents,
      version: 'test',
      locale: 'en-IN',
      countryCode: 'IN',
      secretKey: key,
      openExternal: async () => undefined,
    }),
  );
  fs.writeFileSync(
    path.join(userData, 'master-pin.enc'),
    createKeyedSafeStorage(key).encryptString(
      JSON.stringify({ hash: bcrypt.hashSync('2468', 4), createdAt: 'x', updatedAt: 'x' }),
    ),
  );
  initTestDb();
  getDatabase().prepare("INSERT INTO categories (id, name) VALUES ('c-1', 'Tea')").run();
  getDatabase()
    .prepare(
      "INSERT INTO products (id, category_id, name, price) VALUES ('p-1', 'c-1', 'Masala Chai', 30)",
    )
    .run();

  console.log('\n--- No backup of any kind on Android ---');
  assertEqualOrThrow(db.backupsDisabled(), true, 'backups are disabled under the Android host');
  assertEqualOrThrow(keptBackups().length, 0, 'migrating a new database keeps no backup');
  assertEqualOrThrow(areAutomaticBackupsEnabled(), false, 'automatic backups are off');
  setAutomaticBackupsEnabled(true);
  assertEqualOrThrow(areAutomaticBackupsEnabled(), false, 'automatic backups cannot be turned on');
  assertEqualOrThrow(localBackupModule.isLocalBackupEnabled(), false, 'local backups are off');
  await localBackup.runIfDue();
  assertEqualOrThrow(
    fs.existsSync(getLocalBackupDir()),
    false,
    'no daily backup or folder is written',
  );

  let refused = '';
  try {
    await db.createBackup(path.join(testDir, 'direct.db'));
  } catch (error) {
    refused = (error as Error).message;
  }
  assertOrThrow(refused.includes('turned off'), `createBackup is refused (${refused})`);
  assertEqualOrThrow(
    fs.existsSync(path.join(testDir, 'direct.db')),
    false,
    'a refused backup writes no file',
  );

  const manual = await hostActions.backupDatabase('2468', androidHostDialogs());
  assertEqualOrThrow(manual.success, false, 'the manual backup action is refused');
  assertOrThrow(
    !fs.existsSync(path.join(documents, 'FloCafe', 'Manual Backups')) ||
      fs.readdirSync(path.join(documents, 'FloCafe', 'Manual Backups')).length === 0,
    'no manual backup file is written',
  );

  console.log('\n--- A reset keeps no copy ---');
  const reset = await db.resetDatabaseWithBackup();
  assertEqualOrThrow(reset.backupPath, '', 'the reset reports no kept backup');
  assertEqualOrThrow(keptBackups().length, 0, 'the reset deletes its own copy after committing');
  assertEqualOrThrow(
    getDatabase().prepare("SELECT COUNT(*) AS n FROM products WHERE id = 'p-1'").get().n,
    0,
    'the reset itself still happened',
  );

  console.log('\n--- Backups from an earlier build are removed ---');
  fs.mkdirSync(privateBackups, { recursive: true });
  fs.writeFileSync(
    path.join(privateBackups, 'flo-backup-2026-10-31T09-34-31-102Z-pre-v0-to-v117.db'),
    'x',
  );
  fs.writeFileSync(path.join(privateBackups, 'flo-reset-recovery-abc.db'), 'x');
  assertEqualOrThrow(db.removeKeptBackups(), 1, 'one kept backup is removed');
  assertEqualOrThrow(keptBackups().length, 0, 'no kept backup remains');
  assertOrThrow(
    fs.existsSync(path.join(privateBackups, 'flo-reset-recovery-abc.db')),
    'a crash-recovery copy is left for the recovery code',
  );

  console.log('\n--- No cloud connections ---');
  assertEqualOrThrow(isOfflineModeLocked(), true, 'Offline mode is locked on Android');
  assertEqualOrThrow(isOfflineMode(), true, 'Offline mode is on without the setting');

  console.log('\n--- Without the Android host: storage without hard links ---');
  platform.resetPlatformHost();
  assertEqualOrThrow(db.backupsDisabled(), false, 'backups are allowed on desktop');
  assertEqualOrThrow(isOfflineModeLocked(), false, 'Offline mode is not locked on desktop');
  setAutomaticBackupsEnabled(true);
  getDatabase().prepare("INSERT INTO categories (id, name) VALUES ('c-2', 'Coffee')").run();
  getDatabase()
    .prepare(
      "INSERT INTO products (id, category_id, name, price) VALUES ('p-2', 'c-2', 'Latte', 40)",
    )
    .run();
  const source = path.join(testDir, 'source.db');
  await db.createBackup(source);
  // Patch the real module: the TypeScript namespace import is a read-only view of it.
  const nodeFs = require('node:fs');
  const realLink = nodeFs.linkSync;
  let linkAttempts = 0;
  // Android shared storage refuses link() with EACCES; network and FAT volumes use EPERM.
  const refusals = ['EACCES', 'EPERM'];
  nodeFs.linkSync = () => {
    const code = refusals[linkAttempts++ % refusals.length];
    throw Object.assign(new Error(`${code}: link refused`), { code });
  };
  try {
    const one = retainBackupLocally(source);
    const two = retainBackupLocally(source);
    assertOrThrow(linkAttempts >= 2, 'the hard link is tried first');
    assertOrThrow(
      typeof one === 'string' && fs.existsSync(one),
      'a backup is published without hard links',
    );
    assertOrThrow(
      typeof two === 'string' && fs.existsSync(two) && two !== one,
      'a second backup gets its own name instead of replacing the first',
    );
    assertOrThrow(
      isValidDatabase(one) && isValidDatabase(two),
      'both published backups are readable databases',
    );
    const leftovers = fs.readdirSync(getLocalBackupDir()).filter((name) => name.endsWith('.tmp'));
    assertEqualOrThrow(leftovers.length, 0, 'no staging files are left behind');
    fs.rmSync(getLocalBackupDir(), { recursive: true, force: true });
    await localBackup.runIfDue();
    assertEqualOrThrow(
      listLocalBackups(getLocalBackupDir()).length,
      1,
      'the scheduled backup also works without hard links',
    );
  } finally {
    nodeFs.linkSync = realLink;
  }
  console.log('\nandroid-backups: all assertions passed');
}

main()
  .then(() => {
    platform.resetPlatformHost();
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
