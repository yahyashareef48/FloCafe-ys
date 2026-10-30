/*
 * Injected at document start into every page the Android shell shows: the main
 * tablet's own POS and, on Screen devices, the main device's pages. A WebView
 * has no pop-up windows, window.print() or downloads, so this:
 *   - shows window.open('') documents (bills, slips, menus) in an in-page
 *     overlay whose Print goes to the Android print service and which closes
 *     back to the page when printing ends;
 *   - opens window.open() links to other sites outside the app;
 *   - hands <a download> files to the system save dialog.
 * It also owns the AlBaikNative channel to the shell and exposes it to
 * electron-api-shim.js as window.__albaikNative.
 */
(function () {
  'use strict';

  if (window.__albaikNative) return;

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

  /** Pages of the server this WebView shows (the tablet itself, or the main device on a Screen). */
  function isOwnServerUrl(url) {
    try {
      var parsed = new URL(url, location.href);
      return parsed.hostname === location.hostname || parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    } catch {
      return false;
    }
  }

  window.open = function (url) {
    var target = url == null ? '' : String(url);
    if (target === '' || target === 'about:blank') return openOverlay('');
    if (isOwnServerUrl(target)) return openOverlay(new URL(target, location.href).href);
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

  Object.defineProperty(window, '__albaikNative', {
    value: Object.freeze({ call: callNative, openOverlay: openOverlay }),
  });
})();
