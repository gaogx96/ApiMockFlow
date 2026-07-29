import React, { useState, useEffect, useRef } from 'react';
import { ArrowUpTrayIcon, SignalIcon, ClockIcon, XMarkIcon, PlusIcon, BookmarkIcon, BookmarkSlashIcon, ShieldCheckIcon, ArrowPathIcon, FunnelIcon } from '@heroicons/react/24/outline';
import { ApiRequest, ApiResponse, ApiHistoryItem, SavedRequest } from '../../shared/api-types';
import { parseImport } from '../../shared/import-parser';
import { generateId } from '../../shared/constants';
import { showToast } from '../../shared/toast';
import { repairAndFormatJson, minifyJson } from '../../shared/json-format';
import { parseJwtExpiry, humanizeDuration } from '../../shared/jwt';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const BODY_TYPES = [
  { value: 'raw', label: 'JSON' },
  { value: 'urlencoded', label: 'URL Encoded' },
];

interface TabData {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  bodyType: string;
  response: ApiResponse | null;
  error: string;
  loading: boolean;
  autoRefreshCookie: boolean;
  activeSubTab: 'headers' | 'body' | 'response' | 'history' | 'saved';
}

function createTab(name?: string): TabData {
  return {
    id: generateId(),
    name: name || '新请求',
    method: 'GET', url: '',
    headers: [['', '']], body: '', bodyType: 'raw',
    response: null, error: '', loading: false,
    autoRefreshCookie: false,
    activeSubTab: 'headers',
  };
}

interface Props {
  onCreateRule?: (prefill: { url: string; method: string }) => void;
}

export default function ApiTester({ onCreateRule }: Props) {
  const [tabs, setTabs] = useState<TabData[]>([createTab()]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [history, setHistory] = useState<ApiHistoryItem[]>([]);
  const [saved, setSaved] = useState<SavedRequest[]>([]);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importedReqs, setImportedReqs] = useState<ApiRequest[]>([]);
  const [saveName, setSaveName] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [allowInternal, setAllowInternal] = useState(false);
  const [syncingCookie, setSyncingCookie] = useState(false);
  const [showWhitelist, setShowWhitelist] = useState(false);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [whitelistInput, setWhitelistInput] = useState('');
  const tabScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadHistory(); loadSaved(); }, []);
  useEffect(() => {
    chrome.storage.local.get(['allowInternalNetwork', 'authCaptureWhitelist'], (res) => {
      if (res.allowInternalNetwork === true) setAllowInternal(true);
      if (Array.isArray(res.authCaptureWhitelist)) setWhitelist(res.authCaptureWhitelist);
    });
  }, []);

  const tab = tabs[activeIdx];

  function updateTab<K extends keyof TabData>(key: K, val: TabData[K]) {
    setTabs(prev => prev.map((t, i) => i === activeIdx ? { ...t, [key]: val } : t));
  }

  function loadHistory() {
    chrome.runtime.sendMessage({ type: 'API_TEST_HISTORY_GET' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      setHistory(resp);
    });
  }

  function loadSaved() {
    chrome.runtime.sendMessage({ type: 'API_SAVED_GET' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      setSaved(resp);
    });
  }

  function updateHeader(idx: number, field: 0 | 1, val: string) {
    const h = [...tab.headers];
    h[idx][field] = val;
    if (idx === h.length - 1 && (h[idx][0] || h[idx][1])) h.push(['', '']);
    updateTab('headers', h);
  }

  function removeHeader(idx: number) {
    updateTab('headers', tab.headers.filter((_, i) => i !== idx));
  }

  function getHeadersRecord(): Record<string, string> {
    const r: Record<string, string> = {};
    tab.headers.forEach(([k, v]) => { if (k.trim()) r[k.trim()] = v; });
    return r;
  }

  function hasContentType(h: Record<string, string>): boolean {
    return Object.keys(h).some(k => k.toLowerCase() === 'content-type');
  }

  // Set or replace headers (case-insensitive) in one pass, so multiple headers
  // are merged against the current list without React setState races.
  function applyHeaders(kv: Record<string, string>) {
    const h = tab.headers.map(pair => [...pair] as [string, string]);
    const setOne = (name: string, value: string) => {
      const idx = h.findIndex(([k]) => k.trim().toLowerCase() === name.toLowerCase());
      if (idx >= 0) {
        h[idx][1] = value;
      } else {
        // Insert before the trailing empty pair (kept for new-row input)
        const lastEmpty = h.length > 0 && !h[h.length - 1][0] && !h[h.length - 1][1];
        const entry: [string, string] = [name, value];
        if (lastEmpty) h.splice(h.length - 1, 0, entry);
        else { h.push(entry); h.push(['', '']); }
      }
    };
    for (const [k, v] of Object.entries(kv)) setOne(k, v);
    updateTab('headers', h);
  }

  // Pull current login state (browser cookies + captured auth headers) into the request.
  function syncLoginState() {
    const url = tab.url.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      showToast('请先填写有效的 http(s) URL', 'warning');
      return;
    }
    setSyncingCookie(true);
    chrome.runtime.sendMessage({ type: 'GET_LOGIN_STATE', payload: { url } }, (resp) => {
      setSyncingCookie(false);
      if (chrome.runtime.lastError) { showToast('通信错误: ' + chrome.runtime.lastError.message, 'error'); return; }
      if (!resp || resp.error) { showToast(resp?.error || '读取登录态失败', 'error'); return; }
      const authHeaders: Record<string, string> = resp.authHeaders || {};
      const kv: Record<string, string> = {};
      if (resp.cookieStr) kv['Cookie'] = resp.cookieStr;
      Object.assign(kv, authHeaders);
      if (Object.keys(kv).length === 0) {
        showToast('未获取到登录态：请先在浏览器登录并操作过该系统（触发过带 token 的请求）', 'warning');
        return;
      }
      applyHeaders(kv);
      const parts: string[] = [];
      if (resp.cookieCount) parts.push(`${resp.cookieCount} 个 Cookie`);
      const authCount = Object.keys(authHeaders).length;
      if (authCount) parts.push(`${authCount} 个认证头`);
      const base = parts.length ? `已同步 ${parts.join('、')}` : '已同步登录态';

      // JWT 过期提醒：取所有认证头里最早的 exp
      let soonestExp: number | null = null;
      for (const v of Object.values(authHeaders)) {
        const exp = parseJwtExpiry(v);
        if (exp !== null && (soonestExp === null || exp < soonestExp)) soonestExp = exp;
      }
      if (soonestExp !== null) {
        const remain = soonestExp - Date.now();
        if (remain <= 0) {
          showToast(`${base}，但 Token 已过期（${humanizeDuration(remain)}前）——请在浏览器重新登录后再同步`, 'warning', 6000);
        } else if (remain < 10 * 60 * 1000) {
          showToast(`${base}；Token 将在 ${humanizeDuration(remain)}后过期`, 'warning', 5000);
        } else {
          showToast(`${base}；Token 有效期约剩 ${humanizeDuration(remain)}`, 'success', 4000);
        }
      } else {
        showToast(base, 'success');
      }
    });
  }

  // ---- 抓取域名白名单 ----
  function cleanDomain(s: string): string {
    let d = s.trim().toLowerCase().replace(/^\*+\.?/, '').replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    d = d.replace(/[/:?#].*$/, ''); // 去端口/路径/查询
    return d;
  }
  function saveWhitelist(list: string[]) {
    setWhitelist(list);
    chrome.storage.local.set({ authCaptureWhitelist: list });
  }
  function addWhitelist() {
    const d = cleanDomain(whitelistInput);
    setWhitelistInput('');
    if (!d || whitelist.includes(d)) return;
    saveWhitelist([...whitelist, d]);
  }
  function removeWhitelist(d: string) {
    saveWhitelist(whitelist.filter(x => x !== d));
  }

  async function sendRequest() {
    if (!tab.url.trim()) { updateTab('error', '请输入 URL'); return; }
    updateTab('loading', true);
    updateTab('error', '');
    updateTab('response', null);
    updateTab('activeSubTab', 'response');

    const h = getHeadersRecord();
    if (tab.body && !hasContentType(h)) {
      h['Content-Type'] = tab.bodyType === 'urlencoded'
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }

    const req: ApiRequest = { method: tab.method, url: tab.url.trim(), headers: h, body: tab.body || undefined, bodyType: tab.bodyType as any };
    chrome.runtime.sendMessage({ type: 'API_TEST_REQUEST', payload: { ...req, refreshCookie: tab.autoRefreshCookie } }, (resp) => {
      updateTab('loading', false);
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        // 白盒化：区分 context invalidated（需重载）和其他错误
        if (lastErr.message?.includes('Extension context invalidated')) {
          updateTab('error', '扩展上下文已失效，请刷新插件 Popup 或重新加载扩展 (chrome://extensions → 刷新)');
        } else {
          updateTab('error', '通信错误: ' + lastErr.message);
        }
        return;
      }
      if (!resp) { updateTab('error', '请求失败：后台脚本未响应。请检查扩展是否正常运行，或尝试重新加载扩展。'); return; }
      if (resp.error) { updateTab('error', resp.error); return; }
      updateTab('response', resp);
      saveToHistory(req, resp);
    });
  }

  function saveToHistory(req: ApiRequest, resp: ApiResponse) {
    const item: ApiHistoryItem = { id: generateId(), request: req, response: resp, timestamp: Date.now() };
    chrome.runtime.sendMessage({ type: 'API_TEST_HISTORY_SAVE', payload: item }, loadHistory);
  }

  function loadRequestToTab(req: ApiRequest, autoRefresh = false) {
    const name = req.url ? req.url.replace(/^https?:\/\//, '').split('/')[0] : '新请求';
    updateTab('method', req.method);
    updateTab('url', req.url);
    updateTab('name', name);
    const h = Object.entries(req.headers).map(([k, v]) => [k, v] as [string, string]);
    if (h.length === 0) h.push(['', '']);
    updateTab('headers', h);
    updateTab('body', req.body || '');
    updateTab('bodyType', req.bodyType || 'raw');
    updateTab('autoRefreshCookie', autoRefresh);
    updateTab('response', null);
    updateTab('error', '');
    updateTab('activeSubTab', 'headers');
  }

  function addTab(name?: string) {
    setTabs(prev => {
      setActiveIdx(prev.length);
      return [...prev, createTab(name)];
    });
  }

  function closeTab(idx: number) {
    if (tabs.length <= 1) return;
    if (activeIdx >= idx && activeIdx > 0) setActiveIdx(activeIdx - 1);
    else if (activeIdx > tabs.length - 2) setActiveIdx(Math.max(0, tabs.length - 2));
    setTabs(prev => prev.filter((_, i) => i !== idx));
  }

  function handleImport() {
    const result = parseImport(importText);
    // 解析不出任何请求：按识别到的格式给出针对性提示（toast 不受当前子标签页影响）
    if (result.requests.length === 0) {
      if (result.format === 'openapi') {
        showToast('检测到 OpenAPI，但未解析出接口。当前仅支持 JSON，若为 YAML 请先转成 JSON，或确认 paths 字段存在', 'error', 6000);
      } else {
        showToast('无法识别输入格式，请粘贴 cURL、HTTPie 或 OpenAPI(JSON)', 'error');
      }
      return;
    }
    // curl/httpie 恒返回 1 条，但可能没解析出 URL（命令残缺）
    if (result.requests.length === 1) {
      if (!result.requests[0].url) {
        showToast('未能从命令中解析出有效的 http(s) URL，请检查粘贴内容', 'error');
        return;
      }
      loadRequestToTab(result.requests[0]);
      setImportText('');
      setShowImport(false);
    } else {
      setImportedReqs(result.requests);
    }
  }

  function importOneToNewTab(r: ApiRequest) {
    const name = r.headers['x-summary'] || r.url.replace(/^https?:\/\//, '').split('/')[0] || '已导入';
    setTabs(prev => {
      const t = createTab(name);
      t.method = r.method;
      t.url = r.url;
      const h = Object.entries(r.headers).filter(([k]) => k !== 'x-summary').map(([k, v]) => [k, v] as [string, string]);
      if (h.length === 0) h.push(['', '']);
      t.headers = h;
      t.body = r.body || '';
      t.bodyType = r.bodyType || 'raw';
      setActiveIdx(prev.length);
      return [...prev, t];
    });
    setImportedReqs(prev => prev.filter(x => x !== r));
    if (importedReqs.length <= 1) { setImportText(''); setShowImport(false); }
  }

  function handleSave() {
    const suggested = tab.url
      ? tab.url.replace(/^https?:\/\//, '').split('/').slice(0, 2).join('/')
      : tab.name;
    setSaveName(suggested);
    setShowSaveDialog(true);
  }

  function toggleAllowInternal() {
    const next = !allowInternal;
    setAllowInternal(next);
    chrome.storage.local.set({ allowInternalNetwork: next });
  }

  function confirmSave() {
    const req: ApiRequest = { method: tab.method, url: tab.url, headers: getHeadersRecord(), body: tab.body || undefined, bodyType: tab.bodyType as any };
    const item: SavedRequest = { id: generateId(), name: saveName || '未命名', request: req, timestamp: Date.now(), autoRefreshCookie: tab.autoRefreshCookie };
    chrome.runtime.sendMessage({ type: 'API_SAVED_SAVE', payload: item }, () => {
      loadSaved();
      setShowSaveDialog(false);
      setSaveName('');
    });
  }

  function deleteSaved(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'API_SAVED_DELETE', payload: { id } }, loadSaved);
  }

  function formatJson(s: string): string {
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
  }

  // 请求体「格式化」按钮：合法则美化；非法则尝试自动修复常见错误并填入，仍失败给带原因/位置的提示
  function formatBody() {
    if (!tab.body.trim()) return;
    const r = repairAndFormatJson(tab.body);
    if (r.ok) {
      updateTab('body', r.text);
      if (r.repaired) showToast('已自动修复并格式化，请核对内容', 'success', 4000);
    } else {
      showToast(r.error || '不是合法 JSON', 'warning', 6000);
    }
  }

  // 请求体「压缩」按钮：解析后压成一行（同样先尝试修复）
  function minifyBody() {
    if (!tab.body.trim()) return;
    const r = minifyJson(tab.body);
    if (r.ok) {
      updateTab('body', r.text);
      if (r.repaired) showToast('已自动修复并压缩，请核对内容', 'success', 4000);
    } else {
      showToast(r.error || '不是合法 JSON', 'warning', 6000);
    }
  }

  // Simple regex-based JSON syntax highlighting (safe: input is from JSON.stringify)
  function highlightJson(s: string): string {
    let formatted: string;
    try { formatted = JSON.stringify(JSON.parse(s), null, 2); } catch { formatted = s; }
    // Escape HTML first
    const esc = formatted.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Highlight: strings, numbers, booleans, null, keys
    return esc
      .replace(/"([^"\\]|\\.)*"/g, (m) => {
        // Check if it's a key (followed by :)
        return `<span style="color:#9cdcfe">${m}</span>`;
      })
      .replace(/\b(true|false)\b/g, '<span style="color:#569cd6">$1</span>')
      .replace(/\b(null)\b/g, '<span style="color:#569cd6">$1</span>')
      .replace(/\b(-?\d+\.?\d*([eE][+-]?\d+)?)\b/g, '<span style="color:#b5cea8">$1</span>');
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  const SUB_TABS: { key: string; label: string; badge?: string }[] = [
    { key: 'headers', label: '请求头' },
    { key: 'body', label: '请求体' },
    { key: 'response', label: '响应', badge: tab.response ? String(tab.response.status) : '' },
    { key: 'history', label: '历史' },
    { key: 'saved', label: '已保存' },
  ];

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-800">
      {/* Tab Bar */}
      <div className="flex items-center border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 shrink-0" style={{ height: 28 }}>
        <div ref={tabScrollRef} className="flex-1 flex items-center overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {tabs.map((t, i) => (
            <div
              key={t.id}
              onClick={() => setActiveIdx(i)}
              className={`flex items-center gap-1 px-2 h-7 text-xs cursor-pointer border-r border-gray-200 dark:border-slate-700 shrink-0 max-w-[120px] ${
                i === activeIdx ? 'bg-white dark:bg-slate-800 text-primary-600 font-medium' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              <span className={`method-badge method-${t.method} scale-75`}>{t.method}</span>
              <span className="truncate">{t.name}</span>
              {tabs.length > 1 && (
                <XMarkIcon
                  className="w-3 h-3 text-gray-400 hover:text-red-500 shrink-0"
                  onClick={(e) => { e.stopPropagation(); closeTab(i); }}
                />
              )}
            </div>
          ))}
        </div>
        <button
          onClick={() => addTab()}
          className="px-2 text-gray-400 hover:text-primary-500 shrink-0"
        >
          <PlusIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* URL Bar */}
      <div className="px-2 py-1.5 border-b border-gray-100 dark:border-slate-700 shrink-0">
        <div className="flex gap-1">
          <select value={tab.method} onChange={e => updateTab('method', e.target.value)}
            className="form-select shrink-0 text-xs" style={{ width: '78px', padding: '4px 20px 4px 6px', fontSize: 11, backgroundPosition: 'right 4px center' }}>
            {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <input type="text" placeholder="输入 URL..."
            value={tab.url} onChange={e => { updateTab('url', e.target.value); if (!tabs[activeIdx].name || tabs[activeIdx].name === '新请求') { const d = e.target.value.replace(/^https?:\/\//, '').split('/')[0]; if (d) updateTab('name', d); } }}
            onKeyDown={e => e.key === 'Enter' && sendRequest()}
            className="form-input flex-1 text-xs" style={{ minWidth: 0, padding: '4px 8px', fontSize: 11 }} />
          <button onClick={sendRequest} disabled={tab.loading}
            className="px-3 py-1 text-xs bg-primary-500 text-white rounded-md hover:bg-primary-600 font-medium disabled:opacity-50 whitespace-nowrap">
            {tab.loading ? '发送中...' : '发送'}
          </button>
          <button onClick={handleSave}
            className="px-2 py-1 text-xs text-gray-500 border border-gray-200 dark:border-slate-700 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-slate-900"
            title="保存请求">
            <BookmarkIcon className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setShowImport(!showImport)}
            className="px-2 py-1 text-xs text-gray-500 border border-gray-200 dark:border-slate-700 rounded-md hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-slate-900"
            title="导入 cURL / HTTPie / OpenAPI">
            <ArrowUpTrayIcon className="w-3.5 h-3.5" />
          </button>
          <button onClick={toggleAllowInternal}
            className={`px-2 py-1 text-xs border rounded-md transition-colors ${
              allowInternal
                ? 'border-green-300 bg-green-50 text-green-700 dark:border-green-600 dark:bg-green-900/30 dark:text-green-400'
                : 'border-gray-200 text-amber-500 dark:border-slate-700 dark:bg-slate-900 dark:text-amber-400'
            }`}
            title={allowInternal ? '允许访问内网地址（点击关闭）' : '内网地址已拦截（点击放行）'}>
            <ShieldCheckIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Save dialog */}
      {showSaveDialog && (
        <div className="px-2 py-1.5 border-b border-gray-100 dark:border-slate-700 bg-blue-50 dark:bg-slate-900 shrink-0 space-y-1.5">
          <div className="flex gap-1.5 items-center">
            <input type="text" placeholder="请求名称..."
              value={saveName} onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmSave(); if (e.key === 'Escape') setShowSaveDialog(false); }}
              className="form-input flex-1 text-xs" style={{ padding: '4px 6px', fontSize: 11 }}
              autoFocus />
            <button onClick={confirmSave} className="px-3 py-1 text-xs bg-primary-500 text-white rounded font-medium">保存</button>
            <button onClick={() => setShowSaveDialog(false)} className="px-2 py-1 text-xs text-gray-500">取消</button>
          </div>
          <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 cursor-pointer select-none" style={{ fontSize: 11 }}>
            <input type="checkbox" checked={tab.autoRefreshCookie}
              onChange={e => updateTab('autoRefreshCookie', e.target.checked)}
              className="w-3 h-3" />
            发送时自动同步登录态（Cookie + Token，避免过期）
          </label>
        </div>
      )}

      {/* Import panel */}
      {showImport && (
        <div className="px-2 py-1.5 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 shrink-0">
          <textarea
            placeholder="粘贴 cURL、HTTPie 或 OpenAPI JSON..."
            value={importText}
            onChange={e => setImportText(e.target.value)}
            rows={3}
            className="form-textarea text-xs w-full mb-1.5" style={{ fontSize: 11 }}
          />
          <div className="flex gap-1.5 mb-1.5">
            <button onClick={handleImport} className="px-2.5 py-1 text-xs bg-primary-500 text-white rounded font-medium">解析</button>
            <button onClick={() => { setShowImport(false); setImportText(''); setImportedReqs([]); }}
              className="px-2.5 py-1 text-xs text-gray-500 border border-gray-200 dark:border-slate-700 rounded font-medium">取消</button>
          </div>
          {importedReqs.length > 0 && (
            <div className="bg-white dark:bg-slate-800 rounded border border-gray-200 dark:border-slate-700 max-h-24 overflow-y-auto">
              <div className="flex items-center justify-between px-2 py-1 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900">
                <span className="text-xs text-gray-500">解析出 {importedReqs.length} 个请求</span>
              </div>
              {importedReqs.map((r, i) => (
                <div key={i} onClick={() => importOneToNewTab(r)}
                  className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-slate-900 text-xs border-b border-gray-50 dark:border-slate-700 last:border-0">
                  <span className={`method-badge method-${r.method}`} style={{ fontSize: 9 }}>{r.method}</span>
                  <span className="text-gray-600 truncate flex-1">{r.url}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sub Tabs */}
      <div className="flex border-b border-gray-100 dark:border-slate-700 px-2 bg-gray-50 dark:bg-slate-900 shrink-0">
        {SUB_TABS.map(st => (
          <button key={st.key}
            className={`px-2.5 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              tab.activeSubTab === st.key ? 'border-primary-500 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => updateTab('activeSubTab', st.key as any)}>
            {st.label}
            {st.badge && <span className="ml-1 text-gray-400">{st.badge}</span>}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab.activeSubTab === 'headers' && (
          <div className="p-2 space-y-1">
            <div className="flex items-center gap-2 mb-1.5 pb-1.5 border-b border-gray-100 dark:border-slate-700">
              <button onClick={syncLoginState} disabled={syncingCookie || !tab.url.trim()}
                className="flex items-center gap-1 px-2 py-1 text-xs border border-gray-200 dark:border-slate-700 rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                title={!tab.url.trim() ? '请先填写 URL' : '从浏览器读取该域名当前有效的 Cookie 及捕获到的 Authorization/token 认证头，写入请求头'}>
                <ArrowPathIcon className={`w-3.5 h-3.5 ${syncingCookie ? 'animate-spin' : ''}`} />
                {syncingCookie ? '同步中...' : '同步登录态'}
              </button>
              <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300 cursor-pointer select-none" style={{ fontSize: 11 }}
                title="开启后，每次发送都会用浏览器最新的 Cookie 与认证头覆盖请求头，避免登录态过期">
                <input type="checkbox" checked={tab.autoRefreshCookie}
                  onChange={e => updateTab('autoRefreshCookie', e.target.checked)}
                  className="w-3 h-3" />
                发送时自动同步
              </label>
              <button onClick={() => setShowWhitelist(v => !v)}
                className={`ml-auto flex items-center gap-1 px-2 py-1 text-xs border rounded-md transition-colors ${
                  showWhitelist || whitelist.length
                    ? 'border-primary-300 text-primary-600 dark:border-primary-600 dark:text-primary-400'
                    : 'border-gray-200 text-gray-500 dark:border-slate-700 dark:text-gray-400'
                } hover:bg-gray-50 dark:hover:bg-gray-800`}
                title="抓取域名白名单：限定后台监听哪些站点的登录态">
                <FunnelIcon className="w-3.5 h-3.5" />
                白名单{whitelist.length ? ` (${whitelist.length})` : ''}
              </button>
            </div>
            {showWhitelist && (
              <div className="mb-1.5 p-2 rounded-md border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900">
                <div className="text-xs text-gray-500 mb-1.5" style={{ fontSize: 10, lineHeight: 1.5 }}>
                  留空 = 抓取所有站点的登录态；填写后仅监听这些域名（含子域），可减少后台开销与隐私足迹。
                </div>
                <div className="flex gap-1 mb-1.5">
                  <input value={whitelistInput} onChange={e => setWhitelistInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addWhitelist(); }}
                    placeholder="如 example.com"
                    className="form-input flex-1 text-xs" style={{ padding: '3px 6px', fontSize: 11 }} />
                  <button onClick={addWhitelist} className="px-2 py-1 text-xs bg-primary-500 text-white rounded font-medium whitespace-nowrap">添加</button>
                </div>
                {whitelist.length === 0 ? (
                  <div className="text-xs text-gray-400" style={{ fontSize: 10 }}>（当前：抓取所有站点）</div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {whitelist.map(d => (
                      <span key={d} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded" style={{ fontSize: 10 }}>
                        {d}
                        <XMarkIcon className="w-3 h-3 text-gray-400 hover:text-red-500 cursor-pointer" onClick={() => removeWhitelist(d)} />
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {tab.headers.map(([k, v], i) => (
              <div key={i} className="flex gap-1">
                <input type="text" placeholder="键" value={k}
                  onChange={e => updateHeader(i, 0, e.target.value)}
                  className="form-input flex-1 text-xs" style={{ padding: '3px 6px', fontSize: 11 }} />
                <input type="text" placeholder="值" value={v}
                  onChange={e => updateHeader(i, 1, e.target.value)}
                  className="form-input flex-1 text-xs" style={{ padding: '3px 6px', fontSize: 11 }} />
                {i < tab.headers.length - 1 && (
                  <button onClick={() => removeHeader(i)}
                    className="text-gray-300 hover:text-red-400 px-0.5"><XMarkIcon className="w-3 h-3" /></button>
                )}
              </div>
            ))}
          </div>
        )}

        {tab.activeSubTab === 'body' && (
          <div className="p-2">
            <div className="flex gap-1.5 mb-1.5 items-center">
              {BODY_TYPES.map(bt => (
                <button key={bt.value}
                  className={`px-2 py-0.5 text-xs rounded-full font-medium ${tab.bodyType === bt.value ? 'bg-primary-50 text-primary-600' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                  onClick={() => updateTab('bodyType', bt.value)}>
                  {bt.label}
                </button>
              ))}
              {tab.bodyType === 'raw' && (
                <div className="ml-auto flex items-center gap-1.5">
                  <button onClick={formatBody}
                    className="px-2 py-0.5 text-xs rounded-full font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-slate-700 dark:text-slate-300"
                    title="格式化 JSON（缩进 2 空格）；能自动修复常见错误：多余逗号、单引号、缺引号、注释、缺括号、中文标点等">
                    格式化
                  </button>
                  <button onClick={minifyBody}
                    className="px-2 py-0.5 text-xs rounded-full font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-slate-700 dark:text-slate-300"
                    title="压缩 JSON：去掉所有空白压成一行（先尝试修复再压缩）">
                    压缩
                  </button>
                </div>
              )}
            </div>
            <textarea
              placeholder="请求体..."
              value={tab.body}
              onChange={e => updateTab('body', e.target.value)}
              rows={7}
              className="form-textarea w-full" style={{ fontSize: 11 }}
            />
          </div>
        )}

        {tab.activeSubTab === 'response' && (
          <div className="p-2">
            {tab.error && (
              <div className="p-2 bg-red-50 border border-red-200 rounded-md text-xs text-red-600 mb-2 break-all" style={{ fontSize: 11 }}>
                {tab.error}
              </div>
            )}
            {tab.response && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-gray-500" style={{ fontSize: 11 }}>
                  <span className={`font-bold ${tab.response.status < 300 ? 'text-green-600' : tab.response.status < 400 ? 'text-amber-600' : 'text-red-600'}`}>
                    {tab.response.status} {tab.response.statusText}
                  </span>
                  <span>{tab.response.duration}ms</span>
                  <span>{formatSize(tab.response.size)}</span>
                </div>
                <details>
                  <summary className="text-xs font-medium text-gray-600 cursor-pointer" style={{ fontSize: 11 }}>
                    响应头 ({Object.keys(tab.response.headers).length})
                  </summary>
                  <div className="mt-1 bg-gray-50 dark:bg-slate-900 rounded p-1.5 text-xs max-h-20 overflow-y-auto" style={{ fontSize: 10 }}>
                    {Object.entries(tab.response.headers).map(([k, v]) => (
                      <div key={k}><span className="text-gray-400">{k}:</span> {v}</div>
                    ))}
                  </div>
                </details>
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="text-xs font-medium text-gray-600" style={{ fontSize: 11 }}>响应体</div>
                    <button
                      onClick={() => copyToClipboard(formatJson(tab.response!.body))}
                      className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      style={{ fontSize: 10 }}
                      title="复制"
                    >
                      复制
                    </button>
                  </div>
                  <pre
                    className="bg-gray-50 dark:bg-slate-900 rounded p-1.5 text-xs max-h-64 overflow-y-auto whitespace-pre-wrap break-all"
                    style={{ fontSize: 10, fontFamily: "'SF Mono', 'Fira Code', Consolas, monospace" }}
                    dangerouslySetInnerHTML={{ __html: highlightJson(tab.response.body.length > 50000 ? tab.response.body.slice(0, 50000) + '\n\n... (已截断，共 ' + formatSize(tab.response.body.length) + ')' : tab.response.body) }}
                  />
                </div>
              </div>
            )}
            {!tab.error && !tab.response && !tab.loading && (
              <div className="empty-state" style={{ padding: '24px 16px' }}>
                <SignalIcon className="w-6 h-6 text-gray-300 mx-auto" />
                <div className="title" style={{ fontSize: 12 }}>输入 URL 并点击发送</div>
                <div className="desc" style={{ fontSize: 11 }}>响应将显示在这里</div>
              </div>
            )}
            {tab.loading && (
              <div className="text-center text-gray-400 text-xs py-6" style={{ fontSize: 11 }}>发送中...</div>
            )}
          </div>
        )}

        {tab.activeSubTab === 'history' && (
          <div className="divide-y divide-gray-50 dark:divide-gray-700">
            {history.length === 0 ? (
              <div className="empty-state" style={{ padding: '24px 16px' }}>
                <ClockIcon className="w-6 h-6 text-gray-300 mx-auto" />
                <div className="title" style={{ fontSize: 12 }}>暂无请求历史</div>
              </div>
            ) : (
              history.map((item) => (
                <div key={item.id}
                  className="px-2 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-slate-900 transition-colors"
                  onClick={() => loadRequestToTab(item.request)}>
                  <div className="flex items-center gap-1.5">
                    <span className={`method-badge method-${item.request.method}`} style={{ fontSize: 9 }}>{item.request.method}</span>
                    <span className="text-xs text-gray-500 truncate flex-1" style={{ fontSize: 10 }}>{item.request.url}</span>
                    {item.response && (
                      <span className={`text-xs font-mono ${item.response.status < 300 ? 'text-green-500' : item.response.status < 400 ? 'text-amber-500' : 'text-red-500'}`} style={{ fontSize: 10 }}>
                        {item.response.status}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab.activeSubTab === 'saved' && (
          <div className="divide-y divide-gray-50 dark:divide-gray-700">
            {saved.length === 0 ? (
              <div className="empty-state" style={{ padding: '24px 16px' }}>
                <BookmarkSlashIcon className="w-6 h-6 text-gray-300 mx-auto" />
                <div className="title" style={{ fontSize: 12 }}>暂无已保存请求</div>
                <div className="desc" style={{ fontSize: 11 }}>点击书签图标保存请求</div>
              </div>
            ) : (
              saved.map((item) => (
                <div key={item.id}
                  className="px-2 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-slate-900 transition-colors group flex items-center"
                  onClick={() => loadRequestToTab(item.request, item.autoRefreshCookie)}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-200 truncate" style={{ fontSize: 11 }}>
                      <span className="truncate">{item.name}</span>
                      {item.autoRefreshCookie && (
                        <ArrowPathIcon className="w-3 h-3 text-green-500 shrink-0" title="发送时自动同步登录态" />
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`method-badge method-${item.request.method}`} style={{ fontSize: 9 }}>{item.request.method}</span>
                      <span className="text-xs text-gray-400 truncate" style={{ fontSize: 10 }}>{item.request.url}</span>
                    </div>
                  </div>
                  {onCreateRule && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onCreateRule({ url: item.request.url, method: item.request.method }); }}
                      className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-primary-500 ml-1"
                      title="创建规则">
                      <ShieldCheckIcon className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={(e) => deleteSaved(item.id, e)}
                    className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 ml-1"
                    title="删除">
                    <XMarkIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
