// Content script — state sync + log bridge
// 每次注入先拆除上一实例（扩展重载后遗留的「孤儿」内容脚本，或被 injectAllTabs / TOGGLE_GLOBAL 重复注入时的旧实例）。
// 关键：扩展重载/更新后，旧内容脚本所在的隔离世界并未销毁——其 window 全局、已注册的监听器、定时器、
// 角标 DOM 都还在，只是 chrome.* 上下文失效（详见下方孤儿角标说明）。若沿用「布尔标记 + 跳过」的老守卫，
// injectAllTabs 重新注入的新内容脚本会被直接跳过 → 页面上只剩一个 chrome.* 已失效的「死桥接」：
// 既不能把规则同步给主世界拦截器（mock 失效），也不能把 APII_LOG 转发给后台（日志丢失）。
// 因此改为「新实例接管」：先调用上一实例导出的 teardown（移除其监听器/定时器/角标），再全新初始化并重新 syncAll。
// 幂等且无副作用：全新导航时无 teardown 可调，直接初始化；先拆旧监听器也避免了重复注入导致的双份日志转发。
// 主世界 world:MAIN 拦截器仍由其自身 __APII_INIT 去重，且重载后老拦截器仍存活（纯页面 JS），本新桥接会重新喂它规则。
if (typeof (window as any).__apimockflow_teardown === 'function') {
  try { (window as any).__apimockflow_teardown(); } catch (_) { /* 旧实例已不可用，忽略 */ }
}
(window as any).__apimockflow_loaded = true;
{

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
  // 顺带通知主世界拦截器停用（它已支持 APII_SYNC；本文件不改动 interceptor 运行时层）
  try { window.postMessage({ type: 'APII_SYNC', active: false, globalEnabled: false, rules: [], groups: [] }, '*'); } catch (_) { }
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
// 两条路径互补，覆盖任意执行顺序；syncAll 幂等（interceptor 每次 APII_SYNC 都重建规则索引），对既有
// script-tag 注入路径也只是一次无害的冗余同步。重载后「新实例接管」也依赖这次主动同步把规则重新喂给老拦截器。
syncAll();

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

// 导出 teardown：下一次注入（尤其扩展重载后 injectAllTabs 的重新注入）会先调用它拆除本实例，
// 从而让新桥接干净接管——移除本实例的 window/文档监听器、storage 监听、定时器与角标 DOM。
// 只做「拆自己」，不发 APII_SYNC active:false（避免健康接管期间误停拦截器；新实例会立刻重新 syncAll 真实状态）。
(window as any).__apimockflow_teardown = function () {
  try { window.removeEventListener('message', onWinMessage); } catch (_) { }
  try { window.removeEventListener('message', onReady); } catch (_) { }
  try { document.removeEventListener('visibilitychange', onVisibility); } catch (_) { }
  try { clearInterval(orphanTimer); } catch (_) { }
  try { if (hasStorageApi) chrome.storage.onChanged.removeListener(onStorageBadge); } catch (_) { }
  try { if (hasStorageApi) chrome.storage.onChanged.removeListener(onStorageSync); } catch (_) { }
  try { if (badge && badge.parentNode) badge.parentNode.removeChild(badge); } catch (_) { }
};

// Content script loaded
} // end injection block
