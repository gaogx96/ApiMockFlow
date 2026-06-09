import React, { useState } from 'react';
import {
  Rule, RuleGroup, RuleMatch, Action, ActionType, MatchType,
  ACTION_TYPE_LABELS, OPERATE_TYPE_LABELS, MATCH_TYPE_LABELS
} from '../../shared/types';
import { generateId, HTTP_METHODS, RESOURCE_TYPES, GROUP_COLORS } from '../../shared/constants';

interface Props {
  rule: Rule | null;
  groups: RuleGroup[];
  onSave: () => void;
  onCancel: () => void;
}

const DEFAULT_MATCH: RuleMatch = { url: '', matchType: 'contains', method: '', resourceType: '' };

const DEFAULT_ACTION: Action = {
  type: 'modifyResponseBody',
  operate: 'replace',
  key: '',
  value: '',
};

export default function RuleEditor({ rule, groups, onSave, onCancel }: Props) {
  const isEdit = !!rule;
  const [name, setName] = useState(rule?.name || '');
  const [groupId, setGroupId] = useState(rule?.groupId || 'default');
  const [match, setMatch] = useState<RuleMatch>(rule?.match || DEFAULT_MATCH);
  const [actions, setActions] = useState<Action[]>(rule?.actions || [{ ...DEFAULT_ACTION }]);

  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState(GROUP_COLORS[0]);

  const updateAction = (index: number, field: keyof Action, value: string) => {
    const newActions = [...actions];
    newActions[index] = { ...newActions[index], [field]: value };
    if (field === 'type') {
      const t = value as ActionType;
      if (t === 'cancel' || t === 'redirect' || t === 'modifyStatusCode') {
        newActions[index].operate = 'set';
      }
    }
    setActions(newActions);
  };

  const addAction = () => setActions([...actions, { ...DEFAULT_ACTION }]);
  const removeAction = (index: number) => setActions(actions.filter((_, i) => i !== index));

  const handleSave = async () => {
    if (!name.trim()) { alert('请输入规则名称'); return; }
    if (!match.url.trim()) { alert('请输入匹配 URL'); return; }
    if (actions.length === 0) { alert('请至少添加一个动作'); return; }

    // Validate match regex
    if (match.matchType === 'regex') {
      try { new RegExp(match.url); } catch { alert(`URL 正则表达式无效: ${match.url}`); return; }
    }

    // Validate action regex
    for (const action of actions) {
      if (action.operate === 'replace') {
        if (!action.key || !action.key.trim()) {
          alert('替换操作必须提供非空的匹配文本/正则表达式'); return;
        }
        try { new RegExp(action.key); } catch { alert(`正则表达式无效: ${action.key}`); return; }
      }
    }

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
  };

  const showKeyField = (type: ActionType) => !['cancel', 'modifyStatusCode'].includes(type);
  const showValueField = (type: ActionType) => type !== 'cancel';
  const showOperateField = (type: ActionType) => !['cancel', 'redirect', 'modifyStatusCode'].includes(type);

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
    return '值';
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-white">
        <span className="text-sm font-semibold text-gray-800">
          {isEdit ? '编辑规则' : '新建规则'}
        </span>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
      </div>

      <div className="overflow-y-auto flex-1 p-4 space-y-4 bg-gray-50">
        {/* Basic info */}
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">基本信息</h3>
          <div className="space-y-2.5">
            <div>
              <label className="form-label">规则名称</label>
              <input
                type="text"
                placeholder="例如：修改 API 响应数据"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="form-input w-full"
                autoFocus
              />
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
                }}
                className="form-select"
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
                <option value="__new__">+ 新建分组</option>
              </select>
            </div>
            {showNewGroup && (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="form-label">新分组名称</label>
                  <input
                    type="text"
                    placeholder="分组名称"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    className="form-input w-full"
                  />
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
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">匹配条件</h3>
          <div className="space-y-2.5">
            {/* URL input — standalone full width for reliable focus */}
            <div className="flex gap-2">
              <select
                value={match.matchType}
                onChange={(e) => setMatch({ ...match, matchType: e.target.value as MatchType })}
                className="form-select shrink-0"
                style={{ width: '90px' }}
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
                onChange={(e) => setMatch({ ...match, url: e.target.value })}
                className="form-input mono"
                style={{ flex: '1 1 0%', minWidth: 0 }}
              />
            </div>
            {match.matchType === 'regex' && match.url.trim() && (
              <div className={`text-xs ml-[7.5rem] -mt-1.5 ${
                (() => { try { new RegExp(match.url); return true; } catch { return false; } })()
                  ? 'text-green-600'
                  : 'text-red-500'
              }`}>
                {(() => { try { new RegExp(match.url); return true; } catch { return false; } })()
                  ? '✓ 正则表达式有效'
                  : '✗ 正则表达式无效'}
              </div>
            )}
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

        {/* Actions */}
        <div className="bg-white rounded-lg border border-gray-200 p-3">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">修改动作</h3>
            <button onClick={addAction} className="text-xs text-primary-500 hover:text-primary-600 font-medium">
              + 添加
            </button>
          </div>
          <div className="space-y-3">
            {actions.map((action, i) => (
              <div key={i} className="p-3 bg-gray-50 rounded-lg border border-gray-100">
                <div className="flex items-center justify-between mb-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-300 font-mono">#{i + 1}</span>
                    <select
                      value={action.type}
                      onChange={(e) => updateAction(i, 'type', e.target.value)}
                      className="text-xs font-medium border-none bg-transparent text-gray-700 focus:outline-none cursor-pointer"
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
                        className="text-xs px-2 py-0.5 border border-gray-200 rounded bg-white text-gray-600 focus:outline-none focus:border-primary-400"
                      >
                        {Object.entries(OPERATE_TYPE_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
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
                    <input
                      type="text"
                      placeholder={getKeyPlaceholder(action)}
                      value={action.key}
                      onChange={(e) => updateAction(i, 'key', e.target.value)}
                      className="form-input w-full text-xs mono"
                    />
                  )}
                  {showValueField(action.type) && (
                    <textarea
                      placeholder={getValuePlaceholder(action)}
                      value={action.value}
                      onChange={(e) => updateAction(i, 'value', e.target.value)}
                      rows={action.type.includes('Body') ? 3 : 1}
                      className="form-textarea text-xs"
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex gap-2 px-4 py-3 bg-white border-t border-gray-200 shrink-0">
        <button onClick={onCancel} className="btn-secondary flex-1">取消</button>
        <button onClick={handleSave} className="btn-primary flex-1">
          {isEdit ? '保存修改' : '创建规则'}
        </button>
      </div>
    </div>
  );
}
