import React, { useState, useEffect, useRef } from 'react';
import { MagnifyingGlassIcon, TrashIcon, PlusIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { InterceptedRequest, RuleMatch } from '../../shared/types';
import { showConfirm } from '../../shared/toast';

interface Props {
  onCreateRule: (prefill: Partial<RuleMatch>) => void;
}

export default function NetworkLog({ onCreateRule }: Props) {
  const [logs, setLogs] = useState<InterceptedRequest[]>([]);
  const [search, setSearch] = useState('');
  const [filterMethod, setFilterMethod] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const timerRef = useRef<any>(null);

  const fetchLogs = () => {
    chrome.runtime.sendMessage({ type: 'LOG_GET' }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return;
      if (res) setLogs(res);
    });
  };

  useEffect(() => {
    fetchLogs();
    if (autoRefresh) {
      timerRef.current = setInterval(fetchLogs, 2000);
      return () => clearInterval(timerRef.current);
    }
  }, [autoRefresh]);

  const clearLogs = async () => {
    if (!await showConfirm('确定清空所有拦截日志？')) return;
    try {
      await chrome.runtime.sendMessage({ type: 'LOG_CLEAR' });
    } catch (_) {}
    setLogs([]);
  };

  const filtered = logs.filter((log) => {
    const matchSearch = !search || log.url.toLowerCase().includes(search.toLowerCase());
    const matchMethod = !filterMethod || log.method === filterMethod;
    return matchSearch && matchMethod;
  });

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
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

  const renderDiff = (label: string, orig: string, mod: string) => {
    const changed = orig !== mod;
    return (
      <div className="space-y-1">
        <div className="text-xs font-semibold text-gray-500 uppercase">{label}</div>
        <div className="grid grid-cols-2 gap-2">
          <div className={`text-xs p-2 rounded font-mono whitespace-pre-wrap break-all ${changed ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800' : 'bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700'}`}>
            <div className="text-xs text-gray-400 mb-1">原始</div>
            {orig || <span className="text-gray-300">无</span>}
          </div>
          <div className={`text-xs p-2 rounded font-mono whitespace-pre-wrap break-all ${changed ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800' : 'bg-gray-50 dark:bg-slate-900 border border-gray-200 dark:border-slate-700'}`}>
            <div className="text-xs text-gray-400 mb-1">修改后</div>
            {mod || <span className="text-gray-300">无</span>}
          </div>
        </div>
      </div>
    );
  };

  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="px-3 py-2.5 border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text" placeholder="搜索 URL..."
              value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 dark:border-gray-600 rounded-md focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-100 bg-gray-50 dark:bg-slate-900"
            />
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          </div>
          <select
            value={filterMethod} onChange={(e) => setFilterMethod(e.target.value)}
            className="form-select text-xs" style={{ width: 80, padding: '4px 20px 4px 6px', fontSize: 11, backgroundPosition: 'right 4px center' }}
          >
            <option value="">全部</option>
            {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`px-2 py-1.5 text-xs rounded-md border font-medium ${autoRefresh ? 'bg-primary-50 text-primary-600 border-primary-200 dark:bg-primary-900/30 dark:text-primary-400 dark:border-primary-800' : 'bg-white dark:bg-slate-800 text-gray-500 border-gray-200 dark:border-gray-600'}`}
            title={autoRefresh ? '暂停自动刷新' : '开启自动刷新'}
          >
            {autoRefresh ? '实时' : '暂停'}
          </button>
        </div>
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="icon">
              <svg className="w-8 h-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
            </div>
            <div className="title">{logs.length === 0 ? '暂无拦截记录' : '没有匹配的日志'}</div>
            <div className="desc">
              {logs.length === 0 ? '启用规则后访问匹配的页面即可看到' : '换个搜索词试试'}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-gray-50 dark:divide-gray-800">
            {filtered.map((log) => {
              const isExpanded = expandedId === log.id;
              const respStatus = log.modifiedResponse?.status || log.originalResponse?.status;

              return (
                <div key={log.id} className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  {/* Summary row */}
                  <div
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  >
                    {/* Expand icon */}
                    {isExpanded
                      ? <ChevronDownIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                      : <ChevronRightIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                    }

                    {/* Time */}
                    <span className="text-xs text-gray-400 font-mono shrink-0" style={{ width: 85 }}>
                      {formatTime(log.timestamp)}
                    </span>

                    {/* Method badge */}
                    <span className={`method-badge method-${log.method} shrink-0`}>
                      {log.method}
                    </span>

                    {/* URL */}
                    <span className="text-xs text-gray-700 dark:text-slate-300 truncate flex-1 font-mono">
                      {log.url}
                    </span>

                    {/* Status */}
                    {respStatus && (
                      <span className={`text-xs font-mono font-medium shrink-0 ${getStatusColor(respStatus)}`}>
                        {respStatus}
                      </span>
                    )}

                    {/* Tags */}
                    {log.cancelled && <span className="tag tag-red">已拦截</span>}
                    {log.delayed && <span className="tag tag-amber">延迟{log.delayMs}ms</span>}
                    {hasDiff(log) && !log.cancelled && <span className="tag tag-green">已修改</span>}

                    {/* Rule names */}
                    <span className="text-xs text-gray-400 truncate shrink-0" style={{ maxWidth: 100 }} title={log.ruleNames.join(', ')}>
                      {log.ruleNames[0]}{log.ruleNames.length > 1 ? ` +${log.ruleNames.length - 1}` : ''}
                    </span>

                    {/* Create rule button */}
                    <button
                      className="btn-ghost p-1 text-xs shrink-0"
                      title="创建规则"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCreateRule({ url: log.url, matchType: 'contains', method: log.method, resourceType: '' });
                      }}
                    >
                      <PlusIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Detail panel */}
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-3 ml-5.5">
                      {/* Rules matched */}
                      <div className="flex gap-1.5 flex-wrap">
                        {log.ruleNames.map((name, i) => (
                          <span key={i} className="tag tag-blue">{name}</span>
                        ))}
                      </div>

                      {/* Request diff */}
                      {renderDiff(
                        '请求',
                        `${log.method} ${log.url}\n${formatHeaders(log.originalRequest.headers)}${log.originalRequest.body ? '\n\n' + log.originalRequest.body : ''}`,
                        `${log.method} ${log.modifiedRequest.url}\n${formatHeaders(log.modifiedRequest.headers)}${log.modifiedRequest.body ? '\n\n' + log.modifiedRequest.body : ''}`
                      )}

                      {/* Response diff */}
                      {log.originalResponse && log.modifiedResponse && renderDiff(
                        '响应',
                        `${log.originalResponse.status} ${log.originalResponse.statusText}\n${formatHeaders(log.originalResponse.headers)}\n\n${log.originalResponse.body || ''}`,
                        `${log.modifiedResponse.status} ${log.modifiedResponse.statusText}\n${formatHeaders(log.modifiedResponse.headers)}\n\n${log.modifiedResponse.body || ''}`
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

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 shrink-0">
        <span className="text-xs text-gray-400">{filtered.length} 条记录</span>
        <button
          onClick={clearLogs}
          className="text-xs text-gray-500 hover:text-red-500 font-medium flex items-center gap-1"
        >
          <TrashIcon className="w-3.5 h-3.5" /> 清空
        </button>
      </div>
    </div>
  );
}

function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}
