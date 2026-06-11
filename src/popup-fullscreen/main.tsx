import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import RuleEditor from '../popup/pages/RuleEditor';
import { Rule, RuleGroup, RuleMatch } from '../shared/types';
import '../styles/global.css';

function FullscreenEditor() {
  const [rule, setRule] = useState<Rule | null>(null);
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [prefill, setPrefill] = useState<Partial<RuleMatch> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // Load dark mode preference
    chrome.storage.local.get('theme', (res) => {
      if (res.theme === 'dark') document.documentElement.classList.add('dark');
    });

    const params = new URLSearchParams(window.location.search);
    const ruleId = params.get('ruleId');
    const isNew = params.get('new') === 'true';
    const groupId = params.get('groupId');

    // Fetch groups
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (res) {
        setGroups(res.groups || []);

        if (ruleId) {
          // Edit existing rule
          const found = res.rules.find((r: Rule) => r.id === ruleId);
          if (found) setRule(found);
        } else if (isNew) {
          // New rule with optional prefill
          const url = params.get('url') || '';
          const matchType = params.get('matchType') || 'contains';
          const method = params.get('method') || '';
          const resourceType = params.get('resourceType') || '';
          setPrefill({ url, matchType: matchType as any, method, resourceType });
        }

        setLoading(false);
      }
    });
  }, []);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClose = () => {
    window.close();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 dark:bg-gray-900">
        <span className="text-sm text-gray-400">加载中...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-6 px-4">
      <div className="max-w-3xl mx-auto bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden" style={{ minHeight: '80vh' }}>
        {saved && (
          <div className="bg-green-50 dark:bg-green-900/30 border-b border-green-200 dark:border-green-800 px-4 py-2 text-sm text-green-700 dark:text-green-400 flex items-center justify-between">
            <span>规则已保存</span>
            <button onClick={() => setSaved(false)} className="text-green-500 hover:text-green-700">&times;</button>
          </div>
        )}
        <RuleEditor
          rule={rule}
          groups={groups}
          onSave={handleSave}
          onCancel={handleClose}
          prefill={prefill}
        />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FullscreenEditor />
  </React.StrictMode>
);
