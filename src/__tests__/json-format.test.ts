import { describe, it, expect } from 'vitest';
import { repairJson, repairAndFormatJson, minifyJson } from '../shared/json-format';

describe('repairAndFormatJson (合法输入不改动，仅格式化)', () => {
  it('合法 JSON → 缩进格式化，repaired=false', () => {
    const r = repairAndFormatJson('{"a":1,"b":[2,3]}');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(false);
    expect(r.text).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it('字符串里的逗号/括号/引号不会被误伤', () => {
    const src = '{"a":"x,y}z","b":"he said \\"hi\\""}';
    const r = repairAndFormatJson(src);
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(false);
    // 解析回来内容一致
    expect(JSON.parse(r.text)).toEqual({ a: 'x,y}z', b: 'he said "hi"' });
  });

  it('空内容 → ok:false', () => {
    expect(repairAndFormatJson('   ').ok).toBe(false);
  });
});

describe('repairAndFormatJson (自动修复常见错误)', () => {
  it('尾逗号（对象与数组）', () => {
    const r = repairAndFormatJson('{"a":1,"b":[1,2,3,],}');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it('单引号字符串', () => {
    const r = repairAndFormatJson("{'name':'test'}");
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ name: 'test' });
  });

  it('未加引号的键', () => {
    const r = repairAndFormatJson('{name: "test", age: 3}');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ name: 'test', age: 3 });
  });

  it('// 与 /* */ 注释', () => {
    const r = repairAndFormatJson('{\n  "a": 1, // 行注释\n  /* 块注释 */ "b": 2\n}');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ a: 1, b: 2 });
  });

  it('Python 风格 True/False/None', () => {
    const r = repairAndFormatJson("{'ok': True, 'bad': False, 'x': None}");
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ ok: true, bad: false, x: null });
  });

  it('末尾缺失的闭合括号', () => {
    const r = repairAndFormatJson('{"a": [1, 2, {"b": 3}');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ a: [1, 2, { b: 3 }] });
  });

  it('指数/负数在尾逗号场景下保留', () => {
    const r = repairAndFormatJson('{"a": 1e5, "b": -3.2,}');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ a: 1e5, b: -3.2 });
  });

  it('无法修复时 → ok:false 且带中文提示，不改动原文', () => {
    const bad = 'this is definitely not json {{{';
    const r = repairAndFormatJson(bad);
    expect(r.ok).toBe(false);
    expect(r.text).toBe(bad);
    expect(r.error).toMatch(/不是合法 JSON/);
  });
});

describe('repairJson (合法输入原样往返)', () => {
  it('合法 JSON 往返后语义不变', () => {
    const src = '{"a":1,"list":[true,false,null,"s"]}';
    expect(JSON.parse(repairJson(src))).toEqual(JSON.parse(src));
  });
});

describe('minifyJson', () => {
  it('压缩为单行', () => {
    const r = minifyJson('{\n  "a": 1,\n  "b": 2\n}');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('{"a":1,"b":2}');
  });

  it('压缩同样会先修复（尾逗号）', () => {
    const r = minifyJson('{"a":1,}');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(r.text).toBe('{"a":1}');
  });
});

describe('全角 / 中文标点自动修复', () => {
  it('全角括号、全角冒号、全角逗号', () => {
    const r = repairAndFormatJson('｛"a"：1，"b"：2｝');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ a: 1, b: 2 });
  });

  it('中文弯引号作为字符串定界符', () => {
    const r = repairAndFormatJson('{“name”:“张三”}');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text)).toEqual({ name: '张三' });
  });

  it('字符串「内部」的中文标点不被改动（本就合法）', () => {
    const r = repairAndFormatJson('{"note":"你好，世界！（含全角）"}');
    expect(r.ok).toBe(true);
    expect(r.repaired).toBe(false);
    expect(JSON.parse(r.text).note).toBe('你好，世界！（含全角）');
  });
});

describe('修复失败时给出原因', () => {
  it('缺少逗号 → 提示缺少逗号', () => {
    const r = repairAndFormatJson('{"a":1 "b":2}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/缺少逗号/);
  });

  it('多了一个右括号 → 提示多了 } ', () => {
    const r = repairAndFormatJson('{"a":1}}');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/多了 1 个/);
  });

  it('报错信息带位置与上下文片段', () => {
    const r = repairAndFormatJson('{"a":1 "b":2}');
    expect(r.error).toMatch(/第 \d+ 行第 \d+ 列/);
    expect(r.error).toMatch(/→/);
  });
});
