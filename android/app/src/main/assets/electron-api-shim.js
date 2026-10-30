/*
 * Android stand-in for the Electron preload bridge (main/preload.ts). The shell
 * injects it at document start into the local POS origin only, replacing the
 * host-config placeholder on the last line with { actionPort, token }.
 *
 * Methods are left out on purpose where absence makes the renderer take a path
 * that already works on Android:
 *   getStatus             - its presence draws the desktop title bar
 *   rasterizePrintDocument, rasterizeKotDocument - WebUSB-only, no WebUSB here
 *   saveHtmlAsPdf         - the browser path prints, and Android offers "Save as PDF"
 *   getBetaChannel, setBetaChannel, getAutoUpdateCheck, setAutoUpdateCheck
 *                         - updates come from a new APK, so the toggles report unsupported
 */
(function (config) {
  'use strict';

  if (window.electronAPI) return;

  var actionBase = 'http://127.0.0.1:' + config.actionPort;
  var nativeChannel = window.AlBaikNative;
  var nextNativeId = 1;
  var pendingNative = {};

  if (nativeChannel) {
    nativeChannel.onmessage = function (event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      var entry = pendingNative[message.id];
      if (!entry) return;
      delete pendingNative[message.id];
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    };
  }

  function callNative(method, params) {
    return new Promise(function (resolve, reject) {
      if (!nativeChannel) {
        reject(new Error('Android shell is unavailable'));
        return;
      }
      var id = nextNativeId++;
      pendingNative[id] = { resolve: resolve, reject: reject };
      nativeChannel.postMessage(JSON.stringify({ id: id, method: method, params: params || null }));
    });
  }

  function action(route, body) {
    return fetch(actionBase + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-flo-host-token': config.token },
      body: JSON.stringify(body || {}),
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) return { success: false, error: (data && data.error) || 'Request failed' };
        return data;
      });
    });
  }

  function unsubscribe() {
    return function () {};
  }

  var storeManaged = { status: 'store-managed' };

  window.electronAPI = Object.freeze({
    backupDatabase: function (pin) {
      return action('/backup', { pin: pin }).then(function (result) {
        if (!result || !result.success || !result.path) return result;
        var name = result.path.split('/').pop();
        return callNative('saveFileCopy', { path: result.path, suggestedName: name, mimeType: 'application/octet-stream' })
          .then(function () {
            return result;
          })
          .catch(function () {
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
    setThemeEffective: function (isDark) {
      return callNative('setThemeEffective', { isDark: Boolean(isDark) }).catch(function () {
        return null;
      });
    },

    getKdsInfo: function () {
      return action('/kds-info');
    },
    openKdsWindow: function () {
      return action('/kds-info').then(function (info) {
        return callNative('openOverlay', { url: 'http://127.0.0.1:' + info.port + '/kds' });
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
})(__FLO_HOST_CONFIG__);
