import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import Icon from '../components/Icon';
import Select from '../components/Select';
import { AppState, Rule, RuleGroup, MATCH_TYPE_LABELS, ACTION_TYPE_LABELS } from '../../shared/types';
import { showToast, showConfirm } from '../../shared/toast';
import { kickCompositorPresent } from '../compositor';

interface Props {
  state: AppState;
  onRefresh: () => void;
  onEditRule: (rule: Rule | null) => void;
}

// 单条规则行：抽成 React.memo 组件，使分组栏展开/拖拽宽度等与规则数据无关的状态变化不再重渲染整列
interface RuleRowProps {
  rule: Rule;
  group: RuleGroup | undefined;
  isFiltered: boolean;
  onEdit: (rule: Rule) => void;
  onToggle: (ruleId: string, enabled: boolean) => void;
  onDelete: (ruleId: string, e: React.MouseEvent) => void;
  onDuplicate: (rule: Rule, e: React.MouseEvent) => void;
  onMove: (ruleId: string, dir: -1 | 1) => void;
}

const RuleRow = React.memo(function RuleRow({ rule, group, isFiltered, onEdit, onToggle, onDelete, onDuplicate, onMove }: RuleRowProps) {
  const actionCount = rule.actions?.length || 0;
  const firstAction = rule.actions?.[0];
  return (
    <div
      className={`rule-row px-3 py-2.5 hover:bg-white dark:hover:bg-slate-800 cursor-pointer transition-colors ${!rule.enabled ? 'opacity-50' : ''}`}
      onClick={() => onEdit(rule)}
    >
      <div className="flex items-center gap-2">
        {/* Group color dot */}
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: group?.color || '#d1d5db' }}
          data-tip={group?.name}
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
          role="switch"
          aria-checked={rule.enabled}
          aria-label={rule.enabled ? '禁用规则' : '启用规则'}
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onToggle(rule.id, !rule.enabled); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggle(rule.id, !rule.enabled); } }}
        />

        {/* Move + Delete (hover only) */}
        <div className="rule-hover-actions flex items-center gap-0.5 shrink-0">
          {/* 排序按钮：筛选时禁用而非隐藏（避免按钮位置跳动，并说明原因） */}
          <button
            className="btn-ghost p-0 leading-none disabled:opacity-30 disabled:cursor-not-allowed"
            disabled={isFiltered}
            onClick={(e) => { e.stopPropagation(); if (!isFiltered) onMove(rule.id, -1); }}
            aria-label={isFiltered ? '排序前请先清除搜索/分组筛选' : '上移'}
            data-tip={isFiltered ? '排序前请先清除搜索/分组筛选' : '上移'}
          >
            <Icon name="chevron-up" size={14} />
          </button>
          <button
            className="btn-ghost p-0 leading-none disabled:opacity-30 disabled:cursor-not-allowed"
            disabled={isFiltered}
            onClick={(e) => { e.stopPropagation(); if (!isFiltered) onMove(rule.id, 1); }}
            aria-label={isFiltered ? '排序前请先清除搜索/分组筛选' : '下移'}
            data-tip={isFiltered ? '排序前请先清除搜索/分组筛选' : '下移'}
          >
            <Icon name="chevron-down" size={14} />
          </button>
          <button className="btn-ghost p-1 text-xs" onClick={(e) => onDuplicate(rule, e)} aria-label="复制规则（副本默认禁用）" data-tip="复制规则（副本默认禁用）">
            <Icon name="copy" size={14} />
          </button>
          <button className="btn-ghost p-1 text-xs" onClick={(e) => onDelete(rule.id, e)} aria-label="删除" data-tip="删除">
            <Icon name="trash-2" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
});

function RuleList({ state, onRefresh, onEditRule }: Props) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filterGroup, setFilterGroup] = useState('');
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [diagnosticUrl, setDiagnosticUrl] = useState('');
  const [diagnosticMethod, setDiagnosticMethod] = useState('GET');
  const [diagnosticType, setDiagnosticType] = useState('fetch');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // 分组栏：收起状态 + 展开宽度（UI 偏好，持久化到 chrome.storage.local，与引擎无关）
  const RAIL_MIN = 120;
  const RAIL_MAX = 300;
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [railWidth, setRailWidth] = useState(150);
  // 分组重命名：双击分组栏条目进入内联编辑
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');

  useEffect(() => {
    chrome.storage.local.get(['ruleRailCollapsed', 'ruleRailWidth'], (res) => {
      if (typeof res.ruleRailCollapsed === 'boolean') setRailCollapsed(res.ruleRailCollapsed);
      if (typeof res.ruleRailWidth === 'number' && res.ruleRailWidth >= RAIL_MIN && res.ruleRailWidth <= RAIL_MAX) {
        setRailWidth(res.ruleRailWidth);
      }
    });
  }, []);

  const toggleRail = () => {
    const next = !railCollapsed;
    setRailCollapsed(next);
    // 持久化与渲染解耦:不放进 setState 更新函数(更新函数在渲染阶段执行,
    // 在其中调用扩展存储 IPC 会挤占点击→绘制的关键路径)。
    chrome.storage.local.set({ ruleRailCollapsed: next });
    // 强制合成器连续出帧,消除弹窗"侧栏已提交却延迟数秒才上屏"的推迟呈现问题。
    kickCompositorPresent();
  };

  // 拖拽调整分组栏宽度：mousedown 记录起点，全局监听 move/up，松手时持久化
  const startRailDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = railWidth;
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(RAIL_MAX, Math.max(RAIL_MIN, startW + (ev.clientX - startX)));
      setRailWidth(w);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setRailWidth((w) => { chrome.storage.local.set({ ruleRailWidth: w }); return w; });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // Debounce search — 200ms delay
  const onSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchInput(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(val), 200);
  }, []);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  // Group map for O(1) lookup instead of Array.find per card
  const groupMap = useMemo(() => {
    const m: Record<string, RuleGroup> = {};
    for (const g of state.groups) m[g.id] = g;
    return m;
  }, [state.groups]);

  const isFiltered = !!(search || filterGroup);

  // 各分组规则数（组分栏计数）
  const groupCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of state.rules) m[r.groupId] = (m[r.groupId] || 0) + 1;
    return m;
  }, [state.rules]);

  const filteredRules = useMemo(() => {
    const q = search.toLowerCase();
    return state.rules.filter((rule) => {
      const matchSearch = !q ||
        rule.name?.toLowerCase().includes(q) ||
        rule.match?.url?.toLowerCase().includes(q);
      const matchGroup = !filterGroup || rule.groupId === filterGroup;
      return matchSearch && matchGroup;
    });
  }, [state.rules, search, filterGroup]);

  // 行内回调统一 useCallback：身份稳定后，分组栏展开/拖拽宽度等变化不会让 memo 行重渲染
  const toggleRule = useCallback(async (ruleId: string, enabled: boolean) => {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_RULE', payload: { ruleId, enabled } });
    onRefresh();
  }, [onRefresh]);

  const deleteRule = useCallback(async (ruleId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await showConfirm('确定删除此规则？')) return;
    await chrome.runtime.sendMessage({ type: 'DELETE_RULE', payload: { id: ruleId } });
    onRefresh();
  }, [onRefresh]);

  const duplicateRule = useCallback(async (rule: Rule, e: React.MouseEvent) => {
    e.stopPropagation();
    const now = Date.now();
    const copy: Rule = {
      ...rule,
      id: crypto.randomUUID?.() || `${now}-${Math.random().toString(36).slice(2)}`,
      name: `${rule.name || '未命名规则'} - 副本`,
      enabled: false,
      createdAt: now,
      updatedAt: now,
      match: { ...rule.match },
      actions: rule.actions.map(action => ({ ...action })),
    };
    const rules = [...state.rules];
    const index = rules.findIndex(item => item.id === rule.id);
    rules.splice(index >= 0 ? index + 1 : rules.length, 0, copy);
    await chrome.runtime.sendMessage({ type: 'SAVE_RULES', payload: rules });
    showToast('规则已复制为禁用副本', 'success');
    onRefresh();
  }, [state.rules, onRefresh]);

  const startRenameGroup = (group: RuleGroup) => {
    setEditingGroupId(group.id);
    setEditingGroupName(group.name);
  };

  const commitRenameGroup = async () => {
    const id = editingGroupId;
    if (!id) return;
    const trimmed = editingGroupName.trim();
    const target = state.groups.find(g => g.id === id);
    setEditingGroupId(null);
    if (!target || !trimmed || trimmed === target.name) return;
    const groups = state.groups.map(g => g.id === id ? { ...g, name: trimmed } : g);
    await chrome.runtime.sendMessage({ type: 'SAVE_GROUPS', payload: groups });
    showToast('分组已重命名', 'success');
    onRefresh();
  };

  const deleteGroup = async (group: RuleGroup, e: React.MouseEvent) => {
    e.stopPropagation();
    if (group.id === 'default') {
      showToast('默认分组不能删除', 'warning');
      return;
    }
    const affected = state.rules.filter(rule => rule.groupId === group.id).length;
    const suffix = affected ? `，${affected} 条规则将移入默认分组` : '';
    if (!await showConfirm(`确定删除分组「${group.name}」吗？${suffix}`)) return;
    const groups = state.groups.filter(item => item.id !== group.id);
    const rules = affected
      ? state.rules.map(rule => rule.groupId === group.id ? { ...rule, groupId: 'default', updatedAt: Date.now() } : rule)
      : state.rules;
    if (affected) await chrome.runtime.sendMessage({ type: 'SAVE_RULES', payload: rules });
    await chrome.runtime.sendMessage({ type: 'SAVE_GROUPS', payload: groups });
    if (filterGroup === group.id) setFilterGroup('');
    showToast(affected ? '分组已删除，规则已移入默认分组' : '分组已删除', 'success');
    onRefresh();
  };

  // 批量操作：一键禁用/启用所有规则
  const toggleAllRules = async (enabled: boolean) => {
    const action = enabled ? '启用' : '禁用';
    if (!await showConfirm(`确定${action}所有 ${state.rules.length} 条规则？`)) return;
    const updated = state.rules.map(r => ({ ...r, enabled }));
    await chrome.runtime.sendMessage({ type: 'SAVE_RULES', payload: updated });
    onRefresh();
  };

  // 批量操作：清空所有规则
  const clearAllRules = async () => {
    if (!await showConfirm(`确定删除所有 ${state.rules.length} 条规则？此操作不可撤销。`)) return;
    await chrome.runtime.sendMessage({ type: 'SAVE_RULES', payload: [] });
    onRefresh();
  };

  const moveRule = useCallback(async (ruleId: string, dir: -1 | 1) => {
    const newRules = [...state.rules];
    const idx = newRules.findIndex(r => r.id === ruleId);
    if (idx < 0) return;
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= newRules.length) return;
    [newRules[idx], newRules[targetIdx]] = [newRules[targetIdx], newRules[idx]];
    await chrome.runtime.sendMessage({ type: 'SAVE_RULES', payload: newRules });
    onRefresh();
  }, [state.rules, onRefresh]);

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
        const parsed = JSON.parse(text);
        if (!parsed.rules && !parsed.groups) {
          showToast('导入失败：文件中没有找到规则或分组数据', 'error');
          return;
        }
        const confirmed = await showConfirm('导入将覆盖当前所有规则和分组，是否继续？');
        if (!confirmed) return;
        await chrome.runtime.sendMessage({ type: 'IMPORT_RULES', payload: text });
        onRefresh();
      } catch {
        showToast('导入失败：无效的 JSON 文件', 'error');
      }
    };
    input.click();
  };

  const toggleDiagnostic = () => {
    setShowDiagnostic(open => {
      if (open) {
        setDiagnosticUrl('');
        setDiagnosticMethod('GET');
        setDiagnosticType('fetch');
      }
      return !open;
    });
  };

  const diagnosticResults = useMemo(() => state.rules.map((rule, index) => {
    const group = groupMap[rule.groupId];
    let reason = '';
    if (!state.globalEnabled) reason = '全局拦截已暂停';
    else if (!rule.enabled) reason = '规则已关闭';
    else if (!group?.enabled) reason = '所属分组已关闭';
    else {
      const match = rule.match || { url: '', matchType: 'contains', method: '', resourceType: '' };
      let urlMatched = false;
      try {
        if (match.matchType === 'exact') urlMatched = diagnosticUrl === match.url;
        else if (match.matchType === 'contains') urlMatched = diagnosticUrl.includes(match.url);
        else if (match.matchType === 'regex') urlMatched = new RegExp(match.url).test(diagnosticUrl);
        else { const host = new URL(diagnosticUrl).hostname; urlMatched = host === match.url || host.endsWith('.' + match.url); }
      } catch (_) { reason = match.matchType === 'regex' ? '规则正则表达式无效' : '诊断 URL 格式无效'; }
      if (!reason && !urlMatched) reason = 'URL 不匹配';
      else if (!reason && match.method && match.method !== diagnosticMethod) reason = `请求方法不匹配（规则：${match.method}）`;
      else if (!reason && match.resourceType && match.resourceType !== diagnosticType) reason = `资源类型不匹配（规则：${match.resourceType}）`;
    }
    return { rule, index, matched: !reason, reason };
  }), [state.rules, state.globalEnabled, groupMap, diagnosticUrl, diagnosticMethod, diagnosticType]);

  // 规则行元素数组：仅在规则数据/筛选/分组变化时重建；分组栏展开或拖宽（railCollapsed/railWidth）不在依赖里，
  // 复用同一批元素引用 → React 跳过整列重渲染，消除展开分组时的卡顿。
  const ruleRows = useMemo(
    () => filteredRules.map((rule) => (
      <RuleRow
        key={rule.id}
        rule={rule}
        group={groupMap[rule.groupId]}
        isFiltered={isFiltered}
        onEdit={onEditRule}
        onToggle={toggleRule}
        onDelete={deleteRule}
        onDuplicate={duplicateRule}
        onMove={moveRule}
      />
    )),
    [filteredRules, groupMap, isFiltered, onEditRule, toggleRule, deleteRule, duplicateRule, moveRule]
  );

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="px-3 py-2.5 border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="搜索规则名称或 URL..."
              value={searchInput}
              onChange={onSearchChange}
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 dark:border-slate-700 rounded-md focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-100 bg-gray-50 dark:bg-slate-900"
            />
            <Icon name="search" size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          </div>
          <button onClick={() => onEditRule(null)} className="btn-primary whitespace-nowrap">
            <Icon name="plus" size={14} /> 新建规则
          </button>
          <button onClick={toggleDiagnostic} className={`btn-ghost p-1.5 shrink-0 ${showDiagnostic ? 'text-primary-600 bg-primary-50 dark:bg-primary-900/30' : ''}`} aria-label="规则命中诊断" data-tip="规则命中诊断">
            <Icon name="wrench" size={16} />
          </button>
        </div>

        {showDiagnostic && (
          <div className="mt-2.5 border-t border-gray-100 dark:border-slate-700 pt-2.5 space-y-2">
            <div className="text-xs font-semibold text-gray-600 dark:text-slate-300">规则命中诊断</div>
            <input value={diagnosticUrl} onChange={e => setDiagnosticUrl(e.target.value)} placeholder="输入完整请求 URL" className="form-input mono w-full text-xs" />
            <div className="flex gap-2">
              <Select value={diagnosticMethod} onChange={setDiagnosticMethod} ariaLabel="诊断请求方法" className="flex-1" options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(m => ({ value: m, label: m }))} />
              <Select value={diagnosticType} onChange={setDiagnosticType} ariaLabel="诊断资源类型" className="flex-1" options={['fetch', 'xmlhttprequest', 'document', 'script', 'stylesheet', 'image', 'font', 'media', 'other'].map(type => ({ value: type, label: type === 'xmlhttprequest' ? 'XHR' : type }))} />
            </div>
            {diagnosticUrl.trim() && <div className="max-h-44 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-700 border border-gray-200 dark:border-slate-700 rounded-md">
              {diagnosticResults.map(({ rule, index, matched, reason }) => <div key={rule.id} className="px-2 py-1.5 flex items-start gap-2 text-xs">
                <span className={`mt-0.5 shrink-0 w-1.5 h-1.5 rounded-full ${matched ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-slate-600'}`} />
                <span className="font-mono text-gray-400 shrink-0">{index + 1}</span><span className="min-w-0 flex-1 truncate text-gray-700 dark:text-slate-300">{rule.name}</span>
                <span className={matched ? 'text-emerald-600 shrink-0' : 'text-gray-400 shrink-0'}>{matched ? '命中' : reason}</span>
              </div>)}
            </div>}
          </div>
        )}
      </div>

      {/* Body: group rail + rules list */}
      <div className="flex-1 flex min-h-0">
        {/* Group rail（收起态：竖条 + 展开钮；展开态：分组栏 + 右侧拖拽条） */}
        {railCollapsed ? (
          <div className="group-rail-collapsed">
            <button className="btn-ghost p-1" onClick={toggleRail} aria-label="展开分组栏">
              <Icon name="panel-left-open" size={16} />
            </button>
          </div>
        ) : (
          <>
            <aside className="group-rail" style={{ width: railWidth }}>
              <div className="group-rail-head">
                <span className="group-rail-title">分组</span>
                <button className="btn-ghost p-1" onClick={toggleRail} aria-label="收起分组栏">
                  <Icon name="panel-left-close" size={14} />
                </button>
              </div>
              <button
                className={`group-rail-item ${!filterGroup ? 'active' : ''}`}
                onClick={() => setFilterGroup('')}
              >
                <span className="truncate">全部</span>
                <span className="count">{state.rules.length}</span>
              </button>
              {state.groups.map((g) => (
                editingGroupId === g.id ? (
                  <div key={g.id} className="group-rail-item active">
                    <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                    <input
                      className="flex-1 min-w-0 bg-transparent border-b border-primary-400 outline-none text-xs"
                      value={editingGroupName}
                      autoFocus
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setEditingGroupName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRenameGroup(); }
                        else if (e.key === 'Escape') { e.preventDefault(); setEditingGroupId(null); }
                      }}
                      onBlur={commitRenameGroup}
                    />
                  </div>
                ) : (
                <button
                  key={g.id}
                  className={`group-rail-item ${filterGroup === g.id ? 'active' : ''}`}
                  onClick={() => setFilterGroup(g.id)}
                  onDoubleClick={() => startRenameGroup(g)}
                >
                  <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                  <span className="truncate flex-1 text-left">{g.name}</span>
                  <span className="count">{groupCounts[g.id] || 0}</span>
                  {g.id !== 'default' && (
                    <span
                      className="group-rail-del"
                      role="button"
                      tabIndex={0}
                      onClick={(e) => deleteGroup(g, e)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); deleteGroup(g, e as unknown as React.MouseEvent); } }}
                      aria-label={`删除分组「${g.name}」`}
                      data-tip={`删除分组「${g.name}」`}
                    >
                      <Icon name="trash-2" size={12} />
                    </span>
                  )}
                </button>
                )
              ))}
            </aside>
            <div
              className="group-rail-resizer"
              onMouseDown={startRailDrag}
              role="separator"
              aria-orientation="vertical"
              aria-label="拖拽调整分组栏宽度"
            />
          </>
        )}

        {/* Rules list */}
        <div className="flex-1 min-w-0 overflow-y-auto">
        {filteredRules.length === 0 ? (
          <div className="empty-state">
            <div className="icon"><Icon name="clipboard-list" size={32} className="text-gray-300" /></div>
            <div className="title">{state.rules.length === 0 ? '还没有规则' : '没有匹配的规则'}</div>
            <div className="desc">
              {state.rules.length === 0 ? '点击「+ 新建规则」开始拦截请求' : '换个搜索词试试'}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-gray-200 dark:divide-slate-700">
            {ruleRows}
          </div>
        )}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex gap-1.5 px-3 py-2 border-t shrink-0" style={{ borderColor: 'var(--line)', background: 'var(--bar)' }}>
        <button onClick={handleExport} className="btn-secondary flex-1">
          <Icon name="download" size={14} /> 导出
        </button>
        <button onClick={handleImport} className="btn-secondary flex-1">
          <Icon name="upload" size={14} /> 导入
        </button>
        {state.rules.length > 0 && (
          <>
            <button
              onClick={() => toggleAllRules(!state.rules.every(r => r.enabled))}
              className="btn-secondary"
              data-tip={state.rules.every(r => r.enabled) ? '禁用所有规则' : '启用所有规则'}
            >
              {state.rules.every(r => r.enabled) ? '全禁' : '全启'}
            </button>
            <button onClick={clearAllRules} className="btn-danger" data-tip="清空所有规则">
              <Icon name="trash-2" size={14} /> 全清
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// memo：日志计数等父级(App)状态变化会让 App 重渲染，但只要 state 与回调引用不变，
// 规则页就跳过重渲染，避免拦截流量高峰时的重渲染风暴挤占主线程、导致点击延迟。
export default React.memo(RuleList);
