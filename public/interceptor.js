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
  var OBSERVE_ENABLED = false;
  var OBSERVE_TYPES = { fetch: true, xmlhttprequest: true };
  function absoluteUrl(value) {
    try { return new URL(value, location.href).href; } catch (_) { return value || ''; }
  }
  var ACTIVE = false;
  var _reqCount = 0;
  // Keep enough response content for creating a usable Mock rule from logs.
  // The response is still capped to avoid unbounded page/storage growth.
  var LOG_BODY_LIMIT = 10000000;
  var _rcTimer = null;

  // === Optimized matching indexes (built on sync) ===
  var _exactMap = {};      // { url: [rule, ...] }
  var _containsList = [];  // [{ needle, rule }, ...]
  var _regexList = [];     // [{ re: RegExp, rule }, ...] — PRE-COMPILED
  var _domainMap = {};     // { domain: [rule, ...] }

  function safeRe(p, f) { try { return new RegExp(p, f); } catch (_) { return null; } }
  function hdrRec(h) { var r = {}; h.forEach(function (v, k) { r[k] = v; }); return r; }
  // 请求头是否发生增/删/改（大小写不敏感比较名字，值精确比较）。
  // 用于 XHR：无变化时绝不重设头（避免同名头被追加合并破坏 Authorization）。
  function hdrsChanged(a, b) {
    function lc(o) { var r = {}; for (var k in o) r[k.toLowerCase()] = String(o[k]); return r; }
    var la = lc(a), lb = lc(b), kb = Object.keys(lb);
    if (Object.keys(la).length !== kb.length) return true;
    for (var i = 0; i < kb.length; i++) { if (!(kb[i] in la) || la[kb[i]] !== lb[kb[i]]) return true; }
    return false;
  }
  function parseHdr(raw) { var r = {}; raw.trim().split(/[\r\n]+/).forEach(function (line) { var idx = line.indexOf(': '); if (idx > 0) r[line.slice(0, idx)] = line.slice(idx + 2); }); return r; }
  function deleteHeaderCI(headers, name) { for (var k in headers) { if (k.toLowerCase() === name) delete headers[k]; } }
  function readXHRText(xhr) {
    try {
      if (!xhr.responseType || xhr.responseType === 'text') return xhr.responseText || '';
      if (xhr.responseType === 'json') return xhr.response == null ? '' : JSON.stringify(xhr.response);
    } catch (_) {}
    return '';
  }
  function defineOn(o, prop, val) { try { Object.defineProperty(o, prop, { value: val, writable: true, configurable: true }); } catch (_) {} }
  function setXHRRespHeaders(self, headers) {
    self.getResponseHeader = function (n) { for (var k in headers) { if (k.toLowerCase() === n.toLowerCase()) return headers[k]; } return null; };
    self.getAllResponseHeaders = function () { return Object.keys(headers).map(function (k) { return k + ': ' + headers[k]; }).join('\r\n'); };
  }
  // 把（可能改写过的）响应回填到页面原始 XHR self，尊重 responseType：
  //  text/''  → responseText 与 response 都设为文本
  //  json     → response 设为 JSON.parse(文本)（页面读 xhr.response 期望的是对象，直接给字符串会崩）
  //  blob/arraybuffer/document 等 → 文本规则无法有意义地改写二进制体；
  //    传入 binaryFallback（代理分支的 px.response）则原样透传，否则不动 self.response（保留原生响应）。
  function applyModRespToXHR(self, rmod, hasBinaryFallback, binaryFallback) {
    defineOn(self, 'status', rmod.status);
    defineOn(self, 'statusText', rmod.statusText);
    setXHRRespHeaders(self, rmod.headers);
    var rt = self.responseType;
    if (!rt || rt === 'text') {
      defineOn(self, 'responseText', rmod.body);
      defineOn(self, 'response', rmod.body);
    } else if (rt === 'json') {
      var obj = null;
      try { obj = rmod.body === '' || rmod.body == null ? null : JSON.parse(rmod.body); } catch (_) { obj = null; }
      defineOn(self, 'response', obj);
    } else if (hasBinaryFallback) {
      defineOn(self, 'response', binaryFallback);
    }
  }
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
  function logId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  // 这些状态码按规范不能带响应体；构造 Response 时必须传 null，否则抛错
  function isNullBodyStatus(s) { return s === 101 || s === 204 || s === 205 || s === 304; }

  // === 签名头检测 ===
  // 请求体被改写、但请求头里带有对 body 计算的签名/摘要时，服务端校验会失败（多表现为 401→跳登录）。
  // 命中这些字段即提示用户：需在 injectScript 里用改写后的 body 重算签名。
  // 注意：不按名匹配 authorization——Bearer/JWT/Basic 是与 body 无关的静态凭证，
  // 只有值形如「对请求体/参数做签名」的方案（如 AWS SigV4）才单独按值判定，避免在每个登录态请求上误报。
  var SIGN_HDR_RE = /(^|[-_])(signature|sign|sig|hmac|digest|checksum)($|[-_])|^content-md5$|^(x-ca-|x-tt-|x-bogus|x-gorgon|x-sap-)/i;
  var AUTH_SIGN_VAL_RE = /^\s*AWS4-HMAC|^\s*HMAC[- ]|\bSignature=|\bSignedHeaders=|\balgorithm\s*=/i;
  function detectSignHeaders(h) {
    var hit = [];
    for (var k in h) {
      if (k.toLowerCase() === 'authorization') {
        // 仅当 Authorization 的值是「基于请求体/参数的签名」时才算，普通 Bearer/Basic/Digest 不报
        if (AUTH_SIGN_VAL_RE.test(String(h[k] || ''))) hit.push(k);
      } else if (SIGN_HDR_RE.test(k)) {
        hit.push(k);
      }
    }
    return hit;
  }

  // === 同步 crypto 辅助（暴露给 injectScript 的 ctx.crypto）===
  // 纯 JS 实现，因 injectScript 在同步流程里执行，无法用异步的 SubtleCrypto。
  // 提供 md5 / sha1 / sha256 / hmacSha1 / hmacSha256 / base64，入参出参均为字符串（hex/base64）。
  var API_CRYPTO = (function () {
    function utf8Bytes(str) {
      if (typeof str !== 'string') str = String(str);
      var out = [], i, c;
      for (i = 0; i < str.length; i++) {
        c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
          var c2 = str.charCodeAt(++i);
          var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
      }
      return out;
    }
    function bytesToHex(b) { var h = ''; for (var i = 0; i < b.length; i++) { var s = (b[i] & 0xff).toString(16); h += s.length === 1 ? '0' + s : s; } return h; }

    // ---- SHA-256 (bytes -> 32 bytes) ----
    var K256 = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    function sha256Bytes(bytes) {
      var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
      var m = bytes.slice(), l = bytes.length;
      m.push(0x80); while (m.length % 64 !== 56) m.push(0);
      var hi = Math.floor(l / 0x20000000), lo = (l * 8) >>> 0;
      m.push((hi>>>24)&0xff,(hi>>>16)&0xff,(hi>>>8)&0xff,hi&0xff,(lo>>>24)&0xff,(lo>>>16)&0xff,(lo>>>8)&0xff,lo&0xff);
      function rr(x,n){return (x>>>n)|(x<<(32-n));}
      var w = new Array(64);
      for (var off = 0; off < m.length; off += 64) {
        for (var i = 0; i < 16; i++) w[i] = (m[off+i*4]<<24)|(m[off+i*4+1]<<16)|(m[off+i*4+2]<<8)|(m[off+i*4+3]);
        for (i = 16; i < 64; i++) {
          var s0 = rr(w[i-15],7)^rr(w[i-15],18)^(w[i-15]>>>3);
          var s1 = rr(w[i-2],17)^rr(w[i-2],19)^(w[i-2]>>>10);
          w[i] = (w[i-16]+s0+w[i-7]+s1)|0;
        }
        var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for (i = 0; i < 64; i++) {
          var S1 = rr(e,6)^rr(e,11)^rr(e,25), ch = (e&f)^(~e&g);
          var t1 = (h+S1+ch+K256[i]+w[i])|0;
          var S0 = rr(a,2)^rr(a,13)^rr(a,22), mj = (a&b)^(a&c)^(b&c);
          var t2 = (S0+mj)|0;
          h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
        }
        H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
      }
      var out = [];
      for (i = 0; i < 8; i++) out.push((H[i]>>>24)&0xff,(H[i]>>>16)&0xff,(H[i]>>>8)&0xff,H[i]&0xff);
      return out;
    }

    // ---- SHA-1 (bytes -> 20 bytes) ----
    function sha1Bytes(bytes) {
      var H = [0x67452301,0xEFCDAB89,0x98BADCFE,0x10325476,0xC3D2E1F0];
      var m = bytes.slice(), l = bytes.length;
      m.push(0x80); while (m.length % 64 !== 56) m.push(0);
      var hi = Math.floor(l / 0x20000000), lo = (l * 8) >>> 0;
      m.push((hi>>>24)&0xff,(hi>>>16)&0xff,(hi>>>8)&0xff,hi&0xff,(lo>>>24)&0xff,(lo>>>16)&0xff,(lo>>>8)&0xff,lo&0xff);
      function rl(x,n){return (x<<n)|(x>>>(32-n));}
      var w = new Array(80);
      for (var off = 0; off < m.length; off += 64) {
        for (var i = 0; i < 16; i++) w[i] = (m[off+i*4]<<24)|(m[off+i*4+1]<<16)|(m[off+i*4+2]<<8)|(m[off+i*4+3]);
        for (i = 16; i < 80; i++) w[i] = rl(w[i-3]^w[i-8]^w[i-14]^w[i-16], 1);
        var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4];
        for (i = 0; i < 80; i++) {
          var f, k;
          if (i < 20) { f = (b&c)|(~b&d); k = 0x5A827999; }
          else if (i < 40) { f = b^c^d; k = 0x6ED9EBA1; }
          else if (i < 60) { f = (b&c)|(b&d)|(c&d); k = 0x8F1BBCDC; }
          else { f = b^c^d; k = 0xCA62C1D6; }
          var t = (rl(a,5)+f+e+k+w[i])|0;
          e=d;d=c;c=rl(b,30);b=a;a=t;
        }
        H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;
      }
      var out = [];
      for (i = 0; i < 5; i++) out.push((H[i]>>>24)&0xff,(H[i]>>>16)&0xff,(H[i]>>>8)&0xff,H[i]&0xff);
      return out;
    }

    // ---- MD5 (bytes -> 16 bytes) ----
    function md5Bytes(bytes) {
      function add(a,b){return (a+b)|0;}
      function rl(x,c){return (x<<c)|(x>>>(32-c));}
      var m = bytes.slice(), l = bytes.length;
      m.push(0x80); while (m.length % 64 !== 56) m.push(0);
      var lo = (l * 8) >>> 0, hi = Math.floor(l / 0x20000000);
      m.push(lo&0xff,(lo>>>8)&0xff,(lo>>>16)&0xff,(lo>>>24)&0xff,hi&0xff,(hi>>>8)&0xff,(hi>>>16)&0xff,(hi>>>24)&0xff);
      var S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
      var T = [];
      for (var n = 0; n < 64; n++) T[n] = (Math.floor(Math.abs(Math.sin(n + 1)) * 4294967296)) | 0;
      var a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
      var w = new Array(16);
      for (var off = 0; off < m.length; off += 64) {
        for (var i = 0; i < 16; i++) w[i] = m[off+i*4]|(m[off+i*4+1]<<8)|(m[off+i*4+2]<<16)|(m[off+i*4+3]<<24);
        var A=a0,B=b0,C=c0,D=d0;
        for (i = 0; i < 64; i++) {
          var F, g;
          if (i < 16) { F = (B&C)|(~B&D); g = i; }
          else if (i < 32) { F = (D&B)|(~D&C); g = (5*i+1)%16; }
          else if (i < 48) { F = B^C^D; g = (3*i+5)%16; }
          else { F = C^(B|~D); g = (7*i)%16; }
          F = add(add(add(F, A), T[i]), w[g]);
          A=D;D=C;C=B;B=add(B, rl(F, S[i]));
        }
        a0=add(a0,A);b0=add(b0,B);c0=add(c0,C);d0=add(d0,D);
      }
      var out = [];
      [a0,b0,c0,d0].forEach(function (x) { out.push(x&0xff,(x>>>8)&0xff,(x>>>16)&0xff,(x>>>24)&0xff); });
      return out;
    }

    function hmac(hashBytes, blockSize, keyStr, msgStr) {
      var key = utf8Bytes(keyStr);
      if (key.length > blockSize) key = hashBytes(key);
      while (key.length < blockSize) key.push(0);
      var ipad = [], opad = [];
      for (var i = 0; i < blockSize; i++) { ipad.push(key[i]^0x36); opad.push(key[i]^0x5c); }
      var inner = hashBytes(ipad.concat(utf8Bytes(msgStr)));
      return hashBytes(opad.concat(inner));
    }

    return {
      md5: function (s) { return bytesToHex(md5Bytes(utf8Bytes(s))); },
      sha1: function (s) { return bytesToHex(sha1Bytes(utf8Bytes(s))); },
      sha256: function (s) { return bytesToHex(sha256Bytes(utf8Bytes(s))); },
      hmacSha1: function (key, msg) { return bytesToHex(hmac(sha1Bytes, 64, key, msg)); },
      hmacSha256: function (key, msg) { return bytesToHex(hmac(sha256Bytes, 64, key, msg)); },
      base64Encode: function (s) { var b = utf8Bytes(s), str = ''; for (var i = 0; i < b.length; i++) str += String.fromCharCode(b[i]); return btoa(str); },
      base64Decode: function (s) { var bin = atob(s), arr = []; for (var i = 0; i < bin.length; i++) arr.push(bin.charCodeAt(i)); try { return new TextDecoder().decode(new Uint8Array(arr)); } catch (_) { return bin; } }
    };
  })();

  // === Build optimized matching indexes from rules ===
  function buildIndexes() {
    _exactMap = {}; _containsList = []; _regexList = []; _domainMap = {};

    if (GROUPS.length === 0) GROUPS = [{ id: 'default', name: '默认分组', enabled: true, color: '#1677ff' }];
    var enabledGroups = {};
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].enabled) enabledGroups[GROUPS[i].id] = true;
    }

    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (!r.enabled || !r.match || !enabledGroups[r.groupId]) continue;
      var m = r.match;

      switch (m.matchType) {
        case 'exact':
          var key = m.url || '';
          if (!_exactMap[key]) _exactMap[key] = [];
          _exactMap[key].push(r);
          break;
        case 'contains':
          _containsList.push({ needle: m.url || '', rule: r });
          break;
        case 'regex':
          var re = safeRe(m.url || '', '');
          if (re) _regexList.push({ re: re, rule: r });
          break;
        case 'domain':
          var d = m.url || '';
          if (!_domainMap[d]) _domainMap[d] = [];
          _domainMap[d].push(r);
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
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      var parts = [];
      try { body.forEach(function (value, key) {
        if (typeof File !== 'undefined' && value instanceof File) {
          parts.push(key + '=[File: ' + (value.name || 'unnamed') + ', ' + (value.type || 'application/octet-stream') + ', ' + value.size + ' bytes]');
        } else parts.push(key + '=' + String(value));
      }); } catch (_) {}
      return parts.join('\n');
    }
    // Blob, ReadableStream — cannot safely stringify, skip body modification
    return undefined;
  }

  function applyReq(url, hdrs, body, actions) {
    var u = url, b = body, h = {}; for (var k in hdrs) h[k] = hdrs[k];
    var cancelled = false; var delayMs = 0; var bodyChanged = false; var hadInject = false;

    // 签名类脚本必须在 body/header 改写之后运行，才能对最终请求体重算签名。
    // 稳定排序把 injectScript 挪到最后，避免规则里动作顺序摆错导致重签失效。
    var ordered = actions.slice().sort(function (x, y) {
      return (x.type === 'injectScript' ? 1 : 0) - (y.type === 'injectScript' ? 1 : 0);
    });

    for (var i = 0; i < ordered.length; i++) {
      var a = ordered[i];
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
            hadInject = true;
            var _bBefore = b;
            // ctx.crypto 暴露同步签名工具；改写后请求头/请求体/URL 均可回写。
            var _ctx = { url: u, headers: h, body: b, crypto: API_CRYPTO };
            new Function('ctx', a.value)(_ctx);
            u = _ctx.url; b = _ctx.body;
            // 脚本可能整体替换了 headers 对象（而非原地改），显式回写
            if (_ctx.headers && _ctx.headers !== h) { h = {}; for (var _hk in _ctx.headers) h[_hk] = _ctx.headers[_hk]; }
            // 脚本改了 body → 与 modifyRequestBody 一样需清除 content-length，交由浏览器重算
            if (b !== _bBefore) bodyChanged = true;
          } catch (err) {
            // 白盒化：将注入脚本报错暴露给测试人员，而非静默吞掉
            var errMsg = 'injectScript 执行错误: ' + (err && err.message ? err.message : String(err));
            console.warn('[ApiMockFlow]', errMsg, '\n脚本内容:', a.value.slice(0, 200));
            postLog({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: Date.now(), url: u, method: 'INJECT_ERROR', ruleIds: [], ruleNames: [], originalRequest: { headers: h, body: trunc(b, 200) }, modifiedRequest: { url: u, headers: h, body: trunc(b, 200) }, originalResponse: undefined, modifiedResponse: { status: 0, statusText: errMsg, headers: {}, body: '' }, cancelled: false, delayed: false, delayMs: 0 });
          }
          break;
      }
    }
    if (bodyChanged) { deleteHeaderCI(h, 'content-length'); }
    // 诊断：请求体被改写、带签名头、且未用 injectScript 补偿 → 服务端签名校验大概率失败（401→跳登录）
    var warnings = [];
    if (bodyChanged && !hadInject) {
      var signHit = detectSignHeaders(h);
      if (signHit.length > 0) {
        warnings.push('请求体已被改写，但检测到签名/鉴权头 [' + signHit.join(', ') +
          ']，其值仍基于原始请求体，服务端校验可能失败（常表现为 401 后跳转登录）。' +
          '如需生效，请加一条 injectScript 动作，用改写后的 ctx.body 重算签名头（可用 ctx.crypto.md5/sha256/hmacSha256 等）。');
      }
    }
    return { url: u, headers: h, body: b, cancelled: cancelled, delayMs: delayMs, warnings: warnings };
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
          if (a.operate === 'replace') { var re3 = safeRe(a.key, 'g'); if (re3) { b = b.replace(re3, a.value); bodyChanged = true; } }
          else if (a.operate === 'set') { b = a.value; bodyChanged = true; }
          break;
        case 'modifyStatusCode':
          // 只接受 200-599：Response 构造器不允许 <200 的状态码（1xx 也无法作为 fetch 最终响应）
          if (a.operate === 'set') { var c = parseInt(a.value); if (!isNaN(c) && c >= 200 && c <= 599) { s = c; st = (c >= 200 && c < 300) ? 'OK' : ''; } }
          break;
      }
    }
    if (bodyChanged) {
      deleteHeaderCI(h, 'content-length');
      deleteHeaderCI(h, 'content-encoding');
      var ctKey = Object.keys(h).find(function (k) { return k.toLowerCase() === 'content-type'; });
      var ct = ctKey ? h[ctKey] : undefined;
      if (ct && ct.indexOf('charset') === -1) h[ctKey] = ct + '; charset=utf-8';
    }
    return { status: s, statusText: st, headers: h, body: b };
  }

  // === Fetch 响应改写（流感知）===
  // 文本响应缓冲后应用改写（保留日志/diff）；SSE 与二进制不缓冲，直接透传原始字节流，
  // 避免阻塞 SSE、破坏二进制。opaque/跨域响应无法读写，原样返回。
  function buildResp(body, rmod, orig) {
    try { return new Response(body, { status: rmod.status, statusText: rmod.statusText, headers: rmod.headers }); }
    catch (e) { return orig; } // 例如 1xx 等状态码无法构造 Response，退回原始响应
  }

  function respFullLog(ctx, origResp, modResp) {
    return {
      id: logId(), timestamp: Date.now(), url: ctx.origUrl, method: ctx.method,
      ruleIds: ctx.ruleIds, ruleNames: ctx.ruleNames,
      originalRequest: ctx.origReq, modifiedRequest: ctx.modReq,
      originalResponse: origResp || undefined, modifiedResponse: modResp || undefined,
      cancelled: false, delayed: ctx.delayMs > 0, delayMs: ctx.delayMs,
      kind: ctx.ruleIds.length ? 'rule-applied' : 'observed', resourceType: ctx.resourceType,
      warnings: (ctx.warnings && ctx.warnings.length) ? ctx.warnings : undefined
    };
  }

  // 文本类响应（含未声明 content-type）→ 缓冲，以支持正则替换并在日志里展示 body/diff。
  // SSE 与二进制不算文本：SSE 缓冲会阻塞到流结束，二进制按 UTF-8 解码会损坏。
  function isTextResponse(ct) {
    if (!ct) return true; // 无 content-type：多数是文本/JSON，按文本处理以保留日志
    if (ct.indexOf('text/event-stream') >= 0) return false; // SSE 单独透传
    return /^text\//.test(ct) ||
      /^application\/(json|xml|javascript|ecmascript|graphql|x-www-form-urlencoded|manifest\+json|ld\+json|csp-report)\b/.test(ct) ||
      /^application\/[a-z0-9.+-]*\+(json|xml)\b/.test(ct) ||
      ct.indexOf('charset=') >= 0;
  }

  async function handleFetchResp(resp, respA, ctx) {
    // opaque / error / 无状态响应：既读不到 body 也改不了 header，原样返回
    if (resp.type === 'opaque' || resp.type === 'opaqueredirect' || resp.type === 'error' || resp.status === 0) {
      postLog(respFullLog(ctx, undefined, respA.length ? { status: 0, statusText: '跨域/opaque 响应，无法读取或修改', headers: {}, body: '' } : undefined));
      return resp;
    }

    var ct = '';
    try { ct = (resp.headers.get('content-type') || '').toLowerCase(); } catch (_) {}
    var isEventStream = ct.indexOf('text/event-stream') >= 0;
    var srcHdr = hdrRec(resp.headers); // 原始响应头快照，多处复用
    var bodyActs = respA.filter(function (a) { return a.type === 'modifyResponseBody'; });
    var hasReplace = bodyActs.some(function (a) { return a.operate === 'replace'; });
    var hasSet = bodyActs.some(function (a) { return a.operate === 'set'; });

    // 观察日志只读取 Response 的副本。此前它落入下面的改写路径，即使没有
    // 响应规则也会为重建 Response 删除 content-length/content-encoding，造成假差异。
    if (respA.length === 0) {
      if (!isTextResponse(ct)) {
        postLog(respFullLog(ctx, { status: resp.status, statusText: resp.statusText, headers: srcHdr, body: isEventStream ? '(SSE，未读取)' : '(二进制，未读取)' }, undefined));
        return resp;
      }
      try {
        var observedBody = await resp.clone().text();
        postLog(respFullLog(ctx, { status: resp.status, statusText: resp.statusText, headers: srcHdr, body: trunc(observedBody, LOG_BODY_LIMIT) }, undefined));
      } catch (_) {
        postLog(respFullLog(ctx, { status: resp.status, statusText: resp.statusText, headers: srcHdr, body: '' }, undefined));
      }
      return resp;
    }

    // ---- 文本响应：缓冲后应用全部动作（replace / set / 改头改状态），保留完整日志与 diff ----
    if (isTextResponse(ct)) {
      try {
        var rb = await resp.text();
        var rmod = applyResp(resp.status, resp.statusText, srcHdr, rb, respA);
        // 回填的是已解码文本 → 原 content-encoding/length 不再成立，删除以免消费方按原编码/长度误判
        deleteHeaderCI(rmod.headers, 'content-encoding');
        deleteHeaderCI(rmod.headers, 'content-length');
        postLog(respFullLog(ctx,
          { status: resp.status, statusText: resp.statusText, headers: srcHdr, body: trunc(rb, LOG_BODY_LIMIT) },
          { status: rmod.status, statusText: rmod.statusText, headers: rmod.headers, body: trunc(rmod.body, LOG_BODY_LIMIT) }));
        var finalBody = rmod.body;
        if (finalBody && finalBody.length > LOG_BODY_LIMIT) { finalBody = finalBody.slice(0, LOG_BODY_LIMIT); rmod.headers['content-type'] = 'text/plain; charset=utf-8'; }
        return buildResp(isNullBodyStatus(rmod.status) ? null : finalBody, rmod, resp);
      } catch (readErr) {
        console.warn('[ApiMockFlow] 响应体读取失败，无法应用响应修改:', readErr && readErr.message);
        postLog(respFullLog(ctx, undefined, { status: 0, statusText: '响应体读取失败(可能流已消费)，修改未生效', headers: {}, body: '' }));
        return resp;
      }
    }

    // ---- 非文本：SSE / 二进制，一律不缓冲 ----
    // 丢弃 replace 型 body 动作（对未缓冲的流无意义），保留 set 与 header/status 动作
    var actsForApply = respA.filter(function (a) { return a.type !== 'modifyResponseBody' || a.operate === 'set'; });
    var kind = isEventStream ? 'SSE' : '二进制';

    // 过滤后无任何可对流生效的动作（即规则只有被跳过的 replace）→ 原样返回，
    // 不做无谓重建，保留原始 Response 的 type/url/content-length。
    if (actsForApply.length === 0) {
      if (hasReplace) console.warn('[ApiMockFlow] ' + kind + '响应无法做正则替换，已跳过响应体改写');
      postLog(respFullLog(ctx,
        { status: resp.status, statusText: resp.statusText, headers: srcHdr, body: '(' + kind + '，未改写)' },
        { status: 0, statusText: kind + '响应不支持正则替换，未改写', headers: {}, body: '' }));
      return resp;
    }

    var rmod2 = applyResp(resp.status, resp.statusText, srcHdr, '', actsForApply);

    if (hasSet) {
      // set 用给定值整体替换 body（用户明确要替换），无需读取原始响应体
      var fb = rmod2.body;
      if (fb && fb.length > LOG_BODY_LIMIT) { fb = fb.slice(0, LOG_BODY_LIMIT); rmod2.headers['content-type'] = 'text/plain; charset=utf-8'; }
      postLog(respFullLog(ctx,
        { status: resp.status, statusText: resp.statusText, headers: srcHdr, body: '(' + kind + '，未缓冲)' },
        { status: rmod2.status, statusText: rmod2.statusText, headers: rmod2.headers, body: trunc(rmod2.body, LOG_BODY_LIMIT) }));
      return buildResp(isNullBodyStatus(rmod2.status) ? null : fb, rmod2, resp);
    }

    // 只有 header/status 修改 → 透传原始 body 流（对 SSE/二进制的 replace 已在上面被过滤跳过）
    if (hasReplace) {
      console.warn('[ApiMockFlow] ' + kind + '响应无法做正则替换，已跳过响应体改写，仅应用头/状态并透传');
    }
    // 透传的是 fetch 已解码的 body 流，原 content-encoding/length 不再匹配，删掉以免消费方误判
    deleteHeaderCI(rmod2.headers, 'content-encoding');
    deleteHeaderCI(rmod2.headers, 'content-length');
    postLog(respFullLog(ctx,
      { status: resp.status, statusText: resp.statusText, headers: srcHdr, body: '(' + kind + '流式透传)' },
      { status: rmod2.status, statusText: rmod2.statusText, headers: rmod2.headers, body: '(流式透传)' }));
    var passBody = (isNullBodyStatus(rmod2.status) || resp.body == null) ? null : resp.body;
    return buildResp(passBody, rmod2, resp);
  }

  // === Intercepted fetch ===
  async function interceptedFetch(input, init) {
    _reqCount++;
    var url = absoluteUrl(typeof input === 'string' ? input : (input instanceof URL ? input.href : (input && input.url) || ''));
    var method = (init && init.method) || (input && input.method) || 'GET';
    var rules = getMatchingRules(url, method, 'fetch');
    var observing = GLOBAL_ENABLED && OBSERVE_ENABLED && OBSERVE_TYPES.fetch;
    if (rules.length === 0 && !observing) return NATIVE_FETCH(input, init);

    var allA = []; for (var i = 0; i < rules.length; i++) allA = allA.concat(rules[i].actions);
    var reqA = allA.filter(function (a) { return REQ.indexOf(a.type) >= 0; });
    var respA = allA.filter(function (a) { return RESP.indexOf(a.type) >= 0; });

    // input 可能是 Request 对象：其自带的 headers/body 必须取出——否则重建 init 时
    // ni.headers 会把 Request 头冲掉，且请求体改写/日志拿不到内容。
    var reqObj = (input && typeof input === 'object' && !(input instanceof URL) && typeof input.url === 'string') ? input : null;
    var origH = init && init.headers
      ? hdrRec(init.headers instanceof Headers ? init.headers : new Headers(init.headers))
      : (reqObj ? hdrRec(reqObj.headers) : {});
    var actualBody = init && init.body;
    var isFormDataBody = typeof FormData !== 'undefined' && actualBody instanceof FormData;
    var isMultipartBody = isFormDataBody || !!(reqObj && /multipart\/form-data/i.test(reqObj.headers.get('content-type') || ''));
    var origB = extractBody(actualBody);
    if (isFormDataBody) {
      try { origB = await new Request(url, { method: method, headers: origH, body: actualBody }).text(); } catch (_) {}
    }
    if (origB === undefined && reqObj && method !== 'GET' && method !== 'HEAD' &&
        (observing || reqA.some(function (a) { return a.type === 'modifyRequestBody'; }))) {
      // Request 对象的 FormData 不在 init.body 中；观察模式下也读取其副本用于日志，
      // 实际发送仍使用原 Request，避免消费请求流或破坏 multipart boundary。
      try {
        var reqClone = reqObj.clone();
        // 保留浏览器实际序列化后的 multipart 文本（包含 boundary），
        // 这样日志打开 API Tester 时 Header 与 Body 能保持一致。
        origB = await reqClone.text();
        if (!origB && (reqClone.headers.get('content-type') || '').toLowerCase().indexOf('multipart/form-data') >= 0 && reqClone.formData) {
          origB = extractBody(await reqClone.formData());
        }
      } catch (_) {}
    }

    var origUrl = url;
    var effectiveReqA = isMultipartBody ? reqA.filter(function (a) { return a.type !== 'modifyRequestBody'; }) : reqA;
    var origReq = { headers: origH, body: trunc(origB, LOG_BODY_LIMIT), bodyType: isMultipartBody ? 'multipart' : undefined };
    var rm = applyReq(url, origH, origB, effectiveReqA);
    if (isMultipartBody && effectiveReqA.length !== reqA.length) rm.warnings.push('Multipart/FormData 请求暂不支持“修改请求体”规则；该动作已跳过，请改用 API Tester 手动重放。');
    var modReq = { url: rm.url, headers: rm.headers, body: trunc(rm.body, LOG_BODY_LIMIT), bodyType: isMultipartBody ? 'multipart' : undefined };
    var ctx = {
      origUrl: origUrl, method: method,
      ruleIds: rules.map(function (r) { return r.id; }),
      ruleNames: rules.map(function (r) { return r.name; }),
      origReq: origReq, modReq: modReq, delayMs: rm.delayMs, warnings: rm.warnings,
      resourceType: 'fetch'
    };
    if (rm.warnings && rm.warnings.length) {
      for (var _wi = 0; _wi < rm.warnings.length; _wi++) console.warn('[ApiMockFlow] ' + rm.warnings[_wi]);
    }

    if (rm.cancelled) {
      postLog({
        id: logId(), timestamp: Date.now(), url: origUrl, method: method,
        ruleIds: ctx.ruleIds, ruleNames: ctx.ruleNames,
        originalRequest: origReq, modifiedRequest: modReq,
        originalResponse: undefined, modifiedResponse: undefined,
        cancelled: true, delayed: false, delayMs: 0
      });
      return new Response(null, { status: 403, statusText: 'Blocked' });
    }

    if (rm.delayMs > 0) {
      await new Promise(function (r) { setTimeout(r, rm.delayMs); });
    }

    // 请求阶段无任何修改（仅响应规则）→ 原样透传，避免重建 init 冲掉 Request 自带的 headers/body
    var fetchInput = input, fetchInit = init;
    if (effectiveReqA.length > 0) {
      var ni = init ? Object.assign({}, init) : {};
      if (rm.url !== url) fetchInput = rm.url;
      ni.headers = rm.headers;
      if (rm.body !== undefined && !isFormDataBody) ni.body = rm.body;
      fetchInit = ni;
    }

    try {
      var resp = await NATIVE_FETCH(fetchInput, fetchInit);
      if (respA.length > 0 || observing) return await handleFetchResp(resp, respA, ctx);
      postLog(respFullLog(ctx, undefined, undefined));
      return resp;
    } catch (fetchErr) {
      // 改写后网络错误 → 用原始 input/init 重试，避免死循环
      try { return NATIVE_FETCH(input, init); } catch (_) { throw fetchErr; }
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
      var ou = absoluteUrl(self._xu), om = self._xm, orh = {}; for (var k in self._xrh) orh[k] = self._xrh[k]; var ob = self._xb;
      var rules = getMatchingRules(ou, om, 'xmlhttprequest');
      var observing = GLOBAL_ENABLED && OBSERVE_ENABLED && OBSERVE_TYPES.xmlhttprequest;
      if (rules.length === 0 && !observing) { return _XHR_send.call(self, body); }

      var allA = []; for (var i = 0; i < rules.length; i++) allA = allA.concat(rules[i].actions);
      var reqA = allA.filter(function (a) { return REQ.indexOf(a.type) >= 0; });
      var respA = allA.filter(function (a) { return RESP.indexOf(a.type) >= 0; });
      var isFormDataBody = typeof FormData !== 'undefined' && body instanceof FormData;
      var effectiveReqA = isFormDataBody ? reqA.filter(function (a) { return a.type !== 'modifyRequestBody'; }) : reqA;
      var xhrOrigReq = { headers: orh, body: trunc(ob, LOG_BODY_LIMIT), bodyType: isFormDataBody ? 'multipart' : undefined };
      var rm = applyReq(ou, orh, ob, effectiveReqA);
      if (isFormDataBody && effectiveReqA.length !== reqA.length) rm.warnings.push('Multipart/FormData 请求暂不支持“修改请求体”规则；该动作已跳过，请改用 API Tester 手动重放。');
      var xhrModReq = { url: rm.url, headers: rm.headers, body: trunc(rm.body, LOG_BODY_LIMIT), bodyType: isFormDataBody ? 'multipart' : undefined };
      var xhrRuleIds = rules.map(function(r){return r.id;});
      var xhrRuleNames = rules.map(function(r){return r.name;});

      function xhrLog(origResp, modResp, cancelled) {
        postLog({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: Date.now(), url: ou, method: om, ruleIds: xhrRuleIds, ruleNames: xhrRuleNames, originalRequest: xhrOrigReq, modifiedRequest: xhrModReq, originalResponse: origResp || undefined, modifiedResponse: modResp || undefined, cancelled: !!cancelled, delayed: rm.delayMs > 0, delayMs: rm.delayMs, kind: xhrRuleIds.length ? (cancelled ? 'rule-cancelled' : 'rule-applied') : 'observed', resourceType: 'xmlhttprequest', warnings: (rm.warnings && rm.warnings.length) ? rm.warnings : undefined });
      }
      if (rm.warnings && rm.warnings.length) {
        for (var _xwi = 0; _xwi < rm.warnings.length; _xwi++) console.warn('[ApiMockFlow] ' + rm.warnings[_xwi]);
      }

      function doXHRSend() {
        if (rm.cancelled) {
          try{Object.defineProperty(self,'status',{value:403,writable:true,configurable:true});Object.defineProperty(self,'statusText',{value:'Blocked',writable:true,configurable:true});Object.defineProperty(self,'responseText',{value:'',writable:true,configurable:true});Object.defineProperty(self,'response',{value:'',writable:true,configurable:true});Object.defineProperty(self,'readyState',{value:4,writable:true,configurable:true});}catch(_){}
          xhrLog(null, null, true);
          setTimeout(function(){self.dispatchEvent(new Event('load'));},0);
          return;
        }
        // 关键修复：self 上已带业务代码设好的原始请求头。XHR 的 setRequestHeader 对同名头是
        // 「追加合并」而非覆盖（Authorization: x → "x, x"），因此绝不能在 self 上重设已有头，
        // 否则会破坏 Authorization/Token 等导致 401。无头变化时只改 body、不动头。
        var hdrChanged = hdrsChanged(orh, rm.headers);

        if (rm.url !== ou || hdrChanged) {
          // 需要改 URL，或增/删/改请求头 → 用全新代理 XHR，请求头只干净地设一次
          // 代理 XHR 必须用原生方法收发，否则它命中的是被 patch 过的原型 → send 会重新进入拦截器，
          // 同一请求被再匹配、再在发送前记一条(不带响应)日志（表现为「一次调用两条：一条带响应一条不带」）。
          var px = new NATIVE_XHR();
          try { _XHR_open.call(px, om, rm.url, true); } catch (openErr) {
            // 打开失败（如非法 URL）→ 通知调用方网络错误
            self.dispatchEvent(new Event('error'));
            xhrLog(null, null, false);
            return;
          }
          // 继承原 XHR 的凭证/超时/响应类型——否则代理请求会丢 Cookie(withCredentials) 造成鉴权失败
          try { px.withCredentials = self.withCredentials; } catch (_) {}
          try { if (self.timeout) px.timeout = self.timeout; } catch (_) {}
          try { if (self.responseType) px.responseType = self.responseType; } catch (_) {}
          var hk2 = Object.keys(rm.headers);
          for (var i3 = 0; i3 < hk2.length; i3++) { try { _XHR_setRH.call(px, hk2[i3], rm.headers[hk2[i3]]); } catch (_) {} }

          // Timeout handler —— 置 _xrm 抢占，避免超时后 onreadystatechange(4) 再派发一个 status=0 的假 load
          px.ontimeout = function() {
            if (self._xrm) return;
            self._xrm = true;
            try { Object.defineProperty(self,'readyState',{value:4,writable:true,configurable:true}); } catch(_) {}
            self.dispatchEvent(new Event('timeout'));
            self.dispatchEvent(new Event('loadend')); // 现代 axios 只在 onloadend 结算，缺它请求永久挂起
            xhrLog(null, null, false);
          };

          px.onerror = function() {
            if (self._xrm) return;
            self._xrm = true;
            try { Object.defineProperty(self,'status',{value:px.status || 0,writable:true,configurable:true}); } catch(_) {}
            self.dispatchEvent(new Event('error'));
            // 网络错误按规范只应有 error + loadend，不派发 load（否则监听 load 的库会把网络错误误当成 status=0 的响应）
            self.dispatchEvent(new Event('loadend'));
            xhrLog(null, null, false);
          };

          px.onreadystatechange = function () {
            if (px.readyState === 4 && !self._xrm) {
              self._xrm = true;
              var rb = readXHRText(px);
              var rh = parseHdr(px.getAllResponseHeaders());
              var xhrOrigResp = { status: px.status, statusText: px.statusText, headers: rh, body: trunc(rb, LOG_BODY_LIMIT) };
              if (respA.length > 0) {
                var rmod = applyResp(px.status, px.statusText, rh, rb, respA);
                // self 从未真正发送，二进制类型用代理 px 的原生 response 兜底
                applyModRespToXHR(self, rmod, true, px.response);
                xhrLog(xhrOrigResp, { status: rmod.status, statusText: rmod.statusText, headers: rmod.headers, body: trunc(rmod.body, LOG_BODY_LIMIT) });
              } else {
                // 仅改了请求（未改响应）：必须把代理 px 收到的真实响应回填到 self，
                // 否则页面 load 时读 self.responseText/response 是空的 → 请求成功但页面拿不到数据。
                try {
                  var _hdrStr = px.getAllResponseHeaders();
                  Object.defineProperty(self, 'status', { value: px.status, writable: true, configurable: true });
                  Object.defineProperty(self, 'statusText', { value: px.statusText, writable: true, configurable: true });
                  // response 按 responseType 原样透传（json/blob/arraybuffer 保持对象形态）；responseText 仅文本类型可读
                  Object.defineProperty(self, 'response', { value: px.response, writable: true, configurable: true });
                  if (!self.responseType || self.responseType === 'text') {
                    Object.defineProperty(self, 'responseText', { value: px.responseText, writable: true, configurable: true });
                  }
                  self.getResponseHeader = function (n) { return px.getResponseHeader(n); };
                  self.getAllResponseHeaders = function () { return _hdrStr; };
                } catch (_) {}
                xhrLog(xhrOrigResp, null);
              }
              try{Object.defineProperty(self,'readyState',{value:4,writable:true,configurable:true});}catch(_){}
              self.dispatchEvent(new Event('readystatechange'));
              self.dispatchEvent(new Event('load'));
              self.dispatchEvent(new Event('loadend')); // 现代 axios 只在 onloadend 结算，缺它请求永久挂起
              // 注意：HTTP 4xx/5xx 是"成功完成的传输"，原生 XHR 只通过 load 事件 + status 暴露，
              // 不派发 error。此前多派发的 error 会让 axios/jQuery 把正常响应误判为网络错误。
            }
          };
          try { _XHR_send.call(px, rm.body !== undefined && !isFormDataBody ? rm.body : body); } catch (sendErr) {
            // 发送失败 → 通知调用方网络错误
            self.dispatchEvent(new Event('error'));
            xhrLog(null, null, false);
          }
          return;
        }

        // 无 URL 变化、无请求头增删改（至多改了 body）→ 保留 self 上业务代码设好的原始头不动，
        // 只把（可能改写过的）body 发出去；在原生 XHR 上拦截响应
        if (respA.length > 0 || observing) {
          self.addEventListener('readystatechange', function h() {
            if (self.readyState === 4 && !self._xrm) {
              self._xrm = true;
              self.removeEventListener('readystatechange', h);
              try {
                var rb = readXHRText(self);
                var rh = parseHdr(oGAH.call(self));
                var os = self.status, ot = self.statusText;
                var xhrOrigResp2 = { status: os, statusText: ot, headers: rh, body: trunc(rb, LOG_BODY_LIMIT) };
                if (respA.length > 0) {
                  var rmod = applyResp(os, ot, rh, rb, respA);
                  // self 已原生发送：二进制类型不传兜底 → 保留原生 response，不被文本覆盖损坏
                  applyModRespToXHR(self, rmod, false);
                  xhrLog(xhrOrigResp2, { status: rmod.status, statusText: rmod.statusText, headers: rmod.headers, body: trunc(rmod.body, LOG_BODY_LIMIT) });
                } else {
                  xhrLog(xhrOrigResp2, null);
                }
              } catch (readErr) {
                console.warn('[ApiMockFlow] XHR 响应体读取失败:', readErr && readErr.message);
              }
            }
          });
        }
        // 观察模式只在请求完成后记录一次；规则请求「无响应动作」时才保留发送前日志——
        // 有响应动作(respA.length>0)时上面已挂 readystatechange 完成日志，再记发送前日志就成双条。
        if (!observing && respA.length === 0) xhrLog(null, null);
        return _XHR_send.call(self, rm.body !== undefined && !isFormDataBody ? rm.body : body);
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
      OBSERVE_ENABLED = e.data.observeEnabled === true;
      OBSERVE_TYPES = {};
      (e.data.observeResourceTypes || ['fetch', 'xmlhttprequest']).forEach(function (t) { OBSERVE_TYPES[t] = true; });
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
