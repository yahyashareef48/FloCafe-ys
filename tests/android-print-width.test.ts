/**
 * Android print width — the Android Node runtime crashes inside Intl.Segmenter#segment, so on
 * Android the print width helpers must split graphemes without it and still agree with the
 * Segmenter on receipt text.
 */
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const reference = new Intl.Segmenter('und', { granularity: 'grapheme' });
const samples = ['Paneer Tikka', 'Total ₹1,250.00', 'Café crème', 'Jeera Rice x2 ₹300'];
const expected = samples.map((text) => Array.from(reference.segment(text), (part) => part.segment));

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const realSegment = Intl.Segmenter.prototype.segment;
let segmentCalls = 0;
Object.defineProperty(process, 'platform', { value: 'android' });
Intl.Segmenter.prototype.segment = function (this: Intl.Segmenter, input: string) {
  segmentCalls += 1;
  return realSegment.call(this, input);
};

try {
  // A fresh copy: the test helpers already loaded this module under the real platform.
  delete require.cache[require.resolve('../shared/print/width')];
  const width = require('../shared/print/width');
  for (const [index, text] of samples.entries()) {
    assertEqualOrThrow(
      JSON.stringify(width.graphemeSegments(text)),
      JSON.stringify(expected[index]),
      `"${text}" splits the same as Intl.Segmenter`,
    );
  }
  assertOrThrow(width.graphemeSegments('पनीर').length > 0, 'Devanagari text still splits');
  assertEqualOrThrow(segmentCalls, 0, 'Intl.Segmenter#segment is never called on Android');
  console.log('\nandroid-print-width: all assertions passed');
} finally {
  Object.defineProperty(process, 'platform', realPlatform);
  Intl.Segmenter.prototype.segment = realSegment;
}
