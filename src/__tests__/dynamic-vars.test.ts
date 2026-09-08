import { describe, it, expect } from 'vitest';
import {
  resolveDynamicVars,
  hasDynamicVars,
  decodeDynamicVars,
  DYNAMIC_VAR_TOKENS,
} from '../shared/dynamic-vars';

// 固定基准时刻：2021-11-14T22:13:20.000Z（Unix 秒 1700000000 的近似，用整千毫秒便于断言）
const NOW = 1700000000000; // 毫秒
const NOW_SEC = 1700000000;

describe('resolveDynamicVars', () => {
  it('解析 {{$ts}} 为 Unix 秒', () => {
    expect(resolveDynamicVars('{{$ts}}', { now: NOW })).toBe(String(NOW_SEC));
  });

  it('解析 {{$tsMs}} 为 Unix 毫秒', () => {
    expect(resolveDynamicVars('{{$tsMs}}', { now: NOW })).toBe(String(NOW));
  });

  it('解析 {{$isoTs}} 为 UTC ISO8601', () => {
    expect(resolveDynamicVars('{{$isoTs}}', { now: NOW })).toBe(new Date(NOW).toISOString());
  });

  it('支持秒级正偏移 {{$ts+30}}', () => {
    expect(resolveDynamicVars('{{$ts+30}}', { now: NOW })).toBe(String(NOW_SEC + 30));
  });

  it('支持秒级负偏移 {{$ts-60}}', () => {
    expect(resolveDynamicVars('{{$ts-60}}', { now: NOW })).toBe(String(NOW_SEC - 60));
  });

  it('偏移对毫秒变量按秒换算', () => {
    expect(resolveDynamicVars('{{$tsMs+1}}', { now: NOW })).toBe(String(NOW + 1000));
  });

  it('偏移对 ISO 变量生效', () => {
    expect(resolveDynamicVars('{{$isoTs-10}}', { now: NOW })).toBe(new Date(NOW - 10000).toISOString());
  });

  it('容忍花括号内空白', () => {
    expect(resolveDynamicVars('{{ $ts + 5 }}', { now: NOW })).toBe(String(NOW_SEC + 5));
  });

  it('替换字符串中嵌入的多个变量', () => {
    const out = resolveDynamicVars('https://x.test/api?t={{$ts}}&n={{$tsMs}}', { now: NOW });
    expect(out).toBe(`https://x.test/api?t=${NOW_SEC}&n=${NOW}`);
  });

  it('非内置占位符原样透传', () => {
    expect(resolveDynamicVars('{{foo}} {{$unknown}} {{ ts }}', { now: NOW })).toBe('{{foo}} {{$unknown}} {{ ts }}');
  });

  it('空字符串原样返回', () => {
    expect(resolveDynamicVars('', { now: NOW })).toBe('');
  });
});

describe('hasDynamicVars', () => {
  it('识别存在的内置变量', () => {
    expect(hasDynamicVars('a={{$ts}}')).toBe(true);
    expect(hasDynamicVars('{{$isoTs-1}}')).toBe(true);
  });
  it('对无变量或非内置占位符返回 false', () => {
    expect(hasDynamicVars('plain')).toBe(false);
    expect(hasDynamicVars('{{foo}}')).toBe(false);
    expect(hasDynamicVars('')).toBe(false);
  });
});

describe('DYNAMIC_VAR_TOKENS', () => {
  it('每个内置变量的 insert 都可被解析', () => {
    for (const t of DYNAMIC_VAR_TOKENS) {
      expect(hasDynamicVars(t.insert)).toBe(true);
      expect(resolveDynamicVars(t.insert, { now: NOW })).not.toBe(t.insert);
    }
  });
});

describe('decodeDynamicVars', () => {
  it('还原被 URLSearchParams 编码的 {{$ts}}', () => {
    // new URL(...).searchParams.append('ts','{{$ts}}') + toString() 的产物
    const encoded = 'https://x.test/api?ts=%7B%7B%24ts%7D%7D';
    const decoded = decodeDynamicVars(encoded);
    expect(decoded).toBe('https://x.test/api?ts={{$ts}}');
    // 还原后可被正常解析成时间戳字面值
    expect(resolveDynamicVars(decoded, { now: NOW })).toBe(`https://x.test/api?ts=${NOW_SEC}`);
  });

  it('还原带正偏移的编码占位符（+ 被编码为 %2B）', () => {
    const encoded = 'https://x.test?t=%7B%7B%24ts%2B30%7D%7D';
    expect(decodeDynamicVars(encoded)).toBe('https://x.test?t={{$ts+30}}');
  });

  it('还原带负偏移的编码占位符（- 不被编码）', () => {
    const encoded = 'https://x.test?t=%7B%7B%24ts-60%7D%7D';
    expect(decodeDynamicVars(encoded)).toBe('https://x.test?t={{$ts-60}}');
  });

  it('还原多个编码占位符', () => {
    const encoded = 'https://x.test?a=%7B%7B%24ts%7D%7D&b=%7B%7B%24tsMs%7D%7D';
    expect(decodeDynamicVars(encoded)).toBe('https://x.test?a={{$ts}}&b={{$tsMs}}');
  });

  it('不动其它百分号编码（仅解占位符段）', () => {
    // 中文值编码不应被还原，只有占位符段被解
    const encoded = 'https://x.test?name=%E4%BD%A0%E5%A5%BD&t=%7B%7B%24ts%7D%7D';
    expect(decodeDynamicVars(encoded)).toBe('https://x.test?name=%E4%BD%A0%E5%A5%BD&t={{$ts}}');
  });

  it('对不含编码占位符的字符串原样返回', () => {
    expect(decodeDynamicVars('https://x.test?t={{$ts}}')).toBe('https://x.test?t={{$ts}}');
    expect(decodeDynamicVars('plain')).toBe('plain');
    expect(decodeDynamicVars('')).toBe('');
  });
});
