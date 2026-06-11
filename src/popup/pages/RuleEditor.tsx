import React, { useState } from 'react';
import {
  Rule, RuleGroup, RuleMatch, Action, ActionType, MatchType,
  ACTION_TYPE_LABELS, OPERATE_TYPE_LABELS, MATCH_TYPE_LABELS
} from '../../shared/types';
import { generateId, HTTP_METHODS, RESOURCE_TYPES, GROUP_COLORS } from '../../shared/constants';
import { ArrowsPointingOutIcon } from '@heroicons/react/24/outline';
import { showToast } from '../../shared/toast';

const isFullscreen = window.location.pathname.includes('popup-fullscreen');

interface Props {
  rule: Rule | null;
  groups: RuleGroup[];
  onSave: () => void;
  onCancel: () => void;
  prefill?: Partial<RuleMatch> | null;
}

const DEFAULT_MATCH: RuleMatch = { url: '', matchType: 'contains', method: '', resourceType: '' };

const DEFAULT_ACTION: Action = {
  type: 'modifyResponseBody',
  operate: 'replace',
  key: '',
  value: '',
};

export default function RuleEditor({ rule, groups, onSave, onCancel, prefill }: Props) {
  const isEdit = !!rule;
  const [name, setName] = useState(rule?.name || '');
  const [groupId, setGroupId] = useState(rule?.groupId || 'default');
  const [match, setMatch] = useState<RuleMatch>(rule?.match || {
    url: prefill?.url || '',
    matchType: prefill?.matchType || 'contains',
    method: prefill?.method || '',
    resourceType: prefill?.resourceType || '',
  });
  const [actions, setActions] = useState<Action[]>(rule?.actions || [{ ...DEFAULT_ACTION }]);

  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState(GROUP_COLORS[0]);
  const [testExpanded, setTestExpanded] = useState(false);
  const [testUrl, setTestUrl] = useState('');
  const [testMethod, setTestMethod] = useState('');
  const [testResourceType, setTestResourceType] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  function testMatch() {
    if (!match.url.trim() || !testUrl.trim()) return null;
    // URL match
    var urlOk = false;
    switch (match.matchType) {
      case 'exact': urlOk = testUrl === match.url; break;
      case 'contains': urlOk = testUrl.indexOf(match.url) >= 0; break;
      case 'regex': try { urlOk = new RegExp(match.url).test(testUrl); } catch (_) { return { ok: false, reason: '正则表达式无效' }; } break;
      case 'domain': try { var u = new URL(testUrl); urlOk = u.hostname === match.url || u.hostname.endsWith('.' + match.url); } catch (_) { return { ok: false, reason: '测试 URL 格式无效' }; } break;
    }
    if (!urlOk) return { ok: false, reason: 'URL 不匹配' };
    if (match.method && match.method !== testMethod) return { ok: false, reason: '请求方法不匹配' };
    if (match.resourceType && match.resourceType !== testResourceType) return { ok: false, reason: '资源类型不匹配' };
    return { ok: true, reason: '匹配成功' };
  }

  var testResult = testMatch();

  const updateAction = (index: number, field: keyof Action, value: string) => {
    const newActions = [...actions];
    newActions[index] = { ...newActions[index], [field]: value };
    if (field === 'type') {
      const t = value as ActionType;
      if (t === 'cancel' || t === 'redirect' || t === 'modifyStatusCode' || t === 'delay' || t === 'injectScript') {
        newActions[index].operate = 'set';
      }
    }
    setActions(newActions);
  };

  const addAction = () => setActions([...actions, { ...DEFAULT_ACTION }]);
  const removeAction = (index: number) => setActions(actions.filter((_, i) => i !== index));

  const clearError = (key: string) => { if (errors[key]) { const e = { ...errors }; delete e[key]; setErrors(e); } };

  const handleSave = async () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = '请输入规则名称';
    if (!match.url.trim()) errs.matchUrl = '请输入匹配 URL';
    if (actions.length === 0) errs.actions = '请至少添加一个动作';
    if (match.matchType === 'regex' && match.url.trim()) {
      try { new RegExp(match.url); } catch { errs.matchUrl = '正则表达式格式无效'; }
    }
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.operate === 'replace') {
        if (!a.key || !a.key.trim()) { errs[`action_${i}_key`] = '替换操作必须提供匹配文本'; }
        else { try { new RegExp(a.key); } catch { errs[`action_${i}_key`] = '正则表达式格式无效'; } }
      }
    }
    if (showNewGroup && !newGroupName.trim()) errs.newGroup = '请输入新分组名称';
    if (!showNewGroup && !groups.find(g => g.id === groupId)) errs.group = '所选分组不存在';
    if (Object.keys(errs).length > 0) { setErrors(errs); showToast(Object.values(errs)[0], 'warning'); return; }
    setErrors({});

    try {
    const now = Date.now();
    const newRule: Rule = {
      id: rule?.id || generateId(),
      name: name.trim(),
      groupId,
      enabled: rule?.enabled ?? true,
      createdAt: rule?.createdAt || now,
      updatedAt: now,
      match: { ...match, url: match.url.trim() },
      actions: actions.map((a) => ({
        ...a,
        key: a.key.trim(),
        value: a.value,
      })),
    };

    const resp = await chrome.runtime.sendMessage({ type: 'GET_RULES' });
    const rules: Rule[] = resp || [];
    const index = rules.findIndex((r) => r.id === newRule.id);
    if (index >= 0) rules[index] = newRule;
    else rules.push(newRule);
    await chrome.runtime.sendMessage({ type: 'SAVE_RULES', payload: rules });

    if (showNewGroup && newGroupName.trim()) {
      const groupsResp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      const currentGroups = groupsResp?.groups || [];
      if (!currentGroups.find((g: RuleGroup) => g.id === groupId)) {
        const newGroups = [...currentGroups, {
          id: groupId, name: newGroupName.trim(), enabled: true, color: newGroupColor
        }];
        await chrome.runtime.sendMessage({ type: 'SAVE_GROUPS', payload: newGroups });
      }
    }

    onSave();
    } catch (err) {
      showToast('保存失败：' + (err instanceof Error ? err.message : '未知错误'), 'error');
    }
  };

  const showKeyField = (type: ActionType) => !['cancel', 'modifyStatusCode', 'delay', 'injectScript'].includes(type);
  const showValueField = (type: ActionType) => type !== 'cancel';
  const showOperateField = (type: ActionType) => !['cancel', 'redirect', 'modifyStatusCode', 'delay', 'injectScript'].includes(type);

  const getAvailableOperates = (type: ActionType): (keyof typeof OPERATE_TYPE_LABELS)[] => {
    if (type === 'modifyRequestBody' || type === 'modifyResponseBody') return ['set', 'replace'];
    return Object.keys(OPERATE_TYPE_LABELS) as (keyof typeof OPERATE_TYPE_LABELS)[];
  };

  const getKeyPlaceholder = (action: Action) => {
    if (action.operate === 'replace') return '正则表达式';
    if (action.type === 'modifyRequestUrl') return '参数名 (key)';
    if (action.type.includes('Header')) return 'Header 名称';
    if (action.type.includes('Body')) return '搜索文本';
    return '键名';
  };

  const getValuePlaceholder = (action: Action) => {
    if (action.operate === 'replace') return '替换文本';
    if (action.type === 'modifyResponseBody') return '新的响应体内容 (支持 JSON)';
    if (action.type === 'modifyRequestBody') return '新的请求体内容 (支持 JSON)';
    if (action.type === 'redirect') return '目标 URL';
    if (action.type === 'modifyStatusCode') return 'HTTP 状态码 (如 200, 404)';
    if (action.type === 'delay') return '延迟毫秒数 (如 3000)';
    if (action.type === 'injectScript') return '要注入的 JavaScript 代码';
    return '值';
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800">
        <span className="text-sm font-semibold text-gray-800 dark:text-slate-200">
          {isEdit ? '编辑规则' : '新建规则'}
        </span>
        <div className="flex items-center gap-1">
          {!isFullscreen && (
            <button
              onClick={() => {
                const params = new URLSearchParams();
                if (rule) params.set('ruleId', rule.id);
                else { params.set('new', 'true'); if (match.url) params.set('url', match.url); }
                chrome.tabs.create({ url: chrome.runtime.getURL('popup-fullscreen.html') + '?' + params.toString() });
              }}
              className="text-gray-400 hover:text-gray-600 p-0.5"
              title="全屏编辑"
            >
              <ArrowsPointingOutIcon className="w-4 h-4" />
            </button>
          )}
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>
      </div>

      <div className="overflow-y-auto flex-1 p-4 space-y-4 bg-gray-50 dark:bg-slate-900">
        {/* Basic info */}
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-3">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 mb-3">基本信息</h3>
          <div className="space-y-2.5">
            <div>
              <label className="form-label">规则名称</label>
              <input
                type="text"
                placeholder="例如：修改 API 响应数据"
                value={name}
                onChange={(e) => { setName(e.target.value); clearError('name'); }}
                className={`form-input w-full ${errors.name ? 'border-red-400 focus:border-red-400 focus:ring-red-100' : ''}`}
                autoFocus
              />
              {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
            </div>
            <div>
              <label className="form-label">所属分组</label>
              <select
                value={groupId}
                onChange={(e) => {
                  if (e.target.value === '__new__') {
                    setShowNewGroup(true);
                    setGroupId(generateId());
                  } else {
                    setShowNewGroup(false);
                    setGroupId(e.target.value);
                  }
                  clearError('group');
                }}
                className={`form-select ${errors.group ? 'border-red-400' : ''}`}
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
                <option value="__new__">+ 新建分组</option>
              </select>
              {errors.group && <p className="text-xs text-red-500 mt-1">{errors.group}</p>}
            </div>
            {showNewGroup && (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="form-label">新分组名称</label>
                  <input
                    type="text"
                    placeholder="分组名称"
                    value={newGroupName}
                    onChange={(e) => { setNewGroupName(e.target.value); clearError('newGroup'); }}
                    className={`form-input w-full ${errors.newGroup ? 'border-red-400' : ''}`}
                  />
                  {errors.newGroup && <p className="text-xs text-red-500 mt-1">{errors.newGroup}</p>}
                </div>
                <div className="flex gap-1 pb-1">
                  {GROUP_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`w-6 h-6 rounded-full border-2 transition-all ${newGroupColor === c ? 'border-gray-700 scale-110' : 'border-transparent hover:scale-105'}`}
                      style={{ backgroundColor: c }}
                      onClick={() => setNewGroupColor(c)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Match conditions */}
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-3">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400 mb-3">匹配条件</h3>
          <div className="space-y-2.5">
            <div className="flex gap-2">
              <select
                value={match.matchType}
                onChange={(e) => { setMatch({ ...match, matchType: e.target.value as MatchType }); clearError('matchUrl'); }}
                className="form-select shrink-0"
                style={{ width: '70px' }}
              >
                {Object.entries(MATCH_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder={
                  match.matchType === 'regex' ? '正则表达式' :
                  match.matchType === 'domain' ? 'example.com' :
                  '输入 URL 或 URL 特征'
                }
                value={match.url}
                onChange={(e) => { setMatch({ ...match, url: e.target.value }); clearError('matchUrl'); }}
                className={`form-input mono flex-1 min-w-0 ${errors.matchUrl ? 'border-red-400' : ''}`}
              />
            </div>
            {match.matchType === 'regex' && match.url.trim() && !errors.matchUrl && (
              <div className={`text-xs pl-[76px] -mt-1.5 ${
                (() => { try { new RegExp(match.url); return true; } catch { return false; } })()
                  ? 'text-green-600'
                  : 'text-red-500'
              }`}>
                {(() => { try { new RegExp(match.url); return true; } catch { return false; } })()
                  ? '✓ 正则表达式有效'
                  : '✗ 正则表达式无效'}
              </div>
            )}
            {errors.matchUrl && <p className="text-xs text-red-500 pl-[76px] -mt-1.5">{errors.matchUrl}</p>}
            <div className="flex gap-2">
              <select
                value={match.method}
                onChange={(e) => setMatch({ ...match, method: e.target.value })}
                className="form-select flex-1"
              >
                {HTTP_METHODS.map((m) => (
                  <option key={m} value={m}>{m || '全部请求方法'}</option>
                ))}
              </select>
              <select
                value={match.resourceType}
                onChange={(e) => setMatch({ ...match, resourceType: e.target.value })}
                className="form-select flex-1"
              >
                {RESOURCE_TYPES.map((t) => (
                  <option key={t} value={t}>{t || '全部资源类型'}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Test Match */}
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700">
          <button
            className="flex items-center justify-between w-full px-3 py-2.5 text-left"
            onClick={() => setTestExpanded(!testExpanded)}
          >
            <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400">测试匹配</h3>
            <span className="text-xs text-gray-400">{testExpanded ? '▾' : '▸'}</span>
          </button>
          {testExpanded && (
            <div className="px-3 pb-3 space-y-2">
              <div className="flex gap-1.5">
                <input type="text" placeholder="输入测试 URL..."
                  value={testUrl} onChange={e => setTestUrl(e.target.value)}
                  className="form-input flex-1 text-xs py-1 px-2" />
                <select value={testMethod} onChange={e => setTestMethod(e.target.value)}
                  className="form-select text-xs py-1 w-20 pr-5">
                  <option value="">全部方法</option>
                  {HTTP_METHODS.filter(m => m).map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <select value={testResourceType} onChange={e => setTestResourceType(e.target.value)}
                  className="form-select text-xs py-1 w-20 pr-5">
                  <option value="">全部类型</option>
                  {RESOURCE_TYPES.filter(t => t).map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              {testResult && (
                <div className={`text-xs py-1.5 px-2 rounded font-medium ${
                  testResult.ok ? 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400' : 'bg-red-50 text-red-500 dark:bg-red-900/20 dark:text-red-400'
                }`}>
                  {testResult.ok ? '匹配成功' : '不匹配 — ' + testResult.reason}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-3">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-slate-400">修改动作</h3>
            <button onClick={addAction} className="text-xs text-primary-500 hover:text-primary-600 font-medium">
              + 添加
            </button>
          </div>
          {errors.actions && <p className="text-xs text-red-500 mb-2">{errors.actions}</p>}
          <div className="space-y-3">
            {actions.map((action, i) => {
              const isReq = ['modifyRequestUrl','modifyRequestHeader','modifyRequestBody','redirect','cancel','delay','injectScript'].includes(action.type);
              return (
              <div key={i} className="p-3 bg-gray-50 dark:bg-slate-900 rounded-lg border border-gray-100 dark:border-slate-700">
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isReq ? 'bg-blue-400' : 'bg-green-400'}`} title={isReq ? '请求阶段' : '响应阶段'} />
                    <select
                      value={action.type}
                      onChange={(e) => updateAction(i, 'type', e.target.value)}
                      className="text-xs font-medium border-none bg-transparent text-gray-700 dark:text-slate-300 focus:outline-none cursor-pointer"
                    >
                      {Object.entries(ACTION_TYPE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    {showOperateField(action.type) && (
                      <select
                        value={action.operate}
                        onChange={(e) => updateAction(i, 'operate', e.target.value)}
                        className="text-xs px-2 py-0.5 border border-gray-200 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-400 focus:outline-none focus:border-primary-400"
                      >
                        {getAvailableOperates(action.type).map(k => (
                          <option key={k} value={k}>{OPERATE_TYPE_LABELS[k]}</option>
                        ))}
                      </select>
                    )}
                    {actions.length > 1 && (
                      <button onClick={() => removeAction(i)} className="text-gray-300 hover:text-red-400 text-xs">
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  {showKeyField(action.type) && (
                    <div>
                      <input
                        type="text"
                        placeholder={getKeyPlaceholder(action)}
                        value={action.key}
                        onChange={(e) => { updateAction(i, 'key', e.target.value); clearError(`action_${i}_key`); }}
                        className={`form-input w-full text-xs mono ${errors[`action_${i}_key`] ? 'border-red-400' : ''}`}
                      />
                      {errors[`action_${i}_key`] && <p className="text-xs text-red-500 mt-1">{errors[`action_${i}_key`]}</p>}
                    </div>
                  )}
                  {showValueField(action.type) && (
                    <textarea
                      placeholder={getValuePlaceholder(action)}
                      value={action.value}
                      onChange={(e) => updateAction(i, 'value', e.target.value)}
                      rows={action.type === 'injectScript' ? 6 : action.type.includes('Body') ? 5 : (action.type.includes('Header') || action.type === 'modifyRequestUrl') ? 1 : 2}
                      className="form-textarea text-xs"
                    />
                  )}
                </div>
              </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex gap-2 px-4 py-3 bg-white dark:bg-slate-800 border-t border-gray-200 dark:border-slate-700 shrink-0">
        <button onClick={onCancel} className="btn-secondary flex-1">取消</button>
        <button onClick={handleSave} className="btn-primary flex-1">
          {isEdit ? '保存修改' : '创建规则'}
        </button>
      </div>
    </div>
  );
}
