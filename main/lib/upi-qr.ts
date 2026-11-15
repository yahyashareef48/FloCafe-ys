/** UPI payment links for a fixed-amount QR, per the NPCI UPI linking specification. */

const UPI_ID_RE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/;
const MAX_UPI_AMOUNT = 1_00_00_000;

export function isValidUpiId(value: unknown): value is string {
  return typeof value === 'string' && UPI_ID_RE.test(value.trim());
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, max);
}

/** `@` stays literal: several UPI apps do not decode `%40` in the payee address. */
function encodeParam(value: string): string {
  return encodeURIComponent(value).replace(/%40/g, '@');
}

/** Builds `upi://pay?pa=..&pn=..&am=..&cu=INR`; throws on an invalid UPI ID or amount. */
export function buildUpiPaymentLink(input: {
  upiId: string;
  payeeName?: string;
  amount: number;
  note?: string;
}): string {
  const upiId = input.upiId.trim();
  if (!isValidUpiId(upiId)) throw new Error('Invalid UPI ID');
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > MAX_UPI_AMOUNT) {
    throw new Error('Invalid amount');
  }
  const params: Array<[string, string]> = [['pa', upiId]];
  const payeeName = cleanText(input.payeeName, 50);
  if (payeeName) params.push(['pn', payeeName]);
  params.push(['am', (Math.round(input.amount * 100) / 100).toFixed(2)], ['cu', 'INR']);
  const note = cleanText(input.note, 50);
  if (note) params.push(['tn', note]);
  return 'upi://pay?' + params.map(([key, value]) => `${key}=${encodeParam(value)}`).join('&');
}
