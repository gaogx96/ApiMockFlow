import React, { useState, useEffect, useRef, useMemo } from 'react';
import Icon from '../components/Icon';
import Select from '../components/Select';
import KeyValueEditor from '../components/KeyValueEditor';
import TabStrip from '../components/TabStrip';
import SearchBar from '../components/SearchBar';
import { Highlight, useMatchNav, useTextareaSearch } from '../components/search';
import { ApiRequest, ApiResponse, ApiHistoryItem, SavedRequest } from '../../shared/api-types';
import { parseImport } from '../../shared/import-parser';
import { generateId } from '../../shared/constants';
import { showToast, showConfirm } from '../../shared/toast';
import { repairAndFormatJson, minifyJson } from '../../shared/json-format';
import { parseJwtExpiry, humanizeDuration } from '../../shared/jwt';
import { resolveDynamicVars, hasDynamicVars, decodeDynamicVars, DYNAMIC_VAR_TOKENS } from '../../shared/dynamic-vars';
import { detectTimestamps, applyTimestamps, TsCandidate } from '../../shared/timestamp-detect';
import { kickCompositorPresent } from '../compositor';
// 纯逻辑与无状态子组件已抽到同级模块（行为逐字不变，见 ApiTester.helpers.ts / ApiTester.parts.tsx）。
import {
  BodyType, TabData, SavedGroup, FieldTarget,
  METHODS, BODY_TYPES, MAX_PERSIST_RESP,
  readMultipart, hasUnsupportedMultipartFile, readUrlEncoded, contentTypeFor,
  defaultFormPanelHeight, convertJsonAndEncoded, createTab, serializeTabsForStorage,
  formatJson, highlightJson, shellQuote, requestToCurl, getDiagnostic, formatSize, copyToClipboard,
} from './ApiTester.helpers';
import { Diagnostic } from './ApiTester.parts';

// 标签持久化（UI 专用存储键）：草稿 + 响应。上限 MAX_PERSIST_RESP 与相关序列化逻辑见 helpers。
const TABS_KEY = 'apiTesterTabs';
const SAVED_GROUPS_KEY = 'apiSavedGroups';

interface Props {
  onCreateRule?: (prefill: { url: string; method: string }) => void;
  prefillRequest?: ApiRequest | null;
  prefillName?: string;
  onPrefillConsumed?: () => void;
  autoSend?: boolean;
}

export default function ApiTester({ onCreateRule, prefillRequest, prefillName, onPrefillConsumed, autoSend = false }: Props) {
  const [tabs, setTabs] = useState<TabData[]>([createTab()]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [history, setHistory] = useState<ApiHistoryItem[]>([]);
  const [saved, setSaved] = useState<SavedRequest[]>([]);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importedReqs, setImportedReqs] = useState<ApiRequest[]>([]);
  // 导入结果列表高度（px）：null=按窗口/条数自适应默认值；用户拖拽 resize 后记住本次会话的选择。
  const [importListHeight, setImportListHeight] = useState<number | null>(null);
  // 导入时的时间戳检测-确认：命中固定时间戳时，先让用户勾选是否转成动态占位符
  const [tsReview, setTsReview] = useState<{ req: ApiRequest; candidates: TsCandidate[]; selected: Set<string> } | null>(null);
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
  // 「已打开过的网站」实时快照：白名单从这里勾选，而非手填（见 loadOpenedSites）。
  const [openedSites, setOpenedSites] = useState<string[]>([]);
  const tabScrollRef = useRef<HTMLDivElement>(null);

  // 条件挂载的对话框（保存/导入/白名单）在弹窗被判后台时会出现"已点取消/保存、对话框却
  // 延迟数秒才消失"的推迟呈现（合成器节流出帧，详见 compositor.ts）。开关任一对话框都
  // 踢一下合成器，强制连续出帧把被推迟的那帧顶上屏。
  useEffect(() => { kickCompositorPresent(); }, [showSaveDialog, showImport, showWhitelist]);
  // 打开白名单面板时刷新「已打开过的网站」清单（新开的标签自动出现在可选项里）。
  useEffect(() => { if (showWhitelist) loadOpenedSites(); }, [showWhitelist]);
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
  const urlInputRef = useRef<HTMLInputElement>(null);
  // 记录最近获得焦点的可编辑字段，供“插入动态变量”按钮把占位符插到光标处。
  // 存「位置描述」而非闭包：点击插入时用当前渲染的最新函数写回，避免捕获到过期的 tab 状态。
  const activeFieldRef = useRef<{ el: HTMLInputElement | HTMLTextAreaElement; target: FieldTarget } | null>(null);
  // 切换标签后旧字段的 DOM 已不属于当前请求，清空以免插入到不可见字段（默认退化为 URL）
  useEffect(() => { activeFieldRef.current = null; }, [activeIdx]);
  // 「更多」溢出菜单（内网放行 + 插入时间戳等低频项）：向下展开、右对齐；点外部/Esc 关闭
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => { if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) setMoreOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [moreOpen]);
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
  // 用查询参数重建 URL：URLSearchParams 会把 {{$ts}} 编码成 %7B%7B%24ts%7D%7D，
  // 这里重建后立即把动态占位符还原为明文，否则发送时正则匹配不到、会把编码占位符原样发出。
  function rebuildUrlFromParams(params: { enabled: boolean; key: string; value: string }[]) {
    try {
      const u = new URL(tab.url); u.search = '';
      params.filter(p => p.enabled && p.key).forEach(p => u.searchParams.append(p.key, p.value));
      updateTab('url', decodeDynamicVars(u.toString()));
    } catch { /* incomplete URL */ }
  }
  function updateQuery(index: number, field: 'enabled' | 'key' | 'value', value: boolean | string) {
    const params = tab.queryParams.map((p, i) => i === index ? { ...p, [field]: value } : p);
    updateTab('queryParams', params);
    rebuildUrlFromParams(params);
  }
  function addQuery() { updateTab('queryParams', [...tab.queryParams, { enabled: true, key: '', value: '' }]); }
  function removeQuery(index: number) { const params = tab.queryParams.filter((_, i) => i !== index); updateTab('queryParams', params); rebuildUrlFromParams(params); }

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

  // === 动态变量插入：把「光标所在字段」映射为写回回调 ===
  // onFocus 记录字段位置；点击插入项时用当前渲染的 update* 函数生成 apply，保证写回最新状态。
  const trackField = (target: FieldTarget) =>
    (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      activeFieldRef.current = { el: e.currentTarget, target };
    };
  const applyForTarget = (t: FieldTarget): ((next: string) => void) => {
    switch (t.kind) {
      case 'url': return (next) => { updateTab('url', next); syncQueryFromUrl(next); };
      case 'body': return (next) => updateBody(next);
      case 'query': return (next) => updateQuery(t.index, t.field, next);
      case 'header': return (next) => updateHeader(t.index, t.field, next);
    }
  };
  const resolveInsertTarget = () => {
    const a = activeFieldRef.current;
    if (a && a.el) return { el: a.el, apply: applyForTarget(a.target) };
    // 尚未聚焦任何字段时，默认插入到 URL（URL 栏常驻，光标退化为末尾）
    if (urlInputRef.current) return { el: urlInputRef.current, apply: applyForTarget({ kind: 'url' }) };
    return null;
  };
  // 把占位符插到「光标所在字段」。以 DOM 为准读当前值与选区，写回后 rAF 恢复焦点与光标。
  const insertDynamicVar = (text: string) => {
    const target = resolveInsertTarget();
    const el = target?.el;
    if (!target || !el) return;
    const cur = el.value;
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + text + cur.slice(end);
    const caret = start + text.length;
    target.apply(next);
    requestAnimationFrame(() => {
      try { el.focus({ preventScroll: true }); el.setSelectionRange(caret, caret); } catch (_) { /* 元素可能已卸载 */ }
    });
  };

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

      // 只同步到 Cookie、没抓到认证头：明确告知，避免误以为 Authorization 已同步。
      // （SW 刚被唤醒/该系统尚未发起过带 token 的请求时会这样；仅用 Cookie 鉴权则可忽略。）
      if (authCount === 0) {
        showToast(`${base}；未捕获到该站点认证头——若该系统用 Authorization/Token 鉴权，请先在浏览器里对其发起一次带 token 的请求再同步（仅用 Cookie 鉴权可忽略）`, 'warning', 6000);
        return;
      }

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
  // 枚举当前所有标签页，取 http(s) 站点的域名作为可勾选项（无需 tabs 权限，
  // <all_urls> host_permission 即可读到 tab.url）。这就是「已打开过的网站」实时快照。
  function loadOpenedSites() {
    try {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError) return; // 读不到就保持空清单，不打扰
        const set = new Set<string>();
        for (const t of tabs) {
          const u = t.url || '';
          if (!/^https?:\/\//i.test(u)) continue; // 过滤 chrome://、扩展页、about: 等
          const d = cleanDomain(u);
          if (d) set.add(d);
        }
        setOpenedSites([...set].sort());
      });
    } catch { /* tabs 不可用则保持空清单 */ }
  }
  // 勾选=加入白名单，取消勾选=移出；清空回到「抓全部」（后端 authCaptureWhitelist 空=全站）。
  function toggleSite(d: string) {
    if (whitelist.includes(d)) saveWhitelist(whitelist.filter(x => x !== d));
    else saveWhitelist([...whitelist, d]);
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

    // 历史与重放用「未解析」请求：保留 {{$ts}} 等占位符，使再次发起/复制 cURL 时按“当时”重新解析，
    // 避免把某一次发送时刻的时间戳冻结进历史（否则重放会带上过期时间戳，被服务端判为 timestamp error）。
    // decodeDynamicVars：归一化任何已被百分号编码的占位符（如旧数据里的 %7B%7B%24ts%7D%7D），还原成明文再存。
    const rawUrl = decodeDynamicVars(tab.url.trim());
    const rawReq: ApiRequest = { method: tab.method, url: rawUrl, headers: h, body: tab.body || undefined, bodyType: tab.bodyType as any };

    // 仅为本次网络发送把占位符解析成当前时刻的字面值
    const now = Date.now();
    const rh: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) rh[resolveDynamicVars(k, { now })] = resolveDynamicVars(v, { now });
    const rUrl = resolveDynamicVars(rawUrl, { now });
    const rBody = tab.body ? resolveDynamicVars(tab.body, { now }) : undefined;

    const wireReq: ApiRequest = { method: tab.method, url: rUrl, headers: rh, body: rBody, bodyType: tab.bodyType as any };
    chrome.runtime.sendMessage({ type: 'API_TEST_REQUEST', payload: { ...wireReq, refreshCookie: tab.autoRefreshCookie } }, (resp) => {
      updateTab('loading', false);
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        // 白盒化：区分 context invalidated（需重载）和其他错误
        if (lastErr.message?.includes('Extension context invalidated')) {
          const error = '扩展上下文已失效，请刷新插件 Popup 或重新加载扩展 (chrome://extensions → 刷新)';
          updateTab('error', error);
          saveToHistory(rawReq, undefined, error);
        } else {
          const error = '通信错误: ' + lastErr.message;
          updateTab('error', error);
          saveToHistory(rawReq, undefined, error);
        }
        return;
      }
      if (!resp) {
        const error = '请求失败：后台脚本未响应。请检查扩展是否正常运行，或尝试重新加载扩展。';
        updateTab('error', error);
        saveToHistory(rawReq, undefined, error);
        return;
      }
      if (resp.error) { updateTab('error', resp.error); saveToHistory(rawReq, undefined, resp.error); return; }
      updateTab('response', resp);
      saveToHistory(rawReq, resp);
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
      } else if (result.format === 'har') {
        showToast('检测到 HAR，但未解析出请求。请确认 log.entries 中含有效的 request 记录', 'error', 6000);
      } else {
        showToast('无法识别输入格式，请粘贴 cURL、HTTPie、OpenAPI(JSON) 或 HAR', 'error');
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
      const candidates = detectTimestamps(result.requests[0]);
      if (candidates.length > 0) {
        // 命中固定时间戳：进入检测-确认，默认全选转为动态占位符
        setTsReview({ req: result.requests[0], candidates, selected: new Set(candidates.map(c => c.id)) });
        return;
      }
      loadRequestToTab(result.requests[0]);
      setImportText('');
      setShowImport(false);
    } else {
      setImportListHeight(null); // 新一批导入结果，回到自适应默认高度
      setImportedReqs(result.requests);
    }
  }

  function finishTsReview(applyDynamic: boolean) {
    if (!tsReview) return;
    const finalReq = applyDynamic ? applyTimestamps(tsReview.req, tsReview.candidates, tsReview.selected) : tsReview.req;
    loadRequestToTab(finalReq);
    setTsReview(null);
    setImportText('');
    setShowImport(false);
  }

  function toggleTsCandidate(id: string) {
    setTsReview(prev => {
      if (!prev) return prev;
      const selected = new Set(prev.selected);
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      return { ...prev, selected };
    });
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
            ref={urlInputRef}
            value={tab.url} onChange={e => { updateTab('url', e.target.value); syncQueryFromUrl(e.target.value); if (!tabs[activeIdx].name || tabs[activeIdx].name === '新请求') { const d = e.target.value.replace(/^https?:\/\//, '').split('/')[0]; if (d) updateTab('name', d); } }}
            onFocus={trackField({ kind: 'url' })}
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
            aria-label="导入 cURL / HTTPie / OpenAPI / HAR"
            data-tip="导入请求">
            <Icon name="clipboard-paste" size={16} />
          </button>
          {/* 更多：低频项收进溢出菜单，向下展开、右对齐，避免工具栏拥挤 */}
          <div className="relative shrink-0 flex items-center" ref={moreMenuRef}>
            <button onClick={() => setMoreOpen(o => !o)}
              className={`btn-ghost ${moreOpen ? 'text-primary-600' : ''}`}
              aria-label="更多（内网放行 / 插入时间戳）"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              data-tip="更多">
              <Icon name="ellipsis" size={16} />
            </button>
            {moreOpen && (
              <div className="settings-menu" role="menu" style={{ minWidth: 184, padding: 4 }}>
                <button className="menu-item" role="menuitem" onClick={toggleAllowInternal}
                  aria-label={allowInternal ? '允许访问内网地址（点击关闭）' : '内网地址已拦截（点击放行）'}
                  style={{ padding: '8px 9px', gap: 8 }}>
                  <Icon name={allowInternal ? 'shield-check' : 'shield-alert'} size={16}
                    className={allowInternal ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-slate-500'} />
                  <span className="flex-1" style={{ fontSize: 11 }}>内网访问</span>
                  <span style={{ fontSize: 10, color: allowInternal ? 'var(--success, #16a05d)' : 'var(--text3, #9aa1aa)' }}>
                    {allowInternal ? '已放行' : '已拦截'}
                  </span>
                </button>
                <div className="relative group">
                  <div className="menu-item" role="menuitem" tabIndex={0}
                    style={{ padding: '8px 9px', gap: 8, cursor: 'default' }}>
                    <Icon name="plus" size={15} className="text-indigo-500" />
                    <span className="flex-1" style={{ fontSize: 11 }}>时间戳</span>
                    <span style={{ fontSize: 12, color: 'var(--text3, #9aa1aa)' }}>›</span>
                  </div>
                  <div className="hidden group-hover:block group-focus-within:block absolute right-full top-0 mr-1 z-20"
                    role="menu" style={{ width: 158 }}>
                    <div className="settings-menu" style={{ padding: 4 }}>
                      {DYNAMIC_VAR_TOKENS.map((t) => (
                        <button key={t.name} className="menu-item" role="menuitem"
                          style={{ padding: '8px 9px', gap: 7 }}
                          onClick={() => { insertDynamicVar(t.insert); setMoreOpen(false); }}>
                          <code style={{ fontSize: 10.5, color: 'var(--accent-fg, #4f46e5)' }}>{t.insert}</code>
                          <span className="flex-1 text-right" style={{ fontSize: 10, color: 'var(--text2)' }}>{t.label.replace('时间戳', '').replace('（', '').replace('）', '')}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 动态变量预览：URL/请求体含 {{$ts}} 等占位符时，提示发送时的实际取值 */}
      {(hasDynamicVars(tab.url) || hasDynamicVars(tab.body)) && (
        <div className="px-2 py-1 border-b border-gray-100 dark:border-slate-700 bg-indigo-50/60 dark:bg-slate-900 shrink-0 flex items-center gap-1.5 text-[11px] text-indigo-600 dark:text-indigo-300 overflow-hidden" aria-label="动态时间戳预览" data-tip-placement="below" data-tip={resolveDynamicVars(hasDynamicVars(tab.url) ? tab.url : tab.body)}>
          <span className="shrink-0 opacity-80">发送时解析为</span>
          <code className="truncate">
            {resolveDynamicVars(hasDynamicVars(tab.url) ? tab.url : tab.body)}
          </code>
        </div>
      )}

      {tab.queryParams.length > 0 && (
        <div className="px-2 py-1.5 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 shrink-0">
          <div className="flex items-center justify-between mb-1"><span className="text-xs font-semibold text-gray-500 dark:text-slate-400">Query 参数</span><button onClick={addQuery} className="btn-ghost p-0.5 text-xs">+ 添加</button></div>
          <div className="space-y-1 max-h-24 overflow-y-auto">{tab.queryParams.map((p, i) => <div key={i} className="flex items-center gap-1"><input type="checkbox" checked={p.enabled} onChange={e => updateQuery(i, 'enabled', e.target.checked)} className="w-3 h-3" /><input value={p.key} onChange={e => updateQuery(i, 'key', e.target.value)} onFocus={trackField({ kind: 'query', index: i, field: 'key' })} placeholder="参数名" className="form-input text-xs flex-1" style={{ padding: '3px 5px', fontSize: 11 }} /><input value={p.value} onChange={e => updateQuery(i, 'value', e.target.value)} onFocus={trackField({ kind: 'query', index: i, field: 'value' })} placeholder="参数值" className="form-input text-xs flex-1" style={{ padding: '3px 5px', fontSize: 11 }} /><button onClick={() => removeQuery(i)} className="btn-ghost p-0.5 text-gray-400 hover:text-red-500" title="删除参数">×</button></div>)}</div>
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
            placeholder="粘贴 cURL、HTTPie、OpenAPI JSON 或 HAR..."
            value={importText}
            onChange={e => setImportText(e.target.value)}
            rows={3}
            className="form-textarea text-xs w-full mb-1.5" style={{ fontSize: 11 }}
          />
          <div className="flex gap-1.5 mb-1.5">
            <button onClick={handleImport} className="btn-primary">解析</button>
            <button onClick={() => { setShowImport(false); setImportText(''); setImportedReqs([]); setTsReview(null); }}
              className="btn-secondary">取消</button>
          </div>
          {tsReview && (
            <div className="bg-white dark:bg-slate-800 rounded border border-indigo-200 dark:border-indigo-800 mb-1.5">
              <div className="px-2 py-1 border-b border-gray-100 dark:border-slate-700 bg-indigo-50/70 dark:bg-slate-900 flex items-center gap-1.5">
                <Icon name="clock-3" size={13} className="text-indigo-500 shrink-0" />
                <span className="text-xs text-indigo-700 dark:text-indigo-300">检测到 {tsReview.candidates.length} 处时间戳，勾选后将替换为动态占位符（发送时按当前时刻解析）</span>
              </div>
              <div className="max-h-32 overflow-y-auto">
                {tsReview.candidates.map(c => (
                  <label key={c.id}
                    className="flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 border-b border-gray-50 dark:border-slate-700 last:border-0">
                    <input type="checkbox" className="w-3 h-3 shrink-0"
                      checked={tsReview.selected.has(c.id)}
                      onChange={() => toggleTsCandidate(c.id)} />
                    <span className="shrink-0 text-gray-400" style={{ minWidth: 68 }}>{c.label}</span>
                    <code className="truncate text-gray-500" title={c.original}>{c.original}</code>
                    <Icon name="chevron-right" size={11} className="shrink-0 text-gray-300" />
                    <code className="shrink-0 text-indigo-600 dark:text-indigo-400">{c.token}</code>
                  </label>
                ))}
              </div>
              <div className="flex gap-1.5 px-2 py-1.5 border-t border-gray-100 dark:border-slate-700">
                <button onClick={() => finishTsReview(true)} className="btn-primary" style={{ fontSize: 11 }}>
                  应用并载入{tsReview.selected.size > 0 ? `（${tsReview.selected.size}）` : ''}
                </button>
                <button onClick={() => finishTsReview(false)} className="btn-secondary" style={{ fontSize: 11 }}>保持固定值载入</button>
              </div>
            </div>
          )}
          {importedReqs.length > 0 && (
            <div
              className="bg-white dark:bg-slate-800 rounded border border-gray-200 dark:border-slate-700 flex flex-col resize-y overflow-hidden min-h-[92px]"
              style={{
                // 结果列表最多占窗口约 1/3（maxHeight:33vh），把下方剩余空间留给请求头/请求体等配置区
                // （SUB_TABS 内容在下面的 flex-1 overflow-y-auto 里，可独立滚动查看）。默认按条数撑高、封顶 1/3。
                // 100vh 同时适配弹窗(≈580)与独立窗口(整窗高)；resize 亦受 maxHeight 约束，拖到底也不超 1/3。
                height: importListHeight ?? `min(${30 + importedReqs.length * 27 + 4}px, 33vh)`,
                maxHeight: '33vh',
              }}
              onMouseUp={(e) => setImportListHeight(e.currentTarget.offsetHeight)}
            >
              <div className="sticky top-0 z-10 flex items-center justify-between px-2 py-1 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900">
                <span className="text-xs text-gray-500">解析出 {importedReqs.length} 个请求，点击逐条载入新标签</span>
              </div>
              <div className="flex-1 overflow-y-auto">
                {importedReqs.map((r, i) => (
                  <div key={i} onClick={() => importOneToNewTab(r)}
                    className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-slate-900 text-xs border-b border-gray-50 dark:border-slate-700 last:border-0">
                    <span className={`method-badge method-${r.method}`} style={{ fontSize: 9 }}>{r.method}</span>
                    <span className="text-gray-600 truncate flex-1">{r.url}</span>
                  </div>
                ))}
              </div>
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
                <div className="flex items-center gap-1 mb-1.5">
                  <span className="text-xs text-gray-600 dark:text-gray-300 font-medium" style={{ fontSize: 11 }}>从已打开的网站中选择</span>
                  <button onClick={loadOpenedSites}
                    className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    title="重新读取当前已打开的网站">
                    <Icon name="refresh-cw" size={12} />刷新
                  </button>
                </div>
                <div className="text-xs text-gray-500 mb-1.5" style={{ fontSize: 10, lineHeight: 1.5 }}>
                  一个都不勾 = 抓取所有站点的登录态；勾选后仅监听所选域名（含子域），可减少后台开销与隐私足迹。
                </div>
                {(() => {
                  const sites = [...new Set([...openedSites, ...whitelist])].sort();
                  if (sites.length === 0) {
                    return (
                      <div className="text-xs text-gray-400" style={{ fontSize: 10 }}>
                        未发现已打开的 http(s) 网站，去打开要监听的系统后点「刷新」。
                      </div>
                    );
                  }
                  return (
                    <div className="flex flex-col gap-0.5 max-h-40 overflow-auto">
                      {sites.map(d => {
                        const checked = whitelist.includes(d);
                        return (
                          <button key={d} onClick={() => toggleSite(d)}
                            className="flex items-center gap-1.5 px-1.5 py-1 rounded text-left hover:bg-white dark:hover:bg-slate-800"
                            role="checkbox" aria-checked={checked} title={checked ? '取消监听该站点' : '仅监听该站点'}>
                            <span className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm border shrink-0 ${
                              checked
                                ? 'bg-primary-500 border-primary-500 text-white'
                                : 'border-gray-300 dark:border-slate-600'
                            }`}>
                              {checked && <Icon name="check" size={10} />}
                            </span>
                            <span className="text-xs truncate" style={{ fontSize: 11 }}>{d}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
                <div className="text-xs text-gray-400 mt-1.5" style={{ fontSize: 10 }}>
                  {whitelist.length === 0 ? '（当前：抓取所有站点）' : `（当前：仅抓 ${whitelist.length} 个所选站点）`}
                </div>
              </div>
            )}
            {tab.headers.map(([k, v], i) => (
              <div key={i} className="flex gap-1">
                <input type="text" placeholder="键" value={k}
                  onChange={e => updateHeader(i, 0, e.target.value)}
                  onFocus={trackField({ kind: 'header', index: i, field: 0 })}
                  className="form-input flex-1 text-xs" style={{ padding: '3px 6px', fontSize: 11 }} />
                <input type="text" placeholder="值" value={v}
                  onChange={e => updateHeader(i, 1, e.target.value)}
                  onFocus={trackField({ kind: 'header', index: i, field: 1 })}
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
              onFocus={trackField({ kind: 'body' })}
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
