/**
 * Daily order and bill numbers (and so the bill token) restart when the store's business day ends,
 * not at midnight: with the day set to end at 02:00, a sale at 00:30 continues the evening's count.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/business-day-numbering.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-business-day-numbering-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, assertEqualOrThrow, closeDatabase } = require('./helpers/test-setup');
const { generateOrderNumber, generateBillNumber } = require('../main/db');

const RealDate = Date;
let fakeNow = RealDate.now();
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(fakeNow);
    else super(...(args as [string]));
  }
  static now() {
    return fakeNow;
  }
}

/** Sets the clock to a wall time in India (UTC+05:30). */
function at(isoLocalIndia: string) {
  fakeNow = RealDate.parse(`${isoLocalIndia}+05:30`);
}

const tail = (value: string) => Number(value.split('-').pop());
const date = (value: string) => value.split('-')[1];

function main() {
  const db = initTestDb();
  (globalThis as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;
  const setDayStart = (value: string) =>
    db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('business_day_start_time', ?)")
      .run(value);

  try {
    console.log('\n--- The day ends at 02:00 ---');
    setDayStart('02:00');
    at('2026-11-16T23:50:00');
    const lateOrder = generateOrderNumber();
    const lateBill = generateBillNumber();
    assertEqualOrThrow(date(lateOrder), '20261116', 'an 11:50 pm order is on the 16th');
    assertEqualOrThrow(tail(lateBill), 1, 'the first bill of the day is token 1');

    at('2026-11-17T00:30:00');
    const afterMidnightOrder = generateOrderNumber();
    const afterMidnightBill = generateBillNumber();
    assertEqualOrThrow(
      date(afterMidnightOrder),
      '20261116',
      'a 12:30 am order still belongs to the 16th',
    );
    assertEqualOrThrow(tail(afterMidnightOrder), tail(lateOrder) + 1, 'the order count continues');
    assertEqualOrThrow(date(afterMidnightBill), '20261116', 'so does the bill date');
    assertEqualOrThrow(tail(afterMidnightBill), 2, 'the token continues to 2, not back to 1');

    at('2026-11-17T01:59:00');
    assertEqualOrThrow(tail(generateBillNumber()), 3, 'at 1:59 am the token is still counting');

    at('2026-11-17T02:00:00');
    const newDayOrder = generateOrderNumber();
    const newDayBill = generateBillNumber();
    assertEqualOrThrow(date(newDayOrder), '20261117', 'at 2:00 am the 17th begins');
    assertEqualOrThrow(tail(newDayOrder), 1, 'the order count restarts');
    assertEqualOrThrow(tail(newDayBill), 1, 'the token restarts at 1');

    console.log('\n--- With no day end set, midnight still restarts the count ---');
    setDayStart('00:00');
    at('2026-11-18T23:50:00');
    generateBillNumber();
    at('2026-11-19T00:10:00');
    assertEqualOrThrow(tail(generateBillNumber()), 1, 'midnight restarts the token');

    console.log('\n--- Monthly invoice numbering keeps the calendar month ---');
    setDayStart('02:00');
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('invoice_number_reset_period', 'monthly')",
    ).run();
    at('2026-12-01T00:30:00');
    assertEqualOrThrow(
      date(generateBillNumber()),
      '202612',
      'the invoice month is the calendar one',
    );

    console.log('\nbusiness-day-numbering: all assertions passed');
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

try {
  main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
