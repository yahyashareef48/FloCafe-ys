/**
 * Android backups — with the Android platform host installed, scheduled local
 * backups are off until the "automatic backups" switch is turned on, then land
 * in the host's documents folder; manual backups work either way, and
 * publishing still works on storage without hard links (Android shared storage).
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
const localBackupModule = require('../main/services/local-backup');
const {
  setAutomaticBackupsEnabled,
  areAutomaticBackupsEnabled,
} = require('../main/services/automatic-backups');
const hostActions = require('../main/host-actions');
const { androidHostDialogs } = require('../main/android/host-action-routes');

const { localBackup, getLocalBackupDir, listLocalBackups, retainBackupLocally } = localBackupModule;
const key = randomBytes(32);

function backupFiles(): string[] {
  const dir = getLocalBackupDir();
  return fs.existsSync(dir) ? listLocalBackups(dir) : [];
}

function clearBackups(): void {
  fs.rmSync(getLocalBackupDir(), { recursive: true, force: true });
}

function isValidDatabase(file: string): boolean {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'orders'")
        .get().n === 1
    );
  } finally {
    db.close();
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
  // Scheduled backups skip a database with no business data.
  getDatabase().prepare("INSERT INTO categories (id, name) VALUES ('c-1', 'Tea')").run();
  getDatabase()
    .prepare(
      "INSERT INTO products (id, category_id, name, price) VALUES ('p-1', 'c-1', 'Masala Chai', 30)",
    )
    .run();

  console.log(
    '\n--- Scheduled backups are off by default and go to the Android documents folder when on ---',
  );
  assertEqualOrThrow(
    getLocalBackupDir(),
    path.join(documents, 'FloCafe', 'Backups'),
    'the backup folder is under the Android documents folder',
  );
  assertEqualOrThrow(areAutomaticBackupsEnabled(), false, 'automatic backups start switched off');
  await localBackup.runIfDue();
  assertEqualOrThrow(
    fs.existsSync(getLocalBackupDir()),
    false,
    'by default no daily backup is written and no folder is created',
  );
  setAutomaticBackupsEnabled(true);
  await localBackup.runIfDue();
  const first = backupFiles();
  assertEqualOrThrow(first.length, 1, 'switched on, the daily backup is written');
  assertOrThrow(
    isValidDatabase(path.join(getLocalBackupDir(), first[0])),
    'the daily backup is a readable database',
  );

  console.log('\n--- Switching automatic backups off stops them ---');
  clearBackups();
  setAutomaticBackupsEnabled(false);
  await localBackup.runIfDue();
  assertEqualOrThrow(backupFiles().length, 0, 'switched off, no daily backup is written');
  assertEqualOrThrow(
    fs.existsSync(getLocalBackupDir()),
    false,
    'switched off, the backup folder is not even created',
  );

  console.log('\n--- Manual backups still work with automatic backups off ---');
  const manual = await hostActions.backupDatabase('2468', androidHostDialogs());
  assertEqualOrThrow(manual.success, true, `the manual backup succeeds (${manual.error ?? ''})`);
  assertOrThrow(
    manual.path.startsWith(path.join(documents, 'FloCafe', 'Manual Backups')),
    'the manual backup lands in the Android documents folder',
  );
  assertOrThrow(isValidDatabase(manual.path), 'the manual backup is a readable database');
  const wrongPin = await hostActions.backupDatabase('1111', androidHostDialogs());
  assertEqualOrThrow(wrongPin.success, false, 'a wrong master PIN is still refused');

  console.log('\n--- Storage without hard links (Android shared storage) ---');
  setAutomaticBackupsEnabled(true);
  // Patch the real module: the TypeScript namespace import is a read-only view of it.
  const nodeFs = require('node:fs');
  const realLink = nodeFs.linkSync;
  let linkAttempts = 0;
  // Android shared storage refuses link() with EACCES (seen on the emulator); other volumes use EPERM.
  const refusals = ['EACCES', 'EPERM'];
  nodeFs.linkSync = () => {
    const code = refusals[linkAttempts++ % refusals.length];
    throw Object.assign(new Error(`${code}: link refused`), { code });
  };
  try {
    const one = retainBackupLocally(manual.path);
    const two = retainBackupLocally(manual.path);
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

    clearBackups();
    await localBackup.runIfDue();
    assertEqualOrThrow(
      backupFiles().length,
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
