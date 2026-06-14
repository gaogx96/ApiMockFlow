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

// Cache showBadge value to avoid storage reads on every update
chrome.storage.local.get('showBadge', function (res) {
  cachedShowBadge = res?.showBadge === true;
});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.showBadge) {
    cachedShowBadge = changes.showBadge.newValue === true;
  }
});

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
var s = document.createElement('script');
s.src = chrome.runtime.getURL('interceptor.js');
s.onload = function () { s.remove(); };
s.onerror = function () {};
(document.head || document.documentElement).appendChild(s);

// Sync all rules + state to interceptor
var contextDead = false;

function syncAll() {
  if (contextDead) return;
  try {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, function (resp) {
      var err = chrome.runtime.lastError;
      if (err) {
        if (err.message && err.message.indexOf('Extension context invalidated') >= 0) {
          contextDead = true;
          updateBadge(false, 0);
          window.postMessage({ type: 'APII_SYNC', active: false, globalEnabled: false, rules: [], groups: [] }, '*');
          // Extension context lost
        }
        return;
      }
      if (!resp) return;
      var state = resp;
      var hasActive = state.globalEnabled && state.rules.some(function (r: any) { return r.enabled; });
      updateBadge(hasActive, state.rules.filter(function (r: any) { return r.enabled; }).length);

      window.postMessage({
        type: 'APII_SYNC',
        active: hasActive,
        globalEnabled: state.globalEnabled,
        rules: state.rules,
        groups: state.groups
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
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.rules || changes.groups || changes.globalEnabled || changes.showBadge) {
    syncAll();
  }
});

// Content script loaded
} // end __apimockflow_loaded guard
