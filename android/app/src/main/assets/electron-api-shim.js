/*
 * Android stand-in for the Electron preload bridge (main/preload.ts), injected
 * after webview-shim.js into the main tablet's own POS origin only. Database
 * and settings actions travel over the shell's message channel to the backend
 * (main/android/host-action-routes.ts), never over the network.
 *
 * Methods are left out on purpose where absence makes the renderer take a path
 * that already works on Android:
 *   getStatus             - its presence draws the desktop title bar
 *   rasterizePrintDocument, rasterizeKotDocument - WebUSB-only, no WebUSB here
 *   saveHtmlAsPdf         - the browser path prints, and Android offers "Save as PDF"
 *   getBetaChannel, setBetaChannel, getAutoUpdateCheck, setAutoUpdateCheck
 *                         - updates come from a new APK, so the toggles report unsupported
 */
(function () {
  'use strict';

  if (window.electronAPI || !window.__albaikNative) return;

  var callNative = window.__albaikNative.call;
  var openOverlay = window.__albaikNative.openOverlay;

  function action(route, body) {
    return callNative('hostAction', { route: route, body: body || {} }).catch(function (error) {
      return { success: false, error: (error && error.message) || 'Request failed' };
    });
  }

  function unsubscribe() {
    return function () {};
  }

  // ---- electronAPI ---------------------------------------------------------------

  var storeManaged = { status: 'store-managed' };

  window.electronAPI = Object.freeze({
    backupDatabase: function (pin) {
      return action('/backup', { pin: pin }).then(function (result) {
        if (!result || !result.success || !result.path) return result;
        var name = result.path.split('/').pop();
        return callNative('saveFileCopy', { path: result.path, suggestedName: name, mimeType: 'application/octet-stream' })
          .catch(function () {
            return null;
          })
          .then(function () {
            return result;
          });
      });
    },
    restoreBackup: function (pin, backupPath) {
      return action('/restore', { pin: pin, backupPath: backupPath });
    },
    pickRestoreFile: function () {
      return action('/pick-restore-file');
    },
    dbHealthCheck: function () {
      return action('/health-check');
    },
    dbApplySafeFixes: function (pin, findingIds) {
      return action('/safe-fixes', { pin: pin, findingIds: findingIds });
    },
    dbInitialize: function (pin, confirmationPhrase) {
      return action('/initialize', { pin: pin, confirmationPhrase: confirmationPhrase });
    },
    getMasterPinStatus: function () {
      return action('/master-pin-status');
    },

    getSettings: function () {
      return action('/settings');
    },
    setSetting: function (key, value) {
      return action('/set-setting', { key: key, value: value });
    },
    setThemeEffective: function () {
      return Promise.resolve({ success: true });
    },

    getKdsInfo: function () {
      return action('/kds-info');
    },
    openKdsWindow: function () {
      return action('/kds-info').then(function (info) {
        openOverlay('http://127.0.0.1:' + info.port + '/kds');
      });
    },

    getAppInfo: function () {
      return action('/app-info');
    },
    getLogTail: function () {
      return action('/log-tail');
    },
    reportRendererError: function () {
      return action('/report-renderer-error');
    },
    getPostHogBootstrap: function () {
      return Promise.resolve({ enabled: false });
    },

    openWhatsAppShare: function (url) {
      return action('/whatsapp-share', { url: url });
    },

    windowReady: function () {
      return Promise.resolve({ success: true });
    },
    windowAction: function () {
      return Promise.resolve({ success: true });
    },
    getWindowState: function () {
      return Promise.resolve({ isMaximized: false, isFullScreen: true });
    },
    onWindowStateChanged: unsubscribe,

    getPrinters: function () {
      return action('/printers');
    },

    getUpdateStatus: function () {
      return Promise.resolve(storeManaged);
    },
    checkForUpdates: function () {
      return Promise.resolve(storeManaged);
    },
    downloadUpdate: function () {
      return Promise.resolve({ success: false, error: 'Install a new Al Baik POS APK to update' });
    },
    restartAndInstall: function () {
      return Promise.resolve({ success: false, error: 'Install a new Al Baik POS APK to update' });
    },
    onUpdateStatus: unsubscribe,

    getApplicationMenu: function () {
      return Promise.resolve({ entries: [] });
    },
    openApplicationMenu: function () {
      return Promise.resolve({ error: 'There is no application menu on Android' });
    },
    onMenuAction: unsubscribe,

    platform: 'android',
  });
})();
