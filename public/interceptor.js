// Main-world interceptor — local matching, zero bridge overhead
(function () {
  'use strict';

  var NATIVE_FETCH = window.fetch;
  var NATIVE_XHR = window.XMLHttpRequest;
  var oGAH = NATIVE_XHR.prototype.getAllResponseHeaders;
  var RULES = [];        // current rules (local copy)
  var GROUPS = [];       // current groups
  var GLOBAL_ENABLED = true;
  var ACTIVE = false;
  var _init = false;
  var _reqCount = 0;

  function safeRe(p, f) { try { return new RegExp(p, f); } catch (_) { return null; } }
  function hdrRec(h) { var r = {}; h.forEach(function (v, k) { r[k] = v; }); return r; }
  function parseHdr(raw) { var r = {}; raw.trim().split(/[\r\n]+/).forEach(function (line) { var idx = line.indexOf(': '); if (idx > 0) r[line.slice(0, idx)] = line.slice(idx + 2); }); return r; }
  var REQ = ['modifyRequestUrl','modifyRequestHeader','modifyRequestBody','redirect','cancel','delay'];
  var RESP = ['modifyResponseHeader','modifyResponseBody','modifyStatusCode'];

  function applyReq(url, hdrs, body, actions) { var u = url, b = body, h = {}; for (var k in hdrs) h[k] = hdrs[k]; var cancelled = false; var delayMs = 0; for (var i = 0; i < actions.length; i++) { var a = actions[i]; switch (a.type) { case 'modifyRequestUrl': if (a.operate === 'replace') { var re = safeRe(a.key, 'g'); if (re) u = u.replace(re, a.value); } else if (a.operate === 'set') u = a.value; else if (a.operate === 'remove') { var re2 = safeRe('[?&]' + a.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=[^&]*', 'g'); if (re2) u = u.replace(re2, ''); } break; case 'modifyRequestHeader': if (a.operate === 'set') h[a.key] = a.value; else if (a.operate === 'append') h[a.key] = (h[a.key] ? h[a.key] + ', ' : '') + a.value; else if (a.operate === 'remove') { var re3 = safeRe(a.key, 'i'); if (re3) { var ks = Object.keys(h); for (var j = 0; j < ks.length; j++) { if (re3.test(ks[j])) delete h[ks[j]]; } } } else if (a.operate === 'replace') { var re4 = safeRe(a.key, 'i'); if (re4) { var ks2 = Object.keys(h); for (var j2 = 0; j2 < ks2.length; j2++) { if (re4.test(ks2[j2])) h[ks2[j2]] = a.value; } } } break; case 'modifyRequestBody': if (b !== undefined) { if (a.operate === 'replace') { var re5 = safeRe(a.key, 'g'); if (re5) b = b.replace(re5, a.value); } else if (a.operate === 'set') b = a.value; } break; case 'redirect': if (a.operate === 'set') u = a.value; break; case 'cancel': cancelled = true; break; case 'delay': delayMs = Math.max(delayMs, parseInt(a.value) || 0); break; } } return { url: u, headers: h, body: b, cancelled: cancelled, delayMs: delayMs }; }

  function applyResp(status, statusText, hdrs, body, actions) { var s = status, st = statusText, b = body, h = {}; for (var k in hdrs) h[k] = hdrs[k]; var bodyChanged = false; for (var i = 0; i < actions.length; i++) { var a = actions[i]; switch (a.type) { case 'modifyResponseHeader': if (a.operate === 'set') h[a.key] = a.value; else if (a.operate === 'append') h[a.key] = (h[a.key] ? h[a.key] + ', ' : '') + a.value; else if (a.operate === 'remove') { var re = safeRe(a.key, 'i'); if (re) { var ks = Object.keys(h); for (var j = 0; j < ks.length; j++) { if (re.test(ks[j])) delete h[ks[j]]; } } } else if (a.operate === 'replace') { var re2 = safeRe(a.key, 'i'); if (re2) { var ks2 = Object.keys(h); for (var j2 = 0; j2 < ks2.length; j2++) { if (re2.test(ks2[j2])) h[ks2[j2]] = a.value; } } } break; case 'modifyResponseBody': if (a.operate === 'replace') { var re3 = safeRe(a.key, 'g'); if (re3) b = b.replace(re3, a.value); bodyChanged = true; } else if (a.operate === 'set') { b = a.value; bodyChanged = true; } break; case 'modifyStatusCode': if (a.operate === 'set') { var c = parseInt(a.value); if (!isNaN(c) && c >= 100 && c <= 599) { s = c; st = (c >= 200 && c < 300) ? 'OK' : ''; } } break; } } if (bodyChanged) { delete h['content-length']; delete h['content-encoding']; var ct = h['content-type']; if (ct && ct.indexOf('charset') === -1) h['content-type'] = ct + '; charset=utf-8'; } return { status: s, statusText: st, headers: h, body: b }; }

  // === LOCAL rule matching (same logic as background, no bridge) ===
  function matchUrl(ruleUrl, matchType, url) {
    switch (matchType) {
      case 'exact': return url === ruleUrl;
      case 'contains': return url.indexOf(ruleUrl) >= 0;
      case 'regex': try { return new RegExp(ruleUrl).test(url); } catch (_) { return false; }
      case 'domain': try { var u = new URL(url); return u.hostname === ruleUrl || u.hostname.indexOf('.' + ruleUrl) >= 0 && u.hostname.slice(-ruleUrl.length - 1) === '.' + ruleUrl; } catch (_) { return false; }
      default: return false;
    }
  }

  function getMatchingRules(url, method, rtype) {
    if (!ACTIVE || !GLOBAL_ENABLED) return [];
    // Resolve relative URLs to absolute (e.g. /api/x → https://host/api/x)
    try { if (url.charAt(0) === '/') url = location.origin + url; } catch (_) {}
    if (GROUPS.length === 0) GROUPS = [{ id: 'default', name: '默认分组', enabled: true, color: '#1677ff' }];
    var enabledGroups = {}; for (var i = 0; i < GROUPS.length; i++) { if (GROUPS[i].enabled) enabledGroups[GROUPS[i].id] = true; }
    var result = [];
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (!r.enabled) continue;
      if (!enabledGroups[r.groupId]) continue;
      if (!r.match) continue;  // skip malformed rules
      if (r.match.method && r.match.method !== method) continue;
      if (r.match.resourceType && r.match.resourceType !== rtype) continue;
      if (matchUrl(r.match.url || '', r.match.matchType || '', url)) result.push(r);
    }
    return result;
  }

  // === Intercepted fetch ===
  async function interceptedFetch(input, init) {
    _reqCount++;
    var url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input && input.url) || '');
    var method = (init && init.method) || (input && input.method) || 'GET';
    var rules = getMatchingRules(url, method, 'fetch');
    if (rules.length === 0) return NATIVE_FETCH(input, init);

    console.log('[ApiMockFlow] Matched', rules.length, 'rule(s):', method, url);
    var allA = []; for (var i = 0; i < rules.length; i++) allA = allA.concat(rules[i].actions);
    var reqA = allA.filter(function (a) { return REQ.indexOf(a.type) >= 0; });
    var respA = allA.filter(function (a) { return RESP.indexOf(a.type) >= 0; });
    var origH = init && init.headers ? hdrRec(init.headers instanceof Headers ? init.headers : new Headers(init.headers)) : {};
    var origB = init && init.body ? (init.body instanceof ReadableStream ? undefined : init.body.toString()) : undefined;
    var rm = applyReq(url, origH, origB, reqA);

    if (rm.cancelled) {
      return new Response(null, { status: 403, statusText: 'Blocked' });
    }

    // Delay simulation
    if (rm.delayMs > 0) {
      await new Promise(function (r) { setTimeout(r, rm.delayMs); });
    }

    var ni = init ? Object.assign({}, init) : {};
    if (rm.url !== url) input = rm.url; ni.headers = rm.headers; if (rm.body !== undefined) ni.body = rm.body;

    return NATIVE_FETCH(input, ni).then(function (resp) {
      if (respA.length > 0) {
        return resp.text().then(function (rb) {
          var rmod = applyResp(resp.status, resp.statusText, hdrRec(resp.headers), rb, respA);
          console.log('[ApiMockFlow] Response modified:', method, url, 'status', resp.status, '→', rmod.status, 'body', rb.length, '→', rmod.body.length);
          return new Response(rmod.body, { status: rmod.status, statusText: rmod.statusText, headers: rmod.headers });
        });
      }
      return resp;
    }).catch(function (err) { console.error('[ApiMockFlow] fetch error:', err); return NATIVE_FETCH(input, init); });
  }

  // === Intercepted XHR — patch prototype, NOT constructor (avoids Illegal invocation) ===
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
      var self = this; this._xb = body ? body.toString() : undefined;
      if (!self._xu) { return _XHR_send.call(self, body); }
      _reqCount++;
      var ou = self._xu, om = self._xm, orh = {}; for (var k in self._xrh) orh[k] = self._xrh[k]; var ob = self._xb;
      var rules = getMatchingRules(ou, om, 'xmlhttprequest');
      if (rules.length === 0) { return _XHR_send.call(self, body); }
      console.log('[ApiMockFlow] XHR Matched', rules.length, 'rule(s):', om, ou);

      var allA = []; for (var i = 0; i < rules.length; i++) allA = allA.concat(rules[i].actions);
      var reqA = allA.filter(function (a) { return REQ.indexOf(a.type) >= 0; });
      var respA = allA.filter(function (a) { return RESP.indexOf(a.type) >= 0; });
      var rm = applyReq(ou, orh, ob, reqA);

      function doXHRSend() {
        if (rm.cancelled) { try{Object.defineProperty(self,'status',{value:403});Object.defineProperty(self,'statusText',{value:'Blocked'});Object.defineProperty(self,'responseText',{value:''});Object.defineProperty(self,'response',{value:''});Object.defineProperty(self,'readyState',{value:4});}catch(_){} setTimeout(function(){self.dispatchEvent(new Event('load'));},0); return; }
        var hk = Object.keys(rm.headers); for (var i2 = 0; i2 < hk.length; i2++) { try { _XHR_setRH.call(self, hk[i2], rm.headers[hk[i2]]); } catch (_) {} }
        if (rm.url !== ou) { var px = new NATIVE_XHR(); px.open(om, rm.url, true); var hk2 = Object.keys(rm.headers); for (var i3 = 0; i3 < hk2.length; i3++) { try { px.setRequestHeader(hk2[i3], rm.headers[hk2[i3]]); } catch (_) {} } px.onreadystatechange = function () { if (px.readyState === 4 && !self._xrm) { self._xrm = true; var rb = px.responseText || ''; var rh = parseHdr(px.getAllResponseHeaders()); if (respA.length > 0) { var rmod = applyResp(px.status, px.statusText, rh, rb, respA); try{Object.defineProperty(self,'status',{value:rmod.status});Object.defineProperty(self,'statusText',{value:rmod.statusText});Object.defineProperty(self,'responseText',{value:rmod.body});Object.defineProperty(self,'response',{value:rmod.body});self.getResponseHeader=function(n){for(var k2 in rmod.headers){if(k2.toLowerCase()===n.toLowerCase())return rmod.headers[k2];}return null;};self.getAllResponseHeaders=function(){return Object.keys(rmod.headers).map(function(k2){return k2+': '+rmod.headers[k2];}).join('\r\n');};}catch(_){} } try{Object.defineProperty(self,'readyState',{value:4});}catch(_){} self.dispatchEvent(new Event('readystatechange')); self.dispatchEvent(new Event('load')); if (px.status >= 400) self.dispatchEvent(new Event('error')); } }; px.send(rm.body !== undefined ? rm.body : body); return; }
        if (respA.length > 0) { self.addEventListener('readystatechange', function h() { if (self.readyState === 4 && !self._xrm) { self._xrm = true; self.removeEventListener('readystatechange', h); var rb = self.responseText || ''; var rh = parseHdr(oGAH.call(self)); var os = self.status, ot = self.statusText; var rmod = applyResp(os, ot, rh, rb, respA); console.log('[ApiMockFlow] XHR Response modified:', om, ou, 'status', os, '→', rmod.status, 'bodyLen', rb.length, '→', rmod.body.length); 
try{Object.defineProperty(self,'status',{value:rmod.status});Object.defineProperty(self,'statusText',{value:rmod.statusText});Object.defineProperty(self,'responseText',{value:rmod.body});Object.defineProperty(self,'response',{value:rmod.body});self.getResponseHeader=function(n){for(var k2 in rmod.headers){if(k2.toLowerCase()===n.toLowerCase())return rmod.headers[k2];}return null;};self.getAllResponseHeaders=function(){return Object.keys(rmod.headers).map(function(k2){return k2+': '+rmod.headers[k2];}).join('\r\n');};}catch(_){} } }); return _XHR_send.call(self, rm.body !== undefined ? rm.body : body); }
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

  // === On/Off — swap window.fetch, patch/unpatch XHR prototype ===
  function setActive(on) {
    if (on === ACTIVE) return;
    ACTIVE = on;
    if (on) {
      window.fetch = interceptedFetch;
      patchXHR();
      console.log('[ApiMockFlow] Activated');
    } else {
      window.fetch = NATIVE_FETCH;
      unpatchXHR();
      console.log('[ApiMockFlow] Deactivated');
    }
  }

  // Receive state + rules from content script
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'APII_SYNC') {
      GLOBAL_ENABLED = e.data.globalEnabled;
      RULES = e.data.rules || [];
      // Trim rule match URLs to avoid whitespace mismatch
      for (var i = 0; i < RULES.length; i++) {
        if (RULES[i].match && RULES[i].match.url) RULES[i].match.url = RULES[i].match.url.trim();
      }
      GROUPS = e.data.groups || [];
      setActive(e.data.active);
    }
  });

  // Debug: expose on window for manual console check
  window.__API__ = { test: function () { return 'OK'; }, count: function () { return _reqCount; }, active: function () { return ACTIVE; }, fetch: function () { return window.fetch === interceptedFetch; } };

  window.postMessage({ type: 'APII_READY' }, '*');
  setInterval(function () { window.postMessage({ type: 'APII_RCOUNT', count: _reqCount }, '*'); }, 2000);
  console.log('[ApiMockFlow] Main-world interceptor ready');
})();
