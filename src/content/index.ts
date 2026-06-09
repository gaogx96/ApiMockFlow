// Content script — state sync + log bridge

var badge = document.createElement('div');
badge.id = 'apimockflow-badge';
badge.style.cssText = 'position:fixed;top:0;right:0;z-index:99999;color:white;padding:3px 8px;font-size:10px;font-family:sans-serif;border-radius:0 0 0 6px;pointer-events:none;transition:background 0.3s;display:none;';
if (document.body) { document.body.appendChild(badge); }
else { document.addEventListener('DOMContentLoaded', function () { (document.body || document.documentElement).appendChild(badge); }); }

var badgeActive = false;
var lastRuleCount = 0;

function updateBadge(active: boolean, count: number, reqCount?: number) {
  badge.style.display = 'block';
  badgeActive = active && count > 0;
  if (count > 0) lastRuleCount = count;
  if (badgeActive) {
    badge.style.background = '#1677ff';
    badge.textContent = 'ApiMockFlow ON | ' + lastRuleCount + ' rules';
  } else {
    badge.style.background = '#9ca3af';
    badge.textContent = 'ApiMockFlow OFF';
  }
}

// Listen for request counts from interceptor
window.addEventListener('message', function (e) {
  if (e.source !== window || !e.data) return;
  if (e.data.type === 'APII_RCOUNT') {
    updateBadge(badgeActive, lastRuleCount, e.data.count);
  }
});

// Inject main-world interceptor
var s = document.createElement('script');
s.src = chrome.runtime.getURL('interceptor.js');
s.onload = function () { console.log('[ApiMockFlow] interceptor.js injected'); s.remove(); };
s.onerror = function () { console.error('[ApiMockFlow] interceptor.js load FAILED'); };
(document.head || document.documentElement).appendChild(s);

// Sync all rules + state to interceptor
var syncTimer: any = null;
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
          if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
          console.warn('[ApiMockFlow] Extension context lost, deactivated');
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

syncTimer = setInterval(syncAll, 1500);

// Listen for storage changes to sync immediately (not just on 1.5s interval)
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.rules || changes.groups || changes.globalEnabled) {
    syncAll();
  }
});

console.log('[ApiMockFlow] Content script loaded');
