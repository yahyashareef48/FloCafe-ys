/*
 * Injected ahead of the backend's raster page (rasterRendererHtml in
 * main/printers/raster-renderer.ts) inside the shell's hidden WebView. It
 * provides the window.__floRaster contract Electron's raster-preload gives,
 * backed by the AlBaikRasterHost Java interface. Band pixels are a Uint8Array,
 * which JSON cannot carry, so they travel as base64.
 */
(function () {
  'use strict';

  function toBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  }

  window.__floRaster = {
    onRequest: function (callback) {
      window.__floRasterDeliver = callback;
      AlBaikRasterHost.ready();
      return function () {};
    },
    sendResult: function (message) {
      var result = message && message.result;
      if (result && result.ok && result.unit && result.unit.bands) {
        result.unit.bands = result.unit.bands.map(function (band) {
          return { widthDots: band.widthDots, heightDots: band.heightDots, pixelsBase64: toBase64(band.pixels) };
        });
      }
      AlBaikRasterHost.result(JSON.stringify(result || {}));
    },
  };
})();
