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

// ===== Message handler =====
chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: any) => {
  const t = msg.type;

  if (t === 'GET_MATCHING_RULES') {
    const { url, method, resourceType } = msg.payload;
    getMatching(url, method, resourceType).then(rules => {
      console.log('[ApiMockFlow] Matched', rules.length, 'rules');
      sendResponse({ rules });
    });
    return true;
  }

  if (t === 'GET_STATE') {
    Promise.all([
      storageGet('globalEnabled', true), storageGet('rules', []),
      storageGet<RuleGroup[]>('groups', [])
    ]).then(([ge, r, g]) => {
      if (g.length === 0) {
        g = [{ id: 'default', name: '默认分组', enabled: true, color: '#1677ff' }];
      }
      sendResponse({ globalEnabled: ge, rules: r, groups: g });
    });
    return true;
  }

  if (t === 'GET_RULES') { storageGet('rules', []).then(sendResponse); return true; }
  if (t === 'SAVE_RULES') { storageSet('rules', msg.payload).then(() => sendResponse({ success: true })); return true; }
  if (t === 'SAVE_GROUPS') {
    var gs: RuleGroup[] = msg.payload;
    if (!Array.isArray(gs) || gs.length === 0) {
      gs = [{ id: 'default', name: '默认分组', enabled: true, color: '#1677ff' }];
    }
    storageSet('groups', gs).then(() => sendResponse({ success: true }));
    return true;
  }
  if (t === 'DELETE_RULE') {
    storageGet<Rule[]>('rules', []).then(rules => {
      storageSet('rules', rules.filter(r => r.id !== msg.payload.id)).then(() => sendResponse({ success: true }));
    });
    return true;
  }

  if (t === 'TOGGLE_GLOBAL') {
    storageSet('globalEnabled', msg.payload).then(() => {
      setIcon(msg.payload);
      sendResponse({ success: true });
    });
    return true;
  }

  if (t === 'TOGGLE_RULE') {
    const { ruleId, enabled } = msg.payload;
    storageGet<Rule[]>('rules', []).then(rules => {
      const r = rules.find(x => x.id === ruleId);
      if (r) { r.enabled = enabled; storageSet('rules', rules).then(() => sendResponse({ success: true })); }
      else sendResponse({ success: false });
    });
    return true;
  }

  if (t === 'TOGGLE_GROUP') {
    const { groupId, enabled } = msg.payload;
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
      const ps: Promise<void>[] = [];
      if (d.rules && Array.isArray(d.rules)) ps.push(storageSet('rules', d.rules));
      if (d.groups && Array.isArray(d.groups) && d.groups.length > 0) {
        ps.push(storageSet('groups', d.groups));
      }
      Promise.all(ps).then(() => sendResponse({ success: true }));
    } catch { sendResponse({ success: false, error: 'Invalid JSON' }); }
    return true;
  }

  // ---- API Tester: proxy request (bypasses CORS) ----
  if (t === 'API_TEST_REQUEST') {
    const { method, url, headers, body } = msg.payload as { method: string; url: string; headers: Record<string, string>; body?: string };
    const start = Date.now();

    async function doRequest() {
      const hdrs = new Headers(headers || {});

      // Attach browser cookies if user hasn't set a Cookie header
      if (!hdrs.has('Cookie')) {
        try {
          const cookies = await new Promise<chrome.cookies.Cookie[]>((r) =>
            chrome.cookies.getAll({ url }, r)
          );
          if (cookies && cookies.length > 0) {
            const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            hdrs.set('Cookie', cookieStr);
          }
        } catch (_) { /* cookies permission may be missing */ }
      }

      const init: RequestInit = { method, headers: hdrs };
      if (body && method !== 'GET' && method !== 'HEAD') init.body = body;

      // 30s timeout via AbortController
      const ac = new AbortController();
      const tm = setTimeout(() => ac.abort(), 30000);
      init.signal = ac.signal;

      try {
        const resp = await fetch(url, init);
        clearTimeout(tm);
        const respBody = await resp.text();
        const respHdrs: Record<string, string> = {};
        resp.headers.forEach((v, k) => { respHdrs[k] = v; });
        sendResponse({
          status: resp.status, statusText: resp.statusText,
          headers: respHdrs, body: respBody.slice(0, 100000),
          duration: Date.now() - start, size: new Blob([respBody]).size,
        });
      } catch (err: unknown) {
        clearTimeout(tm);
        const msg = (err as Error).name === 'AbortError' ? '请求超时 (30s)' : (err as Error).message;
        sendResponse({ error: msg, duration: Date.now() - start });
      }
    }

    doRequest();
    return true;
  }

  // ---- API Tester: history ----
  if (t === 'API_TEST_HISTORY_GET') { storageGet<any[]>('apiHistory', []).then(sendResponse); return true; }
  if (t === 'API_TEST_HISTORY_SAVE') {
    storageGet<any[]>('apiHistory', []).then(history => {
      history.unshift(msg.payload);
      if (history.length > 50) history.length = 50;
      storageSet('apiHistory', history).then(() => sendResponse({ success: true }));
    });
    return true;
  }
  if (t === 'API_TEST_HISTORY_CLEAR') { storageSet('apiHistory', []).then(() => sendResponse({ success: true })); return true; }

  // ---- Saved Requests ----
  if (t === 'API_SAVED_GET') { storageGet<any[]>('savedRequests', []).then(sendResponse); return true; }
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
