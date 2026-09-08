/**
 * 动态变量占位符解析器
 *
 * 支持在 URL / 请求头 / 请求体中嵌入内置动态变量，发送（或应用规则）时按当前时刻实时解析：
 *   {{$ts}}      当前 Unix 时间戳（秒）
 *   {{$tsMs}}    当前 Unix 时间戳（毫秒）
 *   {{$isoTs}}   当前 UTC ISO8601 时间字符串
 *
 * 三者均支持秒级偏移：{{$ts+30}} 表示 30 秒后，{{$tsMs-60}} 表示 60 秒前。
 *
 * 仅解析以 `$` 开头的内置变量；其它形如 {{foo}} 的占位符原样透传，
 * 以免误伤用户自身模板语法（如 Handlebars / 变量占位）。
 */

export type DynamicVarKind = 'ts' | 'tsMs' | 'isoTs';

export interface DynamicVarToken {
  /** 变量名（不含 $ 前缀与花括号） */
  name: DynamicVarKind;
  /** 面板中展示的插入文本，如 "{{$ts}}" */
  insert: string;
  /** 中文标题 */
  label: string;
}

/** 供插入菜单展示的内置变量清单 */
export const DYNAMIC_VAR_TOKENS: DynamicVarToken[] = [
  { name: 'ts', insert: '{{$ts}}', label: '时间戳（秒）' },
  { name: 'tsMs', insert: '{{$tsMs}}', label: '时间戳（毫秒）' },
  { name: 'isoTs', insert: '{{$isoTs}}', label: 'ISO 时间' },
];

/**
 * 匹配一个内置动态变量占位符。
 * 分组：1=变量名 2=偏移符号(+/-) 3=偏移秒数
 * 全局标志用于 replace / match 遍历；使用处应各自 new 或重置 lastIndex。
 */
const TOKEN_SRC = '\\{\\{\\s*\\$(ts|tsMs|isoTs)(?:\\s*([+-])\\s*(\\d+))?\\s*\\}\\}';

/** 是否包含至少一个内置动态变量 */
export function hasDynamicVars(input: string): boolean {
  if (!input) return false;
  return new RegExp(TOKEN_SRC).test(input);
}

function computeValue(kind: DynamicVarKind, baseMs: number, offsetSec: number): string {
  const ms = baseMs + offsetSec * 1000;
  switch (kind) {
    case 'ts':
      return String(Math.floor(ms / 1000));
    case 'tsMs':
      return String(ms);
    case 'isoTs':
      return new Date(ms).toISOString();
  }
}

/**
 * 将输入中的内置动态变量替换为按 `now` 计算的字面值。
 * @param input 原始字符串
 * @param opts.now 基准时刻（毫秒），默认当前时间；注入以便测试确定性
 */
export function resolveDynamicVars(input: string, opts?: { now?: number }): string {
  if (!input) return input;
  const baseMs = opts?.now ?? Date.now();
  return input.replace(new RegExp(TOKEN_SRC, 'g'), (_full, name: DynamicVarKind, sign: string | undefined, digits: string | undefined) => {
    let offsetSec = 0;
    if (sign && digits) {
      offsetSec = parseInt(digits, 10) * (sign === '-' ? -1 : 1);
    }
    return computeValue(name, baseMs, offsetSec);
  });
}
