import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../components/Icon';
import Select from '../components/Select';
import TabStrip from '../components/TabStrip';
import SearchBar from '../components/SearchBar';
import { Highlight, countMatches, useMatchNav } from '../components/search';
import { InterceptedRequest, RuleMatch, CreateRuleContext } from '../../shared/types';
import { ApiRequest } from '../../shared/api-types';
import { parseMultipartBody } from '../../shared/import-parser';
import { showConfirm, showToast } from '../../shared/toast';

interface Props {
  onCreateRule: (context: CreateRuleContext) => void;
  observeEnabled: boolean;
  observeResourceTypes: string[];
  onObserveChange: (enabled: boolean, resourceTypes: string[]) => void;
  onOpenRequest: (request: ApiRequest, name: string) => void;
  onReplay: (request: ApiRequest, name: string) => void;
  onClear: () => void;
}

export default function NetworkLog({ onCreateRule, observeEnabled, observeResourceTypes, onObserveChange, onOpenRequest, onReplay, onClear }: Props) {
  const [logs, setLogs] = useState<InterceptedRequest[]>([]);
  const [search, setSearch] = useState('');
  const [filterMethod, setFilterMethod] = useState('');
  const [filterResourceType, setFilterResourceType] = useState('');
  const [logScope, setLogScope] = useState<'observed' | 'rule'>('observed');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 自动刷新按视图各自独立：观察日志、规则日志分别记忆开/关，互不联动。
  const [autoRefresh, setAutoRefresh] = useState<{ observed: boolean; rule: boolean }>({ observed: true, rule: true });
  // 关闭某视图自动刷新的「冻结时刻」：该视图只显示 timestamp <= 冻结点的日志，冻结后新增的不再冒出。
  // 与 autoRefresh 一起持久化，故关闭弹窗再打开仍冻结、开关仍为关。null = 未冻结（实时）。
  const [freezeAt, setFreezeAt] = useState<{ observed: number | null; rule: number | null }>({ observed: null, rule: null });
  const scopeAutoRefresh = autoRefresh[logScope];
  const [showObserveOptions, setShowObserveOptions] = useState(false);
  const [showTime, setShowTime] = useState(false);
  const [showResourceType, setShowResourceType] = useState(false);
  const [urlTooltip, setUrlTooltip] = useState<{ url: string; left: number; top?: number; bottom?: number; maxWidth: number; lines: number } | null>(null);
  const [createLog, setCreateLog] = useState<InterceptedRequest | null>(null);
  const invalidatedRef = useRef(false); // 上下文失效只提示一次
  const refreshHydratedRef = useRef(false); // 自动刷新状态水合完成前不回写，避免默认值覆盖已存偏好

  // 展开详情内的关键字搜索（同一时刻只展开一条日志，故搜索态挂在组件级即可）
  const [bodySearchOpen, setBodySearchOpen] = useState(false);
  const [bodyQuery, setBodyQuery] = useState('');
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setBodySearchOpen(false); setBodyQuery(''); }, [expandedId]);

  // 展开日志的可搜索文本段 → 全局命中计数/导航；定位时把当前 <mark> 滚到视口中央
  const expandedLog = expandedId ? logs.find((l) => l.id === expandedId) ?? null : null;
  const searchPieces = useMemo(() => (expandedLog ? collectSearchPieces(expandedLog) : []), [expandedLog]);
  const { total: matchTotal, index: matchIndex, next: matchNext, prev: matchPrev } = useMatchNav(searchPieces, bodyQuery);
  useEffect(() => {
    if (!bodyQuery) return;
    const t = window.setTimeout(() => {
      detailRef.current?.querySelector('[data-search-active]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 0);
    return () => window.clearTimeout(t);
  }, [matchIndex, bodyQuery, expandedId]);

  const fetchLogs = () => {
    chrome.runtime.sendMessage({ type: 'LOG_GET' }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        // 白盒化：context invalidated（扩展被重载/更新）时停止轮询并明确提示，而非静默吞掉
        if (err.message?.includes('Extension context invalidated') && !invalidatedRef.current) {
          invalidatedRef.current = true;
          setAutoRefresh({ observed: false, rule: false });
          setFreezeAt({ observed: Date.now(), rule: Date.now() });
          showToast('扩展已重新加载，已暂停自动刷新，请重新打开插件面板', 'warning', 5000);
        }
        return;
      }
      if (res) setLogs(res);
    });
  };

  useEffect(() => {
    chrome.storage.local.get('showNetworkResourceType', (res) => setShowResourceType(res.showNetworkResourceType === true));
    fetchLogs();
    if (!scopeAutoRefresh) return;
    // 事件驱动：后台写入 interceptLog 时才刷新，取代 2 秒轮询（关掉当前视图的自动刷新即冻结视图并停止监听）
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes.interceptLog) {
        const next = changes.interceptLog.newValue;
        setLogs(Array.isArray(next) ? next : []);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [scopeAutoRefresh]);

  // 水合：挂载时从存储恢复各视图的自动刷新开关与冻结点（关闭弹窗前的选择得以延续）。
  useEffect(() => {
    chrome.storage.local.get('logRefreshState', (res) => {
      const s = res.logRefreshState;
      if (s && typeof s === 'object') {
        if (s.autoRefresh && typeof s.autoRefresh === 'object') {
          setAutoRefresh({ observed: s.autoRefresh.observed !== false, rule: s.autoRefresh.rule !== false });
        }
        if (s.freezeAt && typeof s.freezeAt === 'object') {
          const num = (v: unknown) => (typeof v === 'number' ? v : null);
          setFreezeAt({ observed: num(s.freezeAt.observed), rule: num(s.freezeAt.rule) });
        }
      }
      refreshHydratedRef.current = true;
    });
  }, []);

  // 持久化：水合完成后，开关/冻结点任一变化即写回（防止用默认值覆盖已存偏好）。
  useEffect(() => {
    if (!refreshHydratedRef.current) return;
    chrome.storage.local.set({ logRefreshState: { autoRefresh, freezeAt } });
  }, [autoRefresh, freezeAt]);

  const clearLogs = async () => {
    const scopeLabel = logScope === 'observed' ? '观察' : '规则';
    if (!await showConfirm(`确定清空所有${scopeLabel}日志？`)) return;
    // 按当前视图隔离清空：读全量 interceptLog，仅剔除本视图这一类、保留另一类后写回。
    // 后台不在内存缓存该键（每次 LOG_SAVE/CLEAR 都是 storage 读改写），故弹窗端直读直写
    // 是一致且安全的（与 savedRequests 同款），不新增后台消息、不改后台逻辑。
    try {
      const all = await new Promise<InterceptedRequest[]>((resolve) => {
        chrome.storage.local.get('interceptLog', (res) =>
          resolve(Array.isArray(res.interceptLog) ? res.interceptLog : []));
      });
      // 保留“另一类”：观察视图清空后留下规则日志，规则视图清空后留下观察日志。
      const remaining = all.filter((log) => logScope === 'observed' ? !isObservedLog(log) : isObservedLog(log));
      await new Promise<void>((resolve, reject) => {
        chrome.storage.local.set({ interceptLog: remaining }, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(err); else resolve();
        });
      });
      setLogs(remaining);
      // 徽标计数按全量统计，仅在两类都清空后才归零；否则交给 App 的 2s 轮询自愈。
      if (remaining.length === 0) onClear();
    } catch (_) {
      showToast('清空失败：扩展上下文可能已失效，请重新打开面板', 'error');
    }
  };

  // 复制该请求的全部信息（请求原始/修改后 + 响应原始/修改后 + 元信息），供反馈/排障整段粘贴
  const copyLogAll = (log: InterceptedRequest) => {
    const rq = reqStrings(log);
    const rs = respStrings(log);
    const lines: string[] = [];
    lines.push(`时间: ${formatTime(log.timestamp)}`);
    lines.push(`方法: ${log.method}`);
    lines.push(`URL: ${log.url}`);
    if (log.resourceType) lines.push(`类型: ${log.resourceType === 'xmlhttprequest' ? 'XHR' : log.resourceType}`);
    if (log.ruleNames && log.ruleNames.length) lines.push(`命中规则: ${log.ruleNames.join(', ')}`);
    const flags: string[] = [];
    if (log.cancelled) flags.push('请求已取消 (403 Blocked)');
    if (log.delayed) flags.push(`延迟 ${log.delayMs}ms`);
    if (flags.length) lines.push(`标记: ${flags.join(' / ')}`);
    if (log.warnings && log.warnings.length) lines.push(`签名风险:\n${log.warnings.map((w) => '  - ' + w).join('\n')}`);

    const reqChanged = rq.orig !== rq.mod;
    lines.push('', `===== 请求${reqChanged ? '（原始）' : ''} =====`, rq.orig);
    if (reqChanged) lines.push('', '===== 请求（修改后） =====', rq.mod);

    if (rs.orig != null) {
      const respChanged = rs.mod != null && rs.orig !== rs.mod;
      lines.push('', `===== 响应${respChanged ? '（原始）' : ''} =====`, rs.orig);
      if (respChanged) lines.push('', '===== 响应（修改后） =====', rs.mod as string);
    } else {
      lines.push('', '===== 响应 =====', '（无响应信息）');
    }

    navigator.clipboard.writeText(lines.join('\n'))
      .then(() => showToast('已复制该请求的全部信息', 'success'))
      .catch(() => showToast('复制失败，请检查剪贴板权限', 'error'));
  };

  const isObservedLog = (log: InterceptedRequest) => log.kind === 'observed' || (!log.kind && (!log.ruleIds || log.ruleIds.length === 0));
  // 视图冻结：某视图自动刷新关闭时，只保留冻结时刻及之前的日志，之后新增的隐藏（重开弹窗仍冻结）。
  const capFor = (scope: 'observed' | 'rule') => (autoRefresh[scope] ? null : freezeAt[scope]);
  const withinCap = (log: InterceptedRequest, scope: 'observed' | 'rule') => {
    const c = capFor(scope);
    return c == null || log.timestamp <= c;
  };
  const observedLogs = logs.filter(log => isObservedLog(log) && withinCap(log, 'observed'));
  const ruleLogs = logs.filter(log => !isObservedLog(log) && withinCap(log, 'rule'));
  const scopedLogs = logScope === 'observed' ? observedLogs : ruleLogs;
  const filtered = scopedLogs.filter((log) => {
    const matchSearch = !search || log.url.toLowerCase().includes(search.toLowerCase());
    const matchMethod = !filterMethod || log.method === filterMethod;
    const matchResourceType = !filterResourceType || log.resourceType === filterResourceType;
    return matchSearch && matchMethod && matchResourceType;
  });

  const resourceTypes = Array.from(new Set(observedLogs.map(log => log.resourceType).filter((type): type is string => !!type)));
  const resourceTypeLabel = (type: string) => type === 'xmlhttprequest' ? 'XHR' : type === 'fetch' ? 'Fetch' : type;

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  };

  const getStatusColor = (status?: number) => {
    if (!status) return 'text-gray-400';
    if (status >= 200 && status < 300) return 'text-green-600';
    if (status >= 300 && status < 400) return 'text-amber-600';
    return 'text-red-500';
  };

  const headersChanged = (a: Record<string, string>, b: Record<string, string>) => {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return true;
    for (const k of ka) { if (a[k] !== b[k]) return true; }
    return false;
  };

  const hasDiff = (log: InterceptedRequest) => {
    if (log.cancelled) return true;
    if (log.originalResponse && log.modifiedResponse) {
      return log.originalResponse.status !== log.modifiedResponse.status ||
        log.originalResponse.body !== log.modifiedResponse.body ||
        headersChanged(log.originalResponse.headers, log.modifiedResponse.headers);
    }
    return log.modifiedRequest.url !== log.url ||
      headersChanged(log.modifiedRequest.headers, log.originalRequest.headers) ||
      log.modifiedRequest.body !== log.originalRequest.body;
  };

  const hasRequestDiff = (log: InterceptedRequest) =>
    log.modifiedRequest.url !== log.url ||
    headersChanged(log.modifiedRequest.headers, log.originalRequest.headers) ||
    log.modifiedRequest.body !== log.originalRequest.body;

  const hasResponseDiff = (log: InterceptedRequest) => !!(
    log.originalResponse && log.modifiedResponse && (
      log.originalResponse.status !== log.modifiedResponse.status ||
      log.originalResponse.body !== log.modifiedResponse.body ||
      headersChanged(log.originalResponse.headers, log.modifiedResponse.headers)
    )
  );

  // 单块展示（无改写时）：仅展示一份内容，不暗示"前后对比"
  // 展开详情内搜索：ctr 为一次渲染内递增的全局匹配计数器（按 DOM 渲染顺序穿过请求/响应各段）
  type SearchCtx = { query: string; activeIndex: number; ctr: { n: number } };
  const hl = (text: string, sc: SearchCtx, fallback: React.ReactNode) => {
    const base = sc.ctr.n;
    sc.ctr.n += countMatches(text, sc.query);
    if (!sc.query) return fallback;
    return <Highlight text={text} query={sc.query} base={base} activeIndex={sc.activeIndex} />;
  };

  const renderSingle = (label: string, text: string, sc: SearchCtx) => (
    <div className="space-y-1">
      <div className="text-xs font-semibold text-gray-500 uppercase">{label}</div>
      <div className="text-xs p-2 rounded font-mono whitespace-pre-wrap break-all bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700">
        {hl(text, sc, text || <span className="text-gray-300">无</span>)}
      </div>
    </div>
  );

  // 行级 Diff：高亮具体的变更行，而非整块着色
  const renderDiff = (label: string, orig: string, mod: string, sc: SearchCtx) => {
    const changed = orig !== mod;
    if (!changed) {
      return (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-gray-500 uppercase">{label}</div>
          <div className="text-xs p-2 rounded font-mono whitespace-pre-wrap break-all bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700">
            <div className="text-xs text-gray-400 mb-1">原始 = 修改后（无变更）</div>
            {hl(orig, sc, orig || <span className="text-gray-300">无</span>)}
          </div>
        </div>
      );
    }

    const origLines = (orig || '').split('\n');
    const modLines = (mod || '').split('\n');
    const origSet = new Set(origLines);
    const modSet = new Set(modLines);

    return (
      <div className="space-y-1">
        <div className="text-xs font-semibold text-gray-500 uppercase flex items-center gap-1"><Icon name="git-compare-arrows" size={14} className="text-gray-400" aria-label="修改前后对比" />{label} <span className="text-red-500">(已修改)</span></div>
        <div className="grid grid-cols-2 gap-2">
          <div className="text-xs p-2 rounded font-mono whitespace-pre-wrap break-all bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
            <div className="text-xs text-gray-400 mb-1">原始</div>
            {origLines.map((line, i) => {
              const isRemoved = !modSet.has(line);
              return (
                <div key={i} className={isRemoved ? 'bg-red-200 dark:bg-red-800/50 px-0.5 -mx-0.5 rounded' : ''}>
                  {hl(line, sc, line || ' ')}
                </div>
              );
            })}
          </div>
          <div className="text-xs p-2 rounded font-mono whitespace-pre-wrap break-all bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
            <div className="text-xs text-gray-400 mb-1">修改后</div>
            {modLines.map((line, i) => {
              const isAdded = !origSet.has(line);
              return (
                <div key={i} className={isAdded ? 'bg-green-200 dark:bg-green-800/50 px-0.5 -mx-0.5 rounded' : ''}>
                  {hl(line, sc, line || ' ')}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
  const multipartBody = (req: { body?: string; bodyType?: string }, contentType: string) => {
    if (!req.body) return [];
    const parsed = parseMultipartBody(req.body, contentType);
    if (parsed.length) return parsed;
    if (req.bodyType !== 'multipart') return [];
    // XHR 的 FormData 会被浏览器自动加 boundary，脚本拿不到该请求头；日志中保留为 key=value。
    return req.body.split(/\r?\n/).filter(Boolean).map(line => {
      const index = line.indexOf('=');
      return { name: index < 0 ? line : line.slice(0, index), value: index < 0 ? '' : line.slice(index + 1) };
    }).filter(part => part.name);
  };
  const toApiRequest = (log: InterceptedRequest): ApiRequest => {
    const req = log.modifiedRequest || { url: log.url, headers: log.originalRequest.headers, body: log.originalRequest.body };
    const contentType = Object.entries(req.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
    const multipart = multipartBody(req, contentType);
    return { method: log.method, url: req.url, headers: req.headers || {}, body: multipart.length ? JSON.stringify(multipart) : req.body, bodyType: multipart.length ? 'multipart' : (/x-www-form-urlencoded/i.test(contentType) ? 'urlencoded' : 'raw') };
  };
  const toOriginalApiRequest = (log: InterceptedRequest): ApiRequest => {
    const req = { url: log.url, headers: log.originalRequest.headers, body: log.originalRequest.body };
    const contentType = Object.entries(req.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
    const multipart = multipartBody(req, contentType);
    return { method: log.method, url: req.url, headers: req.headers || {}, body: multipart.length ? JSON.stringify(multipart) : req.body, bodyType: multipart.length ? 'multipart' : (/x-www-form-urlencoded/i.test(contentType) ? 'urlencoded' : 'raw') };
  };

  const showUrlTooltip = (url: string, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    // 左锚定在触发元素起点（留出最少展示宽度），宽度自适应内容、超出上限才换行
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - 12 - 240));
    const maxWidth = Math.min(560, window.innerWidth - 12 - left);
    const below = rect.top < window.innerHeight / 2;
    // 依可用竖向空间限制最多行数，超出用省略号（避免超长 URL 顶出下边框）
    const avail = (below ? window.innerHeight - (rect.bottom + 6) : rect.top - 6) - 12;
    const lines = Math.max(2, Math.min(8, Math.floor((avail - 8) / 18)));
    setUrlTooltip(below
      ? { url, left, top: rect.bottom + 6, maxWidth, lines }
      : { url, left, bottom: window.innerHeight - rect.top + 6, maxWidth, lines });
  };

  const switchLogScope = (scope: 'observed' | 'rule') => {
    setLogScope(scope);
    setSearch('');
    setFilterMethod('');
    setFilterResourceType('');
    setShowObserveOptions(false);
    setExpandedId(null);
    setUrlTooltip(null);
    setCreateLog(null);
  };

  return (
    <div className="flex flex-col h-full">
      <TabStrip
        tabs={[
          { key: 'observed', label: '观察日志', count: observedLogs.length },
          { key: 'rule', label: '规则日志', count: ruleLogs.length },
        ]}
        active={logScope}
        onChange={(key) => switchLogScope(key as 'observed' | 'rule')}
      />
      {/* Toolbar */}
      <div className="relative px-3 py-2.5 border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text" placeholder="搜索 URL..."
              value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full h-8 box-border pl-8 pr-3 text-xs border border-gray-200 dark:border-gray-600 rounded-md focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-100 bg-gray-50 dark:bg-slate-900"
            />
            <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          </div>
          <Select
            value={filterMethod} onChange={setFilterMethod}
            options={[{ value: '', label: '全部' }, ...METHODS.map(m => ({ value: m, label: m }))]}
            ariaLabel="按方法筛选" className="shrink-0" style={{ width: 82, fontSize: 11 }}
          />
          <button
            onClick={() => {
              const nextOn = !autoRefresh[logScope];
              setAutoRefresh(prev => ({ ...prev, [logScope]: nextOn }));
              // 开→清冻结点恢复实时；关→记录当刻，之后新增的日志在本视图隐藏
              setFreezeAt(prev => ({ ...prev, [logScope]: nextOn ? null : Date.now() }));
            }}
            className={`shrink-0 h-8 w-8 box-border inline-flex items-center justify-center rounded-md border ${scopeAutoRefresh ? 'bg-primary-50 text-primary-600 border-primary-200 dark:bg-primary-900/30 dark:text-primary-400 dark:border-primary-800' : 'bg-white dark:bg-slate-800 text-gray-500 border-gray-200 dark:border-gray-600'}`}
            aria-label={scopeAutoRefresh ? '暂停自动刷新' : '开启自动刷新'}
            data-tip={scopeAutoRefresh ? '暂停自动刷新' : '开启自动刷新'}
          >
            <Icon name="refresh-cw" size={16} />
          </button>
          {logScope === 'observed' && <button
            onClick={() => onObserveChange(!observeEnabled, observeResourceTypes)}
            className={`shrink-0 h-8 w-8 box-border inline-flex items-center justify-center rounded-md border ${observeEnabled ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800' : 'bg-white dark:bg-slate-800 text-gray-500 border-gray-200 dark:border-gray-600'}`}
            aria-label={observeEnabled ? '停止观察未命中规则的请求' : '开始观察未命中规则的请求'}
            data-tip={observeEnabled ? '停止观察' : '开始观察'}
          >
            <Icon name={observeEnabled ? 'eye' : 'eye-off'} size={16} />
          </button>}
          {logScope === 'observed' && <button onClick={() => setShowObserveOptions(v => !v)} className={`shrink-0 h-8 w-8 box-border inline-flex items-center justify-center rounded-md border ${showObserveOptions ? 'bg-primary-50 text-primary-600 border-primary-200 dark:bg-primary-900/30 dark:text-primary-400 dark:border-primary-800' : 'bg-white dark:bg-slate-800 text-gray-500 border-gray-200 dark:border-gray-600'}`} aria-label="观察类型" data-tip="观察类型">
            <Icon name="list-filter" size={16} />
          </button>}
        </div>
        {logScope === 'observed' && showObserveOptions && (
          <div className="absolute z-20 mt-1 right-3 flex flex-wrap items-center gap-x-3 gap-y-1 p-2 text-xs text-gray-500 dark:text-slate-400 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-md shadow-lg max-w-[calc(100%-24px)]">
            <span className="font-medium">观察类型</span>
            {([['fetch', 'Fetch'], ['xmlhttprequest', 'XHR'], ['document', 'Document'], ['script', 'Script'], ['stylesheet', 'Stylesheet'], ['image', 'Image'], ['font', 'Font'], ['media', 'Media'], ['other', 'Other']] as const).map(([type, label]) => (
              <label key={type} className="inline-flex items-center gap-1 cursor-pointer">
                <input type="checkbox" checked={observeResourceTypes.includes(type)} onChange={e => onObserveChange(observeEnabled, e.target.checked ? [...new Set([...observeResourceTypes, type])] : observeResourceTypes.filter(x => x !== type))} />
                {label}
              </label>
            ))}
            <span className="text-gray-400">默认 Fetch/XHR；其他类型将在对应捕获能力启用后生效</span>
          </div>
        )}
      </div>

      {logScope === 'observed' && showResourceType && resourceTypes.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto px-3 py-1.5 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 shrink-0">
          <button onClick={() => setFilterResourceType('')} className={`shrink-0 px-2 py-0.5 text-xs rounded-md ${!filterResourceType ? 'bg-primary-500 text-white' : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-slate-700'}`}>全部</button>
          {resourceTypes.map(type => {
            const count = observedLogs.filter(log => log.resourceType === type).length;
            return <button key={type} onClick={() => setFilterResourceType(type)} className={`shrink-0 px-2 py-0.5 text-xs rounded-md ${filterResourceType === type ? 'bg-primary-500 text-white' : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-slate-700'}`}>{resourceTypeLabel(type)} {count}</button>;
          })}
        </div>
      )}

      {/* Log list */}
      <div className="flex-1 overflow-y-auto" onScroll={() => setUrlTooltip(null)}>
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="icon">
              <Icon name="clipboard-list" size={32} className="text-gray-300" />
            </div>
            <div className="title">{scopedLogs.length === 0 ? `暂无${logScope === 'observed' ? '观察' : '规则'}日志` : '没有匹配的日志'}</div>
            <div className="desc">
              {scopedLogs.length === 0 ? (logScope === 'observed' ? '开启观察后访问页面即可看到请求' : '规则命中、取消或延迟后会显示在这里') : '换个搜索词试试'}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-gray-50 dark:divide-gray-800">
            {filtered.map((log) => {
              const isExpanded = expandedId === log.id;
              const respStatus = log.modifiedResponse?.status ?? log.originalResponse?.status;
              // 一次渲染内递增的匹配计数器；仅展开的这条日志会用到（renderDiff/renderSingle 按 DOM 顺序取号）
              const sc = { query: isExpanded ? bodyQuery : '', activeIndex: matchIndex, ctr: { n: 0 } };

              return (
                <div key={log.id} className="group hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  {/* Summary row（两行式：方法+URL+时间 / 标签+状态·操作，复刻草稿） */}
                  <div
                    className="px-3 py-2.5 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  >
                    {/* Line 1: 展开 + 方法 + URL + 时间 */}
                    <div className="flex items-center gap-2 min-w-0">
                      {isExpanded
                        ? <Icon name="chevron-down" size={14} className="text-gray-400 shrink-0" />
                        : <Icon name="chevron-right" size={14} className="text-gray-400 shrink-0" />
                      }

                      <span className={`log-method log-method-${log.method}`}>{log.method}</span>

                      <span
                        className="relative flex-1 min-w-0"
                        onMouseEnter={(e) => showUrlTooltip(log.url, e.currentTarget)}
                        onMouseLeave={() => setUrlTooltip(null)}
                      >
                        <span className="block text-xs text-gray-700 dark:text-slate-300 truncate font-mono">{log.url}</span>
                      </span>

                      {showTime && <span className="text-[11px] text-gray-400 font-mono shrink-0">{formatTime(log.timestamp)}</span>}
                    </div>

                    {/* Line 2: 标签 + 状态 + 行内操作 */}
                    <div className="flex items-center gap-1.5 mt-1.5 pl-[22px]">
                      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                        {logScope === 'observed' && showResourceType && log.resourceType && <span className="tag tag-gray">{log.resourceType === 'xmlhttprequest' ? 'XHR' : log.resourceType}</span>}
                        {log.cancelled && <span className="tag tag-red">请求已取消</span>}
                        {log.delayed && <span className="tag tag-amber">延迟{log.delayMs}ms</span>}
                        {hasRequestDiff(log) && !log.cancelled && <span className="tag tag-red">请求已修改</span>}
                        {hasResponseDiff(log) && !log.cancelled && <span className="tag tag-green">响应已修改</span>}
                        {log.warnings && log.warnings.length > 0 && (
                          <span className="tag tag-amber" title={log.warnings.join('\n')}><Icon name="alert-triangle" size={11} />签名风险</span>
                        )}
                        {respStatus && (
                          <span className={`text-[11px] font-mono font-medium shrink-0 ${getStatusColor(respStatus)}`}>
                            {respStatus}
                          </span>
                        )}
                      </div>

                      {/* 行内操作（工具位：纯图标 + aria-label）——悬停/聚焦才显示，与已保存/历史一致 */}
                      <div className="ml-auto flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button
                          className="btn-ghost p-1 text-xs"
                          aria-label="创建规则"
                          data-tip="创建规则"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCreateLog(log);
                          }}
                        >
                          <Icon name="plus" size={14} />
                        </button>
                        {logScope === 'observed' && <button className="btn-ghost p-1 text-xs" aria-label="复制全部信息" data-tip="复制全部信息" onClick={(e) => { e.stopPropagation(); copyLogAll(log); }}><Icon name="copy" size={14} /></button>}
                        <button className="btn-ghost p-1 text-xs" aria-label="在 API 测试中打开" data-tip="载入 API" onClick={(e) => { e.stopPropagation(); onOpenRequest(toApiRequest(log), `日志 ${log.method}`); }}><Icon name="arrow-right-to-line" size={14} /></button>
                        <button className="btn-ghost p-1 text-xs" aria-label="重放原始请求" data-tip="重放原始请求" onClick={(e) => { e.stopPropagation(); onReplay(toOriginalApiRequest(log), `重放 ${log.method}`); }}><Icon name="repeat-2" size={14} /></button>
                        {hasRequestDiff(log) && <button className="btn-ghost p-1 text-xs relative" style={{ color: 'var(--clay)' }} aria-label="重放修改后请求" data-tip="重放修改后" onClick={(e) => { e.stopPropagation(); onReplay(toApiRequest(log), `重放修改后 ${log.method}`); }}><Icon name="repeat-2" size={14} /><span className="absolute rounded-full" style={{ top: 3, right: 3, width: 5, height: 5, background: 'var(--clay)' }} /></button>}
                      </div>
                    </div>
                  </div>

                  {createLog?.id === log.id && (
                    <div className="mx-8 mb-2 p-2 rounded-md border border-primary-200 bg-primary-50 dark:bg-primary-900/20 dark:border-primary-800 flex items-center gap-2 text-xs">
                      <span className="text-primary-700 dark:text-primary-300 font-medium">创建 Mock：</span>
                      <button className="btn-secondary py-1 px-2 text-xs" onClick={() => { onCreateRule({ log, mode: 'request' }); setCreateLog(null); }}>修改请求</button>
                      {log.originalResponse && <button className="btn-primary py-1 px-2 text-xs" onClick={() => { onCreateRule({ log, mode: 'response' }); setCreateLog(null); }}>修改响应</button>}
                      <button className="btn-ghost p-1 ml-auto" onClick={() => setCreateLog(null)} aria-label="取消">取消</button>
                    </div>
                  )}

                  {/* Detail panel */}
                  {isExpanded && (
                    <div ref={detailRef} className="px-3 pb-3 space-y-3 ml-5.5">
                      {/* 搜索关键字 + 定位 */}
                      <div className="flex items-center gap-2">
                        {bodySearchOpen ? (
                          <div className="flex-1">
                            <SearchBar
                              query={bodyQuery}
                              onQueryChange={setBodyQuery}
                              count={matchTotal}
                              index={matchIndex}
                              onNext={matchNext}
                              onPrev={matchPrev}
                              onClose={() => { setBodySearchOpen(false); setBodyQuery(''); }}
                              placeholder="在请求 / 响应中搜索…"
                            />
                          </div>
                        ) : (
                          <button className="btn-ghost p-1 text-xs" aria-label="搜索请求/响应" data-tip="搜索关键字" onClick={() => setBodySearchOpen(true)}>
                            <Icon name="search" size={14} />
                          </button>
                        )}
                      </div>

                      {/* Rules matched */}
                      <div className="flex gap-1.5 flex-wrap">
                        {log.ruleNames.map((name, i) => (
                          <span key={i} className="tag tag-blue">{name}</span>
                        ))}
                      </div>

                      {/* Sign / diagnostic warnings */}
                      {log.warnings && log.warnings.length > 0 && (
                        <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 p-2 rounded space-y-1">
                          {log.warnings.map((w, i) => (
                            <div key={i} className="flex gap-1.5">
                              <Icon name="alert-triangle" size={12} className="shrink-0 mt-0.5" />
                              <span className="leading-relaxed">{w}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Request diff */}
                      {renderDiff(
                        '请求',
                        `${log.method} ${log.url}\n${formatHeaders(log.originalRequest.headers)}${log.originalRequest.body ? '\n\n' + log.originalRequest.body : ''}`,
                        `${log.method} ${log.modifiedRequest.url}\n${formatHeaders(log.modifiedRequest.headers)}${log.modifiedRequest.body ? '\n\n' + log.modifiedRequest.body : ''}`,
                        sc
                      )}

                      {/* 响应：有改写时做前后 diff；仅改请求（或纯观察）时也要展示接口实际响应 */}
                      {log.originalResponse && (
                        log.modifiedResponse
                          ? renderDiff(
                              '响应',
                              `${log.originalResponse.status} ${log.originalResponse.statusText}\n${formatHeaders(log.originalResponse.headers)}\n\n${log.originalResponse.body || ''}`,
                              `${log.modifiedResponse.status} ${log.modifiedResponse.statusText}\n${formatHeaders(log.modifiedResponse.headers)}\n\n${log.modifiedResponse.body || ''}`,
                              sc
                            )
                          : renderSingle(
                              '响应',
                              `${log.originalResponse.status} ${log.originalResponse.statusText}\n${formatHeaders(log.originalResponse.headers)}\n\n${log.originalResponse.body || ''}`,
                              sc
                            )
                      )}

                      {log.cancelled && (
                        <div className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 p-2 rounded">
                          请求已被拦截，返回 403 Blocked
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {urlTooltip && createPortal(
        <div className="url-tooltip fixed z-50 px-2 py-1 rounded text-[11px] leading-relaxed font-mono break-all shadow-lg pointer-events-none" style={{ left: urlTooltip.left, top: urlTooltip.top, bottom: urlTooltip.bottom, maxWidth: urlTooltip.maxWidth, width: 'max-content', display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: urlTooltip.lines, overflow: 'hidden' }}>
          {urlTooltip.url}
        </div>,
        document.body,
      )}

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 shrink-0">
        <span className="text-xs text-gray-400">{filtered.length} 条记录</span>
        <div className="flex items-center gap-1.5">
          {logScope === 'observed' && <button onClick={() => { setShowResourceType(v => { const next = !v; chrome.storage.local.set({ showNetworkResourceType: next }); if (!next) setFilterResourceType(''); return next; }); }} className={`btn-ghost p-1 ${showResourceType ? 'text-primary-600 bg-primary-50 dark:bg-primary-900/30' : ''}`} data-tip={showResourceType ? '隐藏请求类型' : '显示请求类型'} aria-label={showResourceType ? '隐藏请求类型与筛选' : '显示请求类型与筛选'}>
            <Icon name="tag" size={16} />
          </button>}
          <button onClick={() => setShowTime(v => !v)} className={`btn-ghost p-1 ${showTime ? 'text-primary-600 bg-primary-50 dark:bg-primary-900/30' : ''}`} data-tip={showTime ? '隐藏时间' : '显示时间'} aria-label={showTime ? '隐藏请求时间' : '显示请求时间'}>
            <Icon name="clock-3" size={16} />
          </button>
          <button onClick={clearLogs} className="btn-danger py-1 px-2 text-xs" aria-label={`清空${logScope === 'observed' ? '观察' : '规则'}日志`}>
            <Icon name="trash-2" size={14} /> 清空
          </button>
        </div>
      </div>
    </div>
  );
}

function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}

// 请求/响应文本串构造（渲染与搜索计数共用同一来源，避免漂移）
function reqStrings(log: InterceptedRequest) {
  return {
    orig: `${log.method} ${log.url}\n${formatHeaders(log.originalRequest.headers)}${log.originalRequest.body ? '\n\n' + log.originalRequest.body : ''}`,
    mod: `${log.method} ${log.modifiedRequest.url}\n${formatHeaders(log.modifiedRequest.headers)}${log.modifiedRequest.body ? '\n\n' + log.modifiedRequest.body : ''}`,
  };
}
function respStrings(log: InterceptedRequest) {
  return {
    orig: log.originalResponse ? `${log.originalResponse.status} ${log.originalResponse.statusText}\n${formatHeaders(log.originalResponse.headers)}\n\n${log.originalResponse.body || ''}` : null,
    mod: log.modifiedResponse ? `${log.modifiedResponse.status} ${log.modifiedResponse.statusText}\n${formatHeaders(log.modifiedResponse.headers)}\n\n${log.modifiedResponse.body || ''}` : null,
  };
}
// 展开详情内按 DOM 渲染顺序枚举可搜索文本段（changed diff 按行拆分，其余整段），供全局命中计数
function collectSearchPieces(log: InterceptedRequest): string[] {
  const pieces: string[] = [];
  const rq = reqStrings(log);
  if (rq.orig !== rq.mod) pieces.push(...rq.orig.split('\n'), ...rq.mod.split('\n'));
  else pieces.push(rq.orig);
  const rs = respStrings(log);
  if (rs.orig != null) {
    if (rs.mod != null && rs.orig !== rs.mod) pieces.push(...rs.orig.split('\n'), ...rs.mod.split('\n'));
    else pieces.push(rs.orig);
  }
  return pieces;
}
