import { ApiRequest } from './api-types';
import { DynamicVarKind } from './dynamic-vars';

/**
 * 时间戳候选检测（用于导入 cURL/HTTPie 时"自动插入动态占位符"的检测-确认流程）
 *
 * 思路：在 URL / 请求头值 / 请求体的**字符串文本**上按位置扫描时间戳形状的字面值，
 * 记录每个匹配的起止下标与建议替换的占位符。应用时按字段、按下标从后往前替换选中项，
 * 既能保留原文格式，又能精确避免同值多处替换的歧义。
 *
 * 只识别高置信形状：
 *   - 10 位秒级 Unix（约 2001–2100）→ {{$ts}}
 *   - 13 位毫秒级 Unix（约 2001–2100）→ {{$tsMs}}
 *   - 带时区的 ISO8601（…Z / …+08:00）→ {{$isoTs}}
 * 并对认证/签名/Cookie 等敏感键名整体跳过，避免破坏鉴权。
 */

export type TsLocation =
  | { kind: 'url' }
  | { kind: 'header'; name: string }
  | { kind: 'body' };

export interface TsCandidate {
  id: string;
  loc: TsLocation;
  /** 面板展示用的位置标签 */
  label: string;
  /** 命中的原始字面值 */
  original: string;
  /** 建议替换成的占位符 */
  token: string;
  varKind: DynamicVarKind;
  /** 在所属字段文本中的起止下标 */
  start: number;
  end: number;
}

// 敏感键名：命中则跳过（避免把签名/令牌里的数字误当时间戳替换，破坏鉴权）
const SENSITIVE_KEY =
  /(?:^|[_-])(?:authorization|auth|token|secret|sign|signature|password|pwd|cookie|session|sid|apikey|api[_-]?key|access[_-]?token|refresh[_-]?token|jwt|bearer)(?:[_-]|$)/i;

// 敏感请求头名：整条跳过
const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token|x-csrf-token)$/i;

// 带时区的 ISO8601 瞬时
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})/g;
// 10/13 位整数，且两侧不接字母/数字/点（排除 JWT 段内数字、小数、更长数字串）
const NUM_RE = /(?<![\w.])(\d{13}|\d{10})(?![\w.])/g;

const SEC_MIN = 1_000_000_000;        // ~2001-09
const SEC_MAX = 4_102_444_800;        // ~2100-01
const MS_MIN = 1_000_000_000_000;
const MS_MAX = 4_102_444_800_000;

/** 从匹配位置向前提取所属键名（query 的 k=、JSON 的 "k":、header 内联 k=） */
function keyBefore(text: string, index: number): string {
  const head = text.slice(0, index);
  const q = head.match(/([\w.\-]+)\s*=\s*$/);
  if (q) return q[1];
  const j = head.match(/"([^"]+)"\s*:\s*"?\s*$/);
  if (j) return j[1];
  return '';
}

interface RawMatch { start: number; end: number; value: string; varKind: DynamicVarKind; token: string }

function scanText(text: string): RawMatch[] {
  if (!text) return [];
  const out: RawMatch[] = [];

  const iso = new RegExp(ISO_RE);
  let m: RegExpExecArray | null;
  while ((m = iso.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0], varKind: 'isoTs', token: '{{$isoTs}}' });
    if (m.index === iso.lastIndex) iso.lastIndex++;
  }

  const num = new RegExp(NUM_RE);
  while ((m = num.exec(text)) !== null) {
    const raw = m[1];
    const n = Number(raw);
    let varKind: DynamicVarKind | null = null;
    if (raw.length === 13 && n >= MS_MIN && n <= MS_MAX) varKind = 'tsMs';
    else if (raw.length === 10 && n >= SEC_MIN && n <= SEC_MAX) varKind = 'ts';
    if (varKind) {
      const start = m.index + m[0].indexOf(raw);
      out.push({ start, end: start + raw.length, value: raw, varKind, token: varKind === 'tsMs' ? '{{$tsMs}}' : '{{$ts}}' });
    }
    if (m.index === num.lastIndex) num.lastIndex++;
  }

  // 避免 ISO 内部的数字被 NUM 二次命中：剔除落在已有区间内的匹配
  out.sort((a, b) => a.start - b.start);
  const filtered: RawMatch[] = [];
  let lastEnd = -1;
  for (const r of out) {
    if (r.start >= lastEnd) { filtered.push(r); lastEnd = r.end; }
  }
  return filtered;
}

let seq = 0;
function nextId(): string {
  seq = (seq + 1) % 1e9;
  return 'ts' + seq.toString(36);
}

/** 扫描一个请求，返回全部时间戳候选（未命中返回空数组） */
export function detectTimestamps(req: ApiRequest): TsCandidate[] {
  const cands: TsCandidate[] = [];

  const pushFrom = (text: string, loc: TsLocation, labelBase: string, allowSensitiveKeySkip: boolean) => {
    for (const r of scanText(text)) {
      if (allowSensitiveKeySkip) {
        const key = keyBefore(text, r.start);
        if (key && SENSITIVE_KEY.test(key)) continue;
      }
      cands.push({
        id: nextId(),
        loc,
        label: labelBase,
        original: r.value,
        token: r.token,
        varKind: r.varKind,
        start: r.start,
        end: r.end,
      });
    }
  };

  if (req.url) pushFrom(req.url, { kind: 'url' }, 'URL', true);

  for (const [name, value] of Object.entries(req.headers || {})) {
    if (SENSITIVE_HEADER.test(name.trim())) continue;
    if (typeof value !== 'string') continue;
    pushFrom(value, { kind: 'header', name }, `请求头 ${name}`, true);
  }

  if (req.body && typeof req.body === 'string') {
    pushFrom(req.body, { kind: 'body' }, '请求体', true);
  }

  return cands;
}

/**
 * 将选中的候选应用到请求，返回新的 ApiRequest（原对象不改）。
 * 每个字段按下标从后往前替换，保证前面的下标不失效。
 */
export function applyTimestamps(req: ApiRequest, candidates: TsCandidate[], selectedIds: Set<string>): ApiRequest {
  const selected = candidates.filter((c) => selectedIds.has(c.id));
  if (selected.length === 0) return req;

  const replaceInText = (text: string, cs: TsCandidate[]): string => {
    let out = text;
    for (const c of [...cs].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, c.start) + c.token + out.slice(c.end);
    }
    return out;
  };

  let url = req.url;
  const urlCs = selected.filter((c) => c.loc.kind === 'url');
  if (urlCs.length) url = replaceInText(url, urlCs);

  const headers: Record<string, string> = { ...req.headers };
  const byHeader = new Map<string, TsCandidate[]>();
  for (const c of selected) {
    if (c.loc.kind === 'header') {
      const arr = byHeader.get(c.loc.name) || [];
      arr.push(c);
      byHeader.set(c.loc.name, arr);
    }
  }
  for (const [name, cs] of byHeader) {
    if (headers[name] != null) headers[name] = replaceInText(headers[name], cs);
  }

  let body = req.body;
  const bodyCs = selected.filter((c) => c.loc.kind === 'body');
  if (bodyCs.length && body) body = replaceInText(body, bodyCs);

  return { ...req, url, headers, body };
}
