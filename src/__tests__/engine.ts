/**
 * Pure matching and rewriting engine — extracted from interceptor.js for testability.
 * No DOM, no chrome APIs, no side effects.
 */

import { Rule, Action, OperateType } from '../shared/types';

// === Regex safety wrapper ===
function safeRe(pattern: string, flags?: string): RegExp | null {
  try { return new RegExp(pattern, flags); } catch { return null; }
}

// === URL Matching ===
export function matchUrl(ruleUrl: string, matchType: string, url: string): boolean {
  switch (matchType) {
    case 'exact': return url === ruleUrl;
    case 'contains': return url.indexOf(ruleUrl) >= 0;
    case 'regex': { const re = safeRe(ruleUrl); return re ? re.test(url) : false; }
    case 'domain':
      try {
        const u = new URL(url);
        return u.hostname === ruleUrl ||
          (u.hostname.endsWith('.' + ruleUrl) && u.hostname.slice(-ruleUrl.length - 1) === '.' + ruleUrl);
      } catch { return false; }
    default: return false;
  }
}

// === Rule matching engine ===
export function getMatchingRules(
  rules: Rule[],
  groups: { id: string; enabled: boolean }[],
  url: string,
  method: string,
  resourceType: string
): Rule[] {
  if (groups.length === 0) groups = [{ id: 'default', enabled: true }];
  const enabledGroups = new Set(groups.filter(g => g.enabled).map(g => g.id));

  return rules.filter(r => {
    if (!r.enabled) return false;
    if (!enabledGroups.has(r.groupId)) return false;
    if (!r.match) return false;
    if (r.match.method && r.match.method !== method) return false;
    if (r.match.resourceType && r.match.resourceType !== resourceType) return false;
    return matchUrl(r.match.url || '', r.match.matchType || '', url);
  });
}

// === Request rewriting ===
const PROTECTED_RESP_HEADERS: Record<string, boolean> = {
  'content-security-policy': true,
  'strict-transport-security': true,
  'x-content-type-options': true,
  'x-frame-options': true,
  'set-cookie': true,
};

export interface ReqResult {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  cancelled: boolean;
  delayMs: number;
}

export function applyReq(url: string, hdrs: Record<string, string>, body: string | undefined, actions: Action[]): ReqResult {
  let u = url, b = body;
  const h: Record<string, string> = {};
  for (const k in hdrs) h[k] = hdrs[k];
  let cancelled = false, delayMs = 0, bodyChanged = false;

  for (const a of actions) {
    switch (a.type) {
      case 'modifyRequestUrl':
        if (a.operate === 'replace') { const re = safeRe(a.key, 'g'); if (re) u = u.replace(re, a.value); }
        else if (a.operate === 'set') u = a.value;
        else if (a.operate === 'remove') {
          const re2 = safeRe('[?&]' + a.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=[^&]*', 'g');
          if (re2) u = u.replace(re2, '');
        }
        break;
      case 'modifyRequestHeader':
        if (a.operate === 'set') h[a.key] = a.value;
        else if (a.operate === 'append') h[a.key] = (h[a.key] ? h[a.key] + ', ' : '') + a.value;
        else if (a.operate === 'remove') { const re = safeRe(a.key, 'i'); if (re) { for (const k of Object.keys(h)) { if (re.test(k)) delete h[k]; } } }
        else if (a.operate === 'replace') { const re = safeRe(a.key, 'i'); if (re) { for (const k of Object.keys(h)) { if (re.test(k)) h[k] = a.value; } } }
        break;
      case 'modifyRequestBody':
        if (b !== undefined) {
          if (a.operate === 'replace') { const re = safeRe(a.key, 'g'); if (re) { b = b.replace(re, a.value); bodyChanged = true; } }
          else if (a.operate === 'set') { b = a.value; bodyChanged = true; }
        }
        break;
      case 'redirect': if (a.operate === 'set') u = a.value; break;
      case 'cancel': cancelled = true; break;
      case 'delay': delayMs = Math.max(delayMs, Math.min(parseInt(a.value) || 0, 30000)); break;
    }
  }
  if (bodyChanged) delete h['content-length'];
  return { url: u, headers: h, body: b, cancelled, delayMs };
}

// === Response rewriting ===
export interface RespResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export function applyResp(status: number, statusText: string, hdrs: Record<string, string>, body: string, actions: Action[]): RespResult {
  let s = status, st = statusText, b = body;
  const h: Record<string, string> = {};
  for (const k in hdrs) h[k] = hdrs[k];
  let bodyChanged = false;

  for (const a of actions) {
    switch (a.type) {
      case 'modifyResponseHeader':
        if (a.operate === 'remove' || a.operate === 'replace') {
          const reKey = safeRe(a.key, 'i');
          if (reKey) {
            let isProtected = false;
            for (const ph in PROTECTED_RESP_HEADERS) { if (reKey.test(ph)) { isProtected = true; break; } }
            if (isProtected) break;
          }
        }
        if (a.operate === 'set') h[a.key] = a.value;
        else if (a.operate === 'append') h[a.key] = (h[a.key] ? h[a.key] + ', ' : '') + a.value;
        else if (a.operate === 'remove') { const re = safeRe(a.key, 'i'); if (re) { for (const k of Object.keys(h)) { if (re.test(k)) delete h[k]; } } }
        else if (a.operate === 'replace') { const re = safeRe(a.key, 'i'); if (re) { for (const k of Object.keys(h)) { if (re.test(k)) h[k] = a.value; } } }
        break;
      case 'modifyResponseBody':
        if (a.operate === 'replace') { const re = safeRe(a.key, 'g'); if (re) { b = b.replace(re, a.value); bodyChanged = true; } }
        else if (a.operate === 'set') { b = a.value; bodyChanged = true; }
        break;
      case 'modifyStatusCode':
        // 只接受 200-599：Response 构造器不允许 <200 的状态码（1xx 也无法作为最终响应）
        if (a.operate === 'set') { const c = parseInt(a.value); if (!isNaN(c) && c >= 200 && c <= 599) { s = c; st = (c >= 200 && c < 300) ? 'OK' : ''; } }
        break;
    }
  }
  if (bodyChanged) {
    delete h['content-length'];
    delete h['content-encoding'];
    const ct = h['content-type'];
    if (ct && ct.indexOf('charset') === -1) h['content-type'] = ct + '; charset=utf-8';
  }
  return { status: s, statusText: st, headers: h, body: b };
}
