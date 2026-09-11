/**
 * 单一匹配/改写引擎 —— P0-1 收敛。
 *
 * 线上 interceptor 运行时层（src/interceptor/index.js）与测试都消费本模块，从此不再有第二份实现。
 * 纯逻辑：无 DOM / chrome / postMessage 副作用。两类副作用由调用方经 opts 注入：
 *   - injectScript 的 ctx.crypto（同步签名工具，浏览器侧由运行时传入 API_CRYPTO）
 *   - injectScript 抛错时的上报（onInjectError；测试/默认省略即静默吞）
 *
 * 行为以 src/__tests__/fixtures/interceptor.golden.js（今日发布版的冻结基准）为准，
 * 由 engine-drift.test.ts 在同一批断言用例上逐条守卫，杜绝历史上出现过的漂移
 * （大小写删头 / redirect URL 校验 / 域名单段 TLD / 保护响应头 / injectScript 排序）。
 */
import type { Rule, Action, RuleGroup } from '../shared/types';

// === 模块级匹配状态（每页仅一个引擎实例，与线上 1:1；测试每例经 syncRules 重新播种）===
let RULES: Rule[] = [];
let GROUPS: Array<{ id: string; enabled: boolean }> = [];
let ACTIVE = false;
let GLOBAL_ENABLED = true;

// 优化匹配索引（sync 时构建）：exact/domain 走哈希 O(1)，contains/regex 走预编译列表 O(K)。
let _exactMap: Record<string, Rule[]> = {};      // { url: [rule, ...] }
let _containsList: Array<{ needle: string; rule: Rule }> = [];
let _regexList: Array<{ re: RegExp; rule: Rule }> = []; // 预编译
let _domainMap: Record<string, Rule[]> = {};     // { domain: [rule, ...] }

export function safeRe(p: string, f?: string): RegExp | null { try { return new RegExp(p, f); } catch (_) { return null; } }

// 大小写不敏感删除头（头键可能是 Content-Length / Content-Encoding 等大写形态）。
export function deleteHeaderCI(headers: Record<string, string>, name: string): void {
  for (var k in headers) { if (k.toLowerCase() === name) delete headers[k]; }
}

// 响应改写不可删除的安全关键头。
const PROTECTED_RESP_HEADERS: Record<string, boolean> = {
  'content-security-policy': true,
  'strict-transport-security': true,
  'x-content-type-options': true,
  'x-frame-options': true,
  'set-cookie': true,
};

// === 签名头检测 ===
// 请求体被改写、但请求头带对 body 计算的签名/摘要时，服务端校验会失败（多表现为 401→跳登录）。
// 不按名匹配 authorization——Bearer/JWT/Basic 是与 body 无关的静态凭证，
// 只有值形如「对请求体/参数做签名」的方案（如 AWS SigV4）才按值判定，避免在每个登录态请求上误报。
const SIGN_HDR_RE = /(^|[-_])(signature|sign|sig|hmac|digest|checksum)($|[-_])|^content-md5$|^(x-ca-|x-tt-|x-bogus|x-gorgon|x-sap-)/i;
const AUTH_SIGN_VAL_RE = /^\s*AWS4-HMAC|^\s*HMAC[- ]|\bSignature=|\bSignedHeaders=|\balgorithm\s*=/i;
export function detectSignHeaders(h: Record<string, string>): string[] {
  var hit: string[] = [];
  for (var k in h) {
    if (k.toLowerCase() === 'authorization') {
      if (AUTH_SIGN_VAL_RE.test(String(h[k] || ''))) hit.push(k);
    } else if (SIGN_HDR_RE.test(k)) {
      hit.push(k);
    }
  }
  return hit;
}

// === 构建优化匹配索引（每次 sync 时重建）===
function buildIndexes(): void {
  _exactMap = {}; _containsList = []; _regexList = []; _domainMap = {};

  if (GROUPS.length === 0) {
    const DEFAULT_GROUP: RuleGroup = { id: 'default', name: '默认分组', enabled: true, color: '#1677ff' };
    GROUPS = [DEFAULT_GROUP];
  }
  var enabledGroups: Record<string, boolean> = {};
  for (var i = 0; i < GROUPS.length; i++) {
    if (GROUPS[i].enabled) enabledGroups[GROUPS[i].id] = true;
  }

  for (var j = 0; j < RULES.length; j++) {
    var r = RULES[j];
    if (!r.enabled || !r.match || !enabledGroups[r.groupId]) continue;
    var m = r.match;

    switch (m.matchType) {
      case 'exact': {
        var key = m.url || '';
        if (!_exactMap[key]) _exactMap[key] = [];
        _exactMap[key].push(r);
        break;
      }
      case 'contains':
        _containsList.push({ needle: m.url || '', rule: r });
        break;
      case 'regex': {
        var re = safeRe(m.url || '', '');
        if (re) _regexList.push({ re: re, rule: r });
        break;
      }
      case 'domain': {
        var d = m.url || '';
        if (!_domainMap[d]) _domainMap[d] = [];
        _domainMap[d].push(r);
        break;
      }
    }
  }
}

// === 快速匹配 —— exact/domain O(1)，contains/regex O(K) ===
// 注意：入参 url 需已是绝对 URL。运行时两个调用方（interceptedFetch / XHR send）均先经 absoluteUrl(...)，
// 故此处不再做 leading-slash 补全（原 interceptor.js 该行对运行时冗余，收敛时删除，行为不变）。
export function getMatchingRules(url: string, method: string, rtype: string): Rule[] {
  if (!ACTIVE || !GLOBAL_ENABLED) return [];

  var result: Rule[] = [];
  var seen: Record<string, boolean> = {}; // 按 rule id 去重

  function addRule(r: Rule) {
    if (!seen[r.id]) {
      if (!r.match.resourceType || r.match.resourceType === rtype) {
        seen[r.id] = true;
        result.push(r);
      }
    }
  }

  // 1. 精确匹配 —— O(1)
  var exact = _exactMap[url];
  if (exact) {
    for (var i = 0; i < exact.length; i++) {
      var r = exact[i];
      if (!r.match.method || r.match.method === method) addRule(r);
    }
  }

  // 2. 域名匹配 —— O(1) + 父域后缀
  try {
    var hostname = new URL(url).hostname;
    var domainRules = _domainMap[hostname];
    if (domainRules) {
      for (var i2 = 0; i2 < domainRules.length; i2++) {
        var dr = domainRules[i2];
        if (!dr.match.method || dr.match.method === method) addRule(dr);
      }
    }
    // 父域（p 从 1 到 len-2）：单段 TLD（如 'com'）不参与，避免误命中所有 .com 子域
    var parts = hostname.split('.');
    for (var p = 1; p < parts.length - 1; p++) {
      var parentDomain = parts.slice(p).join('.');
      var parentRules = _domainMap[parentDomain];
      if (parentRules) {
        for (var i3 = 0; i3 < parentRules.length; i3++) {
          var pr = parentRules[i3];
          if (!pr.match.method || pr.match.method === method) addRule(pr);
        }
      }
    }
  } catch (_) {}

  // 3. 包含匹配 —— O(K)
  for (var i4 = 0; i4 < _containsList.length; i4++) {
    var c = _containsList[i4];
    if (url.indexOf(c.needle) >= 0) {
      if (!c.rule.match.method || c.rule.match.method === method) addRule(c.rule);
    }
  }

  // 4. 正则匹配 —— O(K)，预编译，不每次重编
  for (var i5 = 0; i5 < _regexList.length; i5++) {
    var entry = _regexList[i5];
    if (entry.re.test(url)) {
      if (!entry.rule.match.method || entry.rule.match.method === method) addRule(entry.rule);
    }
  }

  return result;
}

// === 请求改写 ===
export interface ReqResult {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  cancelled: boolean;
  delayMs: number;
  warnings: string[];
}

// injectScript 的副作用注入点（浏览器运行时提供；测试/默认省略）。
export interface ReqOpts {
  /** 同步签名工具，暴露为 ctx.crypto（运行时传入 API_CRYPTO；类型不约束以免把实现拖进本模块）。 */
  crypto?: unknown;
  /** injectScript 抛错时的上报回调；省略则静默吞（与旧测试镜像一致）。 */
  onInjectError?: (
    err: unknown,
    info: { url: string; headers: Record<string, string>; body: string | undefined; script: string }
  ) => void;
}

export function applyReq(
  url: string,
  hdrs: Record<string, string>,
  body: string | undefined,
  actions: Action[],
  opts?: ReqOpts
): ReqResult {
  var u = url; var b = body; var h: Record<string, string> = {}; for (var k in hdrs) h[k] = hdrs[k];
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
          // 验证重定向 URL 格式，避免 fetch 抛出不透明的 TypeError；非法则保留原 URL 并告警
          try { new URL(a.value); u = a.value; } catch (urlErr) {
            console.warn('[ApiMockFlow] redirect URL 格式无效，已跳过:', a.value, (urlErr as Error).message);
          }
        }
        break;
      case 'cancel': cancelled = true; break;
      case 'delay': delayMs = Math.max(delayMs, Math.min(parseInt(a.value) || 0, 30000)); break;
      case 'injectScript':
        try {
          hadInject = true;
          var _bBefore = b;
          // ctx.crypto 由调用方经 opts 注入（浏览器：API_CRYPTO；测试/默认：省略）。
          var _ctx: any = { url: u, headers: h, body: b };
          if (opts && opts.crypto) _ctx.crypto = opts.crypto;
          new Function('ctx', a.value)(_ctx);
          u = _ctx.url; b = _ctx.body;
          // 脚本可能整体替换了 headers 对象（而非原地改），显式回写
          if (_ctx.headers && _ctx.headers !== h) { h = {}; for (var _hk in _ctx.headers) h[_hk] = _ctx.headers[_hk]; }
          // 脚本改了 body → 与 modifyRequestBody 一样需清除 content-length，交由浏览器重算
          if (b !== _bBefore) bodyChanged = true;
        } catch (err) {
          // 副作用（console.warn + 上报日志）交给调用方；省略 onInjectError 时静默吞，不影响其它动作与返回值
          if (opts && opts.onInjectError) opts.onInjectError(err, { url: u, headers: h, body: b, script: a.value });
        }
        break;
    }
  }
  if (bodyChanged) { deleteHeaderCI(h, 'content-length'); }
  // 诊断：请求体被改写、带签名头、且未用 injectScript 补偿 → 服务端签名校验大概率失败（401→跳登录）
  var warnings: string[] = [];
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

// === 响应改写 ===
export interface RespResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export function applyResp(
  status: number,
  statusText: string,
  hdrs: Record<string, string>,
  body: string,
  actions: Action[]
): RespResult {
  var s = status; var st = statusText; var b = body; var h: Record<string, string> = {}; for (var k in hdrs) h[k] = hdrs[k];
  var bodyChanged = false;

  for (var i = 0; i < actions.length; i++) {
    var a = actions[i];
    switch (a.type) {
      case 'modifyResponseHeader':
        // 保护安全关键头不被删除/替换
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
    if (ct && ct.indexOf('charset') === -1) h[ctKey as string] = ct + '; charset=utf-8';
  }
  return { status: s, statusText: st, headers: h, body: b };
}

// === 状态 setter（与线上 1:1；运行时经 APII_SYNC / setActive 调用，测试经 syncRules 播种）===
export function syncRules(rules: Rule[], groups: Array<{ id: string; enabled: boolean }>): void {
  RULES = rules || [];
  GROUPS = groups || [];
  buildIndexes();
}
export function setActive(on: boolean): void { ACTIVE = on; }
export function setGlobalEnabled(on: boolean): void { GLOBAL_ENABLED = on; }
