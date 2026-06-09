import React, { useState, useEffect } from 'react';
import { BoltIcon, Cog6ToothIcon, BeakerIcon, SunIcon, MoonIcon } from '@heroicons/react/24/outline';
import { AppState, Rule } from '../shared/types';
import RuleList from './pages/RuleList';
import RuleEditor from './pages/RuleEditor';
import ApiTester from './pages/ApiTester';

export type Page = 'list' | 'editor' | 'apitest';

export default function App() {
  const [page, setPage] = useState<Page>('list');
  const [state, setState] = useState<AppState>({
    globalEnabled: true,
    rules: [],
    groups: [{ id: 'default', name: '默认分组', enabled: true, color: '#1677ff' }],
  });
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [dark, setDark] = useState(false);

  // Load dark mode preference
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
      if (res) {
        setState(res);
        console.log('[ApiMockFlow] STATE:', JSON.stringify({ rules: res.rules, groups: res.groups, globalEnabled: res.globalEnabled }, null, 2));
      }
    });
  };

  useEffect(() => { refreshState(); }, []);

  const toggleGlobal = async () => {
    const newVal = !state.globalEnabled;
    await chrome.runtime.sendMessage({ type: 'TOGGLE_GLOBAL', payload: newVal });
    setState({ ...state, globalEnabled: newVal });
  };

  const handleEditRule = (rule: Rule | null) => {
    setEditingRule(rule);
    setPage('editor');
  };

  const handleSaveRule = () => {
    refreshState();
    setPage('list');
  };

  const ruleCount = state.rules.length;
  const activeRuleCount = state.rules.filter((r) => r.enabled).length;

  return (
    <div className="flex h-full" style={{ height: '580px' }}>
      {/* Sidebar */}
      <aside className="w-44 bg-gray-50 dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col shrink-0">
        {/* Logo area */}
        <div className="px-3 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-1.5">
            <BoltIcon className="w-4 h-4 text-primary-500" />
            <span className="text-sm font-bold text-gray-800 tracking-tight">ApiMockFlow</span>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <div
              className={`toggle-switch ${state.globalEnabled ? 'active' : ''}`}
              onClick={toggleGlobal}
              title={state.globalEnabled ? '暂停拦截' : '启用拦截'}
            />
            <span className={`text-xs font-medium ${state.globalEnabled ? 'text-green-600' : 'text-gray-400'}`}>
              {state.globalEnabled ? '运行中' : '已暂停'}
            </span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2">
          <div
            className={`sidebar-item ${page === 'list' ? 'active' : ''}`}
            onClick={() => setPage('list')}
          >
            <Cog6ToothIcon className="w-4 h-4" />
            <span>规则</span>
            {ruleCount > 0 && (
              <span className="ml-auto text-xs text-gray-400">{activeRuleCount}/{ruleCount}</span>
            )}
          </div>
          <div
            className={`sidebar-item ${page === 'apitest' ? 'active' : ''}`}
            onClick={() => setPage('apitest')}
          >
            <BeakerIcon className="w-4 h-4" />
            <span>API 测试</span>
          </div>
        </nav>

        {/* Footer */}
        <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-700 space-y-1">
          <div className="text-xs text-gray-400">
            {state.groups.length} 个分组 · {ruleCount} 条规则
          </div>
          <div className="text-xs text-gray-400">
            全局: {state.globalEnabled ? 'ON' : 'OFF'}
          </div>
          <button
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
            onClick={toggleTheme}
          >
            {dark ? <SunIcon className="w-3.5 h-3.5" /> : <MoonIcon className="w-3.5 h-3.5" />}
            {dark ? '亮色' : '暗色'}
          </button>
          <button
            className="text-xs text-gray-500 hover:text-primary-500 underline"
            onClick={() => {
              chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
                console.log('=== FULL STATE ===');
                console.log(JSON.stringify(res, null, 2));
                alert('已导出到 Console（右键插件图标 → 检查弹出内容 → Console）');
              });
            }}
          >
            导出状态到 Console
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {page === 'list' && (
          <RuleList
            state={state}
            onRefresh={refreshState}
            onEditRule={handleEditRule}
          />
        )}
        {page === 'editor' && (
          <RuleEditor
            rule={editingRule}
            groups={state.groups}
            onSave={handleSaveRule}
            onCancel={() => setPage('list')}
          />
        )}
        {page === 'apitest' && <ApiTester />}
      </main>
    </div>
  );
}
