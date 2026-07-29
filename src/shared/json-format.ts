// JSON 修复 / 格式化 / 压缩小工具，供「格式化」「压缩」按钮与校验提示共用。
//
// 设计要点：
// - repairAndFormatJson / minifyJson 先严格 JSON.parse；只有原文「本就非法」才跑修复器，
//   因此合法 JSON 绝不会被改动/破坏（含字符串里的中文标点等内容）。
// - 修复器逐字符扫描并正确识别字符串边界，不会误伤字符串内容。
// - 失败时给出「原因 + 位置 + 上下文片段」的中文提示，便于排查。

export interface JsonFormatResult {
  ok: boolean;
  text: string;        // 成功时为处理后的文本；失败/空时原样返回
  error?: string;      // 失败时的中文提示（原因 + 位置 + 片段）
  repaired?: boolean;  // 是否经过自动修复（而非本来就合法）
}

// 双/单引号的各种写法（含中文弯引号与全角），都当作字符串定界符
const DQUOTE = new Set(['"', '“', '”', '＂']); // "  “  ”  ＂
const SQUOTE = new Set(["'", '‘', '’', '＇']); // '  ‘  ’  ＇

// 结构位置上的全角/中文标点 → 半角（仅在字符串外替换）
const STRUCT_MAP: Record<string, string> = {
  '：': ':', // ：
  '，': ',', // ，
  '、': ',', // 、
  '；': ',', // ；
  '｛': '{', // ｛
  '｝': '}', // ｝
  '［': '[', // ［
  '］': ']', // ］
  '　': ' ', // 全角空格
};

// 严格优先 + 失败则尝试修复，最终按 indent 缩进输出
export function repairAndFormatJson(input: string, indent = 2): JsonFormatResult {
  return process(input, (obj) => JSON.stringify(obj, null, indent));
}

// 压缩：解析后去掉所有多余空白，压成一行（同样先修复再压）
export function minifyJson(input: string): JsonFormatResult {
  return process(input, (obj) => JSON.stringify(obj));
}

function process(input: string, render: (obj: unknown) => string): JsonFormatResult {
  const s = (input ?? '').trim();
  if (!s) return { ok: false, text: input, error: '内容为空' };
  try {
    return { ok: true, text: render(JSON.parse(s)), repaired: false };
  } catch (e0) {
    try {
      return { ok: true, text: render(JSON.parse(repairJson(s))), repaired: true };
    } catch {
      // 修复也失败：用「原文」的报错定位，保证行列/片段与用户看到的内容一致
      return { ok: false, text: input, error: jsonErrorMessage(e0, s) };
    }
  }
}

// 尽力修复常见的「近似 JSON」写法。返回的字符串仍可能非法（交给上层再 parse 判定）。
// 覆盖：// 与 /* */ 注释、尾逗号、单/弯/全角引号字符串、未加引号的键/值、
// 结构位置的全角标点（：，｛｝［］等）、Python 风格 True/False/None、末尾缺失的 } / ]。
export function repairJson(input: string): string {
  const s = input;
  const n = s.length;
  let out = '';
  const stack: string[] = [];
  let i = 0;

  const stripTrailingComma = () => {
    let k = out.length;
    while (k > 0 && /\s/.test(out[k - 1])) k--;
    if (k > 0 && out[k - 1] === ',') out = out.slice(0, k - 1) + out.slice(k);
  };

  while (i < n) {
    let c = s[i];

    // 行注释 //
    if (c === '/' && s[i + 1] === '/') { i += 2; while (i < n && s[i] !== '\n') i++; continue; }
    // 块注释 /* */
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }

    // 字符串（单/双/弯/全角引号）→ 归一为双引号；内部内容逐字复制，中文标点等原样保留
    if (DQUOTE.has(c) || SQUOTE.has(c)) {
      const closers = DQUOTE.has(c) ? DQUOTE : SQUOTE;
      i++;
      let str = '';
      while (i < n) {
        const ch = s[i];
        if (ch === '\\') {
          const nx = s[i + 1] ?? '';
          if (nx === '"') { str += '\\"'; i += 2; continue; }
          if (nx === "'") { str += "'"; i += 2; continue; }               // \' → '
          if ('\\/bfnrtu'.indexOf(nx) >= 0) { str += '\\' + nx; i += 2; continue; }
          str += nx; i += 2; continue;                                     // 未知转义 → 丢弃反斜杠
        }
        if (closers.has(ch)) { i++; break; }
        if (ch === '"') { str += '\\"'; i++; continue; }                   // 单引号串里的裸 "
        if (ch === '\n') { str += '\\n'; i++; continue; }
        if (ch === '\r') { str += '\\r'; i++; continue; }
        if (ch === '\t') { str += '\\t'; i++; continue; }
        str += ch; i++;
      }
      out += '"' + str + '"';
      continue;
    }

    // 结构位置的全角标点归一为半角（字符串已在上面处理，这里必是结构位）
    if (STRUCT_MAP[c] !== undefined) c = STRUCT_MAP[c];

    // 数字整体复制（避免把指数 e 当成单词误切）
    if (/[0-9]/.test(c) ||
        ((c === '-' || c === '+') && /[0-9.]/.test(s[i + 1] ?? '')) ||
        (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      let num = '';
      while (i < n && /[0-9eE+\-.]/.test(s[i])) { num += s[i]; i++; }
      out += num;
      continue;
    }

    // 裸词：字面量，或未加引号的键/值
    if (/[A-Za-z_$]/.test(c)) {
      let w = ''; let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(s[j])) { w += s[j]; j++; }
      i = j;
      if (w === 'true' || w === 'false' || w === 'null') out += w;
      else if (w === 'True' || w === 'False') out += w.toLowerCase();
      else if (w === 'None') out += 'null';
      else if (w === 'NaN' || w === 'Infinity' || w === 'undefined') out += 'null';
      else out += '"' + w + '"';
      continue;
    }

    if (c === '}' || c === ']') { stripTrailingComma(); out += c; if (stack.length) stack.pop(); i++; continue; }
    if (c === '{' || c === '[') { stack.push(c); out += c; i++; continue; }

    out += c; i++;
  }

  while (stack.length) {
    stripTrailingComma();
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  return out;
}

// 组合「原因 + 位置 + 上下文片段」的中文报错。
export function jsonErrorMessage(e: unknown, src: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  const reason = diagnoseReason(src, raw);

  let where = '', snippet = '';
  const pm = raw.match(/position (\d+)/i);
  if (pm) {
    const pos = parseInt(pm[1], 10);
    const lc = posToLineCol(src, pos);
    where = `第 ${lc.line} 行第 ${lc.col} 列`;
    snippet = snippetAround(src, pos);
  } else {
    const m = raw.match(/line (\d+) column (\d+)/i);
    if (m) where = `第 ${m[1]} 行第 ${m[2]} 列`;
  }

  let msg = '不是合法 JSON';
  if (reason) msg += '：' + reason;
  if (where) msg += (reason ? `（${where}附近）` : `：${where}附近`);
  if (snippet) msg += ` → ${snippet}`;
  return msg;
}

// 分析最可能的错误原因（在原文上做轻量结构扫描 + 翻译解析器报错）
function diagnoseReason(src: string, rawMsg: string): string {
  const st = structuralScan(src);
  if (st.unterminated) return '字符串未闭合，可能缺少结尾引号';

  const t = translateV8(rawMsg);
  if (t) return t;

  if (st.curly > 0) return `缺少 ${st.curly} 个「}」（对象未闭合）`;
  if (st.curly < 0) return `多了 ${-st.curly} 个「}」`;
  if (st.square > 0) return `缺少 ${st.square} 个「]」（数组未闭合）`;
  if (st.square < 0) return `多了 ${-st.square} 个「]」`;
  if (st.fullWidth) return `发现全角/中文字符「${st.fullWidth}」，JSON 结构需用半角符号`;
  return '';
}

// 把常见的 V8/Node JSON 报错翻译成可操作的中文原因；不认识的返回 ''
function translateV8(m: string): string {
  if (/unterminated string/i.test(m)) return '字符串未闭合（缺少结尾引号）';
  if (/expected double-quoted property name/i.test(m)) return '属性名需要用双引号，或多了逗号';
  if (/expected property name/i.test(m)) return '缺少属性名（可能多了逗号或漏了引号）';
  if (/after property name in json/i.test(m) || /expected ':'/i.test(m)) return '缺少冒号「:」';
  if (/expected ',' or '}'/i.test(m)) return '对象里缺少逗号「,」或引号';
  if (/expected ',' or ']'/i.test(m)) return '数组里缺少逗号「,」';
  if (/unexpected end of (json|data)/i.test(m)) return '内容不完整（缺少括号或引号）';
  return '';
}

// 轻量结构扫描：括号是否平衡、字符串是否未闭合、是否含全角/中文字符（字符串外）
function structuralScan(src: string): { curly: number; square: number; unterminated: boolean; fullWidth: string } {
  let curly = 0, square = 0, fullWidth = '';
  let inStr = false, isD = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if ((isD && DQUOTE.has(ch)) || (!isD && SQUOTE.has(ch))) inStr = false;
      continue;
    }
    if (DQUOTE.has(ch)) { inStr = true; isD = true; continue; }
    if (SQUOTE.has(ch)) { inStr = true; isD = false; continue; }
    if (ch === '{' || ch === '｛') curly++;
    else if (ch === '}' || ch === '｝') curly--;
    else if (ch === '[' || ch === '［') square++;
    else if (ch === ']' || ch === '］') square--;
    else if (!fullWidth && (STRUCT_MAP[ch] !== undefined || /[０-９！-～]/.test(ch))) fullWidth = ch;
  }
  return { curly, square, unterminated: inStr, fullWidth };
}

function posToLineCol(src: string, pos: number): { line: number; col: number } {
  let line = 1, col = 1;
  const end = Math.min(pos, src.length);
  for (let i = 0; i < end; i++) {
    if (src[i] === '\n') { line++; col = 1; } else { col++; }
  }
  return { line, col };
}

// 取出错点附近 ~30 字的片段（折叠空白），比行列数字更容易在原文里找到
function snippetAround(src: string, pos: number): string {
  const start = Math.max(0, pos - 15);
  const end = Math.min(src.length, pos + 15);
  const seg = src.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + seg + (end < src.length ? '…' : '');
}
