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
 *
 * A WebView has no pop-up windows, window.print() or downloads, so this also
 * shows window.open() documents in an in-page overlay printed through Android,
 * and hands <a download> files to the system save dialog.
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
      } catch {
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

  // ---- In-page overlay for window.open() --------------------------------------

  function documentHtml(win) {
    var doc = win.document;
    var doctype = doc.doctype ? '<!DOCTYPE ' + doc.doctype.name + '>' : '<!DOCTYPE html>';
    return doctype + doc.documentElement.outerHTML;
  }

  function overlayButton(label, onClick) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute(
      'style',
      'font:600 18px system-ui,sans-serif;padding:12px 28px;border-radius:10px;border:0;margin-left:12px;' +
        'cursor:pointer;background:' + (label === 'Print' ? '#c62828;color:#fff' : '#e0e0e0;color:#111'),
    );
    button.addEventListener('click', onClick);
    return button;
  }

  function openOverlay(url) {
    var root = document.createElement('div');
    root.setAttribute('data-flo-android-overlay', '');
    root.setAttribute(
      'style',
      'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;background:#fff;',
    );
    var bar = document.createElement('div');
    bar.setAttribute(
      'style',
      'display:flex;justify-content:flex-end;align-items:center;padding:10px 14px;background:#f5f5f5;' +
        'border-bottom:1px solid #ddd;flex:none;',
    );
    var frame = document.createElement('iframe');
    frame.setAttribute('style', 'flex:1;width:100%;border:0;background:#fff;');
    if (url) frame.src = url;
    root.appendChild(bar);
    root.appendChild(frame);
    (document.body || document.documentElement).appendChild(root);

    var win = frame.contentWindow;
    var printing = false;
    function close() {
      if (root.parentNode) root.parentNode.removeChild(root);
    }
    function print() {
      if (printing) return;
      printing = true;
      callNative('printHtml', { html: documentHtml(win), jobName: 'Al Baik POS' })
        .catch(function () {
          return null;
        })
        .then(function () {
          printing = false;
          close();
        });
    }
    if (!url) {
      bar.appendChild(overlayButton('Print', print));
      try {
        win.print = print;
      } catch {
        // The frame navigated cross-origin; the toolbar still prints it.
      }
    }
    bar.appendChild(overlayButton('Close', close));
    try {
      win.close = close;
    } catch {
      // Cross-origin frames keep their own close(); the toolbar closes them.
    }
    return win;
  }

  function isLocalUrl(url) {
    try {
      var parsed = new URL(url, location.href);
      return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    } catch {
      return false;
    }
  }

  window.open = function (url) {
    var target = url == null ? '' : String(url);
    if (target === '' || target === 'about:blank') return openOverlay('');
    if (isLocalUrl(target)) return openOverlay(new URL(target, location.href).href);
    callNative('openExternal', { url: new URL(target, location.href).href }).catch(function () {
      return null;
    });
    return null;
  };

  // ---- Downloads ---------------------------------------------------------------

  var blobsByUrl = new Map();
  var nativeCreateObjectURL = URL.createObjectURL.bind(URL);
  var nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (object) {
    var url = nativeCreateObjectURL(object);
    if (object instanceof Blob) blobsByUrl.set(url, object);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    setTimeout(function () {
      blobsByUrl.delete(url);
    }, 60000);
    nativeRevokeObjectURL(url);
  };

  function saveBlob(blob, name) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = String(reader.result);
        resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
      };
      reader.onerror = function () {
        reject(reader.error);
      };
      reader.readAsDataURL(blob);
    }).then(function (base64) {
      return callNative('saveDownload', {
        name: name,
        mimeType: blob.type || 'application/octet-stream',
        base64: base64,
      });
    });
  }

  function interceptDownload(anchor) {
    if (!anchor || !anchor.hasAttribute || !anchor.hasAttribute('download')) return false;
    var blob = blobsByUrl.get(anchor.href);
    if (!blob) return false;
    saveBlob(blob, anchor.getAttribute('download') || 'download').catch(function () {
      return null;
    });
    return true;
  }

  var nativeAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (interceptDownload(this)) return;
    return nativeAnchorClick.apply(this, arguments);
  };
  document.addEventListener(
    'click',
    function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[download]') : null;
      if (anchor && interceptDownload(anchor)) event.preventDefault();
    },
    true,
  );

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
})(__FLO_HOST_CONFIG__);
