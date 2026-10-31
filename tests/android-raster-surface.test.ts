/**
 * Android raster surface — the shell renders print text a thermal printer
 * cannot encode (the rupee sign, Persian, Urdu) by loading the backend's
 * raster page behind android/app/src/main/assets/raster-host.js in a hidden
 * WebView. This runs that exact page and host script in Chromium, with a
 * stand-in for the AlBaikRasterHost Java interface, and prints a full bill
 * through it on a 58 mm / 32-column USB printer.
 *
 * Needs Chromium; required when REQUIRE_VISUAL_EVIDENCE=1.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-android-raster-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const root = path.resolve(__dirname, '..');
const {
  assertOrThrow,
  assertEqualOrThrow,
  initTestDb,
  closeDatabase,
  getDatabase,
} = require('./helpers/test-setup');
const platform = require('../main/platform');
const { createAndroidPlatformHost } = require('../main/platform/android-host');
const { rasterRendererHtml } = require('../main/printers/raster-renderer');
const { decodeRasterWireResult } = require('../main/android/printing');
const thermal = require('../main/printers/thermal');
const { buildParityFixtures } = require('./print-parity.test');

/**
 * Mirrors RasterSurface.load(): the host script runs before the page's own script.
 * The first script stands in for the AlBaikRasterHost Java interface.
 */
function surfaceHtml(): string {
  const javaInterface =
    '<script>window.__results=[];window.AlBaikRasterHost={ready:function(){window.__ready=true;},result:function(json){window.__results.push(json);}};</script>';
  const host = `${javaInterface}<script>${fs.readFileSync(path.join(root, 'android/app/src/main/assets/raster-host.js'), 'utf8')}</script>`;
  const page = rasterRendererHtml();
  const firstScript = page.indexOf('<script>');
  return page.slice(0, firstScript) + host + page.slice(firstScript);
}

async function launchChromium(): Promise<any> {
  const playwright = require(path.resolve(root, 'frontend/node_modules/@playwright/test'));
  const executablePath = process.env.FLO_TEST_CHROMIUM_PATH || undefined;
  return playwright.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
}

async function main(): Promise<void> {
  let browser: any;
  try {
    browser = await launchChromium();
  } catch (error: any) {
    if (process.env.REQUIRE_VISUAL_EVIDENCE === '1') throw error;
    console.warn(
      `  ! Chromium not available; Android raster surface checks skipped: ${error?.message || error}`,
    );
    return;
  }
  const page = await browser.newPage();
  try {
    await page.setContent(surfaceHtml());
    await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
    assertEqualOrThrow(
      await page.evaluate(() => (window as any).__ready),
      true,
      'the page reports ready through AlBaikRasterHost',
    );

    const surfaceRenderer = {
      async render(request: { requestId: string }) {
        await page.evaluate(
          (req: unknown) => (window as any).__floRasterDeliver({ version: 1, request: req }),
          request,
        );
        const handle = await page.waitForFunction(
          (id: string) =>
            (window as any).__results.find((json: string) => JSON.parse(json).requestId === id),
          request.requestId,
          { timeout: 15_000 },
        );
        return decodeRasterWireResult(JSON.parse(await handle.jsonValue()), request.requestId);
      },
    };

    console.log('\n--- One unit renders through the Android host script ---');
    const single = await surfaceRenderer.render({
      version: 1,
      requestId: 'rupee-1',
      text: 'Total ₹1,250.00',
      widthDots: 384,
      maxBandHeight: 24,
      direction: 'ltr',
      style: 'bold',
      financial: true,
      maxLines: 2,
    } as any);
    assertEqualOrThrow(
      single.ok,
      true,
      `the rupee line renders (${single.ok ? '' : single.detail})`,
    );
    if (single.ok) {
      const band = single.unit.bands[0];
      assertEqualOrThrow(band.widthDots, 384, 'bands span the 58 mm print width (384 dots)');
      assertOrThrow(
        band.pixels instanceof Uint8Array && band.pixels.some((p: number) => p !== 0),
        'the band has printed (black) pixels',
      );
      assertOrThrow(
        band.pixels.every((p: number) => p === 0 || p === 1),
        'pixels survive base64 as 0/1 values',
      );
    }

    console.log('\n--- A full bill with ₹ and Persian text prints through it ---');
    initTestDb();
    getDatabase().exec(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'IN'), ('currency', 'INR'), ('currency_symbol', '₹')",
    );
    getDatabase()
      .prepare(
        `INSERT INTO printers (id, name, connection_type, port, paper_width, is_default, created_at, updated_at)
         VALUES ('usb-1', 'SR588 Posiflow (USB 0483:5720)', 'usb', 9100, 'cols-32', 1, datetime('now'), datetime('now'))`,
      )
      .run();
    const jobs: Buffer[] = [];
    platform.setPlatformHost(
      createAndroidPlatformHost({
        userDataDir: testDir,
        documentsDir: testDir,
        version: 'test',
        locale: 'en-IN',
        countryCode: 'IN',
        secretKey: randomBytes(32),
        openExternal: async () => undefined,
        printers: {
          list: async () => [],
          send: async (_name: string, data: Buffer) => {
            jobs.push(Buffer.from(data));
            return { ok: true };
          },
        },
        rasterRenderer: surfaceRenderer,
      }),
    );
    try {
      const { order, bill, business } = buildParityFixtures();
      const result = await thermal.printReceipt(
        order,
        bill,
        { ...business, highlight_token: true },
        'classic',
      );
      assertEqualOrThrow(result.ok, true, `the bill prints (${result.detail ?? ''})`);
      assertEqualOrThrow(jobs.length, 1, 'one job reaches the USB printer');
      assertOrThrow(
        jobs[0].includes(Buffer.from([0x1d, 0x76, 0x30])),
        'the job carries raster image commands (GS v 0) for the text the printer cannot encode',
      );
      assertOrThrow(
        thermal.escPosToText(jobs[0]).includes('Flo Parity Cafe'),
        'rows the printer can encode (the business name) stay plain ESC/POS text',
      );
    } finally {
      platform.resetPlatformHost();
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  console.log('\nandroid-raster-surface: all assertions passed');
}

main()
  .then(() => {
    try {
      closeDatabase();
    } catch {
      // The database was never opened when Chromium is unavailable.
    }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
