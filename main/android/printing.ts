/**
 * Android printer and raster adapters: USB and Bluetooth ESC/POS bytes, and the
 * raster surface page, are handed to the shell over the native bridge.
 */
import { isRasterRenderResult, type RasterRenderRequest, type RasterRenderResult } from '../../shared/print/raster';
import { rasterRendererHtml } from '../printers/raster-renderer';
import type { PlatformPrinterInfo, PlatformPrinters, PlatformRasterRenderer } from '../platform';
import { callNative } from './native-bridge';

const LIST_TIMEOUT_MS = 30_000;
// Covers the one-time USB permission prompt and a slow Bluetooth connect.
const SEND_TIMEOUT_MS = 120_000;
const RASTER_TIMEOUT_MS = 20_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPrinterInfo(value: unknown): value is PlatformPrinterInfo {
  const candidate = value as Partial<PlatformPrinterInfo> | null;
  return (
    !!candidate &&
    typeof candidate.name === 'string' &&
    (candidate.connectionType === 'usb' || candidate.connectionType === 'bluetooth')
  );
}

export const androidPrinters: PlatformPrinters = {
  async list(signal) {
    if (signal?.aborted) return [];
    const found = await callNative<unknown>('printerList', {}, { timeoutMs: LIST_TIMEOUT_MS });
    if (!Array.isArray(found)) return [];
    return found.filter(isPrinterInfo).map((printer) => ({
      name: printer.name,
      make: String(printer.make ?? ''),
      model: String(printer.model ?? ''),
      connectionType: printer.connectionType,
      deviceUri: String(printer.deviceUri ?? ''),
    }));
  },

  async send(printerName, data, signal) {
    if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
    try {
      const result = await callNative<{ ok?: unknown; detail?: unknown } | null>(
        'printerSend',
        { name: printerName, data: data.toString('base64') },
        { timeoutMs: SEND_TIMEOUT_MS },
      );
      if (result?.ok === true) return { ok: true };
      return { ok: false, detail: typeof result?.detail === 'string' ? result.detail : 'The printer did not accept the job' };
    } catch (error) {
      return { ok: false, detail: describe(error) };
    }
  },
};

/**
 * The shell's raster page sends each band's pixels as `pixelsBase64` because a
 * Uint8Array does not survive JSON; this restores the shape the encoder expects.
 */
export function decodeRasterWireResult(wire: unknown, requestId: string): RasterRenderResult {
  const failure = (detail: string): RasterRenderResult => ({ version: 1, requestId, ok: false, code: 'render-failed', detail });
  if (!wire || typeof wire !== 'object') return failure('The raster surface returned no result');
  const result = wire as { ok?: unknown; unit?: { bands?: unknown } };
  if (result.ok === true && result.unit && Array.isArray(result.unit.bands)) {
    const bands = result.unit.bands.map((band: { widthDots?: unknown; heightDots?: unknown; pixelsBase64?: unknown }) => ({
      widthDots: band.widthDots,
      heightDots: band.heightDots,
      pixels: typeof band.pixelsBase64 === 'string' ? new Uint8Array(Buffer.from(band.pixelsBase64, 'base64')) : undefined,
    }));
    const decoded = { ...result, unit: { ...result.unit, bands } };
    if (isRasterRenderResult(decoded) && decoded.requestId === requestId) return decoded;
    return failure('The raster surface returned an invalid result');
  }
  if (isRasterRenderResult(wire) && wire.requestId === requestId) return wire;
  return failure('The raster surface returned an invalid result');
}

export const androidRasterRenderer: PlatformRasterRenderer = {
  async render(request: RasterRenderRequest): Promise<RasterRenderResult> {
    try {
      const wire = await callNative<unknown>(
        'rasterRender',
        { pageHtml: rasterRendererHtml(), request },
        { timeoutMs: RASTER_TIMEOUT_MS },
      );
      return decodeRasterWireResult(wire, request.requestId);
    } catch (error) {
      return { version: 1, requestId: request.requestId, ok: false, code: 'render-failed', detail: describe(error) };
    }
  },
};
