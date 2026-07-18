// Main-world interceptor — local matching, zero bridge overhead
if (window.__APII_INIT) { /* already injected */ } else { window.__APII_INIT = true;
(function () {
  'use strict';

  var NATIVE_FETCH = window.fetch;
  var NATIVE_XHR = window.XMLHttpRequest;
  var oGAH = NATIVE_XHR.prototype.getAllResponseHeaders;
  var RULES = [];
  var GROUPS = [];
  var GLOBAL_ENABLED = true;
  var ACTIVE = false;
  var _reqCount = 0;
  var _rcTimer = null;

  // === Optimized matching indexes (built on sync) ===
  var _exactMap = {};      // { url: [rule, ...] }
  var _containsList = [];  // [{ needle, rule }, ...]
  var _regexList = [];     // [{ re: RegExp, rule }, ...] — PRE-COMPILED
  var _domainMap = {};     // { domain: [rule, ...] }
  var _methodBuckets = {}; // { GET: [rule, ...], POST: [...], ... }
  var _allRules = [];      // rules with no method filter

  function safeRe(p, f) { try { return new RegExp(p, f); } catch (_) { return null; } }
  function hdrRec(h) { var r = {}; h.forEach(function (v, k) { r[k] = v; }); return r; }
  function parseHdr(raw) { var r = {}; raw.trim().split(/[\r\n]+/).forEach(function (line) { var idx = line.indexOf(': '); if (idx > 0) r[line.slice(0, idx)] = line.slice(idx + 2); }); return r; }
  var REQ = ['modifyRequestUrl','modifyRequestHeader','modifyRequestBody','redirect','cancel','delay','injectScript'];
  var RESP = ['modifyResponseHeader','modifyResponseBody','modifyStatusCode'];

  // Protected headers that should not be removed by response modification
  var PROTECTED_RESP_HEADERS = {
    'content-security-policy': true,
    'strict-transport-security': true,
    'x-content-type-options': true,
    'x-frame-options': true,
    'set-cookie': true
  };

  function trunc(s, n) { return s && s.length > n ? s.slice(0, n) : s; }
  function postLog(entry) { try { window.postMessage({ type: 'APII_LOG', entry: entry }, '*'); } catch (_) {} }

  // === Build optimized matching indexes from rules ===
  function buildIndexes() {
    _exactMap = {}; _containsList = []; _regexList = []; _domainMap = {};
    _methodBuckets = {}; _allRules = [];

    if (GROUPS.length === 0) GROUPS = [{ id: 'default', name: '默认分组', enabled: true, color: '#1677ff' }];
    var enabledGroups = {};
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].enabled) enabledGroups[GROUPS[i].id] = true;
    }

    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (!r.enabled || !r.match || !enabledGroups[r.groupId]) continue;
      var m = r.match;
      var method = m.method || '';
      var bucket = method ? (_methodBuckets[method] = _methodBuckets[method] || []) : _allRules;

      switch (m.matchType) {
        case 'exact':
          var key = m.url || '';
          if (!_exactMap[key]) _exactMap[key] = [];
          _exactMap[key].push(r);
          break;
        case 'contains':
          _containsList.push({ needle: m.url || '', rule: r });
          if (method) bucket.push(r); else _allRules.push(r);
          break;
        case 'regex':
          var re = safeRe(m.url || '', '');
          if (re) {
            _regexList.push({ re: re, rule: r });
            if (method) bucket.push(r); else _allRules.push(r);
          }
          break;
        case 'domain':
          var d = m.url || '';
          if (!_domainMap[d]) _domainMap[d] = [];
          _domainMap[d].push(r);
          if (method) bucket.push(r); else _allRules.push(r);
          break;
      }
    }
  }

  // === Fast matching using indexes — O(1) for exact/domain, O(K) for contains/regex ===
  function getMatchingRules(url, method, rtype) {
    if (!ACTIVE || !GLOBAL_ENABLED) return [];
    try { if (url.charAt(0) === '/') url = location.origin + url; } catch (_) {}

    var result = [];
    var seen = {}; // dedup by rule id

    function addRule(r) {
      if (!seen[r.id]) {
        if (!r.match.resourceType || r.match.resourceType === rtype) {
          seen[r.id] = true;
          result.push(r);
        }
      }
    }

    // 1. Exact match — O(1) hash lookup
    var exact = _exactMap[url];
    if (exact) {
      for (var i = 0; i < exact.length; i++) {
        var r = exact[i];
        if (!r.match.method || r.match.method === method) addRule(r);
      }
    }

    // 2. Domain match — O(1) hash lookup
    try {
      var hostname = new URL(url).hostname;
      var domainRules = _domainMap[hostname];
      if (domainRules) {
        for (var i = 0; i < domainRules.length; i++) {
          var r = domainRules[i];
          if (!r.match.method || r.match.method === method) addRule(r);
        }
      }
      // Also check parent domains
      var parts = hostname.split('.');
      for (var p = 1; p < parts.length - 1; p++) {
        var parentDomain = parts.slice(p).join('.');
        var parentRules = _domainMap[parentDomain];
        if (parentRules) {
          for (var i = 0; i < parentRules.length; i++) {
            var r = parentRules[i];
            if (!r.match.method || r.match.method === method) addRule(r);
          }
        }
      }
    } catch (_) {}

    // 3. Contains match — O(K) where K = number of contains rules
    for (var i = 0; i < _containsList.length; i++) {
      var c = _containsList[i];
      if (url.indexOf(c.needle) >= 0) {
        if (!c.rule.match.method || c.rule.match.method === method) addRule(c.rule);
      }
    }

    // 4. Regex match — O(K) with PRE-COMPILED regex (no re-compilation per request)
    for (var i = 0; i < _regexList.length; i++) {
      var entry = _regexList[i];
      if (entry.re.test(url)) {
        if (!entry.rule.match.method || entry.rule.match.method === method) addRule(entry.rule);
      }
    }

    return result;
  }

  // === Safe body extraction — handles FormData, Blob, ReadableStream ===
  function extractBody(body) {
    if (body == null) return undefined;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      try { return new TextDecoder().decode(body); } catch (_) { return undefined; }
    }
    // FormData, Blob, ReadableStream — cannot safely stringify, skip body modification
    return undefined;
  }

  function applyReq(url, hdrs, body, actions) {
    var u = url, b = body, h = {}; for (var k in hdrs) h[k] = hdrs[k];
    var cancelled = false; var delayMs = 0; var bodyChanged = false;

    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      switch (a.type) {
        case 'modifyRequestUrl':
          if (a.operate === 'replace') { var re = safeRe(a.key, 'g'); if (re) u = u.replace(re, a.value); }
          else if (a.operate === 'set') u = a.value;
          else if (a.operate === 'remove') { var re2 = safeRe('[?&]' + a.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=[^&]*', 'g'); if (re2) u = u.replace(re2, ''); }
          break;
        case 'modifyRequestHeader':
          if (a.operate === 'set') h[a.key] = a.value;
          else if (a.operate === 'append') h[a.key] = (h[a.key] ? h[a.key] + ', ' : '') + a.value;
          else if (a.operate === 'remove') { var re3 = safeRe(a.key, 'i'); if (re3) { var ks = Object.keys(h); for (var j = 0; j < ks.length; j++) { if (re3.test(ks[j])) delete h[ks[j]]; } } }
          else if (a.operate === 'replace') { var re4 = safeRe(a.key, 'i'); if (re4) { var ks2 = Object.keys(h); for (var j2 = 0; j2 < ks2.length; j2++) { if (re4.test(ks2[j2])) h[ks2[j2]] = a.value; } } }
          break;
        case 'modifyRequestBody':
          if (b !== undefined) {
            if (a.operate === 'replace') { var re5 = safeRe(a.key, 'g'); if (re5) { b = b.replace(re5, a.value); bodyChanged = true; } }
            else if (a.operate === 'set') { b = a.value; bodyChanged = true; }
          }
          break;
        case 'redirect':
          if (a.operate === 'set') {
            // 验证重定向 URL 格式，避免 fetch 抛出不透明的 TypeError
            try { new URL(a.value); u = a.value; } catch (urlErr) {
              console.warn('[ApiMockFlow] redirect URL 格式无效，已跳过:', a.value, urlErr.message);
            }
          }
          break;
        case 'cancel': cancelled = true; break;
        case 'delay': delayMs = Math.max(delayMs, Math.min(parseInt(a.value) || 0, 30000)); break;
        case 'injectScript':
          try {
            var _ctx = { url: u, headers: h, body: b };
            new Function('ctx', a.value)(_ctx);
            u = _ctx.url; b = _ctx.body;
          } catch (err) {
            // 白盒化：将注入脚本报错暴露给测试人员，而非静默吞掉
            var errMsg = 'injectScript 执行错误: ' + (err && err.message ? err.message : String(err));
            console.warn('[ApiMockFlow]', errMsg, '\n脚本内容:', a.value.slice(0, 200));
            postLog({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: Date.now(), url: u, method: 'INJECT_ERROR', ruleIds: [], ruleNames: [], originalRequest: { headers: h, body: trunc(b, 200) }, modifiedRequest: { url: u, headers: h, body: trunc(b, 200) }, originalResponse: undefined, modifiedResponse: { status: 0, statusText: errMsg, headers: {}, body: '' }, cancelled: false, delayed: false, delayMs: 0 });
          }
          break;
      }
    }
    if (bodyChanged) { delete h['content-length']; }
    return { url: u, headers: h, body: b, cancelled: cancelled, delayMs: delayMs };
  }

  function applyResp(status, statusText, hdrs, body, actions) {
    var s = status, st = statusText, b = body, h = {}; for (var k in hdrs) h[k] = hdrs[k];
    var bodyChanged = false;

    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      switch (a.type) {
        case 'modifyResponseHeader':
          // Protect security-critical headers from removal
          if (a.operate === 'remove' || a.operate === 'replace') {
            var isProtected = false;
            var reKey = safeRe(a.key, 'i');
            if (reKey) {
              for (var ph in PROTECTED_RESP_HEADERS) {
                if (reKey.test(ph)) { isProtected = true; break; }
              }
            }
            if (isProtected) break;
          }
          if (a.operate === 'set') h[a.key] = a.value;
          else if (a.operate === 'append') h[a.key] = (h[a.key] ? h[a.key] + ', ' : '') + a.value;
          else if (a.operate === 'remove') { var re = safeRe(a.key, 'i'); if (re) { var ks = Object.keys(h); for (var j = 0; j < ks.length; j++) { if (re.test(ks[j])) delete h[ks[j]]; } } }
          else if (a.operate === 'replace') { var re2 = safeRe(a.key, 'i'); if (re2) { var ks2 = Object.keys(h); for (var j2 = 0; j2 < ks2.length; j2++) { if (re2.test(ks2[j2])) h[ks2[j2]] = a.value; } } }
          break;
        case 'modifyResponseBody':
          if (a.operate === 'replace') { var re3 = safeRe(a.key, 'g'); if (re3) b = b.replace(re3, a.value); bodyChanged = true; }
          else if (a.operate === 'set') { b = a.value; bodyChanged = true; }
          break;
        case 'modifyStatusCode':
          if (a.operate === 'set') { var c = parseInt(a.value); if (!isNaN(c) && c >= 100 && c <= 599) { s = c; st = (c >= 200 && c < 300) ? 'OK' : ''; } }
          break;
      }
    }
    if (bodyChanged) {
      delete h['content-length'];
      delete h['content-encoding'];
      var ct = h['content-type'];
      if (ct && ct.indexOf('charset') === -1) h['content-type'] = ct + '; charset=utf-8';
    }
    return { status: s, statusText: st, headers: h, body: b };
  }

  // === Intercepted fetch ===
  async function interceptedFetch(input, init) {
    _reqCount++;
    var url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input && input.url) || '');
    var method = (init && init.method) || (input && input.method) || 'GET';
    var rules = getMatchingRules(url, method, 'fetch');
    if (rules.length === 0) return NATIVE_FETCH(input, init);

    var allA = []; for (var i = 0; i < rules.length; i++) allA = allA.concat(rules[i].actions);
    var reqA = allA.filter(function (a) { return REQ.indexOf(a.type) >= 0; });
    var respA = allA.filter(function (a) { return RESP.indexOf(a.type) >= 0; });
    var origH = init && init.headers ? hdrRec(init.headers instanceof Headers ? init.headers : new Headers(init.headers)) : {};
    var origB = extractBody(init && init.body);
    var origUrl = url;
    var origReq = { headers: origH, body: trunc(origB, 2000) };
    var rm = applyReq(url, origH, origB, reqA);
    var modReq = { url: rm.url, headers: rm.headers, body: trunc(rm.body, 2000) };

    if (rm.cancelled) {
      postLog({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: Date.now(), url: origUrl, method: method, ruleIds: rules.map(function(r){return r.id;}), ruleNames: rules.map(function(r){return r.name;}), originalRequest: origReq, modifiedRequest: modReq, originalResponse: undefined, modifiedResponse: undefined, cancelled: true, delayed: false, delayMs: 0 });
      return new Response(null, { status: 403, statusText: 'Blocked' });
    }

    if (rm.delayMs > 0) {
      await new Promise(function (r) { setTimeout(r, rm.delayMs); });
    }

    var ni = init ? Object.assign({}, init) : {};
    if (rm.url !== url) input = rm.url;
    ni.headers = rm.headers;
    if (rm.body !== undefined) ni.body = rm.body;

    try {
      var resp = await NATIVE_FETCH(input, ni);

      if (respA.length > 0) {
        try {
          var rb = await resp.text();
          var origResp = { status: resp.status, statusText: resp.statusText, headers: hdrRec(resp.headers), body: trunc(rb, 2000) };
          var rmod = applyResp(resp.status, resp.statusText, hdrRec(resp.headers), rb, respA);
          postLog({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: Date.now(), url: origUrl, method: method, ruleIds: rules.map(function(r){return r.id;}), ruleNames: rules.map(function(r){return r.name;}), originalRequest: origReq, modifiedRequest: modReq, originalResponse: origResp, modifiedResponse: { status: rmod.status, statusText: rmod.statusText, headers: rmod.headers, body: trunc(rmod.body, 2000) }, cancelled: false, delayed: rm.delayMs > 0, delayMs: rm.delayMs });
          var finalBody = rmod.body;
          if (finalBody && finalBody.length > 2000000) { finalBody = finalBody.slice(0, 2000000); rmod.headers['content-type'] = 'text/plain; charset=utf-8'; }
          return new Response(finalBody, { status: rmod.status, statusText: rmod.statusText, headers: rmod.headers });
        } catch (readErr) {
          // Response body unreadable (opaque, stream consumed, etc.) — return original response
          console.warn('[ApiMockFlow] 响应体读取失败，无法应用响应修改:', readErr && readErr.message);
          postLog({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: Date.now(), url: origUrl, method: method, ruleIds: rules.map(function(r){return r.id;}), ruleNames: rules.map(function(r){return r.name;}), originalRequest: origReq, modifiedRequest: modReq, originalResponse: undefined, modifiedResponse: { status: 0, statusText: '响应体读取失败(可能是opaque响应或流已消费)，修改未生效', headers: {}, body: '' }, cancelled: false, delayed: rm.delayMs > 0, delayMs: rm.delayMs });
          return resp;
        }
      }

      postLog({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: Date.now(), url: origUrl, method: method, ruleIds: rules.map(function(r){return r.id;}), ruleNames: rules.map(function(r){return r.name;}), originalRequest: origReq, modifiedRequest: modReq, originalResponse: undefined, modifiedResponse: undefined, cancelled: false, delayed: rm.delayMs > 0, delayMs: rm.delayMs });
      return resp;
    } catch (fetchErr) {
      // Network error AFTER modification — retry with ORIGINAL request to avoid infinite loop
      void 0;
      try { return NATIVE_FETCH(origUrl, init); } catch (_) { throw fetchErr; }
    }
  }

  // === Intercepted XHR ===
  var _XHR_open = NATIVE_XHR.prototype.open;
  var _XHR_send = NATIVE_XHR.prototype.send;
  var _XHR_setRH = NATIVE_XHR.prototype.setRequestHeader;
  var XHR_PATCHED = false;

  function patchXHR() {
    if (XHR_PATCHED) return;
    XHR_PATCHED = true;
    NATIVE_XHR.prototype.open = function (m, u) { this._xm = m; this._xu = u; this._xrh = {}; this._xb = undefined; this._xrm = false; return _XHR_open.apply(this, arguments); };
    NATIVE_XHR.prototype.setRequestHeader = function (n, v) { this._xrh = this._xrh || {}; this._xrh[n] = v; return _XHR_setRH.apply(this, arguments); };
    NATIVE_XHR.prototype.send = function (body) {
      var self = this;
      this._xb = extractBody(body);
      if (!self._xu) { return _XHR_send.call(self, body); }
      _reqCount++;
      var ou = self._xu, om = self._xm, orh = {}; for (var k in self._xrh) orh[k] = self._xrh[k]; var ob = self._xb;
      var rules = getMatchingRules(ou, om, 'xmlhttprequest');
      if (rules.length === 0) { return _XHR_send.call(self, body); }

      var allA = []; for (var i = 0; i < rules.length; i++) allA = allA.concat(rules[i].actions);
      var reqA = allA.filter(function (a) { return REQ.indexOf(a.type) >= 0; });
      var respA = allA.filter(function (a) { return RESP.indexOf(a.type) >= 0; });
      var xhrOrigReq = { headers: orh, body: trunc(ob, 2000) };
      var rm = applyReq(ou, orh, ob, reqA);
      var xhrModReq = { url: rm.url, headers: rm.headers, body: trunc(rm.body, 2000) };
      var xhrRuleIds = rules.map(function(r){return r.id;});
      var xhrRuleNames = rules.map(function(r){return r.name;});

      function xhrLog(origResp, modResp, cancelled) {
        postLog({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: Date.now(), url: ou, method: om, ruleIds: xhrRuleIds, ruleNames: xhrRuleNames, originalRequest: xhrOrigReq, modifiedRequest: xhrModReq, originalResponse: origResp || undefined, modifiedResponse: modResp || undefined, cancelled: !!cancelled, delayed: rm.delayMs > 0, delayMs: rm.delayMs });
      }

      function doXHRSend() {
        if (rm.cancelled) {
          try{Object.defineProperty(self,'status',{value:403,writable:true,configurable:true});Object.defineProperty(self,'statusText',{value:'Blocked',writable:true,configurable:true});Object.defineProperty(self,'responseText',{value:'',writable:true,configurable:true});Object.defineProperty(self,'response',{value:'',writable:true,configurable:true});Object.defineProperty(self,'readyState',{value:4,writable:true,configurable:true});}catch(_){}
          xhrLog(null, null, true);
          setTimeout(function(){self.dispatchEvent(new Event('load'));},0);
          return;
        }
        var hk = Object.keys(rm.headers);
        for (var i2 = 0; i2 < hk.length; i2++) { try { _XHR_setRH.call(self, hk[i2], rm.headers[hk[i2]]); } catch (_) {} }

        if (rm.url !== ou) {
          // URL redirect: create proxy XHR with timeout and error handling
          var px = new NATIVE_XHR();
          try { px.open(om, rm.url, true); } catch (openErr) {
            void 0;
            self.dispatchEvent(new Event('error'));
            xhrLog(null, null, false);
            return;
          }
          // Copy timeout from original XHR
          try { if (self.timeout) px.timeout = self.timeout; } catch (_) {}
          var hk2 = Object.keys(rm.headers);
          for (var i3 = 0; i3 < hk2.length; i3++) { try { px.setRequestHeader(hk2[i3], rm.headers[hk2[i3]]); } catch (_) {} }

          // Timeout handler
          px.ontimeout = function() {
            try { Object.defineProperty(self,'readyState',{value:4,writable:true,configurable:true}); } catch(_) {}
            self.dispatchEvent(new Event('timeout'));
          };

          px.onerror = function() {
            if (!self._xrm) {
              self._xrm = true;
              try { Object.defineProperty(self,'status',{value:px.status || 0,writable:true,configurable:true}); } catch(_) {}
              self.dispatchEvent(new Event('error'));
              self.dispatchEvent(new Event('load'));
            }
          };

          px.onreadystatechange = function () {
            if (px.readyState === 4 && !self._xrm) {
              self._xrm = true;
              var rb = px.responseText || '';
              var rh = parseHdr(px.getAllResponseHeaders());
              var xhrOrigResp = { status: px.status, statusText: px.statusText, headers: rh, body: trunc(rb, 2000) };
              if (respA.length > 0) {
                var rmod = applyResp(px.status, px.statusText, rh, rb, respA);
                try{Object.defineProperty(self,'status',{value:rmod.status,writable:true,configurable:true});Object.defineProperty(self,'statusText',{value:rmod.statusText,writable:true,configurable:true});Object.defineProperty(self,'responseText',{value:rmod.body,writable:true,configurable:true});Object.defineProperty(self,'response',{value:rmod.body,writable:true,configurable:true});self.getResponseHeader=function(n){for(var k2 in rmod.headers){if(k2.toLowerCase()===n.toLowerCase())return rmod.headers[k2];}return null;};self.getAllResponseHeaders=function(){return Object.keys(rmod.headers).map(function(k2){return k2+': '+rmod.headers[k2];}).join('\r\n');};}catch(_){}
                xhrLog(xhrOrigResp, { status: rmod.status, statusText: rmod.statusText, headers: rmod.headers, body: trunc(rmod.body, 2000) });
              } else {
                xhrLog(xhrOrigResp, null);
              }
              try{Object.defineProperty(self,'readyState',{value:4,writable:true,configurable:true});}catch(_){}
              self.dispatchEvent(new Event('readystatechange'));
              self.dispatchEvent(new Event('load'));
              if (px.status >= 400) self.dispatchEvent(new Event('error'));
            }
          };
          try { px.send(rm.body !== undefined ? rm.body : body); } catch (sendErr) {
            void 0;
            self.dispatchEvent(new Event('error'));
            xhrLog(null, null, false);
          }
          return;
        }

        // No URL redirect — intercept response
        if (respA.length > 0) {
          self.addEventListener('readystatechange', function h() {
            if (self.readyState === 4 && !self._xrm) {
              self._xrm = true;
              self.removeEventListener('readystatechange', h);
              try {
                var rb = self.responseText || '';
                var rh = parseHdr(oGAH.call(self));
                var os = self.status, ot = self.statusText;
                var xhrOrigResp2 = { status: os, statusText: ot, headers: rh, body: trunc(rb, 2000) };
                var rmod = applyResp(os, ot, rh, rb, respA);
                try{Object.defineProperty(self,'status',{value:rmod.status,writable:true,configurable:true});Object.defineProperty(self,'statusText',{value:rmod.statusText,writable:true,configurable:true});Object.defineProperty(self,'responseText',{value:rmod.body,writable:true,configurable:true});Object.defineProperty(self,'response',{value:rmod.body,writable:true,configurable:true});self.getResponseHeader=function(n){for(var k2 in rmod.headers){if(k2.toLowerCase()===n.toLowerCase())return rmod.headers[k2];}return null;};self.getAllResponseHeaders=function(){return Object.keys(rmod.headers).map(function(k2){return k2+': '+rmod.headers[k2];}).join('\r\n');};}catch(_){}
                xhrLog(xhrOrigResp2, { status: rmod.status, statusText: rmod.statusText, headers: rmod.headers, body: trunc(rmod.body, 2000) });
              } catch (readErr) {
                console.warn('[ApiMockFlow] XHR 响应体读取失败:', readErr && readErr.message);
              }
            }
          });
        }
        xhrLog(null, null);
        return _XHR_send.call(self, rm.body !== undefined ? rm.body : body);
      }

      if (rm.delayMs > 0) {
        setTimeout(doXHRSend, rm.delayMs);
      } else {
        doXHRSend();
      }
    };
  }

  function unpatchXHR() {
    if (!XHR_PATCHED) return;
    NATIVE_XHR.prototype.open = _XHR_open;
    NATIVE_XHR.prototype.send = _XHR_send;
    NATIVE_XHR.prototype.setRequestHeader = _XHR_setRH;
    XHR_PATCHED = false;
  }

  function setActive(on) {
    if (on === ACTIVE) return;
    ACTIVE = on;
    if (on) {
      window.fetch = interceptedFetch;
      patchXHR();
      if (!_rcTimer) _rcTimer = setInterval(function () { window.postMessage({ type: 'APII_RCOUNT', count: _reqCount }, '*'); }, 2000);
    } else {
      window.fetch = NATIVE_FETCH;
      unpatchXHR();
      if (_rcTimer) { clearInterval(_rcTimer); _rcTimer = null; }
    }
  }

  // Receive state + rules from content script
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'APII_SYNC') {
      GLOBAL_ENABLED = e.data.globalEnabled;
      RULES = e.data.rules || [];
      for (var i = 0; i < RULES.length; i++) {
        if (RULES[i].match && RULES[i].match.url) RULES[i].match.url = RULES[i].match.url.trim();
      }
      GROUPS = e.data.groups || [];
      buildIndexes(); // Rebuild matching indexes on rule change
      setActive(e.data.active);
    }
  });

  window.postMessage({ type: 'APII_READY' }, '*');
})(); } // end __APII_INIT guard
