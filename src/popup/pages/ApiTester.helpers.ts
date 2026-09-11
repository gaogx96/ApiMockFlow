// ApiTester 的纯逻辑抽取：类型、常量与无状态工具函数。
// 从 ApiTester.tsx 原地搬出（行为逐字不变），供组件 re-import。这里的一切都不闭包组件 state，
// 仅依赖入参 + 下列模块导入，故可安全独立于那个 ~53-hook 的有状态核心。
import { ApiRequest, ApiResponse, RequestDiagnostic } from '../../shared/api-types';
import { generateId } from '../../shared/constants';
import { showToast } from '../../shared/toast';
import { resolveDynamicVars, decodeDynamicVars } from '../../shared/dynamic-vars';

export type BodyType = 'raw' | 'urlencoded' | 'multipart';

/** 「插入动态变量」按钮的目标字段位置：URL / 请求体 / query 参数某项 / 请求头某项 */
export type FieldTarget =
  | { kind: 'url' }
  | { kind: 'body' }
  | { kind: 'query'; index: number; field: 'key' | 'value' }
  | { kind: 'header'; index: number; field: 0 | 1 };

export interface TabData {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  bodyType: string;
  bodyDrafts: Partial<Record<BodyType, string>>;
  bodyPanelHeights: Partial<Record<'multipart' | 'urlencoded', number>>;
  response: ApiResponse | null;
  error: string;
  loading: boolean;
  autoRefreshCookie: boolean;
  activeSubTab: 'headers' | 'body' | 'response' | 'history' | 'saved';
  autoSend?: boolean;
  queryParams: { enabled: boolean; key: string; value: string }[];
}

export interface SavedGroup { id: string; name: string; }

export const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
export const BODY_TYPES = [
  { value: 'raw', label: 'JSON', icon: 'braces' as const },
  { value: 'urlencoded', label: 'URL Encoded', icon: 'list-tree' as const },
  { value: 'multipart', label: 'Multipart', icon: 'table-2' as const },
];

// 标签持久化：单响应体超此上限只存截断标记，避免极端大响应拖慢写盘。
export const MAX_PERSIST_RESP = 2 * 1024 * 1024; // 2MB

export function readMultipart(body: string): Array<{ name: string; value: string }> {
  try { const v = JSON.parse(body || '[]'); return Array.isArray(v) ? v.map((p: any) => ({ name: String(p?.name ?? ''), value: String(p?.value ?? '') })) : []; } catch { return []; }
}

export function hasUnsupportedMultipartFile(body: string): boolean {
  try { const parts = JSON.parse(body || '[]'); return Array.isArray(parts) && parts.some((part: any) => typeof part?.value === 'string' && part.value.startsWith('@')); } catch { return false; }
}

export function readUrlEncoded(body: string): Array<{ name: string; value: string }> {
  return Array.from(new URLSearchParams(body || '').entries()).map(([name, value]) => ({ name, value }));
}

export function contentTypeFor(bodyType: string): string {
  if (bodyType === 'urlencoded') return 'application/x-www-form-urlencoded';
  if (bodyType === 'multipart') return 'multipart/form-data';
  return 'application/json';
}

export function defaultFormPanelHeight(fieldCount: number): number {
  const maxHeight = typeof window === 'undefined' ? 360 : Math.max(92, window.innerHeight - 215);
  return Math.min(maxHeight, Math.max(92, 66 + Math.max(fieldCount, 1) * 31));
}

export function convertJsonAndEncoded(body: string, from: BodyType, to: BodyType): { body?: string; reason?: string } {
  if (!body.trim()) return { body: '' };
  if (from === 'raw' && to === 'urlencoded') {
    let value: unknown;
    try { value = JSON.parse(body); } catch { return { reason: 'JSON 格式无效' }; }
    if (!value || Array.isArray(value) || typeof value !== 'object') return { reason: '仅支持 JSON 对象' };
    const params = new URLSearchParams();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== null && typeof item === 'object') return { reason: `字段 ${key} 为数组或嵌套对象` };
      params.append(key, item === null ? '' : String(item));
    }
    return { body: params.toString() };
  }
  if (from === 'urlencoded' && to === 'raw') {
    const entries = Array.from(new URLSearchParams(body).entries());
    const seen = new Set<string>();
    for (const [key] of entries) {
      if (seen.has(key)) return { reason: `存在重复字段 ${key}` };
      seen.add(key);
    }
    return { body: JSON.stringify(Object.fromEntries(entries), null, 2) };
  }
  return { reason: '该请求体类型不支持转换' };
}

export function createTab(name?: string): TabData {
  return {
    id: generateId(),
    name: name || '新请求',
    method: 'GET', url: '',
    headers: [['', '']], body: '', bodyType: 'raw', bodyDrafts: { raw: '' }, bodyPanelHeights: {},
    response: null, error: '', loading: false,
    autoRefreshCookie: false,
    activeSubTab: 'headers',
    queryParams: [],
  };
}

export function serializeTabsForStorage(tabs: TabData[]): TabData[] {
  return tabs.map((t) => {
    let response = t.response;
    if (response && response.body && response.body.length > MAX_PERSIST_RESP) {
      response = { ...response, body: '（响应过大，未持久化，请重新发送）' };
    }
    return { ...t, loading: false, autoSend: undefined, response };
  });
}

export function formatJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

// Simple regex-based JSON syntax highlighting (safe: input is from JSON.stringify)
export function highlightJson(s: string): string {
  let formatted: string;
  try { formatted = JSON.stringify(JSON.parse(s), null, 2); } catch { formatted = s; }
  // Escape HTML first
  const esc = formatted.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Highlight: strings, numbers, booleans, null, keys
  return esc
    .replace(/"([^"\\]|\\.)*"/g, (m) => {
      // Check if it's a key (followed by :)
      return `<span class="json-string">${m}</span>`;
    })
    .replace(/\b(true|false)\b/g, '<span class="json-boolean">$1</span>')
    .replace(/\b(null)\b/g, '<span class="json-boolean">$1</span>')
    .replace(/\b(-?\d+\.?\d*([eE][+-]?\d+)?)\b/g, '<span class="json-number">$1</span>');
}

export function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text).then(() => showToast('已复制到剪贴板', 'success')).catch(() => showToast('复制失败，请检查剪贴板权限', 'error'));
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function requestToCurl(req: ApiRequest, includeSensitive = false): string {
  // 复制为 cURL 时把动态变量解析成当前时刻的字面值（对已解析的历史记录为幂等无副作用）
  // 先 decodeDynamicVars 归一化 URL 里可能被编码的占位符，再解析，避免复制出编码后的死占位符。
  const now = Date.now();
  const rv = (s: string) => resolveDynamicVars(s, { now });
  const lines = [`curl ${shellQuote(rv(decodeDynamicVars(req.url)))}`, `  -X ${req.method}`];
  for (const [key, value] of Object.entries(req.headers)) {
    if (!key.trim()) continue;
    if (req.bodyType === 'multipart' && key.toLowerCase() === 'content-type') continue;
    const safeValue = !includeSensitive && /^(authorization|cookie|x-api-key)$/i.test(key) ? '***' : rv(value);
    lines.push(`  -H ${shellQuote(`${rv(key)}: ${safeValue}`)}`);
  }
  if (req.body && !/^(GET|HEAD)$/i.test(req.method)) {
    const body = rv(req.body);
    if (req.bodyType === 'multipart') {
      const parts = readMultipart(body);
      if (parts.length) parts.forEach(part => lines.push(`  --form-string ${shellQuote(`${part.name}=${part.value}`)}`));
      else lines.push(`  --data-raw ${shellQuote(body)}`);
    } else lines.push(`  --data-raw ${shellQuote(body)}`);
  }
  return lines.join(' \\\n');
}

export function getDiagnostic(response?: ApiResponse, error?: string): RequestDiagnostic | null {
  if (error) {
    if (/SSRF|内网|私有地址/i.test(error)) return { level: 'error', title: '安全策略已拦截请求', message: error, suggestion: '如确需访问内网地址，请在 API 测试器中明确开启内网访问。' };
    if (/timeout|超时/i.test(error)) return { level: 'error', title: '请求超时', message: error, suggestion: '检查服务可用性、网络状况或接口响应耗时。' };
    if (/cors/i.test(error)) return { level: 'error', title: '跨域请求受限', message: error, suggestion: '确认目标服务的 CORS 配置，或改用允许的测试环境。' };
    return { level: 'error', title: '请求未完成', message: error, suggestion: '检查 URL、网络连接与扩展运行状态。' };
  }
  if (!response) return null;
  const status = response.status;
  if (status === 401) return { level: 'error', title: '未认证或登录态已失效', message: '服务返回 401 Unauthorized。', suggestion: '尝试同步当前页面登录态，或检查 Authorization 请求头。' };
  if (status === 403) return { level: 'error', title: '请求无权限', message: '服务返回 403 Forbidden。', suggestion: '确认账号权限、Token 作用域或接口访问策略。' };
  if (status === 404) return { level: 'error', title: '接口不存在', message: '服务返回 404 Not Found。', suggestion: '检查 URL、方法与环境域名是否正确。' };
  if (status === 408 || status === 504) return { level: 'error', title: '服务响应超时', message: `服务返回 ${status}。`, suggestion: '检查上游服务、网关配置或稍后重试。' };
  if (status === 429) return { level: 'warning', title: '请求频率受限', message: '服务返回 429 Too Many Requests。', suggestion: '降低请求频率，或等待限流窗口恢复。' };
  if (status >= 500) return { level: 'error', title: '服务端错误', message: `服务返回 ${status} ${response.statusText}。`, suggestion: '检查服务端日志或稍后重试。' };
  const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '';
  if (/json/i.test(contentType) && response.body.trim()) {
    try { JSON.parse(response.body); } catch { return { level: 'warning', title: '响应 JSON 格式异常', message: 'Content-Type 声明为 JSON，但响应体无法解析。', suggestion: '检查服务端序列化结果或查看原始响应体。' }; }
  }
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}
