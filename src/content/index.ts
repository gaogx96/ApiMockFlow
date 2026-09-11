// Content script — state sync + log bridge
// 每次注入先拆除上一实例。分两种「上一实例」：
//  (A) 同一隔离世界里的旧实例（injectAllTabs / TOGGLE_GLOBAL 在同一扩展实例内重复注入）——由 teardown 直接拆；
//  (B) 扩展重载/更新后遗留在【另一个】隔离世界的孤儿实例——teardown 够不到它（不同 window），
//      改由启动时广播 APII_TAKEOVER，让孤儿自行噤声让位（见下方 onTakeover / 广播）。
// 关键背景：扩展重载后旧内容脚本所在的隔离世界并未销毁——其 window 全局、监听器、定时器、角标 DOM 都还在，
// 只是 chrome.* 上下文失效（详见孤儿角标说明）。孤儿里那个每 5s 跑一次的 orphanTimer 会调用 killBadge，
// 而 killBadge 旧实现会向主世界拦截器发 APII_SYNC{active:false, rules:[]} —— 于是「新实例已 syncAll 激活拦截器」
// 后，孤儿这记回马枪把拦截器关停、规则清空：mock 失效、fetch 解除劫持、日志随之断掉。这正是「重载后失效」的根因。
if (typeof (window as any).__apimockflow_teardown === 'function') {
  try { (window as any).__apimockflow_teardown(); } catch (_) { /* 旧实例已不可用，忽略 */ }
}
(window as any).__apimockflow_loaded = true;
{

// 本实例唯一标识：用于忽略自己广播的 APII_TAKEOVER，只对「更新的实例」让位。
var INSTANCE_ID = String(Date.now()) + ':' + String(Math.floor(Math.random() * 1e9));
// 被更新实例接管后置真：此后本实例彻底噤声，killBadge 不再向拦截器发 active:false（避免误关停新实例激活的拦截器）。
var superseded = false;

var badge = document.createElement('div');
badge.id = 'apimockflow-badge';
badge.style.cssText = 'position:fixed;top:0;right:0;z-index:99999;color:white;padding:3px 8px;font-size:10px;font-family:sans-serif;border-radius:0 0 0 6px;pointer-events:none;transition:background 0.3s;display:none;';
if (document.body) { document.body.appendChild(badge); }
else { document.addEventListener('DOMContentLoaded', function () { (document.body || document.documentElement).appendChild(badge); }); }

var badgeActive = false;
var lastRuleCount = 0;
var cachedShowBadge = false;
var hasStorageApi = !!(chrome.storage && chrome.storage.local);

// Cache showBadge value to avoid storage reads on every update
function onStorageBadge(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area === 'local' && changes.showBadge) {
    cachedShowBadge = changes.showBadge.newValue === true;
  }
}
if (hasStorageApi) {
  chrome.storage.local.get('showBadge', function (res) {
    cachedShowBadge = res?.showBadge === true;
  });
  chrome.storage.onChanged.addListener(onStorageBadge);
}

function updateBadge(active: boolean, count: number, reqCount?: number) {
  badgeActive = active && count > 0;
  if (count > 0) lastRuleCount = count;
  if (!cachedShowBadge) { badge.style.display = 'none'; return; }
  badge.style.display = 'block';
  if (badgeActive) {
    badge.style.background = '#1677ff';
    var rc = (typeof reqCount === 'number' && reqCount > 0) ? reqCount : null;
    badge.textContent = 'ApiMockFlow ON | ' + lastRuleCount + ' rules' + (rc ? ' | ' + rc + ' intercepted' : '');
  } else {
    badge.style.background = '#9ca3af';
    badge.textContent = 'ApiMockFlow OFF';
  }
}

// 扩展被停用/卸载/重载后，早先注入本页的这段内容脚本会成为「孤儿」：chrome.* 上下文失效、
// storage.onChanged 不再触发，但页面上已画出的角标 DOM 无人清理——于是没切回去看过的背景标签页
// 会一直显示旧的「ON | N rules」。extAlive() 是一次纯本地属性读取（不发消息、不读存储、不唤醒 SW，
// 故不会重新引入 C2 已移除的轮询开销），据此在标签页重新可见时（正是用户切回来的那一刻）清掉孤儿角标。
function extAlive(): boolean {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
}
function killBadge() {
  contextDead = true;
  try { if (badge && badge.parentNode) badge.parentNode.removeChild(badge); } catch (_) { }
  // 仅在「未被新实例接管」时才通知主世界拦截器停用——即扩展真正被停用/卸载、且无新实例接手的场景，
  // 关停拦截器符合预期。若是扩展重载：新实例会先广播 APII_TAKEOVER 令本孤儿 superseded=true，
  // 从而【不发】这条 active:false，避免把新实例刚激活的拦截器误关停（重载后失效的根因）。
  if (!superseded) {
    try { window.postMessage({ type: 'APII_SYNC', active: false, globalEnabled: false, rules: [], groups: [] }, '*'); } catch (_) { }
  }
}

// Listen for messages from interceptor
function onWinMessage(e: MessageEvent) {
  if (e.source !== window || !e.data) return;
  if (e.data.type === 'APII_RCOUNT') {
    updateBadge(badgeActive, lastRuleCount, e.data.count);
  }
  if (e.data.type === 'APII_LOG' && e.data.entry) {
    var entry = e.data.entry;
    // Validate entry shape to prevent injection from page scripts
    if (entry && typeof entry.url === 'string' && typeof entry.method === 'string' && typeof entry.timestamp === 'number') {
      try {
        chrome.runtime.sendMessage({ type: 'LOG_SAVE', payload: entry });
      } catch (_) {}
    }
  }
}
window.addEventListener('message', onWinMessage);

// 接管握手：新实例启动即广播 APII_TAKEOVER（见文件末尾）。本监听器让【更新的实例注入后】的旧实例噤声让位——
// 主要针对扩展重载后遗留在另一个隔离世界的孤儿（teardown 够不到它）：收到他人 TAKEOVER 即清掉自身定时器/监听器/
// 角标并置 superseded，从此不再向拦截器发 active:false，把控制权干净让给新实例。忽略自己的广播（按 INSTANCE_ID）。
function onTakeover(e: MessageEvent) {
  if (e.source !== window || !e.data || e.data.type !== 'APII_TAKEOVER') return;
  if (e.data.id === INSTANCE_ID) return; // 自己的广播，忽略
  superseded = true;
  contextDead = true; // 停止本实例后续 syncAll
  try { window.removeEventListener('message', onWinMessage); } catch (_) { }
  try { window.removeEventListener('message', onReady); } catch (_) { }
  try { window.removeEventListener('message', onTakeover); } catch (_) { }
  try { document.removeEventListener('visibilitychange', onVisibility); } catch (_) { }
  try { clearInterval(orphanTimer); } catch (_) { }
  try { if (hasStorageApi && chrome.storage && chrome.storage.onChanged) { chrome.storage.onChanged.removeListener(onStorageBadge); chrome.storage.onChanged.removeListener(onStorageSync); } } catch (_) { }
  try { if (badge && badge.parentNode) badge.parentNode.removeChild(badge); } catch (_) { }
}
window.addEventListener('message', onTakeover);

// Inject main-world interceptor
// 扩展被重新加载后，旧标签页里残留的内容脚本上下文会失效，chrome.runtime 变为
// undefined；此时访问 getURL 会抛 Uncaught TypeError。加防御性判断，失效上下文直接跳过。
// 注：严格 CSP 站点会拦掉这条 <script> 注入，改由 manifest 的 world:MAIN 声明式注入 + background
// 的 executeScript world:MAIN 兜底装上拦截器；本路径对普通站点仍有效，且与 __APII_INIT 去重并存。
if (chrome.runtime && typeof chrome.runtime.getURL === 'function') {
  var s = document.createElement('script');
  s.src = chrome.runtime.getURL('interceptor.js');
  s.onload = function () { s.remove(); };
  s.onerror = function () {};
  (document.head || document.documentElement).appendChild(s);
}

// Sync all rules + state to interceptor
var contextDead = false;

function syncAll() {
  if (contextDead) return;
  try {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, function (resp) {
      var err = chrome.runtime.lastError;
      if (err) {
        if (err.message && err.message.indexOf('Extension context invalidated') >= 0) {
          killBadge(); // 扩展已失效：移除残留角标并通知拦截器停用
        }
        return;
      }
      if (!resp) return;
      var state = resp;
      var hasActive = state.globalEnabled && (state.rules.some(function (r: any) { return r.enabled; }) || state.observeEnabled === true);
      updateBadge(hasActive, state.rules.filter(function (r: any) { return r.enabled; }).length);

      window.postMessage({
        type: 'APII_SYNC',
        active: hasActive,
        globalEnabled: state.globalEnabled,
        rules: state.rules,
        groups: state.groups,
        observeEnabled: state.observeEnabled === true,
        observeResourceTypes: Array.isArray(state.observeResourceTypes) ? state.observeResourceTypes : ['fetch', 'xmlhttprequest']
      }, '*');
    });
  } catch (_) { contextDead = true; }
}

function onReady(e: MessageEvent) {
  if (e.source !== window || !e.data) return;
  if (e.data.type === 'APII_READY') {
    window.removeEventListener('message', onReady);
    syncAll();
  }
}
window.addEventListener('message', onReady);

// 声明式 world:MAIN 注入的握手兜底（配合 manifest 新增的第二条 world:MAIN content_script）：
// world:MAIN 的 interceptor 与本 ISOLATED content 谁先执行由浏览器决定、不保证顺序。若 interceptor
// 先跑，它「只发一次、且不重发」的 APII_READY 会早于上面的监听器注册而丢失 —— 规则永不下发、拦截静默
// 失效。此时 interceptor 已注册好 APII_SYNC 监听，故本脚本启动即主动同步一次即可命中。
// 反之若本脚本先跑，这次主动同步可能因 interceptor 尚未就绪而丢，但上面的 APII_READY→syncAll 会兜底。
// 两条路径互补，覆盖任意执行顺序；syncAll 幂等（interceptor 每次 APII_SYNC 都重建规则索引）。
// 重载后「新实例接管」也依赖这次主动同步把规则重新喂给存活的老拦截器、重新激活并恢复日志转发。
syncAll();

// 接管广播：告知遗留在其它隔离世界的旧孤儿「本实例已接管」，令其噤声让位（见 onTakeover）。
// 放在 syncAll() 之后广播：先让本实例把拦截器激活到真实状态，再令旧孤儿停手，避免任何顺序下的关停竞态。
try { window.postMessage({ type: 'APII_TAKEOVER', id: INSTANCE_ID }, '*'); } catch (_) { }

// Sync on storage changes (replaces polling — more efficient, no SW wake-ups)
function onStorageSync(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== 'local') return;
  if (changes.rules || changes.groups || changes.globalEnabled || changes.showBadge || changes.observeEnabled || changes.observeResourceTypes) {
    syncAll();
  }
}
if (hasStorageApi) {
  chrome.storage.onChanged.addListener(onStorageSync);
}

// 孤儿角标兜底清理：标签页重新可见时立即探测扩展是否已停用（覆盖「切回没看过的背景标签页」这一主场景，
// 零后台开销）；另加一个自终止的低频探测覆盖前台停用的边角场景。二者都只做本地属性读取，不触碰 SW/存储。
function onVisibility() {
  if (!contextDead && document.visibilityState === 'visible' && !extAlive()) killBadge();
}
document.addEventListener('visibilitychange', onVisibility);
var orphanTimer = setInterval(function () {
  if (contextDead || !extAlive()) { killBadge(); clearInterval(orphanTimer); }
}, 5000);

// 导出 teardown：下一次【同一隔离世界】的注入会先调用它拆除本实例（不同世界的孤儿走 APII_TAKEOVER 让位）。
// 移除本实例的 window/document 监听、storage 监听、定时器与角标 DOM，让新桥接干净接管。
// 只做「拆自己」，不发 APII_SYNC active:false（避免健康接管期间误停拦截器；新实例会立刻重新 syncAll 真实状态）。
(window as any).__apimockflow_teardown = function () {
  try { window.removeEventListener('message', onWinMessage); } catch (_) { }
  try { window.removeEventListener('message', onReady); } catch (_) { }
  try { window.removeEventListener('message', onTakeover); } catch (_) { }
  try { document.removeEventListener('visibilitychange', onVisibility); } catch (_) { }
  try { clearInterval(orphanTimer); } catch (_) { }
  try { if (hasStorageApi) chrome.storage.onChanged.removeListener(onStorageBadge); } catch (_) { }
  try { if (hasStorageApi) chrome.storage.onChanged.removeListener(onStorageSync); } catch (_) { }
  try { if (badge && badge.parentNode) badge.parentNode.removeChild(badge); } catch (_) { }
};

// Content script loaded
} // end injection block
