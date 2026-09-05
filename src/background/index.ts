// ===== ApiMockFlow Background Service Worker =====
console.log('[ApiMockFlow] Background worker started');

function setIcon(enabled: boolean) {
  const path = enabled ? {
    16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png'
  } : {
    16: 'icons/icon16_gray.png', 48: 'icons/icon48_gray.png', 128: 'icons/icon128_gray.png'
  };
  chrome.action.setIcon({ path });
}

// Init icon on startup
storageGet('globalEnabled', true).then(setIcon);

// Inject interceptor into all existing tabs (for "use without refresh")
function injectAllTabs() {
  chrome.tabs.query({}, (tabs) => {
    const eligible = tabs.filter(t => t.id && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
    // Batch inject: 10 tabs at a time, 100ms apart
    const BATCH = 10;
    for (let i = 0; i < eligible.length; i += BATCH) {
      setTimeout(() => {
        eligible.slice(i, i + BATCH).forEach(tab => {
          chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] }).catch(() => {});
        });
      }, Math.floor(i / BATCH) * 100);
    }
  });
}

// Auto-inject on install/update
chrome.runtime.onInstalled.addListener(() => {
  injectAllTabs();
});

interface Rule {
  id: string; name: string; groupId: string; enabled: boolean;
  match: { url: string; matchType: string; method: string; resourceType: string };
  actions: Array<{ type: string; operate: string; key: string; value: string }>;
}

interface RuleGroup { id: string; name: string; enabled: boolean; color: string; }

// ===== Storage helpers =====
function storageGet<T>(key: string, def: T): Promise<T> {
  return new Promise((r) => chrome.storage.local.get(key, (res) => r(res[key] !== undefined ? res[key] : def)));
}
function storageSet(key: string, val: any): Promise<void> {
  return new Promise((r) => chrome.storage.local.set({ [key]: val }, r));
}
function storageSetMany(values: Record<string, unknown>): Promise<void> {
  return new Promise((r) => chrome.storage.local.set(values, r));
}

// ===== Auth header capture (方案1: 抓真实请求头) =====
// 监听页面实际发出的请求，按语义模式提取认证类请求头（不针对单一键名），
// 按 origin 缓存。用于 API Tester「同步登录态」时复用有效的 Authorization / token。
// 敏感信息只存内存 + chrome.storage.session（内存级，不落磁盘，浏览器关闭即清）。

const AUTH_NAME_RE = /token|auth|session|credential|api[-_]?key/i;
const authCache = new Map<string, Record<string, string>>(); // origin -> { headerName: value }
const AUTH_SESSION_KEY = 'authHeadersByOrigin';
const MAX_AUTH_ORIGINS = 30; // LRU 上限，控制内存/session 体积与隐私足迹

// origin -> { headerName: cookieName }：抓包时若某认证头的值恰好等于某个 cookie 的值，
// 记录这条「镜像」关系。用于同步登录态时用实时 cookie 值校正过期认证头
// （如 shiro：Authorization 头与 shiroCookie 必须是同一 token，重新登录后 token 轮换需保持一致）。
const authCookieLink = new Map<string, Record<string, string>>();
const AUTH_LINK_SESSION_KEY = 'authCookieLinkByOrigin';

function isAuthHeader(name: string): boolean {
  const n = name.toLowerCase();
  if (n === 'cookie') return false; // cookie 单独处理
  return n === 'authorization' || AUTH_NAME_RE.test(n);
}

function persistAuthCache() {
  // 恢复完成前不落盘：SW 重建初期 authCache 可能只含刚抓到的少量 origin，
  // 此时若全量覆盖 session 会丢失之前已保存的其它 origin（竞态）。
  if (!authCacheRestored) return;
  try {
    chrome.storage.session.set({
      [AUTH_SESSION_KEY]: Object.fromEntries(authCache),
      [AUTH_LINK_SESSION_KEY]: Object.fromEntries(authCookieLink),
    });
  } catch (_) { /* storage.session may be unavailable */ }
}

// SW 启动时从 session 恢复缓存（service worker 被回收后重建）
let authCacheRestored = false;
try {
  chrome.storage.session.get([AUTH_SESSION_KEY, AUTH_LINK_SESSION_KEY], (res) => {
    const saved = res?.[AUTH_SESSION_KEY];
    if (saved && typeof saved === 'object') {
      // 不覆盖恢复前已抓到的更新（更新的值更可信）
      for (const [origin, headers] of Object.entries(saved)) {
        if (!authCache.has(origin)) authCache.set(origin, headers as Record<string, string>);
      }
    }
    const savedLinks = res?.[AUTH_LINK_SESSION_KEY];
    if (savedLinks && typeof savedLinks === 'object') {
      for (const [origin, links] of Object.entries(savedLinks)) {
        if (!authCookieLink.has(origin)) authCookieLink.set(origin, links as Record<string, string>);
      }
    }
    authCacheRestored = true;
  });
} catch (_) { authCacheRestored = true; /* session 不可用则直接放行落盘 */ }

// 抓取域名白名单：留空 = 抓取所有站点；非空 = 只监听这些域名（及子域），减少后台唤醒。
const WHITELIST_KEY = 'authCaptureWhitelist';

function normalizeDomain(input: string): string | null {
  let s = (input || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^\*+\.?/, ''); // 去掉前导 * 或 *.
  try {
    s = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : 'http://' + s).hostname;
  } catch {
    s = s.replace(/[/:?#].*$/, ''); // 兜底：去掉端口/路径/查询
  }
  s = s.replace(/^\[|\]$/g, ''); // 去 IPv6 括号
  return s || null;
}

// IP、localhost、单标签主机不追加 "*." 子域 pattern（否则 match pattern 非法或无意义）
function isIpOrSingleLabel(host: string): boolean {
  return /^[\d.]+$/.test(host) || host === 'localhost' || host.includes(':') || !host.includes('.');
}

function domainToPatterns(domain: string): string[] {
  const pats = [`*://${domain}/*`];
  if (!isIpOrSingleLabel(domain)) pats.push(`*://*.${domain}/*`);
  return pats;
}

function buildFilterUrls(whitelist: string[]): string[] {
  const norm = (whitelist || []).map(normalizeDomain).filter((d): d is string => !!d);
  const uniq = [...new Set(norm)];
  if (uniq.length === 0) return ['<all_urls>']; // 空 / 全部无效 → 抓取所有，保证功能不失效
  const urls = new Set<string>();
  for (const d of uniq) for (const p of domainToPatterns(d)) urls.add(p);
  return [...urls];
}

const authHeaderListener = (details: chrome.webRequest.OnBeforeSendHeadersDetails): chrome.webRequest.BlockingResponse | undefined => {
  const headers = details.requestHeaders;
  if (!headers) return;
  if (!/^https?:\/\//i.test(details.url)) return; // 只处理 http(s)
  let origin: string;
  try { origin = new URL(details.url).origin; } catch { return; }

  const found: Record<string, string> = {};
  let cookieHeader = '';
  for (const h of headers) {
    if (!h.value) continue;
    if (h.name.toLowerCase() === 'cookie') { cookieHeader = h.value; continue; }
    if (isAuthHeader(h.name)) found[h.name] = h.value;
  }
  if (Object.keys(found).length === 0) return;

  // 检测「认证头 ↔ cookie」镜像：某认证头的值恰好等于某个 cookie 的值时，记下该 cookie 名。
  // 同步登录态时据此用实时 cookie 值校正过期 token（如 shiro：Authorization === shiroCookie）。
  const foundLinks: Record<string, string> = {};
  if (cookieHeader) {
    const cookiePairs: Record<string, string> = {};
    for (const seg of cookieHeader.split(';')) {
      const i = seg.indexOf('=');
      if (i > 0) cookiePairs[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
    }
    for (const [hn, hv] of Object.entries(found)) {
      for (const [cn, cv] of Object.entries(cookiePairs)) {
        if (cv && cv === hv) { foundLinks[hn] = cn; break; }
      }
    }
  }

  const prev = authCache.get(origin) || {};
  const merged = { ...prev, ...found };
  const prevLinks = authCookieLink.get(origin) || {};
  const mergedLinks = { ...prevLinks, ...foundLinks };
  // 仅在发生变化时写 session，避免每个请求都写入
  if (JSON.stringify(prev) !== JSON.stringify(merged)
    || JSON.stringify(prevLinks) !== JSON.stringify(mergedLinks)) {
    authCache.delete(origin);          // 重新插入到末尾（LRU：最近使用）
    authCache.set(origin, merged);
    if (Object.keys(mergedLinks).length > 0) authCookieLink.set(origin, mergedLinks);
    while (authCache.size > MAX_AUTH_ORIGINS) {
      const oldest = authCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      authCache.delete(oldest);
      authCookieLink.delete(oldest);
    }
    persistAuthCache();
  }
  return;
};

// 按白名单重建 webRequest 监听（白名单变化时收窄/放开 filter）
function registerAuthListener(whitelist: string[]) {
  if (!chrome.webRequest?.onBeforeSendHeaders) return;
  try { chrome.webRequest.onBeforeSendHeaders.removeListener(authHeaderListener); } catch (_) { /* not yet added */ }
  const urls = buildFilterUrls(whitelist);
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(authHeaderListener, { urls, types: ['xmlhttprequest'] }, ['requestHeaders', 'extraHeaders']);
  } catch (_) {
    // 某个 pattern 非法时回退到全量，保证功能不失效
    try {
      chrome.webRequest.onBeforeSendHeaders.addListener(authHeaderListener, { urls: ['<all_urls>'], types: ['xmlhttprequest'] }, ['requestHeaders', 'extraHeaders']);
    } catch (_2) { /* ignore */ }
  }
}

// 启动时按当前白名单注册，并在白名单变化时重建
storageGet<string[]>(WHITELIST_KEY, []).then(registerAuthListener);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[WHITELIST_KEY]) {
    registerAuthListener(changes[WHITELIST_KEY].newValue || []);
  }
});

// 读取某 URL 对应 origin 的认证头缓存（优先内存，miss 时查 session）
function getAuthHeaders(url: string): Promise<Record<string, string>> {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return Promise.resolve({}); }
  if (authCache.has(origin)) return Promise.resolve(authCache.get(origin)!);
  return new Promise((r) => {
    try {
      chrome.storage.session.get(AUTH_SESSION_KEY, (res) => {
        const all = res?.[AUTH_SESSION_KEY] || {};
        r(all[origin] || {});
      });
    } catch { r({}); }
  });
}

// 读取某 origin 的「认证头 ↔ cookie」镜像关系（优先内存，miss 时查 session）
function getAuthLinks(url: string): Promise<Record<string, string>> {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return Promise.resolve({}); }
  if (authCookieLink.has(origin)) return Promise.resolve(authCookieLink.get(origin)!);
  return new Promise((r) => {
    try {
      chrome.storage.session.get(AUTH_LINK_SESSION_KEY, (res) => {
        const all = res?.[AUTH_LINK_SESSION_KEY] || {};
        r(all[origin] || {});
      });
    } catch { r({}); }
  });
}

// 用实时 cookie 校正抓取到的认证头：若某认证头的值在抓包时镜像自某 cookie，
// 而该 cookie 当前值已变化（重新登录后 token 轮换），则改用最新 cookie 值，
// 避免认证头与 Cookie 不一致（如 Authorization != shiroCookie）导致同步后仍 401。
function reconcileAuthWithCookies(
  auth: Record<string, string>,
  links: Record<string, string>,
  liveCookies: chrome.cookies.Cookie[],
): Record<string, string> {
  if (!links || Object.keys(links).length === 0) return auth;
  const live = new Map(liveCookies.map((c) => [c.name, c.value]));
  const out: Record<string, string> = { ...auth };
  for (const [headerName, cookieName] of Object.entries(links)) {
    const liveVal = live.get(cookieName);
    if (liveVal && out[headerName] !== undefined && out[headerName] !== liveVal) {
      out[headerName] = liveVal;
    }
  }
  return out;
}

// 常见「二级公共后缀」关键词：当倒数第二段是这些、且顶级域是 2 字母国家码时，
// 注册域应取三段（如 example.com.cn / example.co.uk / example.com.br / example.co.in）。
// 用启发式取代硬编码后缀表，覆盖 br/in/mx 等未列出的国家，避免把注册域误判成
// com.br 之类的公共后缀，从而在父域兜底时对整个 *.com.br 过度抓取 Cookie（跨站泄露）。
const SLD_KEYWORDS = new Set([
  'com', 'net', 'org', 'gov', 'edu', 'co', 'ac', 'or', 'ne', 'go', 'ltd', 'me', 'biz', 'info',
]);

// 推断可注册域（父域）。IP / localhost / 已是两段域 → 返回 null（无需兜底）
function getBaseDomain(hostname: string): string | null {
  if (!hostname || hostname.includes(':') || /^[\d.]+$/.test(hostname) || hostname === 'localhost') return null;
  const parts = hostname.split('.');
  if (parts.length <= 2) return null;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  // TLD 是 2 字母国家码且二级段是公共后缀关键词 → 注册域取三段
  if (tld.length === 2 && SLD_KEYWORDS.has(sld.toLowerCase())) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

// 获取该 URL 可用的 Cookie：精确匹配 + 父域兜底（解决登录域与接口子域不一致）
async function getCookiesForUrl(url: string): Promise<chrome.cookies.Cookie[]> {
  const primary = (await new Promise<chrome.cookies.Cookie[]>((r) => chrome.cookies.getAll({ url }, (c) => r(c || [])))) || [];
  let host = '';
  try { host = new URL(url).hostname; } catch { return primary; }
  const base = getBaseDomain(host);
  if (!base) return primary;
  const byDomain = (await new Promise<chrome.cookies.Cookie[]>((r) => chrome.cookies.getAll({ domain: base }, (c) => r(c || [])))) || [];
  // 按 name 合并，精确匹配（primary）覆盖父域兜底
  const map = new Map<string, chrome.cookies.Cookie>();
  for (const c of byDomain) map.set(c.name, c);
  for (const c of primary) map.set(c.name, c);
  return [...map.values()];
}

// ===== SSRF 主机判定 =====
// 把十进制/十六进制/八进制等各种 IPv4 写法归一后再判定内网，堵住
// http://2130706433/ (=127.0.0.1)、http://0x7f000001/、http://0177.0.0.1/ 之类的编码绕过。
function ipv4ToInt(host: string): number | null {
  const toNum = (p: string): number | null => {
    if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
    if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
    if (/^\d+$/.test(p)) return parseInt(p, 10);
    return null;
  };
  const parts = host.split('.');
  if (parts.length === 4) {
    let n = 0;
    for (const p of parts) { const v = toNum(p); if (v === null || v < 0 || v > 255) return null; n = n * 256 + v; }
    return n >>> 0;
  }
  if (parts.length === 1) { const v = toNum(parts[0]); if (v === null || v < 0 || v > 0xffffffff) return null; return v >>> 0; }
  return null; // 2/3 段的奇异写法不常见，交给下游解析
}

function isPrivateIpv4Int(n: number): boolean {
  const a = (n >>> 24) & 255, b = (n >>> 16) & 255;
  if (a === 127) return true;                        // 127.0.0.0/8 loopback
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 0) return true;                           // 0.0.0.0/8（含裸 0）
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16（含 169.254.169.254 元数据）
  return false;
}

// 是否为应拦截的内网/环回主机（已归一各种编码）。allowInternalNetwork 开启时不调用。
function isBlockedHost(rawHost: string): boolean {
  const host = (rawHost || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true; // 空主机拦掉
  // 名称型环回：localhost / *.localhost / 末尾带点
  if (host === 'localhost' || host === 'localhost.' || host.endsWith('.localhost')) return true;
  // IPv6 环回 / 未指定 / 链路本地(fe80::/10) / 唯一本地(fc00::/7)
  if (host === '::1' || host === '::' || /^fe80:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host)) return true;
  // IPv4-mapped IPv6，如 ::ffff:127.0.0.1
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) { const n = ipv4ToInt(mapped[1]); if (n !== null && isPrivateIpv4Int(n)) return true; }
  // 各种进制写法的 IPv4（点分/单整数/十六进制/八进制）
  const asInt = ipv4ToInt(host);
  if (asInt !== null && isPrivateIpv4Int(asInt)) return true;
  return false;
}

// ===== Rule matching =====
function matchRule(rule: Rule, url: string, method: string, rtype: string): boolean {
  if (!rule.enabled) return false;
  if (rule.match.method && rule.match.method !== method) return false;
  if (rule.match.resourceType && rule.match.resourceType !== rtype) return false;
  const ru = rule.match.url;
  switch (rule.match.matchType) {
    case 'exact': return url === ru;
    case 'contains': return url.includes(ru);
    case 'regex': try { return new RegExp(ru).test(url); } catch { return false; }
    case 'domain': try { const u = new URL(url); return u.hostname === ru || u.hostname.endsWith('.' + ru); } catch { return false; }
    default: return false;
  }
}

async function getMatching(url: string, method: string, rtype: string): Promise<Rule[]> {
  const ge = await storageGet<boolean>('globalEnabled', true);
  if (!ge) return [];
  const [rules, rawGroups] = await Promise.all([
    storageGet<Rule[]>('rules', []),
    storageGet<RuleGroup[]>('groups', [])
  ]);
  const groups = rawGroups.length === 0
    ? [{ id: 'default', name: '默认分组', enabled: true, color: '#1677ff' }]
    : rawGroups;
  const eg = new Set(groups.filter(g => g.enabled).map(g => g.id));
  return rules.filter(r => eg.has(r.groupId) && matchRule(r, url, method, rtype));
}

// ===== Detached panel window =====
// 把整个 popup UI 弹成独立窗口，切换浏览器标签页不会关闭它。
// 单例：已存在则聚焦，窗口 id 存 session（跨 SW 重启存活，浏览器关闭即清）。
const PANEL_WINDOW_KEY = 'panelWindowId';
const PANEL_W = 680;
const PANEL_H = 740;

async function openPanelWindow(): Promise<void> {
  const url = chrome.runtime.getURL('popup.html?window=1');
  const saved: number | undefined = await new Promise((res) =>
    chrome.storage.session.get(PANEL_WINDOW_KEY, (r) => res(r?.[PANEL_WINDOW_KEY]))
  );
  if (typeof saved === 'number') {
    try {
      await chrome.windows.get(saved);
      await chrome.windows.update(saved, { focused: true });
      return;
    } catch (_) { /* 窗口已关闭，继续新建 */ }
  }
  const created = await chrome.windows.create({ url, type: 'popup', width: PANEL_W, height: PANEL_H });
  if (created?.id != null) chrome.storage.session.set({ [PANEL_WINDOW_KEY]: created.id });
}

chrome.windows.onRemoved.addListener((closedId) => {
  chrome.storage.session.get(PANEL_WINDOW_KEY, (r) => {
    if (r?.[PANEL_WINDOW_KEY] === closedId) chrome.storage.session.remove(PANEL_WINDOW_KEY);
  });
});

// ===== Message handler =====
let logWriteQueue: Promise<unknown> = Promise.resolve();
let historyWriteQueue: Promise<unknown> = Promise.resolve();
let observeWriteQueue: Promise<unknown> = Promise.resolve();
const MAX_INTERCEPT_LOG_BYTES = 100 * 1024 * 1024;

const WEB_REQUEST_TYPE_MAP: Record<string, string> = {
  main_frame: 'document', sub_frame: 'document', script: 'script', stylesheet: 'stylesheet',
  image: 'image', font: 'font', media: 'media', other: 'other', ping: 'other',
  websocket: 'other', webbundle: 'other', csp_report: 'other',
};

// Fetch/XHR are logged by the page interceptor with body details. Other resource types
// can only be observed from webRequest, so keep their logs lightweight and non-duplicated.
chrome.webRequest.onCompleted.addListener((details) => {
  const resourceType = WEB_REQUEST_TYPE_MAP[details.type];
  if (!resourceType || !/^https?:\/\//i.test(details.url)) return;
  Promise.all([
    storageGet<boolean>('globalEnabled', true),
    storageGet<boolean>('observeEnabled', false),
    storageGet<string[]>('observeResourceTypes', ['fetch', 'xmlhttprequest']),
  ]).then(([globalEnabled, observeEnabled, observeTypes]) => {
    if (!globalEnabled || !observeEnabled || !observeTypes.includes(resourceType)) return;
    const responseHeaders: Record<string, string> = {};
    for (const header of details.responseHeaders || []) {
      if (header.name) responseHeaders[header.name] = header.value || '';
    }
    const log = {
      id: `wr-${details.requestId}-${Date.now()}`,
      timestamp: Date.now(), url: details.url, method: details.method,
      ruleIds: [], ruleNames: [],
      originalRequest: { headers: {}, body: undefined },
      modifiedRequest: { url: details.url, headers: {}, body: undefined },
      originalResponse: { status: details.statusCode, statusText: details.statusLine || '', headers: responseHeaders, body: '' },
      modifiedResponse: undefined,
      cancelled: false, delayed: false, delayMs: 0,
      kind: 'observed', resourceType,
    };
    logWriteQueue = logWriteQueue.then(async () => {
      const logs = await storageGet<any[]>('interceptLog', []);
      logs.unshift(log);
      if (logs.length > 200) logs.length = 200;
      let bytes = 0;
      for (const item of logs) bytes += JSON.stringify(item).length * 2;
      while (logs.length && bytes > MAX_INTERCEPT_LOG_BYTES) bytes -= JSON.stringify(logs.pop()).length * 2;
      await storageSet('interceptLog', logs);
    });
  }).catch(() => {});
// Do not restrict `types` here. Some Chrome versions reject an entire listener
// registration when a newer webRequest type is unavailable, which silently left
// only the page-level Fetch/XHR observer working.
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: any) => {
  const t = msg.type;

  if (t === 'OPEN_PANEL') {
    openPanelWindow()
      .then(() => sendResponse({ success: true }))
      .catch((err: any) => sendResponse({ success: false, error: err?.message || 'unknown' }));
    return true;
  }

  if (t === 'GET_MATCHING_RULES') {
    const { url = '', method = '', resourceType = '' } = msg.payload || {};
    getMatching(url, method, resourceType).then(rules => {
      sendResponse({ rules });
    });
    return true;
  }

  if (t === 'GET_STATE') {
    Promise.all([
      storageGet('globalEnabled', true), storageGet('rules', []),
      storageGet<RuleGroup[]>('groups', []), storageGet('observeEnabled', false),
      storageGet<string[]>('observeResourceTypes', ['fetch', 'xmlhttprequest'])
    ]).then(([ge, r, g, observeEnabled, observeResourceTypes]) => {
      if (g.length === 0) {
        g = [{ id: 'default', name: '默认分组', enabled: true, color: '#1677ff' }];
      }
      sendResponse({ globalEnabled: ge, rules: r, groups: g, observeEnabled, observeResourceTypes });
    });
    return true;
  }

  if (t === 'SET_OBSERVE') {
    const p = msg.payload || {};
    const enabled = p.enabled === true;
    const allowedTypes = ['fetch', 'xmlhttprequest', 'document', 'script', 'stylesheet', 'image', 'font', 'media', 'other'];
    const resourceTypes = Array.isArray(p.resourceTypes)
      ? p.resourceTypes.filter((x: unknown): x is string => typeof x === 'string' && allowedTypes.includes(x))
      : ['fetch', 'xmlhttprequest'];
    // Serial + atomic write: rapid checkbox clicks must not let an earlier async
    // write overwrite the latest selection, nor briefly sync half the state.
    observeWriteQueue = observeWriteQueue.then(() => storageSetMany({
      observeEnabled: enabled,
      observeResourceTypes: resourceTypes,
    }));
    observeWriteQueue
      .then(() => sendResponse({ success: true, observeEnabled: enabled, observeResourceTypes: resourceTypes }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (t === 'GET_RULES') { storageGet('rules', []).then(sendResponse); return true; }
  if (t === 'SAVE_RULES') { storageSet('rules', msg.payload).then(() => sendResponse({ success: true })); return true; }
  if (t === 'UPSERT_RULE') {
    if (!msg.payload?.id) { sendResponse({ success: false, error: 'Invalid rule: missing id' }); return true; }
    storageGet<Rule[]>('rules', []).then(rules => {
      const idx = rules.findIndex(r => r.id === msg.payload.id);
      if (idx >= 0) rules[idx] = msg.payload;
      else rules.push(msg.payload);
      return storageSet('rules', rules);
    }).then(() => sendResponse({ success: true }))
      .catch((err: any) => sendResponse({ success: false, error: err?.message || 'unknown' }));
    return true;
  }
  if (t === 'SAVE_GROUPS') {
    var gs: RuleGroup[] = msg.payload;
    if (!Array.isArray(gs) || gs.length === 0) {
      gs = [{ id: 'default', name: '默认分组', enabled: true, color: '#1677ff' }];
    }
    storageSet('groups', gs).then(() => sendResponse({ success: true }));
    return true;
  }
  if (t === 'DELETE_RULE') {
    const deleteId = msg.payload?.id;
    if (!deleteId) { sendResponse({ success: false, error: 'Missing rule id' }); return true; }
    storageGet<Rule[]>('rules', []).then(rules => {
      storageSet('rules', rules.filter(r => r.id !== deleteId)).then(() => sendResponse({ success: true }));
    });
    return true;
  }

  if (t === 'TOGGLE_GLOBAL') {
    storageSet('globalEnabled', msg.payload).then(() => {
      setIcon(msg.payload);
      if (msg.payload) injectAllTabs();
      sendResponse({ success: true });
    });
    return true;
  }

  if (t === 'TOGGLE_RULE') {
    const { ruleId, enabled } = msg.payload || {};
    if (!ruleId) { sendResponse({ success: false, error: 'Missing ruleId' }); return true; }
    storageGet<Rule[]>('rules', []).then(rules => {
      const r = rules.find(x => x.id === ruleId);
      if (r) { r.enabled = enabled; storageSet('rules', rules).then(() => sendResponse({ success: true })); }
      else sendResponse({ success: false });
    });
    return true;
  }

  if (t === 'TOGGLE_GROUP') {
    const { groupId, enabled } = msg.payload || {};
    storageGet<RuleGroup[]>('groups', []).then(groups => {
      const g = groups.find(x => x.id === groupId);
      if (g) { g.enabled = enabled; storageSet('groups', groups).then(() => sendResponse({ success: true })); }
      else sendResponse({ success: false });
    });
    return true;
  }

  if (t === 'EXPORT_RULES') {
    Promise.all([storageGet('rules', []), storageGet('groups', [])])
      .then(([r, g]) => sendResponse(JSON.stringify({ rules: r, groups: g }, null, 2)));
    return true;
  }

  if (t === 'IMPORT_RULES') {
    try {
      const d = JSON.parse(msg.payload);
      if (!d.rules && !d.groups) {
        sendResponse({ success: false, error: '文件中没有找到规则或分组数据' });
        return true;
      }
      const ps: Promise<void>[] = [];
      if (d.rules && Array.isArray(d.rules)) {
        // Validate and sanitize rules
        const validRules = d.rules.filter((r: any) => r && r.id && r.name && r.match && Array.isArray(r.actions));
        // Strip injectScript actions from imported rules for security
        for (const rule of validRules) {
          rule.actions = rule.actions.filter((a: any) => a && a.type && a.type !== 'injectScript');
        }
        ps.push(storageSet('rules', validRules));
      }
      if (d.groups && Array.isArray(d.groups) && d.groups.length > 0) {
        const validGroups = d.groups.filter((g: any) => g && g.id && g.name);
        ps.push(storageSet('groups', validGroups));
      }
      Promise.all(ps).then(() => sendResponse({ success: true }));
    } catch { sendResponse({ success: false, error: 'Invalid JSON' }); }
    return true;
  }

  // ---- API Tester: proxy request (bypasses CORS) ----
  if (t === 'API_TEST_REQUEST') {
    const { method = 'GET', url = '', headers = {}, body, bodyType = 'raw', refreshCookie = false } = (msg.payload || {}) as { method: string; url: string; headers: Record<string, string>; body?: string; bodyType?: string; refreshCookie?: boolean };
    if (!url || !/^https?:\/\//i.test(url)) {
      sendResponse({ error: '仅支持 http:// 和 https:// 协议' });
      return false;
    }
    // SSRF protection: block private/internal IPs (unless user allows it)
    function checkSSRF(): Promise<boolean> {
      return storageGet<boolean>('allowInternalNetwork', false).then(allowInternal => {
        if (allowInternal) return true; // user allowed, skip check
        try {
          const host = new URL(url).hostname;
          if (isBlockedHost(host)) {
            sendResponse({ error: '不允许访问内网地址（如需访问请点击盾牌图标放行内网）' });
            return false;
          }
        } catch (_) {}
        return true;
      });
    }
    const start = Date.now();

    async function doRequest() {
      const hdrs = new Headers(headers || {});

      // Attach / refresh browser cookies.
      // - refreshCookie=true: always override the Cookie header with current browser cookies
      //   (fixes stale hardcoded login state in saved requests).
      // - otherwise: only attach when the user hasn't set a Cookie header.
      let liveCookies: chrome.cookies.Cookie[] = [];
      if (refreshCookie || !hdrs.has('Cookie')) {
        try {
          liveCookies = await getCookiesForUrl(url);
          if (liveCookies.length > 0) {
            const cookieStr = liveCookies.map(c => `${c.name}=${c.value}`).join('; ');
            hdrs.set('Cookie', cookieStr);
          }
        } catch (_) { /* cookies permission may be missing */ }
      }

      // refreshCookie 语义为「同步登录态」：一并用捕获到的最新认证头覆盖同名头，
      // 解决 Authorization / token 过期导致的登录态丢失。
      // 若认证头镜像自某 cookie（如 shiro token），用实时 cookie 值校正，避免过期 token 与 Cookie 不一致导致 401。
      if (refreshCookie) {
        try {
          const auth = await getAuthHeaders(url);
          const links = await getAuthLinks(url);
          const reconciled = reconcileAuthWithCookies(auth, links, liveCookies);
          for (const [k, v] of Object.entries(reconciled)) if (v) hdrs.set(k, v);
        } catch (_) { /* ignore */ }
      }

      const init: RequestInit = { method, headers: hdrs };
      if (body && method !== 'GET' && method !== 'HEAD') {
        if (bodyType === 'urlencoded') {
          try { init.body = new URLSearchParams(body); }
          catch { init.body = body; }
        } else if (bodyType === 'form' || bodyType === 'multipart') {
          try {
            const form = new FormData();
            const parts = JSON.parse(body);
            if (Array.isArray(parts)) parts.forEach((p: any) => form.append(String(p.name || ''), String(p.value ?? '')));
            init.body = form;
            for (const key of [...hdrs.keys()]) if (key.toLowerCase() === 'content-type') hdrs.delete(key);
          } catch { init.body = body; }
        } else init.body = body;
      }

      // 30s timeout via AbortController
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 30000);
      init.signal = ac.signal;

      try {
        const resp = await fetch(url, init);
        clearTimeout(tm);
        const contentLength = resp.headers.get('content-length');
        const respBody = await resp.text();
        const respHdrs: Record<string, string> = {};
        resp.headers.forEach((v, k) => { respHdrs[k] = v; });
        sendResponse({
          status: resp.status, statusText: resp.statusText,
          headers: respHdrs, body: respBody.slice(0, 100000),
          duration: Date.now() - start,
          size: contentLength ? parseInt(contentLength, 10) : respBody.length,
        });
      } catch (err: unknown) {
        clearTimeout(tm);
        const errMsg = (err as Error).name === 'AbortError' ? '请求超时 (30s)' : (err as Error).message;
        sendResponse({ error: errMsg, duration: Date.now() - start });
      }
    }

    checkSSRF().then(ok => { if (ok) doRequest(); });
    return true;
  }

  // ---- API Tester: fetch current browser cookies for a URL ----
  if (t === 'GET_BROWSER_COOKIES') {
    const url = (msg.payload?.url || '') as string;
    if (!url || !/^https?:\/\//i.test(url)) {
      sendResponse({ error: '请先填写有效的 http(s) URL' });
      return true;
    }
    try {
      chrome.cookies.getAll({ url }, (cookies) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message || '读取 Cookie 失败' });
          return;
        }
        const list = cookies || [];
        const cookieStr = list.map(c => `${c.name}=${c.value}`).join('; ');
        sendResponse({ cookieStr, count: list.length });
      });
    } catch (err: unknown) {
      sendResponse({ error: '读取 Cookie 异常: ' + ((err as Error)?.message || String(err)) });
    }
    return true;
  }

  // ---- API Tester: fetch full login state (cookies + captured auth headers) ----
  if (t === 'GET_LOGIN_STATE') {
    const url = (msg.payload?.url || '') as string;
    if (!url || !/^https?:\/\//i.test(url)) {
      sendResponse({ error: '请先填写有效的 http(s) URL' });
      return true;
    }
    (async () => {
      let list: chrome.cookies.Cookie[] = [];
      try {
        list = await getCookiesForUrl(url);
      } catch (_) { /* cookies permission may be missing */ }
      const cookieStr = list.map(c => `${c.name}=${c.value}`).join('; ');
      const cookieCount = list.length;
      const auth = await getAuthHeaders(url);
      const links = await getAuthLinks(url);
      const authHeaders = reconcileAuthWithCookies(auth, links, list);
      sendResponse({ cookieStr, cookieCount, authHeaders });
    })();
    return true;
  }

  // ---- API Tester: history ----
  if (t === 'API_TEST_HISTORY_GET') { storageGet<any[]>('apiHistory', []).then(sendResponse); return true; }
  if (t === 'API_TEST_HISTORY_SAVE') {
    if (!msg.payload) { sendResponse({ success: false }); return true; }
    historyWriteQueue = historyWriteQueue.then(async () => {
      const history = await storageGet<any[]>('apiHistory', []);
      history.unshift(msg.payload);
      if (history.length > 50) history.length = 50;
      await storageSet('apiHistory', history);
    });
    historyWriteQueue.then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
    return true;
  }
  if (t === 'API_TEST_HISTORY_CLEAR') { storageSet('apiHistory', []).then(() => sendResponse({ success: true })); return true; }

  // ---- Saved Requests ----
  if (t === 'API_SAVED_GET') { storageGet<any[]>('savedRequests', []).then(sendResponse); return true; }

  // ---- Intercepted Request Log ----
  if (t === 'LOG_SAVE') {
    if (!msg.payload) { return false; }
    // Serialize read-modify-write operations so near-simultaneous request/response
    // logs cannot overwrite each other in chrome.storage.
    logWriteQueue = logWriteQueue.then(async () => {
      const log = await storageGet<any[]>('interceptLog', []);
      log.unshift(msg.payload);
      if (log.length > 200) log.length = 200;
      let bytes = 0;
      for (const item of log) bytes += JSON.stringify(item).length * 2;
      while (log.length && bytes > MAX_INTERCEPT_LOG_BYTES) bytes -= JSON.stringify(log.pop()).length * 2;
      await storageSet('interceptLog', log);
    });
    logWriteQueue.then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (t === 'LOG_GET') { storageGet<any[]>('interceptLog', []).then(sendResponse); return true; }
  if (t === 'LOG_COUNT') { storageGet<any[]>('interceptLog', []).then(log => sendResponse(log.length)); return true; }
  if (t === 'LOG_CLEAR') { storageSet('interceptLog', []).then(() => sendResponse({ success: true })); return true; }
  if (t === 'API_SAVED_SAVE') {
    storageGet<any[]>('savedRequests', []).then(list => {
      list.unshift(msg.payload);
      if (list.length > 100) list.length = 100;
      storageSet('savedRequests', list).then(() => sendResponse({ success: true }));
    });
    return true;
  }
  if (t === 'API_SAVED_DELETE') {
    storageGet<any[]>('savedRequests', []).then(list => {
      const filtered = list.filter((x: any) => x.id !== msg.payload.id);
      storageSet('savedRequests', filtered).then(() => sendResponse({ success: true }));
    });
    return true;
  }
});
