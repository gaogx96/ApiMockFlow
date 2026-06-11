import React, { useState, useEffect } from 'react';
import { BoltIcon, BeakerIcon, SunIcon, MoonIcon, DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { AppState, Rule, RuleMatch } from '../shared/types';
import RuleList from './pages/RuleList';
import RuleEditor from './pages/RuleEditor';
import ApiTester from './pages/ApiTester';
import NetworkLog from './pages/NetworkLog';

export type Page = 'list' | 'editor' | 'apitest' | 'networklog';

export default function App() {
  const [page, setPage] = useState<Page>('list');
  const [state, setState] = useState<AppState>({
    globalEnabled: true,
    rules: [],
    groups: [{ id: 'default', name: '默认分组', enabled: true, color: '#3b82f6' }],
  });
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [prefillMatch, setPrefillMatch] = useState<Partial<RuleMatch> | null>(null);
  const [dark, setDark] = useState(false);
  const [logCount, setLogCount] = useState(0);

  useEffect(() => {
    chrome.storage.local.get('theme', (res) => {
      const isDark = res.theme === 'dark';
      setDark(isDark);
      if (isDark) document.documentElement.classList.add('dark');
    });
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    chrome.storage.local.set({ theme: next ? 'dark' : 'light' });
  }

  const refreshState = () => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (res) setState(res);
    });
  };

  useEffect(() => { refreshState(); }, []);

  useEffect(() => {
    const fetch = () => {
      chrome.runtime.sendMessage({ type: 'LOG_GET' }, (res) => {
        const err = chrome.runtime.lastError;
        if (err || !res) return;
        setLogCount(res.length);
      });
    };
    fetch();
    const t = setInterval(fetch, 10000);
    return () => clearInterval(t);
  }, []);

  const toggleGlobal = async () => {
    const newVal = !state.globalEnabled;
    await chrome.runtime.sendMessage({ type: 'TOGGLE_GLOBAL', payload: newVal });
    setState({ ...state, globalEnabled: newVal });
  };

  const handleEditRule = (rule: Rule | null) => {
    setEditingRule(rule);
    setPrefillMatch(null);
    setPage('editor');
  };

  const handleCreateFromLog = (prefill: Partial<RuleMatch>) => {
    setEditingRule(null);
    setPrefillMatch(prefill);
    setPage('editor');
  };

  const handleSaveRule = () => {
    refreshState();
    setPrefillMatch(null);
    setPage('list');
  };

  const ruleCount = state.rules.length;
  const activeRuleCount = state.rules.filter((r) => r.enabled).length;

  return (
    <div className="flex flex-col h-full" style={{ height: '580px' }}>
      {/* Header bar */}
      <div className="header-bar">
        <div className="flex items-center gap-2">
          <BoltIcon className="w-5 h-5 text-white opacity-80" />
          <span className="text-sm font-bold text-white tracking-tight">ApiMockFlow</span>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <div
            className={`toggle-switch ${state.globalEnabled ? 'active' : ''}`}
            onClick={toggleGlobal}
            title={state.globalEnabled ? '暂停拦截' : '启用拦截'}
          />
          <span className="text-xs text-white opacity-80">
            {state.globalEnabled ? '运行中' : '已暂停'}
          </span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="tab-bar">
        <div
          className={`tab-item ${page === 'list' || page === 'editor' ? 'active' : ''}`}
          onClick={() => setPage('list')}
        >
          规则
          {ruleCount > 0 && (
            <span className="text-xs opacity-60">{ruleCount}</span>
          )}
        </div>
        <div
          className={`tab-item ${page === 'apitest' ? 'active' : ''}`}
          onClick={() => setPage('apitest')}
        >
          <BeakerIcon className="w-3.5 h-3.5" />
          API 测试
        </div>
        <div
          className={`tab-item ${page === 'networklog' ? 'active' : ''}`}
          onClick={() => setPage('networklog')}
        >
          <DocumentMagnifyingGlassIcon className="w-3.5 h-3.5" />
          拦截日志
          {logCount > 0 && (
            <span className="ml-0.5 px-1.5 py-0.5 text-xs rounded-full bg-blue-500 text-white" style={{ fontSize: 9, lineHeight: 1 }}>
              {logCount}
            </span>
          )}
        </div>
      </div>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden bg-slate-100 dark:bg-slate-900">
        {page === 'list' && (
          <RuleList state={state} onRefresh={refreshState} onEditRule={handleEditRule} />
        )}
        {page === 'editor' && (
          <RuleEditor
            rule={editingRule}
            groups={state.groups}
            onSave={handleSaveRule}
            onCancel={() => setPage('list')}
            prefill={prefillMatch}
          />
        )}
        {page === 'apitest' && <ApiTester onCreateRule={(prefill) => {
          setEditingRule(null);
          setPrefillMatch({ url: prefill.url, matchType: 'contains', method: prefill.method, resourceType: '' });
          setPage('editor');
        }} />}
        {page === 'networklog' && <NetworkLog onCreateRule={handleCreateFromLog} />}
      </main>

      {/* Status bar */}
      <div className="status-bar">
        <span className="text-xs text-gray-400 dark:text-slate-500">
          {state.groups.length} 分组 · {ruleCount} 规则
        </span>
        <button
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300 transition-colors"
          onClick={toggleTheme}
          title={dark ? '切换亮色' : '切换暗色'}
        >
          {dark ? <SunIcon className="w-3.5 h-3.5" /> : <MoonIcon className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}
