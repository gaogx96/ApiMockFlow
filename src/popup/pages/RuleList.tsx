import React, { useState } from 'react';
import { MagnifyingGlassIcon, PlusIcon, ArrowDownTrayIcon, ArrowUpTrayIcon, TrashIcon, ClipboardDocumentListIcon, ChevronUpIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { AppState, Rule, MATCH_TYPE_LABELS, ACTION_TYPE_LABELS } from '../../shared/types';
import { showToast, showConfirm } from '../../shared/toast';

interface Props {
  state: AppState;
  onRefresh: () => void;
  onEditRule: (rule: Rule | null) => void;
}

export default function RuleList({ state, onRefresh, onEditRule }: Props) {
  const [search, setSearch] = useState('');
  const [filterGroup, setFilterGroup] = useState('');

  const filteredRules = state.rules.filter((rule) => {
    const matchSearch = !search ||
      rule.name?.toLowerCase().includes(search.toLowerCase()) ||
      rule.match?.url?.toLowerCase().includes(search.toLowerCase());
    const matchGroup = !filterGroup || rule.groupId === filterGroup;
    return matchSearch && matchGroup;
  });

  const toggleRule = async (ruleId: string, enabled: boolean) => {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_RULE', payload: { ruleId, enabled } });
    onRefresh();
  };

  const deleteRule = async (ruleId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await showConfirm('确定删除此规则？')) return;
    await chrome.runtime.sendMessage({ type: 'DELETE_RULE', payload: { id: ruleId } });
    onRefresh();
  };

  const moveRule = async (idx: number, dir: -1 | 1) => {
    const newRules = [...state.rules];
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= newRules.length) return;
    [newRules[idx], newRules[targetIdx]] = [newRules[targetIdx], newRules[idx]];
    await chrome.runtime.sendMessage({ type: 'SAVE_RULES', payload: newRules });
    onRefresh();
  };

  const handleExport = async () => {
    const json = await chrome.runtime.sendMessage({ type: 'EXPORT_RULES' });
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `api-interceptor-rules-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        JSON.parse(text);
        await chrome.runtime.sendMessage({ type: 'IMPORT_RULES', payload: text });
        onRefresh();
      } catch {
        showToast('导入失败：无效的 JSON 文件', 'error');
      }
    };
    input.click();
  };

  const getGroup = (groupId: string) => state.groups.find((g) => g.id === groupId);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="px-3 py-2.5 border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="搜索规则名称或 URL..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-100 bg-gray-50 dark:bg-slate-900"
            />
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          </div>
          <button
            onClick={() => onEditRule(null)}
            className="px-3 py-1.5 text-xs bg-primary-500 text-white rounded-md hover:bg-primary-600 font-medium whitespace-nowrap"
          >
            <PlusIcon className="w-3.5 h-3.5 inline -mt-0.5" /> 新建规则
          </button>
        </div>

        {/* Group filter chips */}
        {state.groups.length > 1 && (
          <div className="flex gap-1.5 mt-2 overflow-x-auto pb-0.5">
            <button
              className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                !filterGroup ? 'bg-primary-50 text-primary-600 dark:bg-slate-700 dark:text-blue-400' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
              }`}
              onClick={() => setFilterGroup('')}
            >
              全部
            </button>
            {state.groups.map((g) => (
              <button
                key={g.id}
                className={`px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                  filterGroup === g.id ? 'bg-primary-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
                }`}
                onClick={() => setFilterGroup(g.id)}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
                  style={{ backgroundColor: g.color }} />
                {g.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Rules table */}
      <div className="flex-1 overflow-y-auto">
        {filteredRules.length === 0 ? (
          <div className="empty-state">
            <div className="icon"><ClipboardDocumentListIcon className="w-8 h-8 text-gray-300" /></div>
            <div className="title">{state.rules.length === 0 ? '还没有规则' : '没有匹配的规则'}</div>
            <div className="desc">
              {state.rules.length === 0 ? '点击「+ 新建规则」开始拦截请求' : '换个搜索词试试'}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-slate-700">
            {filteredRules.map((rule) => {
              const group = getGroup(rule.groupId);
              const actionCount = rule.actions?.length || 0;
              const firstAction = rule.actions?.[0];

              return (
                <div
                  key={rule.id}
                  className={`px-3 py-2.5 hover:bg-white dark:hover:bg-slate-800 cursor-pointer transition-colors ${!rule.enabled ? 'opacity-50' : ''}`}
                  onClick={() => onEditRule(rule)}
                >
                  <div className="flex items-center gap-2">
                    {/* Group color dot */}
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: group?.color || '#d1d5db' }}
                      title={group?.name}
                    />
                    {/* Name + URL */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-gray-800 dark:text-slate-200 truncate">{rule.name}</span>
                        {group && (
                          <span
                            className="px-1.5 py-px text-xs rounded font-medium shrink-0"
                            style={{ backgroundColor: group.color + '18', color: group.color }}
                          >
                            {group.name}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-slate-500 truncate mt-0.5 font-mono">
                        {MATCH_TYPE_LABELS[rule.match?.matchType || 'contains']}: {rule.match?.url || ''}
                      </div>
                    </div>

                    {/* Action chips */}
                    <div className="flex items-center gap-1 shrink-0">
                      {firstAction && (
                        <span className="tag tag-blue">{ACTION_TYPE_LABELS[firstAction.type]}</span>
                      )}
                      {actionCount > 1 && (
                        <span className="tag tag-gray">+{actionCount - 1}</span>
                      )}
                    </div>

                    {/* Toggle */}
                    <div
                      className={`toggle-switch ${rule.enabled ? 'active' : ''}`}
                      onClick={(e) => { e.stopPropagation(); toggleRule(rule.id, !rule.enabled); }}
                    />

                    {/* Move + Delete (hover only) */}
                    <div className="rule-hover-actions flex items-center gap-0.5 shrink-0">
                      <button className="btn-ghost p-0 leading-none" onClick={(e) => { e.stopPropagation(); moveRule(state.rules.findIndex(r => r.id === rule.id), -1); }} title="上移">
                        <ChevronUpIcon className="w-3.5 h-3.5" />
                      </button>
                      <button className="btn-ghost p-0 leading-none" onClick={(e) => { e.stopPropagation(); moveRule(state.rules.findIndex(r => r.id === rule.id), 1); }} title="下移">
                        <ChevronDownIcon className="w-3.5 h-3.5" />
                      </button>
                      <button className="btn-ghost p-1 text-xs" onClick={(e) => deleteRule(rule.id, e)} title="删除">
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex gap-2 px-3 py-2 border-t border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 shrink-0">
        <button
          onClick={handleExport}
          className="flex-1 py-1.5 text-xs text-gray-600 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-md hover:bg-gray-50 dark:hover:bg-slate-700 font-medium"
        >
          <ArrowDownTrayIcon className="w-3.5 h-3.5 inline -mt-0.5" /> 导出
        </button>
        <button
          onClick={handleImport}
          className="flex-1 py-1.5 text-xs text-gray-600 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-md hover:bg-gray-50 dark:hover:bg-slate-700 font-medium"
        >
          <ArrowUpTrayIcon className="w-3.5 h-3.5 inline -mt-0.5" /> 导入
        </button>
      </div>
    </div>
  );
}
