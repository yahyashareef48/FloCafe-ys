'use strict';

// Preloaded into the Android runtime child so any path that still reaches for
// Electron fails loudly, as it would inside the APK where Electron is absent.
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithoutElectron(request, ...rest) {
  if (request === 'electron') {
    const error = new Error("Cannot find module 'electron' (blocked: the Android runtime must not load Electron)");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return originalResolve.call(this, request, ...rest);
};
