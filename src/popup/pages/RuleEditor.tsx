import React, { useState, useMemo, useRef } from 'react';
import {
  Rule, RuleGroup, RuleMatch, Action, ActionType, MatchType, CreateRuleContext,
  ACTION_TYPE_LABELS, OPERATE_TYPE_LABELS, MATCH_TYPE_LABELS
} from '../../shared/types';
import { generateId, HTTP_METHODS, RESOURCE_TYPES, GROUP_COLORS } from '../../shared/constants';
import Icon from '../components/Icon';
import Select from '../components/Select';
import SearchBar from '../components/SearchBar';
import { useTextareaSearch } from '../components/search';
import { showToast } from '../../shared/toast';
import { repairAndFormatJson, minifyJson } from '../../shared/json-format';

/**
 * 修改请求体/响应体的编辑框：内建关键字搜索（原生选区定位）。
 * 独立成组件，以便在 actions.map 中为每个 body 动作各持一份搜索态（Hook 不可在循环里调用）。
 */
function BodyValueField({ value, onChange, placeholder, rows, hasError, showFormat, onFormat, onMinify }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  rows: number;
  hasError: boolean;
  showFormat: boolean;
  onFormat: () => void;
  onMinify: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const s = useTextareaSearch(ref, value, open ? query : '');
  return (
    <>
      <div className="flex justify-end items-center gap-2 mb-1">
        {showFormat && (
          <>
            <button type="button" onClick={onFormat} className="text-xs text-primary-500 hover:text-primary-600 font-medium"
              title="格式化 JSON（缩进 2 空格）；能自动修复常见错误：多余逗号、单引号、缺引号、注释、缺括号、中文标点等">格式化 JSON</button>
            <button type="button" onClick={onMinify} className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 font-medium"
              title="压缩 JSON：去掉所有空白压成一行（先尝试修复再压缩）">压缩</button>
          </>
        )}
        <button type="button" onClick={() => setOpen(o => !o)} className={`btn-ghost p-1 ${open ? 'text-primary-600' : ''}`}
          aria-label="搜索" data-tip="搜索关键字"><Icon name="search" size={14} /></button>
      </div>
      {open && (
        <div className="mb-1">
          <SearchBar
            query={query}
            onQueryChange={setQuery}
            count={s.count}
            index={s.index}
            onNext={s.next}
            onPrev={s.prev}
            onClose={() => { setOpen(false); setQuery(''); }}
            placeholder="在内容中搜索…"
          />
        </div>
      )}
      <textarea
        ref={ref}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className={`form-textarea text-xs w-full ${hasError ? 'border-red-400 focus:border-red-400 focus:ring-red-100' : ''}`}
      />
    </>
  );
}

interface Props {
  rule: Rule | null;
  groups: RuleGroup[];
  onSave: () => void;
  onCancel: () => void;
  onBack?: () => void;
  prefill?: Partial<RuleMatch> | null;
  createContext?: CreateRuleContext | null;
}

const DEFAULT_MATCH: RuleMatch = { url: '', matchType: 'contains', method: '', resourceType: '' };

const DEFAULT_ACTION: Action = {
  type: 'modifyResponseBody',
  operate: 'replace',
  key: '',
  value: '',
};

export default function RuleEditor({ rule, groups, onSave, onCancel, onBack, prefill, createContext }: Props) {
  const isEdit = !!rule;
  const [name, setName] = useState(rule?.name || (createContext ? `${createContext.mode === 'request' ? '修改请求' : 'Mock 响应'} ${createContext.log.method} ${createContext.log.url}` : ''));
  const [groupId, setGroupId] = useState(rule?.groupId || 'default');
  const contextLog = createContext?.log;
  const [match, setMatch] = useState<RuleMatch>(rule?.match || {
    url: contextLog?.url || prefill?.url || '', matchType: contextLog ? 'exact' : (prefill?.matchType || 'contains'),
    method: contextLog?.method || prefill?.method || '', resourceType: contextLog?.resourceType || prefill?.resourceType || '',
  });
  const initialActions = (): Action[] => {
    if (!createContext || !contextLog) return rule?.actions || [{ ...DEFAULT_ACTION }];
    if (createContext.mode === 'response') {
      const response = contextLog.modifiedResponse || contextLog.originalResponse;
      const acts: Action[] = [];
      if (response) acts.push({ type: 'modifyResponseBody', operate: 'set', key: '', value: response.body || '' });
      if (response && response.status !== contextLog.originalResponse?.status) acts.push({ type: 'modifyStatusCode', operate: 'set', key: '', value: String(response.status) });
      return acts.length ? acts : [{ ...DEFAULT_ACTION }];
    }
    const acts: Action[] = [];
    const original = contextLog.originalRequest, modified = contextLog.modifiedRequest;
    // 请求观察没有“修改前/修改后”差异，创建请求规则时仍要把完整请求上下文带入，
    // 让用户可以直接编辑 URL、Header 和 Body，而不是只看到一个 URL 动作。
    acts.push({ type: 'modifyRequestUrl', operate: 'set', key: '', value: modified.url || contextLog.url });
    const originalHeaders = original.headers || {}, modifiedHeaders = modified.headers || {};
    const headerMap = new Map<string, { name: string; oldValue?: string; newValue?: string }>();
    for (const [name, value] of Object.entries(originalHeaders)) {
      headerMap.set(name.toLowerCase(), { name, oldValue: value });
    }
    for (const [name, value] of Object.entries(modifiedHeaders)) {
      const key = name.toLowerCase();
      const current = headerMap.get(key);
      headerMap.set(key, { name: current?.name || name, oldValue: current?.oldValue, newValue: value });
    }
    const generatedHeaderSkip = new Set(['content-length', 'host', 'connection', 'accept-encoding']);
    for (const item of headerMap.values()) {
      if (item.newValue !== undefined && !generatedHeaderSkip.has(item.name.toLowerCase())) {
        acts.push({ type: 'modifyRequestHeader', operate: 'set', key: item.name, value: item.newValue });
      }
    }
    if (modified.body !== undefined) acts.push({ type: 'modifyRequestBody', operate: 'set', key: '', value: modified.body || '' });
    return acts;
  };
  const [actions, setActions] = useState<Action[]>(initialActions);

  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState(GROUP_COLORS[0]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Memoize regex validity to avoid recompilation on every render
  const isRegexValid = useMemo(() => {
    if (match.matchType !== 'regex' || !match.url.trim()) return null;
    try { new RegExp(match.url); return true; } catch { return false; }
  }, [match.matchType, match.url]);

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

  // 「设置请求体/响应体」的值：合法则美化；非法则尝试自动修复常见错误并填入，仍失败给带位置的提示
  const formatActionValue = (index: number) => {
    const cur = actions[index]?.value || '';
    if (!cur.trim()) return;
    const r = repairAndFormatJson(cur);
    if (r.ok) {
      updateAction(index, 'value', r.text);
      clearError(`action_${index}_value`);
      if (r.repaired) showToast('已自动修复并格式化，请核对内容', 'success', 4000);
    } else {
      showToast(r.error || '不是合法 JSON', 'warning', 6000);
    }
  };

  // 「设置请求体/响应体」的值压缩成一行（同样先尝试修复）
  const minifyActionValue = (index: number) => {
    const cur = actions[index]?.value || '';
    if (!cur.trim()) return;
    const r = minifyJson(cur);
    if (r.ok) {
      updateAction(index, 'value', r.text);
      clearError(`action_${index}_value`);
      if (r.repaired) showToast('已自动修复并压缩，请核对内容', 'success', 4000);
    } else {
      showToast(r.error || '不是合法 JSON', 'warning', 6000);
    }
  };

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
      const v = (a.value ?? '').trim();

      // ---- key（匹配文本 / 正则 / Header 名 / 参数名）校验 ----
      if (a.operate === 'replace') {
        if (!a.key || !a.key.trim()) { errs[`action_${i}_key`] = '替换操作必须提供匹配文本'; }
        else { try { new RegExp(a.key); } catch { errs[`action_${i}_key`] = '正则表达式格式无效'; } }
      } else if (a.type === 'modifyRequestHeader' || a.type === 'modifyResponseHeader') {
        // set/append/remove 都需要 Header 名称；尤其 remove 留空会匹配并删掉所有同类响应头
        if (!a.key || !a.key.trim()) errs[`action_${i}_key`] = '请填写 Header 名称';
      } else if (a.type === 'modifyRequestUrl' && a.operate === 'remove') {
        if (!a.key || !a.key.trim()) errs[`action_${i}_key`] = '请填写要移除的参数名';
      }

      // ---- value（必填 + 值域）校验：避免存下"看似生效、实则空操作"的规则 ----
      if (a.type === 'redirect') {
        if (!v) errs[`action_${i}_value`] = '请填写重定向目标 URL';
        else { try { new URL(v); } catch { errs[`action_${i}_value`] = 'URL 格式无效，需以 http:// 或 https:// 开头'; } }
      } else if (a.type === 'modifyStatusCode') {
        const n = parseInt(v);
        if (!v) errs[`action_${i}_value`] = '请填写 HTTP 状态码';
        else if (isNaN(n) || n < 200 || n > 599) errs[`action_${i}_value`] = '状态码必须是 200-599 之间的数字';
      } else if (a.type === 'delay') {
        const n = parseInt(v);
        if (!v) errs[`action_${i}_value`] = '请填写延迟毫秒数';
        else if (isNaN(n) || n < 0) errs[`action_${i}_value`] = '延迟必须是非负整数（毫秒）';
      } else if (a.type === 'injectScript') {
        if (!v) errs[`action_${i}_value`] = '请填写要注入的脚本内容';
      } else if (a.type === 'modifyRequestUrl' && a.operate === 'set') {
        if (!v) errs[`action_${i}_value`] = '请填写新的完整 URL';
      }
    }
    if (showNewGroup && !newGroupName.trim()) errs.newGroup = '请输入新分组名称';
    if (!showNewGroup && !groups.find(g => g.id === groupId)) errs.group = '所选分组不存在';
    if (Object.keys(errs).length > 0) { setErrors(errs); showToast(Object.values(errs)[0], 'warning'); return; }
    setErrors({});

    try {
    // Save new group FIRST (before rule) to avoid dangling groupId
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

    const upsertResp = await chrome.runtime.sendMessage({ type: 'UPSERT_RULE', payload: newRule });
    if (upsertResp && upsertResp.success === false) {
      showToast('保存失败：' + (upsertResp.error || '未知错误'), 'error');
      return;
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

  // 值域校验：测试环境下给出实时提示，但不阻止保存
  const getValueWarning = (action: Action): string | null => {
    const v = action.value?.trim();
    if (!v) return null;
    if (action.type === 'modifyStatusCode') {
      const n = parseInt(v);
      if (isNaN(n) || n < 200 || n > 599) return '状态码必须是 200-599 之间的数字';
    }
    if (action.type === 'delay') {
      const n = parseInt(v);
      if (isNaN(n) || n < 0) return '延迟必须是正整数（毫秒），最大 30000';
      if (n > 30000) return '延迟上限为 30000ms（30秒），超出将被自动截断';
    }
    if (action.type === 'redirect') {
      try { new URL(v); } catch { return 'URL 格式无效，需以 http:// 或 https:// 开头'; }
    }
    if (action.type === 'modifyResponseBody' && action.operate === 'set') {
      try { JSON.parse(v); } catch { return '提示：不是合法 JSON，将以纯文本形式设置为响应体'; }
    }
    return null;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header — drill-down subheader */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b" style={{ borderColor: 'var(--line)', background: 'var(--bar)' }}>
        {onBack && (
          <button onClick={onBack} className="btn-ghost" aria-label="返回规则列表" title="返回规则列表">
            <Icon name="chevron-left" size={18} />
          </button>
        )}
        <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          {isEdit ? '编辑规则' : '新建规则'}
        </span>
        {!isEdit && (
          <span className="tag tag-gray">草稿</span>
        )}
        <div className="flex items-center gap-1 ml-auto">
          {!onBack && (
            <button onClick={onCancel} className="btn-ghost" aria-label="关闭" title="关闭">
              <Icon name="x" size={16} />
            </button>
          )}
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
              <Select
                value={groupId}
                onChange={(v) => {
                  if (v === '__new__') {
                    setShowNewGroup(true);
                    setGroupId(generateId());
                  } else {
                    setShowNewGroup(false);
                    setGroupId(v);
                  }
                  clearError('group');
                }}
                className="w-full"
                invalid={!!errors.group}
                ariaLabel="所属分组"
                options={[
                  ...groups.map((g) => ({ value: g.id, label: g.name })),
                  { value: '__new__', label: '+ 新建分组' },
                ]}
              />
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
              <Select
                value={match.matchType}
                onChange={(v) => { setMatch({ ...match, matchType: v as MatchType }); clearError('matchUrl'); }}
                className="shrink-0"
                style={{ width: 82 }}
                ariaLabel="匹配方式"
                options={Object.entries(MATCH_TYPE_LABELS).map(([k, v]) => ({ value: k, label: v }))}
              />
              <input
                type="text"
                placeholder={
                  match.matchType === 'regex' ? '正则表达式' :
                  match.matchType === 'domain' ? 'example.com' :
                  '输入 URL 或 URL 特征'
                }
                value={match.url}
                onChange={(e) => { setMatch({ ...match, url: e.target.value }); clearError('matchUrl'); }}
                onPaste={(e) => {
                  // Smart URL detection on paste
                  const text = e.clipboardData.getData('text').trim();
                  if (!text) return;
                  // 只在出现明确的正则元字符时才切正则模式。
                  // 不含 . 和 ? —— 普通 URL 几乎都带点/问号，否则任何 URL 都会被误判为正则。
                  const hasRegex = /[*+^${}()|[\]\\]/.test(text.replace(/https?:\/\//, ''));
                  const isFullUrl = /^https?:\/\//i.test(text);
                  const isDomain = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(text) && !text.includes('/');
                  if (hasRegex) {
                    setMatch(m => ({ ...m, matchType: 'regex' }));
                  } else if (isDomain) {
                    setMatch(m => ({ ...m, matchType: 'domain' }));
                  } else if (isFullUrl) {
                    setMatch(m => ({ ...m, matchType: 'contains' }));
                  }
                }}
                className={`form-input mono flex-1 min-w-0 ${errors.matchUrl ? 'border-red-400' : ''}`}
              />
            </div>
            {isRegexValid !== null && !errors.matchUrl && (
              <div className={`text-xs pl-[76px] -mt-1.5 ${isRegexValid ? 'text-green-600' : 'text-red-500'}`}>
                {isRegexValid ? '✓ 正则表达式有效' : '✗ 正则表达式无效'}
              </div>
            )}
            {errors.matchUrl && <p className="text-xs text-red-500 pl-[76px] -mt-1.5">{errors.matchUrl}</p>}
            <div className="flex gap-2">
              <Select
                value={match.method}
                onChange={(v) => setMatch({ ...match, method: v })}
                className="flex-1"
                ariaLabel="请求方法"
                options={HTTP_METHODS.map((m) => ({ value: m, label: m || '全部请求方法' }))}
              />
              <Select
                value={match.resourceType}
                onChange={(v) => setMatch({ ...match, resourceType: v })}
                className="flex-1"
                ariaLabel="资源类型"
                options={RESOURCE_TYPES.map((t) => ({ value: t, label: t || '全部资源类型' }))}
              />
            </div>
          </div>
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
                    <Select
                      value={action.type}
                      onChange={(v) => updateAction(i, 'type', v)}
                      variant="plain"
                      className="font-medium"
                      ariaLabel="修改动作"
                      options={Object.entries(ACTION_TYPE_LABELS).map(([k, v]) => ({ value: k, label: v }))}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {showOperateField(action.type) && (
                      <Select
                        value={action.operate}
                        onChange={(v) => updateAction(i, 'operate', v)}
                        className="text-xs"
                        ariaLabel="操作方式"
                        options={getAvailableOperates(action.type).map(k => ({ value: k, label: OPERATE_TYPE_LABELS[k] }))}
                      />
                    )}
                    {actions.length > 1 && (
                      <button onClick={() => removeAction(i)} className="btn-ghost p-0.5" aria-label="删除动作" title="删除动作">
                        <Icon name="x" size={14} />
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
                    <div>
                      {(action.type === 'modifyResponseBody' || action.type === 'modifyRequestBody') ? (
                        <BodyValueField
                          value={action.value}
                          onChange={(v) => { updateAction(i, 'value', v); clearError(`action_${i}_value`); }}
                          placeholder={getValuePlaceholder(action)}
                          rows={5}
                          hasError={!!errors[`action_${i}_value`]}
                          showFormat={action.operate === 'set'}
                          onFormat={() => formatActionValue(i)}
                          onMinify={() => minifyActionValue(i)}
                        />
                      ) : (
                        <textarea
                          placeholder={getValuePlaceholder(action)}
                          value={action.value}
                          onChange={(e) => { updateAction(i, 'value', e.target.value); clearError(`action_${i}_value`); }}
                          rows={action.type === 'injectScript' ? 6 : (action.type.includes('Header') || action.type === 'modifyRequestUrl') ? 1 : 2}
                          className={`form-textarea text-xs w-full ${errors[`action_${i}_value`] ? 'border-red-400 focus:border-red-400 focus:ring-red-100' : ''}`}
                        />
                      )}
                      {(() => {
                        const err = errors[`action_${i}_value`];
                        if (err) return <p className="text-xs text-red-500 mt-1">{err}</p>;
                        const w = getValueWarning(action);
                        return w ? <p className="text-xs text-amber-500 dark:text-amber-400 mt-1">{w}</p> : null;
                      })()}
                    </div>
                  )}
                  {action.type === 'injectScript' && (
                    <div className="text-xs text-amber-600 dark:text-amber-400 space-y-1">
                      <p>警告：注入的脚本在页面上下文中执行，可访问页面所有数据。仅使用你信任的脚本。</p>
                      <p>注意：避免死循环（while true）和超大计算量，否则页面将卡死需手动刷新。脚本执行超 2 秒可能阻塞页面。</p>
                      <p className="font-mono text-gray-500">ctx = {`{ url, headers, body, crypto }`} — 改 ctx.url / ctx.body / ctx.headers 即可影响请求</p>
                      <p className="font-mono text-gray-500">ctx.crypto: md5 / sha1 / sha256 / hmacSha1(key,msg) / hmacSha256(key,msg) / base64Encode / base64Decode</p>
                      <p>提示：本动作恒在请求体/头改写之后执行。若接口对请求体签名，可在此用改写后的 ctx.body 重算签名头，例如 <span className="font-mono">{`ctx.headers['x-sign'] = ctx.crypto.md5(ctx.body)`}</span>。</p>
                    </div>
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
