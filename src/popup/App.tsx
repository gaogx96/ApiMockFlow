import React, { useState, useEffect, useRef, useCallback } from 'react';
import Icon from './components/Icon';
import { AppState, Rule, RuleMatch, CreateRuleContext, InterceptedRequest } from '../shared/types';
import { ApiRequest } from '../shared/api-types';
import RuleList from './pages/RuleList';
import RuleEditor from './pages/RuleEditor';
import ErrorBoundary from './ErrorBoundary';
import ApiTester from './pages/ApiTester';
import NetworkLog from './pages/NetworkLog';
import Tooltip from './components/Tooltip';
import { showConfirm } from '../shared/toast';

export type Page = 'list' | 'editor' | 'apitest' | 'networklog';

// 独立窗口模式（由工具栏 popup 弹出的 chrome.windows popup，?window=1）：
// 此时隐藏「独立窗口」按钮，并让根容器填满整个窗口。
const isPanelWindow = new URLSearchParams(location.search).get('window') === '1';

// 日志页自动刷新/冻结状态（由 NetworkLog 写入存储键 logRefreshState）。null = 尚未读取/无记录。
type LogRefreshState = {
  autoRefresh: { observed: boolean; rule: boolean };
  freezeAt: { observed: number | null; rule: number | null };
};
const normLogRefreshState = (s: any): LogRefreshState | null =>
  s && typeof s === 'object' && s.autoRefresh && s.freezeAt
    ? {
        autoRefresh: { observed: s.autoRefresh.observed !== false, rule: s.autoRefresh.rule !== false },
        freezeAt: {
          observed: typeof s.freezeAt.observed === 'number' ? s.freezeAt.observed : null,
          rule: typeof s.freezeAt.rule === 'number' ? s.freezeAt.rule : null,
        },
      }
    : null;
// 是否存在「已冻结」视图（自动刷新关且记了冻结点）。仅此时角标才需按冻结点重算，否则用廉价的 LOG_COUNT。
const hasFrozenScope = (rs: LogRefreshState | null): boolean =>
  !!rs && ((!rs.autoRefresh.observed && rs.freezeAt.observed != null) || (!rs.autoRefresh.rule && rs.freezeAt.rule != null));
const isObservedLog = (log: InterceptedRequest) =>
  log.kind === 'observed' || (!log.kind && (!log.ruleIds || log.ruleIds.length === 0));
// 冻结感知计数：与 NetworkLog 的口径一致，冻结视图只数 timestamp <= 冻结点的日志。
const countVisibleLogs = (logs: InterceptedRequest[], rs: LogRefreshState): number => {
  const capFor = (scope: 'observed' | 'rule') => (rs.autoRefresh[scope] ? null : rs.freezeAt[scope]);
  let n = 0;
  for (const log of logs) {
    const scope = isObservedLog(log) ? 'observed' : 'rule';
    const c = capFor(scope);
    if (c == null || log.timestamp <= c) n++;
  }
  return n;
};

export default function App() {
  const [page, setPage] = useState<Page>('list');
  const [state, setState] = useState<AppState>({
    globalEnabled: true,
    rules: [],
    groups: [{ id: 'default', name: '默认分组', enabled: true, color: '#3b82f6' }],
  });
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [prefillMatch, setPrefillMatch] = useState<Partial<RuleMatch> | null>(null);
  // 每次打开编辑器时自增，作为 RuleEditor 的 key 强制重建，
  // 避免复用同一实例导致的表单 state 残留（新建/编辑/从日志创建之间）。
  const [editorNonce, setEditorNonce] = useState(0);
  const [dark, setDark] = useState(false);
  const [showBadge, setShowBadge] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const themeAnimTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [logCount, setLogCount] = useState(0);
  const [logRefreshState, setLogRefreshState] = useState<LogRefreshState | null>(null);
  const [prefillRequest, setPrefillRequest] = useState<ApiRequest | null>(null);
  const [prefillRequestName, setPrefillRequestName] = useState('');
  const observeRequestVersion = useRef(0);
  const [autoReplay, setAutoReplay] = useState(false);
  const [createRuleContext, setCreateRuleContext] = useState<CreateRuleContext | null>(null);

  useEffect(() => {
    chrome.storage.local.get(['theme', 'showBadge'], (res) => {
      const isDark = res.theme === 'dark';
      setDark(isDark);
      if (isDark) document.documentElement.classList.add('dark');
      setShowBadge(res.showBadge === true);
    });
  }, []);

  function toggleTheme() {
    const next = !dark;
    // 仅在切换的瞬间为颜色类属性开启过渡（临时类），过渡结束即移除，
    // 避免常驻 transition 影响 hover/其它交互，也不改动任何存储键。
    const root = document.documentElement;
    root.classList.add('theme-anim');
    clearTimeout(themeAnimTimer.current);
    themeAnimTimer.current = setTimeout(() => root.classList.remove('theme-anim'), 320);
    setDark(next);
    root.classList.toggle('dark', next);
    chrome.storage.local.set({ theme: next ? 'dark' : 'light' });
  }

  function toggleBadge() {
    const next = !showBadge;
    setShowBadge(next);
    chrome.storage.local.set({ showBadge: next });
  }

  // 设置菜单：点击外部 / Esc 关闭
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  const refreshState = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      setState(res);
    });
  }, []);

  useEffect(() => { refreshState(); }, [refreshState]);

  // 订阅日志页的自动刷新/冻结状态（小对象，onChanged 开销可忽略，不会引入大数组投递）。
  useEffect(() => {
    chrome.storage.local.get('logRefreshState', (res) => setLogRefreshState(normLogRefreshState(res.logRefreshState)));
    const onChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && changes.logRefreshState) setLogRefreshState(normLogRefreshState(changes.logRefreshState.newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  useEffect(() => {
    // 徽标未读计数：无冻结时轻量轮询 LOG_COUNT（后台只回一个数字）。
    // 不订阅 interceptLog 的 storage.onChanged —— 后台每拦截一条请求都会重写整个
    // interceptLog（上限 200 条、含响应体，可达数 MB），onChanged 会把这个完整数组
    // 结构化克隆投递给弹窗；高流量下每秒几十次直接喂爆主线程，导致点击延迟数秒、绘制被饿死。
    // 弹窗生命周期很短，2s 轮询开销可忽略。
    // 有视图被冻结时，角标须与冻结口径一致（否则「列表空、角标涨」），此时改读 LOG_GET 本地按冻结点计数；
    // 仍是 2s 轮询、非 onChanged 洪流，且只在用户主动进入冻结态时才承担这次数组读取。
    let alive = true;
    const frozen = hasFrozenScope(logRefreshState);
    const pull = () => {
      if (frozen) {
        chrome.runtime.sendMessage({ type: 'LOG_GET' }, (res) => {
          if (!alive || chrome.runtime.lastError || !Array.isArray(res)) return;
          setLogCount(countVisibleLogs(res, logRefreshState!));
        });
      } else {
        chrome.runtime.sendMessage({ type: 'LOG_COUNT' }, (res) => {
          if (!alive || chrome.runtime.lastError || res == null) return;
          setLogCount(res);
        });
      }
    };
    pull();
    const id = setInterval(pull, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [logRefreshState]);

  const toggleGlobal = async () => {
    const newVal = !state.globalEnabled;
    await chrome.runtime.sendMessage({ type: 'TOGGLE_GLOBAL', payload: newVal });
    setState(s => ({ ...s, globalEnabled: newVal }));
  };

  const handleEditRule = useCallback((rule: Rule | null) => {
    setEditingRule(rule);
    setPrefillMatch(null);
    setEditorNonce(n => n + 1);
    setPage('editor');
  }, []);

  const handleCreateFromLog = (prefill: Partial<RuleMatch>) => {
    setEditingRule(null);
    setPrefillMatch(prefill);
    setEditorNonce(n => n + 1);
    setPage('editor');
  };

  const handleCreateRuleFromLog = (context: CreateRuleContext) => {
    setEditingRule(null);
    setCreateRuleContext(context);
    setPrefillMatch(null);
    setEditorNonce(n => n + 1);
    setPage('editor');
  };

  const handleSaveRule = () => {
    refreshState();
    setPrefillMatch(null);
    setPage('list');
  };

  const handleObserveChange = (enabled: boolean, resourceTypes: string[]) => {
    const version = ++observeRequestVersion.current;
    // Reflect the user's click immediately. Background persistence is serialized
    // below; older callbacks must never revert a newer checkbox selection.
    setState(s => ({ ...s, observeEnabled: enabled, observeResourceTypes: resourceTypes }));
    chrome.runtime.sendMessage({ type: 'SET_OBSERVE', payload: { enabled, resourceTypes } }, (res) => {
      if (version !== observeRequestVersion.current || chrome.runtime.lastError || !res?.success) return;
      setState(s => ({
        ...s,
        observeEnabled: res.observeEnabled === true,
        observeResourceTypes: Array.isArray(res.observeResourceTypes) ? res.observeResourceTypes : resourceTypes,
      }));
    });
  };

  const handleOpenRequest = (request: ApiRequest, name: string) => {
    setPrefillRequest(request);
    setPrefillRequestName(name);
    setPage('apitest');
  };

  const handleReplay = async (request: ApiRequest, name: string) => {
    const unsafe = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase());
    const start = () => { setPrefillRequest(request); setPrefillRequestName(name); setAutoReplay(true); setPage('apitest'); };
    if (!unsafe || await showConfirm(`即将重放 ${request.method} 请求：\n${request.url}\n\n是否继续？`)) start();
  };

  const ruleCount = state.rules.length;
  const activeRuleCount = state.rules.filter((r) => r.enabled).length;

  return (
    <div
      className="flex flex-col h-full"
      style={{
        height: isPanelWindow ? '100vh' : '580px',
        background: 'var(--surface)',
        borderRadius: isPanelWindow ? 0 : 16,
        overflow: 'hidden',
      }}
    >
      {/* Header bar */}
      <div className="header-bar">
        <div className="flex items-center gap-2">
          <Icon name="zap" size={18} style={{ color: 'var(--accent)' }} />
          <span className="text-sm font-bold tracking-tight" style={{ color: 'var(--text)' }}>ApiMockFlow</span>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <div
            className={`toggle-switch ${state.globalEnabled ? 'active' : ''}`}
            role="switch"
            aria-checked={state.globalEnabled}
            aria-label={state.globalEnabled ? '暂停拦截' : '启用拦截'}
            tabIndex={0}
            onClick={toggleGlobal}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGlobal(); } }}
            data-tip={state.globalEnabled ? '暂停拦截' : '启用拦截'}
          />
          <span className="text-xs opacity-80" style={{ color: 'var(--text2)' }}>{state.globalEnabled ? '运行中' : '已暂停'}</span>
          <div className="relative" ref={menuRef}>
            <button
              className="btn-ghost"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="设置"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-tip="设置"
            >
              <Icon name="settings" size={16} />
            </button>
            {menuOpen && (
              <div className="settings-menu" role="menu">
                <button className="menu-item" role="menuitem" onClick={() => { toggleTheme(); setMenuOpen(false); }}>
                  <Icon name={dark ? 'sun' : 'moon'} size={16} />
                  {dark ? '切换亮色' : '切换暗色'}
                </button>
                <button className="menu-item" role="menuitem" onClick={() => { toggleBadge(); setMenuOpen(false); }}>
                  <Icon name={showBadge ? 'eye-off' : 'eye'} size={16} />
                  {showBadge ? '隐藏页面标识' : '显示页面标识'}
                </button>
                {!isPanelWindow && (
                  <button
                    className="menu-item"
                    role="menuitem"
                    onClick={() => { setMenuOpen(false); chrome.runtime.sendMessage({ type: 'OPEN_PANEL' }, () => window.close()); }}
                  >
                    <Icon name="external-link" size={16} />
                    在独立窗口中打开
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden" style={{ background: 'var(--surface)' }}>
        <ErrorBoundary key={page}>
        {page === 'list' && (
          <RuleList state={state} onRefresh={refreshState} onEditRule={handleEditRule} />
        )}
        {page === 'editor' && (
          <RuleEditor
            key={editorNonce}
            rule={editingRule}
            groups={state.groups}
            onSave={handleSaveRule}
            onCancel={() => setPage('list')}
            onBack={() => setPage('list')}
            prefill={prefillMatch}
            createContext={createRuleContext}
          />
        )}
        {page === 'apitest' && <ApiTester prefillRequest={prefillRequest} prefillName={prefillRequestName} autoSend={autoReplay} onPrefillConsumed={() => { setPrefillRequest(null); setAutoReplay(false); }} onCreateRule={(prefill) => {
          setEditingRule(null);
          setPrefillMatch({ url: prefill.url, matchType: 'contains', method: prefill.method, resourceType: '' });
          setEditorNonce(n => n + 1);
          setPage('editor');
        }} />}
        {page === 'networklog' && <NetworkLog onCreateRule={handleCreateRuleFromLog} onOpenRequest={handleOpenRequest} onReplay={handleReplay} onClear={() => setLogCount(0)} observeEnabled={state.observeEnabled === true} observeResourceTypes={state.observeResourceTypes || ['fetch', 'xmlhttprequest']} onObserveChange={handleObserveChange} />}
        </ErrorBoundary>
      </main>

      {/* Bottom nav */}
      <nav className="bottom-nav">
        <button
          className={`nav-item ${page === 'list' || page === 'editor' ? 'active' : ''}`}
          onClick={() => setPage('list')}
          aria-current={page === 'list' || page === 'editor' ? 'page' : undefined}
        >
          <Icon name="list" size={18} />
          <span className="nav-label">规则</span>
        </button>
        <button
          className={`nav-item ${page === 'apitest' ? 'active' : ''}`}
          onClick={() => setPage('apitest')}
          aria-current={page === 'apitest' ? 'page' : undefined}
        >
          <Icon name="send" size={18} />
          <span className="nav-label">测试</span>
        </button>
        <button
          className={`nav-item ${page === 'networklog' ? 'active' : ''}`}
          onClick={() => setPage('networklog')}
          aria-current={page === 'networklog' ? 'page' : undefined}
        >
          <Icon name="activity" size={18} />
          <span className="nav-label">日志</span>
          {logCount > 0 && <span className="nav-badge">{logCount > 99 ? '99+' : logCount}</span>}
        </button>
      </nav>
      <Tooltip />
    </div>
  );
}
