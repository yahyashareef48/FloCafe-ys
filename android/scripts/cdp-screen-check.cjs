'use strict';

// Checks a Screen device's WebView over the DevTools protocol.
// Usage: node cdp-screen-check.cjs <forwarded-port> <main-origin>
const { connect } = require('./cdp.cjs');

const port = Number(process.argv[2] || 9223);
const origin = process.argv[3];

async function main() {
  const { check, failures, close } = await connect(port, origin);
  await check('the Screen shows the main device page', 'location.origin + location.pathname', `${origin}/kds-standalone/`);
  await check('the page content is rendered', "!!document.getElementById('screen-marker')", true);
  await check('a Screen runs as a browser client (no electronAPI)', 'typeof window.electronAPI', 'undefined');
  await check('the WebView shim is injected on the main device page', "typeof window.__albaikNative === 'object'", true);
  await check(
    'pop-up bills open in the in-page overlay',
    "(() => { const w = window.open('', '_blank'); const shown = !!document.querySelector('[data-flo-android-overlay]'); w.close(); return shown; })()",
    true,
  );
  close();
  process.exit(failures() === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
