import React, { useState, useEffect, useRef, useMemo } from 'react';
import Icon from '../components/Icon';
import Select from '../components/Select';
import KeyValueEditor from '../components/KeyValueEditor';
import TabStrip from '../components/TabStrip';
import SearchBar from '../components/SearchBar';
import { Highlight, useMatchNav, useTextareaSearch } from '../components/search';
import { ApiRequest, ApiResponse, ApiHistoryItem, SavedRequest, RequestDiagnostic } from '../../shared/api-types';
import { parseImport } from '../../shared/import-parser';
import { generateId } from '../../shared/constants';
import { showToast, showConfirm } from '../../shared/toast';
import { repairAndFormatJson, minifyJson } from '../../shared/json-format';
import { parseJwtExpiry, humanizeDuration } from '../../shared/jwt';
import { kickCompositorPresent } from '../compositor';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const BODY_TYPES = [
  { value: 'raw', label: 'JSON', icon: 'braces' as const },
  { value: 'urlencoded', label: 'URL Encoded', icon: 'list-tree' as const },
  { value: 'multipart', label: 'Multipart', icon: 'table-2' as const },
];

function readMultipart(body: string): Array<{ name: string; value: string }> {
  try { const v = JSON.parse(body || '[]'); return Array.isArray(v) ? v.map((p: any) => ({ name: String(p?.name ?? ''), value: String(p?.value ?? '') })) : []; } catch { return []; }
}

function hasUnsupportedMultipartFile(body: string): boolean {
  try { const parts = JSON.parse(body || '[]'); return Array.isArray(parts) && parts.some((part: any) => typeof part?.value === 'string' && part.value.startsWith('@')); } catch { return false; }
}

function readUrlEncoded(body: string): Array<{ name: string; value: string }> {
  return Array.from(new URLSearchParams(body || '').entries()).map(([name, value]) => ({ name, value }));
}

function contentTypeFor(bodyType: string): string {
  if (bodyType === 'urlencoded') return 'application/x-www-form-urlencoded';
  if (bodyType === 'multipart') return 'multipart/form-data';
  return 'application/json';
}

function defaultFormPanelHeight(fieldCount: number): number {
  const maxHeight = typeof window === 'undefined' ? 360 : Math.max(92, window.innerHeight - 215);
  return Math.min(maxHeight, Math.max(92, 66 + Math.max(fieldCount, 1) * 31));
}

function convertJsonAndEncoded(body: string, from: BodyType, to: BodyType): { body?: string; reason?: string } {
  if (!body.trim()) return { body: '' };
  if (from === 'raw' && to === 'urlencoded') {
    let value: unknown;
    try { value = JSON.parse(body); } catch { return { reason: 'JSON 格式无效' }; }
    if (!value || Array.isArray(value) || typeof value !== 'object') return { reason: '仅支持 JSON 对象' };
    const params = new URLSearchParams();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== null && typeof item === 'object') return { reason: `字段 ${key} 为数组或嵌套对象` };
      params.append(key, item === null ? '' : String(item));
    }
    return { body: params.toString() };
  }
  if (from === 'urlencoded' && to === 'raw') {
    const entries = Array.from(new URLSearchParams(body).entries());
    const seen = new Set<string>();
    for (const [key] of entries) {
      if (seen.has(key)) return { reason: `存在重复字段 ${key}` };
      seen.add(key);
    }
    return { body: JSON.stringify(Object.fromEntries(entries), null, 2) };
  }
  return { reason: '该请求体类型不支持转换' };
}

type BodyType = 'raw' | 'urlencoded' | 'multipart';

interface TabData {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  bodyType: string;
  bodyDrafts: Partial<Record<BodyType, string>>;
  bodyPanelHeights: Partial<Record<'multipart' | 'urlencoded', number>>;
  response: ApiResponse | null;
  error: string;
  loading: boolean;
  autoRefreshCookie: boolean;
  activeSubTab: 'headers' | 'body' | 'response' | 'history' | 'saved';
  autoSend?: boolean;
  queryParams: { enabled: boolean; key: string; value: string }[];
}

function createTab(name?: string): TabData {
  return {
    id: generateId(),
    name: name || '新请求',
    method: 'GET', url: '',
    headers: [['', '']], body: '', bodyType: 'raw', bodyDrafts: { raw: '' }, bodyPanelHeights: {},
    response: null, error: '', loading: false,
    autoRefreshCookie: false,
    activeSubTab: 'headers',
    queryParams: [],
  };
}

// 标签持久化（UI 专用存储键）：草稿 + 响应。单响应体超上限只存截断标记，避免极端大响应拖慢写盘。
const TABS_KEY = 'apiTesterTabs';
const SAVED_GROUPS_KEY = 'apiSavedGroups';
const MAX_PERSIST_RESP = 2 * 1024 * 1024; // 2MB

interface SavedGroup { id: string; name: string; }

function serializeTabsForStorage(tabs: TabData[]): TabData[] {
  return tabs.map((t) => {
    let response = t.response;
    if (response && response.body && response.body.length > MAX_PERSIST_RESP) {
      response = { ...response, body: '（响应过大，未持久化，请重新发送）' };
    }
    return { ...t, loading: false, autoSend: undefined, response };
  });
}

interface Props {
  onCreateRule?: (prefill: { url: string; method: string }) => void;
  prefillRequest?: ApiRequest | null;
  prefillName?: string;
  onPrefillConsumed?: () => void;
  autoSend?: boolean;
}

function Diagnostic({ diagnostic }: { diagnostic: RequestDiagnostic | null }) {
  if (!diagnostic) return null;
  const tone = diagnostic.level === 'error'
    ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-900 dark:text-red-300'
    : 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300';
  return (
    <div className={`p-2 border rounded-md text-xs mb-2 ${tone}`} style={{ fontSize: 11 }}>
      <div className="font-medium">诊断：{diagnostic.title}</div>
      <div className="mt-0.5 break-all">{diagnostic.message}</div>
      {diagnostic.suggestion && <div className="mt-1 opacity-90">建议：{diagnostic.suggestion}</div>}
    </div>
  );
}

export default function ApiTester({ onCreateRule, prefillRequest, prefillName, onPrefillConsumed, autoSend = false }: Props) {
  const [tabs, setTabs] = useState<TabData[]>([createTab()]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [history, setHistory] = useState<ApiHistoryItem[]>([]);
  const [saved, setSaved] = useState<SavedRequest[]>([]);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importedReqs, setImportedReqs] = useState<ApiRequest[]>([]);
  const [saveName, setSaveName] = useState('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  // 保存对话框：所选分组（''=不分组）与就地新建分组的输入
  const [saveGroupId, setSaveGroupId] = useState('');
  const [saveNewGroup, setSaveNewGroup] = useState('');
  const [saveCreatingGroup, setSaveCreatingGroup] = useState(false);
  const [allowInternal, setAllowInternal] = useState(false);
  const [syncingCookie, setSyncingCookie] = useState(false);
  const [showWhitelist, setShowWhitelist] = useState(false);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [whitelistInput, setWhitelistInput] = useState('');
  const tabScrollRef = useRef<HTMLDivElement>(null);

  // 条件挂载的对话框（保存/导入/白名单）在弹窗被判后台时会出现"已点取消/保存、对话框却
  // 延迟数秒才消失"的推迟呈现（合成器节流出帧，详见 compositor.ts）。开关任一对话框都
  // 踢一下合成器，强制连续出帧把被推迟的那帧顶上屏。
  useEffect(() => { kickCompositorPresent(); }, [showSaveDialog, showImport, showWhitelist]);
  const hydratedRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);
  // 待处理的 prefill 标签：水合(异步读回持久化标签)未完成时暂存于此，
  // 由水合回调在恢复的标签之上统一追加，避免异步恢复把 prefill 标签覆盖掉。
  const pendingPrefillRef = useRef<TabData | null>(null);

  // 已保存请求分组（UI 专用存储键，独立于规则页分组）
  const [savedGroups, setSavedGroups] = useState<SavedGroup[]>([]);
  // 标签内联改名：正在编辑的标签 id
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  // 已保存分组：折叠态（不持久化）与正在重命名的分组 id
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  // 已保存列表：分组筛选（'all' | group.id | 'ungrouped'）与正在“移动到分组”的条目 id
  const [savedFilter, setSavedFilter] = useState<string>('all');
  const [movingItemId, setMovingItemId] = useState<string | null>(null);

  useEffect(() => { loadHistory(); loadSaved(); loadSavedGroups(); }, []);

  // 水合：挂载时读取持久化的标签快照（草稿+响应），恢复时清掉瞬态/一次性字段。
  // 本页每次导航都会重挂载，prefill(日志「重放/到调试」)必与本异步回调竞态：
  // 若已有等待中的 prefill，就在恢复的标签之上追加并激活，避免被 setTabs(restored) 覆盖。
  useEffect(() => {
    chrome.storage.local.get(TABS_KEY, (res) => {
      const snap = res[TABS_KEY];
      const base: TabData[] | null = (snap && Array.isArray(snap.tabs) && snap.tabs.length)
        ? snap.tabs.map((t: Partial<TabData>) => ({ ...createTab(), ...t, loading: false, autoSend: undefined }))
        : null;
      const pending = pendingPrefillRef.current;
      pendingPrefillRef.current = null;
      if (pending) {
        const next = [...(base ?? [createTab()]), pending];
        setTabs(next);
        setActiveIdx(next.length - 1);
      } else if (base) {
        setTabs(base);
        const idx = typeof snap.activeIdx === 'number' ? snap.activeIdx : 0;
        setActiveIdx(Math.min(Math.max(0, idx), base.length - 1));
      }
      hydratedRef.current = true;
    });
  }, []);

  // 持久化：标签变化后防抖 ~500ms 写盘；水合完成前不写（避免默认值覆盖已存内容）
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      chrome.storage.local.set({ [TABS_KEY]: { tabs: serializeTabsForStorage(tabs), activeIdx } });
    }, 500);
    return () => { if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current); };
  }, [tabs, activeIdx]);

  useEffect(() => {
    if (!prefillRequest) return;
    const headers = Object.entries(prefillRequest.headers || {}) as [string, string][];
    const tab: TabData = {
      ...createTab(prefillName || '日志请求'),
      method: prefillRequest.method || 'GET',
      url: prefillRequest.url || '',
      headers: headers.length ? [...headers, ['', '']] : [['', '']],
      body: prefillRequest.body || '',
      bodyType: prefillRequest.bodyType || 'raw',
      bodyDrafts: { [(prefillRequest.bodyType || 'raw') as BodyType]: prefillRequest.body || '' },
      bodyPanelHeights: {},
      activeSubTab: 'headers',
      autoSend,
      queryParams: parseQuery(prefillRequest.url || ''),
    };
    if (!hydratedRef.current) {
      // 水合尚未完成：暂存，交由水合回调在恢复的标签之上统一追加，避免被覆盖
      pendingPrefillRef.current = tab;
      onPrefillConsumed?.();
      return;
    }
    setTabs(prev => [...prev, tab]);
    setActiveIdx(tabs.length);
    onPrefillConsumed?.();
  // prefillRequest is an intentional one-shot command from the parent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillRequest]);

  useEffect(() => {
    const current = tabs[activeIdx];
    if (!current?.autoSend || current.loading) return;
    setTabs(prev => prev.map((t, i) => i === activeIdx ? { ...t, autoSend: false } : t));
    const timer = window.setTimeout(() => sendRequest(), 0);
    return () => window.clearTimeout(timer);
  }, [tabs, activeIdx]);
  useEffect(() => {
    chrome.storage.local.get(['allowInternalNetwork', 'authCaptureWhitelist'], (res) => {
      if (res.allowInternalNetwork === true) setAllowInternal(true);
      if (Array.isArray(res.authCaptureWhitelist)) setWhitelist(res.authCaptureWhitelist);
    });
  }, []);

  const tab = tabs[activeIdx];

  // 已保存请求按分组分段：先各已知分组，再未分组（含 groupId 指向已删分组的条目）
  const groupedSaved = useMemo(() => {
    const knownIds = new Set(savedGroups.map(g => g.id));
    const sections = savedGroups.map(g => ({ group: g, items: saved.filter(s => s.groupId === g.id) }));
    const ungrouped = saved.filter(s => !s.groupId || !knownIds.has(s.groupId));
    return { sections, ungrouped };
  }, [saved, savedGroups]);

  // 关键字搜索：请求体（可编辑 textarea → 原生选区定位）与响应体（只读 → <mark> 高亮 + 滚动定位）
  const bodyTaRef = useRef<HTMLTextAreaElement>(null);
  const [bodySearchOpen, setBodySearchOpen] = useState(false);
  const [bodyQuery, setBodyQuery] = useState('');
  const bodySearch = useTextareaSearch(bodyTaRef, tab?.body ?? '', bodySearchOpen ? bodyQuery : '');

  const respRef = useRef<HTMLDivElement>(null);
  const [respSearchOpen, setRespSearchOpen] = useState(false);
  const [respQuery, setRespQuery] = useState('');
  const respDisplay = useMemo(() => {
    const b = tab?.response?.body ?? '';
    return b.length > 50000 ? b.slice(0, 50000) + '\n\n... (已截断，共 ' + formatSize(b.length) + ')' : b;
  }, [tab?.response?.body]);
  const respPieces = useMemo(() => (respSearchOpen && respDisplay ? [respDisplay] : []), [respSearchOpen, respDisplay]);
  const respNav = useMatchNav(respPieces, respSearchOpen ? respQuery : '');
  useEffect(() => {
    if (!respSearchOpen || !respQuery) return;
    const t = window.setTimeout(() => { respRef.current?.querySelector('[data-search-active]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 0);
    return () => window.clearTimeout(t);
  }, [respNav.index, respQuery, respSearchOpen]);
  useEffect(() => { setBodySearchOpen(false); setBodyQuery(''); setRespSearchOpen(false); setRespQuery(''); }, [activeIdx]);

  function parseQuery(url: string) {
    try { return Array.from(new URL(url).searchParams.entries()).map(([key, value]) => ({ enabled: true, key, value })); }
    catch { return []; }
  }
  function syncQueryFromUrl(url: string) { updateTab('queryParams', parseQuery(url)); }
  function updateQuery(index: number, field: 'enabled' | 'key' | 'value', value: boolean | string) {
    const params = tab.queryParams.map((p, i) => i === index ? { ...p, [field]: value } : p);
    updateTab('queryParams', params);
    try { const u = new URL(tab.url); u.search = ''; params.filter(p => p.enabled && p.key).forEach(p => u.searchParams.append(p.key, p.value)); updateTab('url', u.toString()); } catch { /* incomplete URL */ }
  }
  function addQuery() { updateTab('queryParams', [...tab.queryParams, { enabled: true, key: '', value: '' }]); }
  function removeQuery(index: number) { const params = tab.queryParams.filter((_, i) => i !== index); updateTab('queryParams', params); try { const u = new URL(tab.url); u.search = ''; params.filter(p => p.enabled && p.key).forEach(p => u.searchParams.append(p.key, p.value)); updateTab('url', u.toString()); } catch {} }

  function updateTab<K extends keyof TabData>(key: K, val: TabData[K]) {
    setTabs(prev => prev.map((t, i) => i === activeIdx ? { ...t, [key]: val } : t));
  }

  function renameTab(id: string, name: string) {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, name: name.trim() || '新请求' } : t));
  }

  function updateBody(body: string) {
    const type = tab.bodyType as BodyType;
    setTabs(prev => prev.map((t, i) => i === activeIdx ? { ...t, body, bodyDrafts: { ...t.bodyDrafts, [type]: body } } : t));
  }

  function updatePanelHeight(type: 'multipart' | 'urlencoded', height: number) {
    setTabs(prev => prev.map((t, i) => i === activeIdx ? { ...t, bodyPanelHeights: { ...t.bodyPanelHeights, [type]: height } } : t));
  }

  function growPanelForField(type: 'multipart' | 'urlencoded', nextFieldCount: number) {
    const target = defaultFormPanelHeight(nextFieldCount);
    const current = tab.bodyPanelHeights[type] || defaultFormPanelHeight(nextFieldCount - 1);
    updatePanelHeight(type, Math.max(current, target));
  }

  function changeBodyType(nextType: BodyType) {
    const from = tab.bodyType as BodyType;
    const existingDraft = tab.bodyDrafts[nextType];
    const hasTargetDraft = Object.prototype.hasOwnProperty.call(tab.bodyDrafts, nextType);
    let nextBody = hasTargetDraft ? existingDraft! : (nextType === 'multipart' ? '[]' : '');
    if (!hasTargetDraft && ((from === 'raw' && nextType === 'urlencoded') || (from === 'urlencoded' && nextType === 'raw'))) {
      const converted = convertJsonAndEncoded(tab.body, from, nextType);
      if (converted.body !== undefined) {
        nextBody = converted.body;
        if (converted.body) showToast('请求体已转换；目标接口仍需支持该 Content-Type，否则可能返回错误', 'warning', 4500);
      }
      else showToast(`未转换：${converted.reason}，已打开空白 ${nextType === 'raw' ? 'JSON' : 'URL Encoded'} 请求体`, 'warning');
    }
    setTabs(prev => prev.map((t, i) => {
      if (i !== activeIdx || t.bodyType === nextType) return t;
      const drafts = { ...t.bodyDrafts, [t.bodyType as BodyType]: t.body };
      const headers = [...t.headers];
      const contentTypeIndex = headers.findIndex(([key]) => key.toLowerCase() === 'content-type');
      if (contentTypeIndex >= 0) headers[contentTypeIndex] = [headers[contentTypeIndex][0], contentTypeFor(nextType)];
      else headers.splice(Math.max(0, headers.length - 1), 0, ['Content-Type', contentTypeFor(nextType)]);
      return { ...t, bodyType: nextType, body: nextBody, bodyDrafts: { ...drafts, [nextType]: nextBody }, headers };
    }));
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

  function loadSavedGroups() {
    chrome.storage.local.get(SAVED_GROUPS_KEY, (res) => {
      const list = res[SAVED_GROUPS_KEY];
      if (Array.isArray(list)) setSavedGroups(list);
    });
  }

  function persistSavedGroups(next: SavedGroup[]) {
    setSavedGroups(next);
    chrome.storage.local.set({ [SAVED_GROUPS_KEY]: next });
  }

  function createSavedGroup(name: string): string {
    const id = generateId();
    persistSavedGroups([...savedGroups, { id, name: name.trim() || '未命名分组' }]);
    return id;
  }

  function renameSavedGroup(id: string, name: string) {
    persistSavedGroups(savedGroups.map((g) => (g.id === id ? { ...g, name: name.trim() || g.name } : g)));
  }

  // 换组 / 移出组 / 删组清空归属：都对 savedRequests 直接读改写，避开 API_SAVED_SAVE 的 unshift 去重问题。
  function reassignSavedGroup(reqId: string, groupId: string | undefined) {
    chrome.storage.local.get('savedRequests', (res) => {
      const list: SavedRequest[] = Array.isArray(res.savedRequests) ? res.savedRequests : [];
      const next = list.map((item) => (item.id === reqId ? { ...item, groupId } : item));
      chrome.storage.local.set({ savedRequests: next }, () => loadSaved());
    });
  }

  async function deleteSavedGroup(id: string) {
    const g = savedGroups.find((x) => x.id === id);
    if (!g) return;
    const count = saved.filter((s) => s.groupId === id).length;
    const msg = count > 0
      ? `删除分组「${g.name}」？组内 ${count} 个请求将移到未分组（不会删除请求）。`
      : `删除分组「${g.name}」？`;
    if (!(await showConfirm(msg))) return;
    persistSavedGroups(savedGroups.filter((x) => x.id !== id));
    chrome.storage.local.get('savedRequests', (res) => {
      const list: SavedRequest[] = Array.isArray(res.savedRequests) ? res.savedRequests : [];
      const next = list.map((item) => (item.groupId === id ? { ...item, groupId: undefined } : item));
      chrome.storage.local.set({ savedRequests: next }, () => loadSaved());
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
    if (tab.bodyType === 'multipart' && hasUnsupportedMultipartFile(tab.body)) {
      const error = 'Multipart 包含 cURL 文件字段（@路径），当前版本不能读取本地文件；请移除该字段或手动使用文本值。';
      updateTab('error', error);
      updateTab('activeSubTab', 'response');
      return;
    }
    updateTab('loading', true);
    updateTab('error', '');
    updateTab('response', null);
    updateTab('activeSubTab', 'response');

    const h = getHeadersRecord();
    if (tab.body) {
      const existing = Object.keys(h).find(key => key.toLowerCase() === 'content-type');
      if (existing) h[existing] = contentTypeFor(tab.bodyType);
      else h['Content-Type'] = contentTypeFor(tab.bodyType);
    }

    const req: ApiRequest = { method: tab.method, url: tab.url.trim(), headers: h, body: tab.body || undefined, bodyType: tab.bodyType as any };
    chrome.runtime.sendMessage({ type: 'API_TEST_REQUEST', payload: { ...req, refreshCookie: tab.autoRefreshCookie } }, (resp) => {
      updateTab('loading', false);
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        // 白盒化：区分 context invalidated（需重载）和其他错误
        if (lastErr.message?.includes('Extension context invalidated')) {
          const error = '扩展上下文已失效，请刷新插件 Popup 或重新加载扩展 (chrome://extensions → 刷新)';
          updateTab('error', error);
          saveToHistory(req, undefined, error);
        } else {
          const error = '通信错误: ' + lastErr.message;
          updateTab('error', error);
          saveToHistory(req, undefined, error);
        }
        return;
      }
      if (!resp) {
        const error = '请求失败：后台脚本未响应。请检查扩展是否正常运行，或尝试重新加载扩展。';
        updateTab('error', error);
        saveToHistory(req, undefined, error);
        return;
      }
      if (resp.error) { updateTab('error', resp.error); saveToHistory(req, undefined, resp.error); return; }
      updateTab('response', resp);
      saveToHistory(req, resp);
    });
  }

  function saveToHistory(req: ApiRequest, resp?: ApiResponse, error?: string) {
    const item: ApiHistoryItem = { id: generateId(), request: req, response: resp, error, timestamp: Date.now() };
    chrome.runtime.sendMessage({ type: 'API_TEST_HISTORY_SAVE', payload: item }, loadHistory);
  }

  function loadRequestToTab(req: ApiRequest, autoRefresh = false, tabName?: string) {
    const name = tabName || (req.url ? req.url.replace(/^https?:\/\//, '').split('/')[0] : '新请求');
    const headers = Object.entries(req.headers).map(([k, v]) => [k, v] as [string, string]);
    if (headers.length === 0) headers.push(['', '']);
    const bodyType = (req.bodyType || 'raw') as BodyType;
    const newTab: TabData = {
      ...createTab(name),
      method: req.method || 'GET',
      url: req.url || '',
      headers,
      body: req.body || '',
      bodyType,
      bodyDrafts: { [bodyType]: req.body || '' },
      autoRefreshCookie: autoRefresh,
      activeSubTab: 'headers',
      queryParams: parseQuery(req.url || ''),
    };
    // 从历史 / 已保存 / 日志载入：一律新开标签，不覆盖当前标签
    setTabs(prev => { setActiveIdx(prev.length); return [...prev, newTab]; });
  }

  function addTab(name?: string) {
    setTabs(prev => {
      setActiveIdx(prev.length);
      return [...prev, createTab(name)];
    });
  }

  function closeTab(idx: number) {
    // 允许移除任意标签；移除最后一个则回退为一个空白标签（等价“清空该标签”）
    if (tabs.length <= 1) {
      setTabs([createTab()]);
      setActiveIdx(0);
      return;
    }
    const next = tabs.filter((_, i) => i !== idx);
    setTabs(next);
    setActiveIdx(prev => {
      const n = prev > idx ? prev - 1 : prev;
      return Math.min(Math.max(0, n), next.length - 1);
    });
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
      result.requests[0].unsupported?.forEach(message => showToast(message, 'warning', 6000));
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
      t.bodyDrafts = { [t.bodyType as BodyType]: t.body };
      t.bodyPanelHeights = {};
      setActiveIdx(prev.length);
      return [...prev, t];
    });
    setImportedReqs(prev => prev.filter(x => x !== r));
    if (importedReqs.length <= 1) { setImportText(''); setShowImport(false); }
  }

  function handleSave() {
    // 默认填入当前标签名；标签名仍是初始「新请求」时退回用 URL 推断
    const suggested = tab.url
      ? tab.url.replace(/^https?:\/\//, '').split('/').slice(0, 2).join('/')
      : tab.name;
    setSaveName(tab.name && tab.name !== '新请求' ? tab.name : suggested);
    setSaveGroupId('');
    setSaveNewGroup('');
    setSaveCreatingGroup(false);
    setShowSaveDialog(true);
  }

  function toggleAllowInternal() {
    const next = !allowInternal;
    setAllowInternal(next);
    chrome.storage.local.set({ allowInternalNetwork: next });
  }

  function confirmSave() {
    // 处于“新建分组”态但未填名：给出提示并中止，避免静默存成未分组
    if (saveCreatingGroup && !saveNewGroup.trim()) {
      showToast('请输入新分组名称，或点击 × 取消新建分组', 'warning');
      return;
    }
    // 若正在就地新建分组，先落库分组再用其 id 归属
    const creatingName = saveNewGroup.trim();
    let groupId = saveGroupId || undefined;
    if (saveCreatingGroup && creatingName) groupId = createSavedGroup(creatingName);
    const req: ApiRequest = { method: tab.method, url: tab.url, headers: getHeadersRecord(), body: tab.body || undefined, bodyType: tab.bodyType as any };
    const item: SavedRequest = { id: generateId(), name: saveName || '未命名', request: req, timestamp: Date.now(), autoRefreshCookie: tab.autoRefreshCookie, groupId };
    chrome.runtime.sendMessage({ type: 'API_SAVED_SAVE', payload: item }, () => {
      loadSaved();
      setShowSaveDialog(false);
      setSaveName('');
      setSaveCreatingGroup(false);
      setSaveNewGroup('');
      // 保存反馈：新建分组 / 归入已有分组 / 未分组
      const groupName = saveCreatingGroup && creatingName
        ? creatingName
        : savedGroups.find(g => g.id === groupId)?.name;
      if (saveCreatingGroup && creatingName) showToast(`已保存并新建分组「${groupName}」`, 'success');
      else if (groupName) showToast(`已保存到分组「${groupName}」`, 'success');
      else showToast('已保存请求', 'success');
    });
  }

  function deleteSaved(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'API_SAVED_DELETE', payload: { id } }, loadSaved);
  }

  function toggleGroupCollapse(id: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // 单条已保存请求的行渲染（分组段与未分组段共用）
  function renderSavedItem(item: SavedRequest) {
    const moving = movingItemId === item.id;
    const curGroup = item.groupId && savedGroups.some(g => g.id === item.groupId) ? item.groupId : '';
    return (
      <div key={item.id} className="dark:bg-slate-900">
        <div
          className="px-2 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors group flex items-center"
          onClick={() => loadRequestToTab(item.request, item.autoRefreshCookie, item.name)}>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-200 truncate" style={{ fontSize: 11 }}>
              <span className="truncate">{item.name}</span>
              {item.autoRefreshCookie && (
                <span className="inline-flex shrink-0 text-green-500" aria-label="发送时自动同步登录态" data-tip="自动同步登录态">
                  <Icon name="key-round" size={12} />
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`method-badge method-${item.request.method}`} style={{ fontSize: 9 }}>{item.request.method}</span>
              <span className="text-xs text-gray-400 truncate" style={{ fontSize: 10 }}>{item.request.url}</span>
            </div>
          </div>
          <div className={`flex items-center gap-0.5 shrink-0 ml-1 transition-opacity ${moving ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={(e) => { e.stopPropagation(); setMovingItemId(moving ? null : item.id); }}
              className={`btn-ghost p-1 text-xs ${moving ? 'text-primary-500' : ''}`}
              aria-label="移动到分组"
              aria-expanded={moving}
              data-tip="移动到分组">
              <Icon name="folder-input" size={14} />
            </button>
            {onCreateRule && (
              <button
                onClick={(e) => { e.stopPropagation(); onCreateRule({ url: item.request.url, method: item.request.method }); }}
                className="btn-ghost p-1 text-xs"
                aria-label="创建规则"
                data-tip="创建规则">
                <Icon name="plus" size={14} />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); copyToClipboard(requestToCurl(item.request)); }}
              className="btn-ghost p-1 text-xs"
              aria-label="复制 cURL（敏感请求头将脱敏）"
              data-tip="复制 cURL（脱敏）"
            >
              <Icon name="copy" size={14} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); copyToClipboard(requestToCurl(item.request, true)); }}
              className="btn-ghost p-1 text-xs relative"
              style={{ color: 'var(--warn-fg)' }}
              aria-label="复制完整 cURL（包含敏感请求头）"
              data-tip="复制完整 cURL"
            >
              <Icon name="copy" size={14} />
              <span className="absolute rounded-full" style={{ top: 1, right: 1, width: 5, height: 5, background: 'var(--warn-fg)' }} />
            </button>
            <button
              onClick={(e) => deleteSaved(item.id, e)}
              className="btn-ghost p-1 text-xs"
              aria-label="删除已保存请求"
              data-tip="删除请求">
              <Icon name="trash-2" size={14} />
            </button>
          </div>
        </div>
        {moving && (
          <div className="px-2 pb-2 pt-0.5 flex flex-wrap items-center gap-1 bg-gray-50 dark:bg-slate-800/60" onClick={(e) => e.stopPropagation()}>
            <span className="text-xs text-gray-400 mr-0.5" style={{ fontSize: 10 }}>移动到</span>
            <button
              disabled={!curGroup}
              onClick={() => { reassignSavedGroup(item.id, undefined); setMovingItemId(null); }}
              className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${!curGroup ? 'border-primary-300 bg-primary-50 text-primary-600 dark:bg-primary-900/30 cursor-default' : 'border-gray-200 dark:border-slate-600 text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-slate-700'}`}
              style={{ fontSize: 10 }}>未分组</button>
            {savedGroups.map(g => (
              <button
                key={g.id}
                disabled={curGroup === g.id}
                onClick={() => { reassignSavedGroup(item.id, g.id); setMovingItemId(null); }}
                className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${curGroup === g.id ? 'border-primary-300 bg-primary-50 text-primary-600 dark:bg-primary-900/30 cursor-default' : 'border-gray-200 dark:border-slate-600 text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-slate-700'}`}
                style={{ fontSize: 10 }}>{g.name}</button>
            ))}
            <button
              onClick={() => setMovingItemId(null)}
              className="px-1.5 py-0.5 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 ml-auto"
              style={{ fontSize: 10 }}>取消</button>
          </div>
        )}
      </div>
    );
  }

  function formatJson(s: string): string {
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
  }

  // 请求体「格式化」按钮：合法则美化；非法则尝试自动修复常见错误并填入，仍失败给带原因/位置的提示
  function formatBody() {
    if (!tab.body.trim()) return;
    const r = repairAndFormatJson(tab.body);
    if (r.ok) {
      updateBody(r.text);
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
      updateBody(r.text);
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
        return `<span class="json-string">${m}</span>`;
      })
      .replace(/\b(true|false)\b/g, '<span class="json-boolean">$1</span>')
      .replace(/\b(null)\b/g, '<span class="json-boolean">$1</span>')
      .replace(/\b(-?\d+\.?\d*([eE][+-]?\d+)?)\b/g, '<span class="json-number">$1</span>');
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => showToast('已复制到剪贴板', 'success')).catch(() => showToast('复制失败，请检查剪贴板权限', 'error'));
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }

  function requestToCurl(req: ApiRequest, includeSensitive = false): string {
    const lines = [`curl ${shellQuote(req.url)}`, `  -X ${req.method}`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (!key.trim()) continue;
      if (req.bodyType === 'multipart' && key.toLowerCase() === 'content-type') continue;
      const safeValue = !includeSensitive && /^(authorization|cookie|x-api-key)$/i.test(key) ? '***' : value;
      lines.push(`  -H ${shellQuote(`${key}: ${safeValue}`)}`);
    }
    if (req.body && !/^(GET|HEAD)$/i.test(req.method)) {
      if (req.bodyType === 'multipart') {
        const parts = readMultipart(req.body);
        if (parts.length) parts.forEach(part => lines.push(`  --form-string ${shellQuote(`${part.name}=${part.value}`)}`));
        else lines.push(`  --data-raw ${shellQuote(req.body)}`);
      } else lines.push(`  --data-raw ${shellQuote(req.body)}`);
    }
    return lines.join(' \\\n');
  }

  function getDiagnostic(response?: ApiResponse, error?: string): RequestDiagnostic | null {
    if (error) {
      if (/SSRF|内网|私有地址/i.test(error)) return { level: 'error', title: '安全策略已拦截请求', message: error, suggestion: '如确需访问内网地址，请在 API 测试器中明确开启内网访问。' };
      if (/timeout|超时/i.test(error)) return { level: 'error', title: '请求超时', message: error, suggestion: '检查服务可用性、网络状况或接口响应耗时。' };
      if (/cors/i.test(error)) return { level: 'error', title: '跨域请求受限', message: error, suggestion: '确认目标服务的 CORS 配置，或改用允许的测试环境。' };
      return { level: 'error', title: '请求未完成', message: error, suggestion: '检查 URL、网络连接与扩展运行状态。' };
    }
    if (!response) return null;
    const status = response.status;
    if (status === 401) return { level: 'error', title: '未认证或登录态已失效', message: '服务返回 401 Unauthorized。', suggestion: '尝试同步当前页面登录态，或检查 Authorization 请求头。' };
    if (status === 403) return { level: 'error', title: '请求无权限', message: '服务返回 403 Forbidden。', suggestion: '确认账号权限、Token 作用域或接口访问策略。' };
    if (status === 404) return { level: 'error', title: '接口不存在', message: '服务返回 404 Not Found。', suggestion: '检查 URL、方法与环境域名是否正确。' };
    if (status === 408 || status === 504) return { level: 'error', title: '服务响应超时', message: `服务返回 ${status}。`, suggestion: '检查上游服务、网关配置或稍后重试。' };
    if (status === 429) return { level: 'warning', title: '请求频率受限', message: '服务返回 429 Too Many Requests。', suggestion: '降低请求频率，或等待限流窗口恢复。' };
    if (status >= 500) return { level: 'error', title: '服务端错误', message: `服务返回 ${status} ${response.statusText}。`, suggestion: '检查服务端日志或稍后重试。' };
    const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
    if (/json/i.test(contentType) && response.body.trim()) {
      try { JSON.parse(response.body); } catch { return { level: 'warning', title: '响应 JSON 格式异常', message: 'Content-Type 声明为 JSON，但响应体无法解析。', suggestion: '检查服务端序列化结果或查看原始响应体。' }; }
    }
    return null;
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
        <div ref={tabScrollRef} className="flex-1 flex items-center overflow-x-auto api-tab-scroll">
          {tabs.map((t, i) => (
            <div
              key={t.id}
              onClick={() => setActiveIdx(i)}
              className={`flex items-center gap-1 px-2 h-7 text-xs cursor-pointer border-r border-gray-200 dark:border-slate-700 shrink-0 max-w-[120px] ${
                i === activeIdx ? 'bg-white dark:bg-slate-800 text-primary-600 font-medium' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              <span className={`method-badge method-${t.method} scale-75`}>{t.method}</span>
              {editingTabId === t.id ? (
                <input
                  autoFocus
                  defaultValue={t.name}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => { renameTab(t.id, e.currentTarget.value); setEditingTabId(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { renameTab(t.id, e.currentTarget.value); setEditingTabId(null); }
                    else if (e.key === 'Escape') { setEditingTabId(null); }
                  }}
                  className="form-input min-w-0 flex-1 text-xs"
                  style={{ padding: '0 2px', fontSize: 11, width: 66 }}
                />
              ) : (
                <span
                  className="truncate"
                  onClick={(e) => { if (i === activeIdx) { e.stopPropagation(); setEditingTabId(t.id); } }}
                  onDoubleClick={(e) => { e.stopPropagation(); setActiveIdx(i); setEditingTabId(t.id); }}
                >{t.name}</span>
              )}
              {editingTabId !== t.id && (
                <span className="inline-flex shrink-0">
                  <Icon
                    name="x"
                    size={12}
                    className="text-gray-400 hover:text-red-500"
                    aria-label="关闭标签"
                    onClick={(e) => { e.stopPropagation(); closeTab(i); }}
                  />
                </span>
              )}
            </div>
          ))}
        </div>
        <button
          onClick={() => addTab()}
          className="px-2 text-gray-400 hover:text-primary-500 shrink-0"
          aria-label="新建请求标签"
          data-tip="新建标签"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      {/* URL Bar */}
      <div className="px-2 py-1.5 border-b border-gray-100 dark:border-slate-700 shrink-0">
        <div className="flex gap-1.5">
          <Select value={tab.method} onChange={v => updateTab('method', v)}
            options={METHODS.map(m => ({ value: m, label: m }))}
            ariaLabel="请求方法" className="shrink-0" style={{ width: 78, fontSize: 11 }} />
          <input type="text" placeholder="输入 URL..."
            value={tab.url} onChange={e => { updateTab('url', e.target.value); syncQueryFromUrl(e.target.value); if (!tabs[activeIdx].name || tabs[activeIdx].name === '新请求') { const d = e.target.value.replace(/^https?:\/\//, '').split('/')[0]; if (d) updateTab('name', d); } }}
            onKeyDown={e => e.key === 'Enter' && sendRequest()}
            className="form-input flex-1 text-xs" style={{ minWidth: 0, padding: '4px 8px', fontSize: 11 }} />
          <button onClick={sendRequest} disabled={tab.loading} className="btn-primary whitespace-nowrap">
            <Icon name="send" size={15} />{tab.loading ? '发送中...' : '发送'}
          </button>
          <button onClick={handleSave}
            className="btn-ghost"
            aria-label="保存请求"
            data-tip="保存请求">
            <Icon name="bookmark" size={16} />
          </button>
          <button onClick={() => setShowImport(!showImport)}
            className="btn-ghost"
            aria-label="导入 cURL / HTTPie / OpenAPI"
            data-tip="导入请求">
            <Icon name="clipboard-paste" size={16} />
          </button>
          <button onClick={toggleAllowInternal}
            className={`px-2 py-1 text-xs border rounded-md transition-colors ${
              allowInternal
                ? 'border-green-300 bg-green-50 text-green-700 dark:border-green-600 dark:bg-green-900/30 dark:text-green-400'
                : 'border-gray-200 text-amber-500 dark:border-slate-700 dark:bg-slate-900 dark:text-amber-400'
            }`}
            aria-label={allowInternal ? '允许访问内网地址（点击关闭）' : '内网地址已拦截（点击放行）'}
            data-tip={allowInternal ? '内网已放行' : '内网已拦截'}>
            <Icon name={allowInternal ? 'shield-check' : 'shield-alert'} size={14} />
          </button>
        </div>
      </div>

      {tab.queryParams.length > 0 && (
        <div className="px-2 py-1.5 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 shrink-0">
          <div className="flex items-center justify-between mb-1"><span className="text-xs font-semibold text-gray-500 dark:text-slate-400">Query 参数</span><button onClick={addQuery} className="btn-ghost p-0.5 text-xs">+ 添加</button></div>
          <div className="space-y-1 max-h-24 overflow-y-auto">{tab.queryParams.map((p, i) => <div key={i} className="flex items-center gap-1"><input type="checkbox" checked={p.enabled} onChange={e => updateQuery(i, 'enabled', e.target.checked)} className="w-3 h-3" /><input value={p.key} onChange={e => updateQuery(i, 'key', e.target.value)} placeholder="参数名" className="form-input text-xs flex-1" style={{ padding: '3px 5px', fontSize: 11 }} /><input value={p.value} onChange={e => updateQuery(i, 'value', e.target.value)} placeholder="参数值" className="form-input text-xs flex-1" style={{ padding: '3px 5px', fontSize: 11 }} /><button onClick={() => removeQuery(i)} className="btn-ghost p-0.5 text-gray-400 hover:text-red-500" title="删除参数">×</button></div>)}</div>
        </div>
      )}

      {/* Save dialog */}
      {showSaveDialog && (
        <div className="px-2 py-1.5 border-b border-gray-100 dark:border-slate-700 bg-blue-50 dark:bg-slate-900 shrink-0 space-y-1.5">
          <div className="flex gap-1.5 items-center">
            <input type="text" placeholder="请求名称..."
              value={saveName} onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmSave(); if (e.key === 'Escape') setShowSaveDialog(false); }}
              className="form-input flex-1 text-xs" style={{ padding: '4px 6px', fontSize: 11 }}
              autoFocus />
            <button onClick={confirmSave} className="btn-primary">保存</button>
            <button onClick={() => setShowSaveDialog(false)} className="btn-secondary">取消</button>
          </div>
          <div className="flex gap-1.5 items-center">
            <span className="text-xs text-gray-500 dark:text-slate-400 shrink-0" style={{ fontSize: 11 }}>分组</span>
            {saveCreatingGroup ? (
              <>
                <input type="text" placeholder="新分组名称..." autoFocus
                  value={saveNewGroup} onChange={e => setSaveNewGroup(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') confirmSave(); if (e.key === 'Escape') { setSaveCreatingGroup(false); setSaveNewGroup(''); } }}
                  className="form-input flex-1 text-xs" style={{ padding: '4px 6px', fontSize: 11 }} />
                <button onClick={() => { setSaveCreatingGroup(false); setSaveNewGroup(''); }} className="btn-ghost p-1 text-xs" aria-label="取消新建分组" data-tip="取消新建分组"><Icon name="x" size={14} /></button>
              </>
            ) : (
              <Select
                value={saveGroupId}
                onChange={(v) => { if (v === '__new__') { setSaveCreatingGroup(true); setSaveGroupId(''); } else setSaveGroupId(v); }}
                options={[
                  { value: '', label: '不分组' },
                  ...savedGroups.map(g => ({ value: g.id, label: g.name })),
                  { value: '__new__', label: '＋ 新建分组…' },
                ]}
                ariaLabel="保存到分组" className="flex-1" style={{ fontSize: 11 }} />
            )}
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
            <button onClick={handleImport} className="btn-primary">解析</button>
            <button onClick={() => { setShowImport(false); setImportText(''); setImportedReqs([]); }}
              className="btn-secondary">取消</button>
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
      <TabStrip
        tabs={SUB_TABS.map(st => ({ key: st.key, label: st.label, count: st.badge }))}
        active={tab.activeSubTab}
        onChange={(key) => updateTab('activeSubTab', key as any)}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {tab.activeSubTab === 'headers' && (
          <div className="p-2 space-y-1">
            <div className="flex items-center gap-2 mb-1.5 pb-1.5 border-b border-gray-100 dark:border-slate-700">
              <button onClick={syncLoginState} disabled={syncingCookie || !tab.url.trim()}
                className="flex items-center gap-1 px-2 py-1 text-xs border border-gray-200 dark:border-slate-700 rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
                title={!tab.url.trim() ? '请先填写 URL' : '从浏览器读取该域名当前有效的 Cookie 及捕获到的 Authorization/token 认证头，写入请求头'}>
                <Icon name="refresh-cw" size={14} className={syncingCookie ? 'animate-spin' : ''} />
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
                <Icon name="list-filter" size={14} />
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
                  <button onClick={addWhitelist} className="btn-primary whitespace-nowrap">添加</button>
                </div>
                {whitelist.length === 0 ? (
                  <div className="text-xs text-gray-400" style={{ fontSize: 10 }}>（当前：抓取所有站点）</div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {whitelist.map(d => (
                      <span key={d} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded" style={{ fontSize: 10 }}>
                        {d}
                        <Icon name="x" size={12} className="text-gray-400 hover:text-gray-600 cursor-pointer" aria-label="移除白名单域名" onClick={() => removeWhitelist(d)} />
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
                    className="btn-ghost p-0.5" aria-label="删除请求头" title="删除请求头"><Icon name="x" size={12} /></button>
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
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full font-medium ${tab.bodyType === bt.value ? 'bg-primary-50 text-primary-600' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                  onClick={() => changeBodyType(bt.value as BodyType)}>
                  <Icon name={bt.icon} size={12} />
                  {bt.label}
                </button>
              ))}
              {tab.bodyType === 'raw' && (
                <div className="ml-auto flex items-center gap-1.5">
                  <button onClick={() => setBodySearchOpen(o => !o)}
                    className={`btn-ghost p-1 ${bodySearchOpen ? 'text-primary-600' : ''}`}
                    aria-label="搜索请求体" data-tip="搜索关键字">
                    <Icon name="search" size={14} />
                  </button>
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
            {tab.bodyType === 'multipart' && (() => {
              const fields = readMultipart(tab.body);
              const setFields = (next: Array<{name: string; value: string}>) => updateBody(JSON.stringify(next));
              const height = tab.bodyPanelHeights.multipart || defaultFormPanelHeight(fields.length);
              return <KeyValueEditor
                fields={fields}
                onChange={setFields}
                height={height}
                onHeightChange={(px) => updatePanelHeight('multipart', px)}
                onAdd={() => { growPanelForField('multipart', fields.length + 1); setFields([...fields, { name: '', value: '' }]); }}
              />;
            })()}
            {tab.bodyType === 'urlencoded' && (() => {
              const fields = readUrlEncoded(tab.body);
              const setFields = (next: Array<{name: string; value: string}>) => { const params = new URLSearchParams(); next.forEach(p => params.append(p.name, p.value)); updateBody(params.toString()); };
              const height = tab.bodyPanelHeights.urlencoded || defaultFormPanelHeight(fields.length);
              return <KeyValueEditor
                fields={fields}
                onChange={setFields}
                height={height}
                onHeightChange={(px) => updatePanelHeight('urlencoded', px)}
                onAdd={() => { growPanelForField('urlencoded', fields.length + 1); setFields([...fields, { name: '', value: '' }]); }}
              />;
            })()}
            {tab.bodyType === 'raw' && bodySearchOpen && (
              <div className="mb-1.5">
                <SearchBar
                  query={bodyQuery}
                  onQueryChange={setBodyQuery}
                  count={bodySearch.count}
                  index={bodySearch.index}
                  onNext={bodySearch.next}
                  onPrev={bodySearch.prev}
                  onClose={() => { setBodySearchOpen(false); setBodyQuery(''); }}
                  placeholder="在请求体中搜索…"
                />
              </div>
            )}
            {tab.bodyType === 'raw' && <textarea
              ref={bodyTaRef}
              placeholder="请求体..."
              value={tab.body}
              onChange={e => updateBody(e.target.value)}
              rows={7}
              className="form-textarea w-full" style={{ fontSize: 11 }}
            />}
          </div>
        )}

        {tab.activeSubTab === 'response' && (
          <div className="p-2">
            {tab.error && (
              <Diagnostic diagnostic={getDiagnostic(undefined, tab.error)} />
            )}
            {tab.response && getDiagnostic(tab.response) && (
              <Diagnostic diagnostic={getDiagnostic(tab.response)} />
            )}
            {tab.error && !getDiagnostic(undefined, tab.error) && (
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
                <div ref={respRef}>
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="text-xs font-medium text-gray-600" style={{ fontSize: 11 }}>响应体</div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setRespSearchOpen(o => !o)}
                        className={`btn-ghost p-1 ${respSearchOpen ? 'text-primary-600' : ''}`}
                        aria-label="搜索响应体"
                        data-tip="搜索关键字"
                      >
                        <Icon name="search" size={14} />
                      </button>
                      <button
                        onClick={() => copyToClipboard(formatJson(tab.response!.body))}
                        className="btn-ghost p-1"
                        aria-label="复制响应体"
                        data-tip="复制响应体"
                      >
                        <Icon name="copy" size={14} />
                      </button>
                    </div>
                  </div>
                  {respSearchOpen && (
                    <div className="mb-1.5">
                      <SearchBar
                        query={respQuery}
                        onQueryChange={setRespQuery}
                        count={respNav.total}
                        index={respNav.index}
                        onNext={respNav.next}
                        onPrev={respNav.prev}
                        onClose={() => { setRespSearchOpen(false); setRespQuery(''); }}
                        placeholder="在响应体中搜索…"
                      />
                    </div>
                  )}
                  <pre
                    className="bg-gray-50 dark:bg-slate-900 text-gray-800 dark:text-slate-200 border border-gray-200 dark:border-slate-700 rounded p-1.5 text-xs whitespace-pre-wrap break-all"
                    style={{ fontSize: 10, fontFamily: "'SF Mono', 'Fira Code', Consolas, monospace" }}
                  >
                    {respSearchOpen && respQuery
                      ? <Highlight text={respDisplay} query={respQuery} base={0} activeIndex={respNav.index} />
                      : <span dangerouslySetInnerHTML={{ __html: highlightJson(respDisplay) }} />}
                  </pre>
                </div>
              </div>
            )}
            {!tab.error && !tab.response && !tab.loading && (
              <div className="empty-state" style={{ padding: '24px 16px' }}>
                <Icon name="activity" size={24} className="text-gray-300 mx-auto" />
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
                <Icon name="clock-3" size={24} className="text-gray-300 mx-auto" />
                <div className="title" style={{ fontSize: 12 }}>暂无请求历史</div>
              </div>
            ) : (
              history.map((item) => (
                <div key={item.id}
                  className="px-2 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-slate-900 transition-colors group"
                  onClick={() => loadRequestToTab(item.request)}>
                  <div className="flex items-center gap-1.5">
                    <span className={`method-badge method-${item.request.method}`} style={{ fontSize: 9 }}>{item.request.method}</span>
                    <span className="text-xs text-gray-500 truncate flex-1" style={{ fontSize: 10 }}>{item.request.url}</span>
                    {item.response && (
                      <span className={`text-xs font-mono ${item.response.status < 300 ? 'text-green-500' : item.response.status < 400 ? 'text-amber-500' : 'text-red-500'}`} style={{ fontSize: 10 }}>
                        {item.response.status}
                      </span>
                    )}
                    <div className="flex items-center gap-0.5 shrink-0 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); copyToClipboard(requestToCurl(item.request)); }}
                        className="btn-ghost p-1 text-xs"
                        aria-label="复制 cURL（敏感请求头将脱敏）"
                        data-tip="复制 cURL（脱敏）"
                      >
                        <Icon name="copy" size={14} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); copyToClipboard(requestToCurl(item.request, true)); }}
                        className="btn-ghost p-1 text-xs relative"
                        style={{ color: 'var(--warn-fg)' }}
                        aria-label="复制完整 cURL（包含敏感请求头）"
                        data-tip="复制完整 cURL"
                      >
                        <Icon name="copy" size={14} />
                        <span className="absolute rounded-full" style={{ top: 1, right: 1, width: 5, height: 5, background: 'var(--warn-fg)' }} />
                      </button>
                    </div>
                  </div>
                  {getDiagnostic(item.response, item.error) && (
                    <div className={`mt-1 text-xs truncate ${getDiagnostic(item.response, item.error)!.level === 'error' ? 'text-red-500' : 'text-amber-600'}`} style={{ fontSize: 10 }}>
                      {getDiagnostic(item.response, item.error)!.title}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {tab.activeSubTab === 'saved' && (
          <div>
            {saved.length === 0 && savedGroups.length === 0 ? (
              <div className="empty-state" style={{ padding: '24px 16px' }}>
                <Icon name="bookmark-x" size={24} className="text-gray-300 mx-auto" />
                <div className="title" style={{ fontSize: 12 }}>暂无已保存请求</div>
                <div className="desc" style={{ fontSize: 11 }}>点击书签图标保存请求</div>
              </div>
            ) : (() => {
              // 分组筛选：筛选值指向已删分组时回退到“全部”
              const known = savedGroups.some(g => g.id === savedFilter);
              const effFilter = savedFilter === 'all' || savedFilter === 'ungrouped' || known ? savedFilter : 'all';
              const single = effFilter !== 'all';
              const visibleSections = groupedSaved.sections.filter(({ group }) => effFilter === 'all' || group.id === effFilter);
              const showUngrouped = (effFilter === 'all' || effFilter === 'ungrouped') && groupedSaved.ungrouped.length > 0;
              return (
              <>
                {savedGroups.length > 0 && (
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-100 dark:border-slate-700 overflow-x-auto api-tab-scroll bg-gray-50/60 dark:bg-slate-900">
                    {[{ id: 'all', name: '全部', count: saved.length },
                      ...savedGroups.map(g => ({ id: g.id, name: g.name, count: saved.filter(s => s.groupId === g.id).length })),
                      ...(groupedSaved.ungrouped.length > 0 ? [{ id: 'ungrouped', name: '未分组', count: groupedSaved.ungrouped.length }] : [])].map(chip => (
                      <button
                        key={chip.id}
                        onClick={() => setSavedFilter(chip.id)}
                        className={`px-2 py-0.5 rounded-full text-xs border shrink-0 transition-colors ${effFilter === chip.id ? 'border-primary-300 bg-primary-50 text-primary-600 dark:bg-primary-900/30 dark:border-primary-700 font-medium' : 'border-gray-200 dark:border-slate-600 text-gray-500 dark:text-gray-400 hover:bg-white dark:hover:bg-slate-700'}`}
                        style={{ fontSize: 10 }}>
                        {chip.name}<span className="opacity-60 ml-1">{chip.count}</span>
                      </button>
                    ))}
                  </div>
                )}
                {visibleSections.map(({ group, items }) => {
                  const collapsed = !single && collapsedGroups.has(group.id);
                  return (
                    <div key={group.id}>
                      <div
                        className="flex items-center gap-1 px-2 py-1 bg-gray-50 dark:bg-slate-900 border-b border-gray-100 dark:border-slate-700 cursor-pointer group/hdr sticky top-0 z-10"
                        onClick={() => !single && toggleGroupCollapse(group.id)}>
                        {!single && <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} className="text-gray-400 shrink-0" />}
                        <Icon name="tag" size={12} className="text-gray-400 shrink-0" />
                        {editingGroupId === group.id ? (
                          <input
                            autoFocus
                            defaultValue={group.name}
                            onClick={(e) => e.stopPropagation()}
                            onFocus={(e) => e.currentTarget.select()}
                            onBlur={(e) => { renameSavedGroup(group.id, e.currentTarget.value); setEditingGroupId(null); }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { renameSavedGroup(group.id, e.currentTarget.value); setEditingGroupId(null); }
                              else if (e.key === 'Escape') { setEditingGroupId(null); }
                            }}
                            className="form-input text-xs flex-1 min-w-0" style={{ padding: '1px 4px', fontSize: 11 }} />
                        ) : (
                          <span className="text-xs font-medium text-gray-600 dark:text-gray-300 truncate flex-1" style={{ fontSize: 11 }}>{group.name}</span>
                        )}
                        <span className="text-xs text-gray-400 shrink-0" style={{ fontSize: 10 }}>{items.length}</span>
                        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/hdr:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => setEditingGroupId(group.id)} className="btn-ghost p-1 text-xs" aria-label="重命名分组" data-tip="重命名分组"><Icon name="pencil" size={13} /></button>
                          <button onClick={() => deleteSavedGroup(group.id)} className="btn-ghost p-1 text-xs" aria-label="删除分组" data-tip="删除分组"><Icon name="trash-2" size={13} /></button>
                        </div>
                      </div>
                      {!collapsed && (
                        items.length === 0
                          ? <div className="px-2 py-2 text-xs text-gray-400 dark:text-slate-500" style={{ fontSize: 10 }}>（空分组，可将请求移动到此）</div>
                          : <div className="divide-y divide-gray-50 dark:divide-gray-700">{items.map(renderSavedItem)}</div>
                      )}
                    </div>
                  );
                })}
                {showUngrouped && (
                  <div>
                    {savedGroups.length > 0 && !single && (
                      <div className="flex items-center gap-1 px-2 py-1 bg-gray-50 dark:bg-slate-900 border-b border-gray-100 dark:border-slate-700 sticky top-0 z-10">
                        <Icon name="tag" size={12} className="text-gray-300 shrink-0" />
                        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 flex-1" style={{ fontSize: 11 }}>未分组</span>
                        <span className="text-xs text-gray-400 shrink-0" style={{ fontSize: 10 }}>{groupedSaved.ungrouped.length}</span>
                      </div>
                    )}
                    <div className="divide-y divide-gray-50 dark:divide-gray-700">{groupedSaved.ungrouped.map(renderSavedItem)}</div>
                  </div>
                )}
              </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
