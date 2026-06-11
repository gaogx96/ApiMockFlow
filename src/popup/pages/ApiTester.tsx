import React, { useState, useEffect, useRef } from 'react';
import { ArrowUpTrayIcon, SignalIcon, ClockIcon, XMarkIcon, PlusIcon, BookmarkIcon, BookmarkSlashIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import { ApiRequest, ApiResponse, ApiHistoryItem, SavedRequest } from '../../shared/api-types';
import { parseImport } from '../../shared/import-parser';
import { generateId } from '../../shared/constants';

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
}

function createTab(name?: string): TabData {
  return {
    id: generateId(),
    name: name || '新请求',
    method: 'GET', url: '',
    headers: [['', '']], body: '', bodyType: 'raw',
    response: null, error: '', loading: false,
  };
}

interface Props {
  onCreateRule?: (prefill: { url: string; method: string }) => void;
}

export default function ApiTester({ onCreateRule }: Props) {
  const [tabs, setTabs] = useState<TabData[]>([createTab()]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeSubTab, setActiveSubTab] = useState<'headers' | 'body' | 'response' | 'history' | 'saved'>('headers');
  const [history, setHistory] = useState<ApiHistoryItem[]>([]);
  const [saved, setSaved] = useState<SavedRequest[]>([]);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importedReqs, setImportedReqs] = useState<ApiRequest[]>([]);
  const [saveName, setSaveName] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const tabScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { loadHistory(); loadSaved(); }, []);

  const tab = tabs[activeIdx];

  function updateTab<K extends keyof TabData>(key: K, val: TabData[K]) {
    setTabs(prev => prev.map((t, i) => i === activeIdx ? { ...t, [key]: val } : t));
  }

  function loadHistory() {
    chrome.runtime.sendMessage({ type: 'API_TEST_HISTORY_GET' }, (resp) => {
      if (resp) setHistory(resp);
    });
  }

  function loadSaved() {
    chrome.runtime.sendMessage({ type: 'API_SAVED_GET' }, (resp) => {
      if (resp) setSaved(resp);
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

  async function sendRequest() {
    if (!tab.url.trim()) { updateTab('error', '请输入 URL'); return; }
    updateTab('loading', true);
    updateTab('error', '');
    updateTab('response', null);
    setActiveSubTab('response');

    const h = getHeadersRecord();
    if (tab.body && !hasContentType(h)) {
      h['Content-Type'] = tab.bodyType === 'urlencoded'
        ? 'application/x-www-form-urlencoded'
        : 'application/json';
    }

    const req: ApiRequest = { method: tab.method, url: tab.url.trim(), headers: h, body: tab.body || undefined, bodyType: tab.bodyType as any };
    chrome.runtime.sendMessage({ type: 'API_TEST_REQUEST', payload: req }, (resp) => {
      updateTab('loading', false);
      if (!resp) { updateTab('error', '请求失败：未收到响应'); return; }
      if (resp.error) { updateTab('error', resp.error); return; }
      updateTab('response', resp);
      saveToHistory(req, resp);
    });
  }

  function saveToHistory(req: ApiRequest, resp: ApiResponse) {
    const item: ApiHistoryItem = { id: generateId(), request: req, response: resp, timestamp: Date.now() };
    chrome.runtime.sendMessage({ type: 'API_TEST_HISTORY_SAVE', payload: item }, loadHistory);
  }

  function loadRequestToTab(req: ApiRequest) {
    const name = req.url ? req.url.replace(/^https?:\/\//, '').split('/')[0] : '新请求';
    updateTab('method', req.method);
    updateTab('url', req.url);
    updateTab('name', name);
    const h = Object.entries(req.headers).map(([k, v]) => [k, v] as [string, string]);
    if (h.length === 0) h.push(['', '']);
    updateTab('headers', h);
    updateTab('body', req.body || '');
    updateTab('bodyType', req.bodyType || 'raw');
    updateTab('response', null);
    updateTab('error', '');
    setActiveSubTab('headers');
  }

  function addTab(name?: string) {
    setTabs(prev => [...prev, createTab(name)]);
    setActiveIdx(tabs.length);
  }

  function closeTab(idx: number) {
    if (tabs.length <= 1) return;
    setTabs(prev => {
      const next = prev.filter((_, i) => i !== idx);
      if (activeIdx >= idx && activeIdx > 0) setActiveIdx(activeIdx - 1);
      else if (activeIdx > next.length - 1) setActiveIdx(next.length - 1);
      return next;
    });
  }

  function handleImport() {
    const result = parseImport(importText);
    if (result.requests.length === 0) { updateTab('error', '无法解析输入内容，请检查格式'); return; }
    if (result.requests.length === 1) {
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
      return [...prev, t];
    });
    setActiveIdx(tabs.length);
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

  function confirmSave() {
    const req: ApiRequest = { method: tab.method, url: tab.url, headers: getHeadersRecord(), body: tab.body || undefined, bodyType: tab.bodyType as any };
    const item: SavedRequest = { id: generateId(), name: saveName || '未命名', request: req, timestamp: Date.now() };
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
        </div>
      </div>

      {/* Save dialog */}
      {showSaveDialog && (
        <div className="px-2 py-1.5 border-b border-gray-100 dark:border-slate-700 bg-blue-50 shrink-0 flex gap-1.5 items-center">
          <input type="text" placeholder="请求名称..."
            value={saveName} onChange={e => setSaveName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') confirmSave(); if (e.key === 'Escape') setShowSaveDialog(false); }}
            className="form-input flex-1 text-xs" style={{ padding: '4px 6px', fontSize: 11 }}
            autoFocus />
          <button onClick={confirmSave} className="px-3 py-1 text-xs bg-primary-500 text-white rounded font-medium">保存</button>
          <button onClick={() => setShowSaveDialog(false)} className="px-2 py-1 text-xs text-gray-500">取消</button>
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
              activeSubTab === st.key ? 'border-primary-500 text-primary-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setActiveSubTab(st.key as any)}>
            {st.label}
            {st.badge && <span className="ml-1 text-gray-400">{st.badge}</span>}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeSubTab === 'headers' && (
          <div className="p-2 space-y-1">
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

        {activeSubTab === 'body' && (
          <div className="p-2">
            <div className="flex gap-1.5 mb-1.5">
              {BODY_TYPES.map(bt => (
                <button key={bt.value}
                  className={`px-2 py-0.5 text-xs rounded-full font-medium ${tab.bodyType === bt.value ? 'bg-primary-50 text-primary-600' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                  onClick={() => updateTab('bodyType', bt.value)}>
                  {bt.label}
                </button>
              ))}
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

        {activeSubTab === 'response' && (
          <div className="p-2">
            {tab.error && (
              <div className="p-2 bg-red-50 border border-red-200 rounded-md text-xs text-red-600 mb-2 break-all" style={{ fontSize: 11 }}>
                {tab.error}
              </div>
            )}
            {tab.response && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-gray-500" style={{ fontSize: 11 }}>
                  <span className={`font-bold ${tab.response.status < 400 ? 'text-green-600' : 'text-red-600'}`}>
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
                  <div className="text-xs font-medium text-gray-600 mb-0.5" style={{ fontSize: 11 }}>响应体</div>
                  <pre className="bg-gray-50 dark:bg-slate-900 rounded p-1.5 text-xs max-h-44 overflow-y-auto whitespace-pre-wrap break-all" style={{ fontSize: 10 }}>
                    {formatJson(tab.response.body)}
                  </pre>
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

        {activeSubTab === 'history' && (
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
                      <span className={`text-xs font-mono ${item.response.status < 400 ? 'text-green-500' : 'text-red-500'}`} style={{ fontSize: 10 }}>
                        {item.response.status}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {activeSubTab === 'saved' && (
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
                  onClick={() => loadRequestToTab(item.request)}>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-700 truncate" style={{ fontSize: 11 }}>{item.name}</div>
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
