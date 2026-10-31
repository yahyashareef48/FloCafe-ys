/** Image upload and compression utilities (WebP pipeline, size validation, fallback colors). */

const MAX_BASE64_LENGTH = 50_000;

type CropArea = { x: number; y: number; width: number; height: number };

const CROP_ENCODING_ATTEMPTS = [
  { size: 400, quality: 0.8 },
  { size: 400, quality: 0.6 },
  { size: 400, quality: 0.4 },
  { size: 320, quality: 0.6 },
  { size: 320, quality: 0.4 },
];

/** Encode a selected product-image crop within the database size limit. */
export function compressCroppedImage(image: HTMLImageElement, crop: CropArea): string | null {
  try {
    for (const { size, quality } of CROP_ENCODING_ATTEMPTS) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, size, size);
      const dataUri = canvas.toDataURL('image/webp', quality);
      if (dataUri !== 'data:,' && dataUri.length <= MAX_BASE64_LENGTH) return dataUri;
    }
  } catch {
    return null;
  }

  return null;
}

/** Compresses an image file to a 1:1 WebP data URI within size limits. */
export function compressImage(file: File, quality = 0.8): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      // Determine crop dimensions (center-crop to 1:1)
      const size = Math.min(img.width, img.height);
      const offsetX = (img.width - size) / 2;
      const offsetY = (img.height - size) / 2;

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }

      ctx.drawImage(img, offsetX, offsetY, size, size, 0, 0, size, size);

      // Try compression with retry at lower quality
      const qualities = [Math.min(1, Math.max(0, quality)), 0.6, 0.4];
      try {
        for (const q of qualities) {
          const dataUri = canvas.toDataURL('image/webp', q);
          if (dataUri.length <= MAX_BASE64_LENGTH) {
            resolve(dataUri);
            return;
          }
        }

        // All qualities too large — try PNG as fallback (smaller than original)
        const pngUri = canvas.toDataURL('image/png');
        if (pngUri.length <= MAX_BASE64_LENGTH) {
          resolve(pngUri);
          return;
        }
      } catch {
        resolve(null);
        return;
      }

      resolve(null); // Image too complex for the size limit
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };

    img.src = url;
  });
}

/** Generates deterministic HSL color from product name for fallback tiles. */
export function nameToColor(name: string): string {
  let hash = 0;
  for (const character of name) {
    const codePoint = character.codePointAt(0) ?? 0;
    hash = codePoint + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, ${TILE_SATURATION}%, ${tileLightness(hue)}%)`;
}

const TILE_SATURATION = 55;
const MIN_WHITE_TEXT_CONTRAST = 4.5;

/** The lightest shade of a hue that keeps white text at WCAG AA contrast; yellows end up darker than blues. */
export function tileLightness(hue: number): number {
  for (let lightness = 50; lightness > 15; lightness -= 1) {
    if (contrastWithWhite(hue, TILE_SATURATION, lightness) >= MIN_WHITE_TEXT_CONTRAST)
      return lightness;
  }
  return 15;
}

export function contrastWithWhite(hue: number, saturation: number, lightness: number): number {
  const s = saturation / 100;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4);
  return 1.05 / (luminance + 0.05);
}

/** Checks whether Base64 data URI is within character size limit (50K chars). */
export function validateImageSize(dataUri: string): boolean {
  return typeof dataUri === 'string' && dataUri.length <= MAX_BASE64_LENGTH;
}

/** Max Base64 string length (characters). ~36.6 KB decoded. */
export const MAX_IMAGE_LENGTH = MAX_BASE64_LENGTH;

/** Max raw file size before loading into memory (5 MB). */
export const MAX_RAW_FILE_SIZE = 5 * 1024 * 1024;
