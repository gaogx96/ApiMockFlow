// Content script — state sync + log bridge
if ((window as any).__apimockflow_loaded) { /* already injected, skip */ } else {
(window as any).__apimockflow_loaded = true;

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
if (hasStorageApi) {
  chrome.storage.local.get('showBadge', function (res) {
    cachedShowBadge = res?.showBadge === true;
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes.showBadge) {
      cachedShowBadge = changes.showBadge.newValue === true;
    }
  });
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
window.addEventListener('message', function (e) {
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
});

// Inject main-world interceptor
// 扩展被重新加载后，旧标签页里残留的内容脚本上下文会失效，chrome.runtime 变为
// undefined；此时访问 getURL 会抛 Uncaught TypeError。加防御性判断，失效上下文直接跳过。
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

window.addEventListener('message', function handler(e) {
  if (e.source !== window || !e.data) return;
  if (e.data.type === 'APII_READY') {
    window.removeEventListener('message', handler);
    syncAll();
  }
});

// Sync on storage changes (replaces polling — more efficient, no SW wake-ups)
if (hasStorageApi) {
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.rules || changes.groups || changes.globalEnabled || changes.showBadge || changes.observeEnabled || changes.observeResourceTypes) {
      syncAll();
    }
  });
}

// 孤儿角标兜底清理：标签页重新可见时立即探测扩展是否已停用（覆盖「切回没看过的背景标签页」这一主场景，
// 零后台开销）；另加一个自终止的低频探测覆盖前台停用的边角场景。二者都只做本地属性读取，不触碰 SW/存储。
document.addEventListener('visibilitychange', function () {
  if (!contextDead && document.visibilityState === 'visible' && !extAlive()) killBadge();
});
var orphanTimer = setInterval(function () {
  if (contextDead || !extAlive()) { killBadge(); clearInterval(orphanTimer); }
}, 5000);

// Content script loaded
} // end __apimockflow_loaded guard
