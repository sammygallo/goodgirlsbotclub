/**
 * Extension Shim
 *
 * This module exports a single constant — SHIM_CODE — that is a self-contained
 * JavaScript IIFE injected into every sandboxed extension iframe.  It provides
 * a faithful-enough stub of the SillyTavern browser globals that most
 * third-party extensions rely on:
 *
 *   • window.$ / window.jQuery  — real DOM ops on the iframe document
 *   • window.SillyTavern.getContext()  — returns host-pushed context snapshot
 *   • window.eventSource             — subscribe to ST lifecycle events
 *   • window.event_types             — ST event name constants
 *   • window.toastr                  — posts ST_TOAST to parent
 *   • window.callPopup               — posts ST_POPUP RPC to parent
 *   • window.extension_settings      — per-extension settings object (synced)
 *   • window.characters / name1 / name2 / this_chid — legacy direct globals
 *
 * Communication protocol (postMessage, type prefix "ST_"):
 *
 *   iframe → host
 *     ST_READY                                     ← iframe + extension initialised
 *     ST_RESIZE   { height: number }               ← content height changed
 *     ST_TOAST    { level, message, title? }       ← show toast in React
 *     ST_RPC      { id, method, args[] }           ← async host call
 *     ST_EVENT_EMIT { eventName, args[] }          ← extension-emitted event
 *
 *   host → iframe
 *     ST_CONTEXT_UPDATE { context }               ← push fresh context snapshot
 *     ST_LIFECYCLE      { event, args[] }         ← fire eventSource subscriber
 *     ST_RPC_RESPONSE   { id, result?, error? }   ← reply to ST_RPC
 */

// ---------------------------------------------------------------------------
// NOTE: This string must be valid ES5-compatible JavaScript — no import/export,
// no top-level await, no TypeScript syntax.  Template literals inside the IIFE
// are fine since they're in the actual iframe document at runtime.
// ---------------------------------------------------------------------------

export const SHIM_CODE: string = /* javascript */ `
(function () {
  'use strict';

  // ── RPC infrastructure ───────────────────────────────────────────────────
  var _pending = Object.create(null); // id → { resolve, reject }
  var _slotCallbacks = Object.create(null); // itemId → fn
  var _seq = 0;

  function _post(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (_) {}
  }

  function _rpc(method, args) {
    return new Promise(function (resolve, reject) {
      var id = 'rpc_' + (++_seq);
      _pending[id] = { resolve: resolve, reject: reject };
      _post({ type: 'ST_RPC', id: id, method: method, args: args || [] });
      setTimeout(function () {
        if (_pending[id]) {
          delete _pending[id];
          reject(new Error('RPC timeout: ' + method));
        }
      }, 8000);
    });
  }

  // ── Context snapshot (populated by host via ST_CONTEXT_UPDATE) ───────────
  var _ctx = {
    characters: [],
    groups: [],
    characterId: null,
    groupId: null,
    chatId: null,
    name1: 'You',
    name2: 'Assistant',
    chat: [],
    settings: {},
    extensionSettings: {},
    personas: [],
  };

  // ── Event subscribers (eventSource.on) ───────────────────────────────────
  var _subs = Object.create(null); // eventName → Array<fn>

  // ── Message handler from host ────────────────────────────────────────────
  window.addEventListener('message', function (evt) {
    var msg = evt.data;
    if (!msg || typeof msg.type !== 'string' || msg.type.slice(0, 3) !== 'ST_') return;

    switch (msg.type) {
      case 'ST_CONTEXT_UPDATE':
        if (msg.context && typeof msg.context === 'object') {
          for (var k in msg.context) {
            if (Object.prototype.hasOwnProperty.call(msg.context, k)) {
              _ctx[k] = msg.context[k];
            }
          }
          // Keep extension_settings reference in sync
          window.extension_settings = _ctx.extensionSettings;
        }
        break;

      case 'ST_LIFECYCLE':
        var fns = _subs[msg.event] || [];
        fns.forEach(function (fn) {
          try { fn.apply(null, msg.args || []); } catch (_) {}
        });
        break;

      case 'ST_RPC_RESPONSE':
        if (_pending[msg.id]) {
          var p = _pending[msg.id];
          delete _pending[msg.id];
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
        break;

      case 'ST_SLOT_INVOKE':
        var slotCb = _slotCallbacks[msg.itemId];
        if (slotCb) {
          try { slotCb(msg.payload); } catch (_) {}
        }
        break;
    }
  });

  // ── jQuery / $ shim ──────────────────────────────────────────────────────

  var _domReady = false;
  var _readyCbs = [];

  function _fireReady() {
    if (_domReady) return;
    _domReady = true;
    _readyCbs.forEach(function (fn) { try { fn(); } catch (_) {} });
    _readyCbs = [];
  }

  // Wraps zero or more DOM nodes in a jQuery-like chainable object.
  function _jq(els) {
    if (!Array.isArray(els)) els = els ? [els] : [];
    var jq = {
      length: els.length,

      get: function (i) { return els[i]; },

      each: function (fn) {
        els.forEach(function (e, i) { fn.call(e, i, e); });
        return jq;
      },

      // ── Insertion ──────────────────────────────────────────────────────
      append: function (content) {
        var html = _toHtml(content);
        els.forEach(function (e) {
          if (!e) return;
          var tmp = document.createElement('div');
          tmp.innerHTML = html;
          while (tmp.firstChild) e.appendChild(tmp.firstChild);
        });
        return jq;
      },

      prepend: function (content) {
        var html = _toHtml(content);
        els.forEach(function (e) {
          if (!e) return;
          var tmp = document.createElement('div');
          tmp.innerHTML = html;
          var frag = document.createDocumentFragment();
          while (tmp.firstChild) frag.appendChild(tmp.firstChild);
          e.insertBefore(frag, e.firstChild);
        });
        return jq;
      },

      html: function (content) {
        if (content === undefined) return els[0] ? els[0].innerHTML : '';
        els.forEach(function (e) { if (e) e.innerHTML = _toHtml(content); });
        return jq;
      },

      text: function (content) {
        if (content === undefined) return els[0] ? (els[0].textContent || '') : '';
        els.forEach(function (e) { if (e) e.textContent = String(content); });
        return jq;
      },

      // ── Form values ────────────────────────────────────────────────────
      val: function (v) {
        if (v === undefined) return els[0] ? (els[0].value || '') : '';
        els.forEach(function (e) { if (e) e.value = v; });
        return jq;
      },

      // ── Attributes / properties ────────────────────────────────────────
      attr: function (name, val) {
        if (val === undefined) return els[0] ? els[0].getAttribute(name) : undefined;
        els.forEach(function (e) { if (e) e.setAttribute(name, String(val)); });
        return jq;
      },

      removeAttr: function (name) {
        els.forEach(function (e) { if (e) e.removeAttribute(name); });
        return jq;
      },

      prop: function (name, val) {
        if (val === undefined) return els[0] ? els[0][name] : undefined;
        els.forEach(function (e) { if (e) e[name] = val; });
        return jq;
      },

      data: function (key, val) {
        if (val === undefined) return els[0] ? els[0].dataset[key] : undefined;
        els.forEach(function (e) { if (e) e.dataset[key] = String(val); });
        return jq;
      },

      // ── CSS / classes ──────────────────────────────────────────────────
      css: function (prop, val) {
        if (typeof prop === 'object') {
          els.forEach(function (e) {
            if (!e) return;
            for (var k in prop) {
              if (Object.prototype.hasOwnProperty.call(prop, k)) e.style[k] = prop[k];
            }
          });
          return jq;
        }
        if (val === undefined) return els[0] ? getComputedStyle(els[0])[prop] : '';
        els.forEach(function (e) { if (e) e.style[prop] = val; });
        return jq;
      },

      addClass: function (cls) {
        els.forEach(function (e) {
          if (!e) return;
          cls.split(/\\s+/).forEach(function (c) { if (c) e.classList.add(c); });
        });
        return jq;
      },

      removeClass: function (cls) {
        els.forEach(function (e) {
          if (!e) return;
          cls.split(/\\s+/).forEach(function (c) { if (c) e.classList.remove(c); });
        });
        return jq;
      },

      toggleClass: function (cls, force) {
        els.forEach(function (e) {
          if (!e) return;
          cls.split(/\\s+/).forEach(function (c) {
            if (!c) return;
            if (force === undefined) e.classList.toggle(c);
            else if (force) e.classList.add(c);
            else e.classList.remove(c);
          });
        });
        return jq;
      },

      hasClass: function (cls) {
        return !!(els[0] && els[0].classList.contains(cls));
      },

      // ── Visibility ─────────────────────────────────────────────────────
      show: function () {
        els.forEach(function (e) { if (e) e.style.display = ''; });
        return jq;
      },

      hide: function () {
        els.forEach(function (e) { if (e) e.style.display = 'none'; });
        return jq;
      },

      toggle: function (force) {
        els.forEach(function (e) {
          if (!e) return;
          if (force === undefined) e.style.display = (e.style.display === 'none') ? '' : 'none';
          else e.style.display = force ? '' : 'none';
        });
        return jq;
      },

      is: function (sel) {
        return !!(els[0] && els[0].matches && els[0].matches(sel));
      },

      // ── Events ─────────────────────────────────────────────────────────
      on: function (events, selectorOrFn, fn) {
        var handler = (typeof selectorOrFn === 'function') ? selectorOrFn : fn;
        var delegate = (typeof selectorOrFn === 'string') ? selectorOrFn : null;
        els.forEach(function (e) {
          if (!e) return;
          events.split(/\\s+/).forEach(function (ev) {
            if (!ev) return;
            e.addEventListener(ev, delegate
              ? function (evObj) {
                  var t = evObj.target;
                  while (t && t !== e) {
                    if (t.matches && t.matches(delegate)) {
                      handler.call(t, evObj);
                      break;
                    }
                    t = t.parentElement;
                  }
                }
              : function (evObj) { handler.call(e, evObj); });
          });
        });
        return jq;
      },

      off: function () { return jq; }, // best-effort stub

      trigger: function (event) {
        els.forEach(function (e) {
          if (e) e.dispatchEvent(new Event(event, { bubbles: true }));
        });
        return jq;
      },

      // ── Traversal ──────────────────────────────────────────────────────
      find: function (sel) {
        var found = [];
        els.forEach(function (e) {
          if (e) found = found.concat(Array.prototype.slice.call(e.querySelectorAll(sel)));
        });
        return _jq(found);
      },

      filter: function (sel) {
        return _jq(els.filter(function (e) { return e && e.matches && e.matches(sel); }));
      },

      not: function (sel) {
        return _jq(els.filter(function (e) { return !e || !e.matches || !e.matches(sel); }));
      },

      closest: function (sel) {
        var found = null;
        var cur = els[0];
        while (cur && cur !== document.documentElement) {
          if (cur.matches && cur.matches(sel)) { found = cur; break; }
          cur = cur.parentElement;
        }
        return _jq(found);
      },

      parent: function () { return _jq(els[0] ? els[0].parentElement : null); },

      parents: function (sel) {
        var found = [];
        var cur = els[0] ? els[0].parentElement : null;
        while (cur && cur !== document.documentElement) {
          if (!sel || (cur.matches && cur.matches(sel))) found.push(cur);
          cur = cur.parentElement;
        }
        return _jq(found);
      },

      children: function (sel) {
        var found = [];
        els.forEach(function (e) {
          if (!e) return;
          var ch = Array.prototype.slice.call(e.children);
          found = found.concat(sel ? ch.filter(function (c) { return c.matches && c.matches(sel); }) : ch);
        });
        return _jq(found);
      },

      first: function () { return _jq(els[0] || null); },
      last:  function () { return _jq(els[els.length - 1] || null); },
      eq:    function (i) { return _jq(els[i] || null); },

      // ── Manipulation ───────────────────────────────────────────────────
      empty: function () {
        els.forEach(function (e) { if (e) e.innerHTML = ''; });
        return jq;
      },

      remove: function () {
        els.forEach(function (e) { if (e && e.parentNode) e.parentNode.removeChild(e); });
        return jq;
      },

      clone: function (deep) {
        return _jq(els.map(function (e) { return e ? e.cloneNode(deep !== false) : null; }));
      },

      replaceWith: function (content) {
        var html = _toHtml(content);
        els.forEach(function (e) {
          if (!e || !e.parentNode) return;
          var tmp = document.createElement('div');
          tmp.innerHTML = html;
          var frag = document.createDocumentFragment();
          while (tmp.firstChild) frag.appendChild(tmp.firstChild);
          e.parentNode.replaceChild(frag, e);
        });
        return jq;
      },

      // ── Misc ───────────────────────────────────────────────────────────
      ready: function (fn) {
        if (_domReady) fn();
        else _readyCbs.push(fn);
        return jq;
      },

      serialize: function () { return ''; },
    };

    // Expose els as numeric indices so the jq object is array-like — required
    // for Array.prototype.slice / spread / for-of to iterate it. Without this,
    // _toHtml(jqObj) returns empty for jq-wrapped HTML, which breaks
    // pattern: $(htmlString) → target.append($wrapper).
    for (var _i = 0; _i < els.length; _i++) jq[_i] = els[_i];
    jq.toArray = function () { return Array.prototype.slice.call(els); };

    return jq;
  }

  function _toHtml(content) {
    if (typeof content === 'string') return content;
    if (content && content.outerHTML) return content.outerHTML;
    if (content && content.length !== undefined) {
      // jQuery-like object
      return Array.prototype.slice.call(content).map(function (el) {
        return el && el.outerHTML ? el.outerHTML : String(el);
      }).join('');
    }
    return String(content || '');
  }

  // Main jQuery function
  function jQuery(selector, context) {
    if (typeof selector === 'function') {
      if (_domReady) selector();
      else _readyCbs.push(selector);
      return;
    }
    if (selector === document || selector === window) {
      return {
        ready: function (fn) { if (_domReady) fn(); else _readyCbs.push(fn); return this; },
        on: function () { return this; },
        off: function () { return this; },
        trigger: function () { return this; },
      };
    }
    if (typeof selector === 'string') {
      var s = selector.trim();
      if (s.charAt(0) === '<') {
        var tmp = document.createElement('div');
        tmp.innerHTML = s;
        return _jq(Array.prototype.slice.call(tmp.children));
      }
      var root = (context && context.querySelectorAll) ? context : document;
      return _jq(Array.prototype.slice.call(root.querySelectorAll(s)));
    }
    if (selector && selector.nodeType) return _jq(selector);
    if (selector && typeof selector.length === 'number') {
      return _jq(Array.prototype.slice.call(selector));
    }
    return _jq(null);
  }

  // Static jQuery helpers — $.ajax returns a thenable jqXHR stand-in so
  // extensions can both \`await $.get(url)\` and chain \`.done()/.fail()\`.
  jQuery.ajax = function (opts) {
    var method = ((opts.method || opts.type || 'GET')).toUpperCase();
    var headers = Object.assign({}, opts.headers || {});
    var body;
    if (method !== 'GET' && opts.data != null) {
      if (typeof opts.data === 'string') {
        body = opts.data;
      } else {
        body = JSON.stringify(opts.data);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
    }

    var doneCbs = [];
    var failCbs = [];

    var promise = fetch(opts.url, { method: method, headers: headers, body: body, credentials: 'include' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var ctype = (r.headers.get('content-type') || '').toLowerCase();
        if (opts.dataType === 'json' || (!opts.dataType && ctype.indexOf('json') >= 0)) return r.json();
        return r.text();
      })
      .then(function (data) {
        try { opts.success && opts.success(data); } catch (_) {}
        doneCbs.forEach(function (fn) { try { fn(data); } catch (_) {} });
        return data;
      }, function (err) {
        try { opts.error && opts.error(null, null, err && err.message); } catch (_) {}
        failCbs.forEach(function (fn) { try { fn(null, null, err && err.message); } catch (_) {} });
        throw err;
      });

    var jqXHR = {
      then:    function (onFulfilled, onRejected) { return promise.then(onFulfilled, onRejected); },
      catch:   function (onRejected) { return promise.catch(onRejected); },
      done:    function (fn) { doneCbs.push(fn); return jqXHR; },
      fail:    function (fn) { failCbs.push(fn); return jqXHR; },
      always:  function (fn) { promise.finally(fn); return jqXHR; },
    };
    return jqXHR;
  };

  jQuery.get = function (url, data, cb) {
    var callback = typeof data === 'function' ? data : cb;
    return jQuery.ajax({ url: url, method: 'GET', success: callback });
  };

  jQuery.post = function (url, data, cb) {
    return jQuery.ajax({ url: url, method: 'POST', data: data, success: cb });
  };

  jQuery.getJSON = function (url, cb) {
    return jQuery.ajax({ url: url, method: 'GET', dataType: 'json', success: cb });
  };

  jQuery.noop   = function () {};
  jQuery.trim   = function (s) { return String(s).trim(); };
  jQuery.isFunction = function (fn) { return typeof fn === 'function'; };
  jQuery.isArray    = Array.isArray;
  jQuery.extend = function (deep) {
    var target = (typeof deep === 'boolean') ? arguments[1] : deep;
    var start  = (typeof deep === 'boolean') ? 2 : 1;
    for (var i = start; i < arguments.length; i++) {
      var src = arguments[i];
      if (src) for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  };
  jQuery.Deferred = function () {
    var _res, _rej, _promise = new Promise(function (resolve, reject) { _res = resolve; _rej = reject; });
    return {
      promise: function () { return { then: function (fn) { _promise.then(fn); return this; } }; },
      resolve: _res,
      reject: _rej,
    };
  };
  jQuery.when = function () {
    return { then: function (fn) { Promise.all(Array.prototype.slice.call(arguments, 0)).then(fn); return this; } };
  };

  window.jQuery = jQuery;
  window.$      = jQuery;

  // ── eventSource ──────────────────────────────────────────────────────────
  window.eventSource = {
    on: function (eventName, callback) {
      if (!_subs[eventName]) _subs[eventName] = [];
      _subs[eventName].push(callback);
    },
    off: function (eventName, callback) {
      if (!_subs[eventName]) return;
      _subs[eventName] = _subs[eventName].filter(function (fn) { return fn !== callback; });
    },
    emit: function (eventName) {
      var args = Array.prototype.slice.call(arguments, 1);
      _post({ type: 'ST_EVENT_EMIT', eventName: eventName, args: args });
    },
    once: function (eventName, callback) {
      var self = this;
      var wrapper = function () { callback.apply(null, arguments); self.off(eventName, wrapper); };
      this.on(eventName, wrapper);
    },
    makeFirst: function (eventName, callback) { this.on(eventName, callback); },
    makeLast:  function (eventName, callback) { this.on(eventName, callback); },
  };

  // ── event_types constants ─────────────────────────────────────────────────
  // Values mirror the strings fireSandboxLifecycleEvent uses in sandboxEventBus.ts
  window.event_types = {
    CHAT_CHANGED:                    'chatChanged',
    CHARACTER_EDITED:                'characterEdited',
    GENERATION_STARTED:              'generationStarted',
    GENERATION_STOPPED:              'generationStopped',
    GENERATION_AFTER:                'generationAfter',
    MESSAGE_RECEIVED:                'messageReceived',
    MESSAGE_SENT:                    'messageSent',
    MESSAGE_DELETED:                 'messageDeleted',
    GROUP_UPDATED:                   'groupUpdated',
    SETTINGS_UPDATED:                'settingsUpdated',
    WORLDINFO_SETTINGS_UPDATED:      'worldInfoSettingsUpdated',
    USER_MESSAGE_RENDERED:           'userMessageRendered',
    AI_MESSAGE_RENDERED:             'aiMessageRendered',
    CHARACTER_MESSAGE_RENDERED:      'characterMessageRendered',
    FORCE_SET_BACKGROUND:            'forceSetBackground',
    CHAT_COMPLETION_SETTINGS_READY:  'chatCompletionSettingsReady',
    GENERATE_BEFORE_COMBINE_PROMPTS: 'generateBeforeCombinePrompts',
    MOVABLE_PANELS_RESET:            'movablePanelsReset',
  };

  // ── toastr ────────────────────────────────────────────────────────────────
  window.toastr = {
    info:    function (msg, title) { _post({ type: 'ST_TOAST', level: 'info',    message: String(msg), title: title }); },
    warning: function (msg, title) { _post({ type: 'ST_TOAST', level: 'warning', message: String(msg), title: title }); },
    error:   function (msg, title) { _post({ type: 'ST_TOAST', level: 'error',   message: String(msg), title: title }); },
    success: function (msg, title) { _post({ type: 'ST_TOAST', level: 'success', message: String(msg), title: title }); },
    options: {},
  };

  // ── callPopup ─────────────────────────────────────────────────────────────
  window.callPopup = function (html, type, inputValue, options) {
    return _rpc('callPopup', [html, type, inputValue, options]);
  };

  // ── callGenericPopup (newer ST API) ───────────────────────────────────────
  window.callGenericPopup = window.callPopup;

  // ── registerSlotItem ──────────────────────────────────────────────────────
  // slot: 'messageActions' | 'chatInputExtras'
  // def:  { id, label, icon?, tooltip?, onClick }
  // Returns an unregister function.
  function _registerSlotItem(slot, def) {
    if (!def || typeof def.onClick !== 'function') {
      throw new Error('registerSlotItem: def.onClick must be a function');
    }
    var itemId = String(def.id || ('slot_' + (++_seq)));
    _slotCallbacks[itemId] = def.onClick;
    _post({
      type: 'ST_REGISTER_SLOT',
      slot: String(slot),
      item: {
        id: itemId,
        label: String(def.label != null ? def.label : itemId),
        icon: typeof def.icon === 'string' ? def.icon : undefined,
        tooltip: typeof def.tooltip === 'string' ? def.tooltip : undefined,
      },
    });
    return function unregister() {
      delete _slotCallbacks[itemId];
      _post({ type: 'ST_UNREGISTER_SLOT', slot: String(slot), itemId: itemId });
    };
  }

  // ── extension_settings ────────────────────────────────────────────────────
  window.extension_settings = _ctx.extensionSettings;

  // ── saveSettingsDebounced / loadSettings stubs ────────────────────────────
  window.saveSettingsDebounced = function () {
    _post({ type: 'ST_RPC', id: 'rpc_' + (++_seq), method: 'saveSettings', args: [] });
  };
  window.saveSettings = window.saveSettingsDebounced;
  window.loadSettings = function () {};

  // ── upstream module-shim back-ends ────────────────────────────────────────
  // The /script.js, /scripts/extensions.js, /scripts/utils.js and
  // /scripts/slash-commands.js shim modules served from the host re-export
  // these globals so ES-module-style upstream extensions resolve their
  // canonical specifiers without us shipping the full upstream monolith.

  window.getCharacters = function () { return _ctx.characters; };

  // Best-effort CSRF token cache. Filled on first call; same-origin fetch.
  var _csrfToken = null;
  function _refreshCsrf() {
    try {
      fetch('/csrf-token', { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && j.token) _csrfToken = j.token; })
        .catch(function () {});
    } catch (_) {}
  }
  _refreshCsrf();
  window.getRequestHeaders = function () {
    return {
      'Content-Type': 'application/json',
      'X-CSRF-Token': _csrfToken || '',
      Accept: 'application/json',
    };
  };

  window.sendMessageAsUser = function (text) {
    return _rpc('sendMessageAsUser', [String(text || '')]);
  };

  // ModuleWorkerWrapper: tiny debounce-style runner upstream uses to coalesce
  // re-entrant async work. Faithful enough for extension purposes.
  window.ModuleWorkerWrapper = function ModuleWorkerWrapper(callback) {
    var busy = false;
    var queued = false;
    function run() {
      if (busy) { queued = true; return Promise.resolve(); }
      busy = true;
      return Promise.resolve()
        .then(function () { return callback(); })
        .catch(function (e) { try { console.error('[ModuleWorkerWrapper]', e); } catch (_) {} })
        .then(function () {
          busy = false;
          if (queued) { queued = false; return run(); }
        });
    }
    this.update = run;
  };

  // renderExtensionTemplate: fetch an HTML template from the extension folder
  // and return its text. Upstream supports {{var}} substitution; we honor that
  // with a minimal pass over the optional template-data object.
  window.renderExtensionTemplate = function (extensionName, templateName, templateData, sanitize, localize) {
    var url = '/scripts/extensions/third-party/' + extensionName + '/' + templateName + '.html';
    // Some upstream call sites pass the full module path (e.g.
    // 'third-party/Extension-Live2d'); strip the prefix so the URL is correct.
    url = url.replace('/third-party/third-party/', '/third-party/');
    return fetch(url, { credentials: 'include' }).then(function (r) {
      if (!r.ok) throw new Error('Template not found: ' + url);
      return r.text();
    }).then(function (html) {
      if (templateData && typeof templateData === 'object') {
        Object.keys(templateData).forEach(function (k) {
          html = html.split('{{' + k + '}}').join(String(templateData[k]));
        });
      }
      return html;
    });
  };
  window.renderExtensionTemplateAsync = window.renderExtensionTemplate;

  // Extras (the python sidecar) is not implemented on mobile.
  window.getApiUrl = function () { return ''; };
  window.doExtrasFetch = function () {
    return Promise.reject(new Error('Extras backend is not available on mobile.'));
  };
  window.modules = [];

  window.registerSlashCommand = function (name, callback, aliases, helpText) {
    try {
      _post({
        type: 'ST_REGISTER_SLASH_COMMAND',
        name: String(name),
        aliases: Array.isArray(aliases) ? aliases.map(String) : [],
        helpText: String(helpText || ''),
      });
    } catch (_) {}
    // Stash callback locally so future ST_INVOKE_SLASH_COMMAND can dispatch.
    if (!window.__shimSlashCommands) window.__shimSlashCommands = {};
    window.__shimSlashCommands[String(name).toLowerCase()] = callback;
  };

  window.loadFileToDocument = function (url, type) {
    return new Promise(function (resolve, reject) {
      var el;
      if (type === 'css') {
        el = document.createElement('link');
        el.rel = 'stylesheet';
        el.href = url;
      } else if (type === 'js') {
        el = document.createElement('script');
        el.src = url;
      } else {
        reject(new Error('loadFileToDocument: invalid type ' + type));
        return;
      }
      el.onload = resolve;
      el.onerror = reject;
      (type === 'css' ? document.head : document.body).appendChild(el);
    });
  };

  // Text utilities ported from upstream public/scripts/utils.js so port
  // extensions don't need to vendor them. Backslash-escape sequences in this
  // block are doubled so the outer TypeScript template literal preserves them
  // — e.g. source \\\\p becomes the JS source \\p which becomes the regex \\p
  // in the running iframe. Single-\\ would be eaten by the template literal
  // and the regex would fail to parse, taking down the entire shim IIFE.
  window.trimToEndSentence = function (input) {
    if (!input) return '';
    var isEmoji = function (x) { return /(\\p{Emoji_Presentation}|\\p{Extended_Pictographic})/gu.test(x); };
    var punct = { '.':1,'!':1,'?':1,'*':1,'"':1,')':1,'}':1,'\`':1,']':1,'$':1,'。':1,'！':1,'？':1,'”':1,'）':1,'】':1,'’':1,'」':1,'_':1 };
    var last = -1;
    var chars = Array.from(input);
    for (var i = chars.length - 1; i >= 0; i--) {
      var c = chars[i];
      var em = isEmoji(c);
      if (punct[c] || em) {
        if (!em && i > 0 && /[\\s\\n]/.test(chars[i - 1])) last = i - 1; else last = i;
        break;
      }
    }
    if (last === -1) return input.trimEnd();
    return chars.slice(0, last + 1).join('').trimEnd();
  };
  window.trimToStartSentence = function (input) {
    if (!input) return '';
    var p1 = input.indexOf('.');
    var p2 = input.indexOf('!');
    var p3 = input.indexOf('?');
    var p4 = input.indexOf('\\n');
    var first = p1;
    var skip1 = false;
    if (p2 > 0 && p2 < first) first = p2;
    if (p3 > 0 && p3 < first) first = p3;
    if (p4 > 0 && p4 < first) { first = p4; skip1 = true; }
    if (first > 0) return skip1 ? input.substring(first + 1) : input.substring(first + 2);
    return input;
  };

  // ── SillyTavern global ────────────────────────────────────────────────────
  window.SillyTavern = {
    getContext: function () {
      return {
        // Data
        characters:      _ctx.characters,
        groups:          _ctx.groups,
        characterId:     _ctx.characterId,
        groupId:         _ctx.groupId,
        chatId:          _ctx.chatId,
        name1:           _ctx.name1,
        name2:           _ctx.name2,
        chat:            _ctx.chat,
        settings:        _ctx.settings,
        extensionSettings: _ctx.extensionSettings,
        personas:        _ctx.personas,

        // Async write methods via RPC
        saveMetadataDebounced: function (data) {
          _rpc('saveMetadata', [data]).catch(function () {});
        },
        saveSettingsDebounced: function () {
          _rpc('saveSettings', []).catch(function () {});
        },
        reloadCurrentChat: function () {
          return _rpc('reloadCurrentChat', []);
        },
        sendSystemMessage: function (type, msg, extra) {
          return _rpc('sendSystemMessage', [type, msg, extra]);
        },
        generateQuietPrompt: function (prompt, loud, skipWIAN, img, name, maxLen) {
          return _rpc('generateQuietPrompt', [prompt, loud, skipWIAN, img, name, maxLen]);
        },
        substituteParams: function (str) {
          return String(str)
            .replace(/{{user}}/gi, _ctx.name1)
            .replace(/{{char}}/gi, _ctx.name2);
        },
      };
    },
    registerSlotItem: _registerSlotItem,
  };

  // ── Legacy flat globals (some old extensions access these directly) ────────
  Object.defineProperty(window, 'characters',     { get: function () { return _ctx.characters; },   configurable: true });
  Object.defineProperty(window, 'name1',          { get: function () { return _ctx.name1; },         configurable: true });
  Object.defineProperty(window, 'name2',          { get: function () { return _ctx.name2; },         configurable: true });
  Object.defineProperty(window, 'this_chid',      { get: function () { return _ctx.characterId; },  configurable: true });
  Object.defineProperty(window, 'selected_group', { get: function () { return _ctx.groupId; },      configurable: true });
  Object.defineProperty(window, 'chat',           { get: function () { return _ctx.chat; },          configurable: true });

  // ── DOMContentLoaded / jQuery(fn) bridge ──────────────────────────────────
  document.addEventListener('DOMContentLoaded', _fireReady);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    _fireReady();
  }

  // ── window.load → ST_READY + ResizeObserver ───────────────────────────────
  window.addEventListener('load', function () {
    _fireReady(); // in case DOMContentLoaded never fired (srcdoc quirk)

    _post({ type: 'ST_READY' });

    function _reportSize() {
      _post({ type: 'ST_RESIZE', height: document.documentElement.scrollHeight });
    }
    _reportSize();

    if (window.ResizeObserver) {
      new ResizeObserver(_reportSize).observe(document.body);
    }
  });

})();
`.trim();
