/**
 * 漂移守卫（drift guard）：在 node:vm 沙箱里加载**冻结基准** interceptor.golden.js 的纯匹配/改写引擎，
 * 与收敛后的单一引擎源 src/engine/engine.ts 在同一批断言用例上逐条比对。
 *
 * P0-1 收敛后引擎只有一份（engine.ts），线上运行时层直接 import 它。本守卫的角色转为
 * **回归基准**：证明抽出的引擎对「今日发布版（golden）」在这批 battery 上逐条等价——
 * 「大小写不敏感删头 / redirect URL 校验 / 保护响应头 / injectScript 排序 / 域名父级匹配」。
 * 未来若**有意**改引擎行为，需刻意重生成 golden（预期的安全属性，非缺陷）。
 *
 * golden 从不置位 window.__APII_TEST_HOOK 于生产，因此其导出分支对线上零副作用。
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, it, expect, beforeAll } from 'vitest';
import { Rule, Action } from '../shared/types';
import * as engine from '../engine/engine';

// 线上引擎的最小类型面（仅测试使用）
interface RealEngine {
  getMatchingRules(url: string, method: string, rtype: string): Rule[];
  applyReq(url: string, hdrs: Record<string, string>, body: string | undefined, actions: Action[]): unknown;
  applyResp(status: number, statusText: string, hdrs: Record<string, string>, body: string, actions: Action[]): unknown;
  detectSignHeaders(h: Record<string, string>): string[];
  setState(rules: Rule[], groups: { id: string; enabled: boolean }[]): void;
}

let real: RealEngine;

beforeAll(() => {
  const src = readFileSync(new URL('./fixtures/interceptor.golden.js', import.meta.url), 'utf8');

  // sandbox 自身即充当 window：让裸 `location` 与 `window.location` 解析到同一对象
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandbox: any = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.location = { href: 'https://host.example.com/', origin: 'https://host.example.com' };
  sandbox.URL = URL;
  sandbox.console = console;
  sandbox.Date = Date;
  sandbox.Math = Math;
  sandbox.btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');
  sandbox.atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
  sandbox.TextDecoder = TextDecoder;
  sandbox.TextEncoder = TextEncoder;
  sandbox.setTimeout = () => 0;
  sandbox.clearTimeout = () => {};
  sandbox.setInterval = () => 0;
  sandbox.clearInterval = () => {};
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.postMessage = () => {};
  sandbox.dispatchEvent = () => true;
  sandbox.document = { addEventListener: () => {}, documentElement: {}, createElement: () => ({}) };
  sandbox.MutationObserver = function () {
    return { observe: () => {}, disconnect: () => {}, takeRecords: () => [] };
  };
  sandbox.fetch = () => Promise.resolve();
  const XHR: any = function () {};
  XHR.prototype = { getAllResponseHeaders: () => '', open: () => {}, send: () => {}, setRequestHeader: () => {} };
  sandbox.XMLHttpRequest = XHR;
  sandbox.Response = typeof Response !== 'undefined' ? Response : function () {};
  sandbox.__APII_TEST_HOOK = true;

  createContext(sandbox);
  runInContext(src, sandbox, { filename: 'interceptor.js' });

  real = sandbox.__APII_ENGINE as RealEngine;
  expect(real, '冻结基准 interceptor.golden.js 未导出 __APII_ENGINE（测试钩子缺失）').toBeTruthy();
});

// === applyReq 用例 ===
const REQ_CASES: Array<{
  name: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  actions: Action[];
}> = [
  {
    name: 'set 头 + 大小写删头（Content-Length）',
    url: 'https://api.x.com/a',
    headers: { 'Content-Length': '10', Authorization: 'Bearer t' },
    body: 'orig',
    actions: [
      { type: 'modifyRequestHeader', operate: 'set', key: 'X-Trace', value: '1' },
      { type: 'modifyRequestHeader', operate: 'remove', key: 'content-length', value: '' },
    ],
  },
  {
    name: 'body set → 清 Content-Length（大写键）',
    url: 'https://api.x.com/a',
    headers: { 'Content-Length': '4' },
    body: 'orig',
    actions: [{ type: 'modifyRequestBody', operate: 'set', key: '', value: 'NEW' }],
  },
  {
    name: 'url replace 正则',
    url: 'https://api.x.com/v1/a?debug=0',
    headers: {},
    body: undefined,
    actions: [{ type: 'modifyRequestUrl', operate: 'replace', key: '/v1/', value: '/v2/' }],
  },
  {
    name: 'url remove 查询参数',
    url: 'https://api.x.com/a?token=abc&keep=1',
    headers: {},
    body: undefined,
    actions: [{ type: 'modifyRequestUrl', operate: 'remove', key: 'token', value: '' }],
  },
  {
    name: 'redirect 合法 URL',
    url: 'https://api.x.com/a',
    headers: {},
    body: undefined,
    actions: [{ type: 'redirect', operate: 'set', key: '', value: 'https://mock.local/a' }],
  },
  {
    name: 'redirect 非法 URL → 保留原 URL',
    url: 'https://api.x.com/a',
    headers: {},
    body: undefined,
    actions: [{ type: 'redirect', operate: 'set', key: '', value: 'not a url' }],
  },
  {
    name: 'cancel + delay 上限钳制',
    url: 'https://api.x.com/a',
    headers: {},
    body: undefined,
    actions: [
      { type: 'cancel', operate: 'set', key: '', value: '' },
      { type: 'delay', operate: 'set', key: '', value: '99999' },
    ],
  },
  {
    name: 'injectScript 恒排最后（能看到已改写的 body）',
    url: 'https://api.x.com/a',
    headers: {},
    body: 'orig',
    actions: [
      { type: 'injectScript', operate: 'set', key: '', value: "ctx.headers['X-Seen-Body'] = ctx.body;" },
      { type: 'modifyRequestBody', operate: 'set', key: '', value: 'CHANGED' },
    ],
  },
  {
    name: 'injectScript 抛错被吞，其它动作照常',
    url: 'https://api.x.com/a',
    headers: {},
    body: 'orig',
    actions: [
      { type: 'modifyRequestHeader', operate: 'set', key: 'X-Ok', value: '1' },
      { type: 'injectScript', operate: 'set', key: '', value: 'throw new Error("boom");' },
    ],
  },
  {
    name: 'body 改写 + 签名头 → warnings 命中',
    url: 'https://api.x.com/a',
    headers: { 'X-Ca-Signature': 'sig' },
    body: 'orig',
    actions: [{ type: 'modifyRequestBody', operate: 'set', key: '', value: 'NEW' }],
  },
  {
    name: 'header replace 正则（大小写不敏感命中 Content-Type）',
    url: 'https://api.x.com/a',
    headers: { 'Content-Type': 'text/plain' },
    body: undefined,
    actions: [{ type: 'modifyRequestHeader', operate: 'replace', key: 'content-type', value: 'application/json' }],
  },
  {
    name: 'header append',
    url: 'https://api.x.com/a',
    headers: { 'X-Tag': 'a' },
    body: undefined,
    actions: [{ type: 'modifyRequestHeader', operate: 'append', key: 'X-Tag', value: 'b' }],
  },
];

// === applyResp 用例 ===
const RESP_CASES: Array<{
  name: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  actions: Action[];
}> = [
  {
    name: 'body set → 清 Content-Length/Encoding + 补 charset',
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Length': '3', 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' },
    body: 'old',
    actions: [{ type: 'modifyResponseBody', operate: 'set', key: '', value: '{"a":1}' }],
  },
  {
    name: '保护头 CSP 不可删',
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Security-Policy': "default-src 'self'" },
    body: 'x',
    actions: [{ type: 'modifyResponseHeader', operate: 'remove', key: 'content-security-policy', value: '' }],
  },
  {
    name: '非保护头可删',
    status: 200,
    statusText: 'OK',
    headers: { 'X-Powered-By': 'php' },
    body: 'x',
    actions: [{ type: 'modifyResponseHeader', operate: 'remove', key: 'x-powered-by', value: '' }],
  },
  {
    name: 'modifyStatusCode 合法',
    status: 200,
    statusText: 'OK',
    headers: {},
    body: 'x',
    actions: [{ type: 'modifyStatusCode', operate: 'set', key: '', value: '404' }],
  },
  {
    name: 'modifyStatusCode 非法（100）被忽略',
    status: 200,
    statusText: 'OK',
    headers: {},
    body: 'x',
    actions: [{ type: 'modifyStatusCode', operate: 'set', key: '', value: '100' }],
  },
  {
    name: 'modifyStatusCode 200 → OK',
    status: 500,
    statusText: 'Server Error',
    headers: {},
    body: 'x',
    actions: [{ type: 'modifyStatusCode', operate: 'set', key: '', value: '200' }],
  },
  {
    name: 'response header replace 正则',
    status: 200,
    statusText: 'OK',
    headers: { 'Cache-Control': 'no-cache' },
    body: 'x',
    actions: [{ type: 'modifyResponseHeader', operate: 'replace', key: 'cache-control', value: 'max-age=60' }],
  },
];

// === detectSignHeaders 用例 ===
const SIGN_CASES: Array<{ name: string; headers: Record<string, string> }> = [
  { name: '普通 Bearer 不算', headers: { Authorization: 'Bearer abc.def' } },
  { name: 'AWS SigV4 值算', headers: { Authorization: 'AWS4-HMAC-SHA256 Credential=...' } },
  { name: 'X-Ca-Signature 按名算', headers: { 'X-Ca-Signature': 'zzz' } },
  { name: 'X-Signature + Content-MD5', headers: { 'X-Signature': 'a', 'Content-MD5': 'b' } },
  { name: '无关头', headers: { 'X-Custom': 'x' } },
];

// === 匹配用例（含域名父级/单段 TLD 收敛）===
function mkRule(p: Partial<Rule> & { id: string; match: Rule['match'] }): Rule {
  return {
    name: p.id,
    groupId: 'default',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    actions: [],
    ...p,
  } as Rule;
}
const RULES: Rule[] = [
  mkRule({ id: 'exact-get', match: { url: 'https://api.example.com/v1/users', matchType: 'exact', method: 'GET', resourceType: '' } }),
  mkRule({ id: 'domain-2seg', match: { url: 'example.com', matchType: 'domain', method: '', resourceType: '' } }),
  mkRule({ id: 'domain-tld', match: { url: 'com', matchType: 'domain', method: '', resourceType: '' } }),
  mkRule({ id: 'contains-special', match: { url: 'special', matchType: 'contains', method: '', resourceType: '' } }),
  mkRule({ id: 'regex-cdn', match: { url: 'https://.*\\.cdn\\.net/.*', matchType: 'regex', method: '', resourceType: '' } }),
  mkRule({ id: 'contains-submit-post', match: { url: 'submit', matchType: 'contains', method: 'POST', resourceType: '' } }),
  mkRule({ id: 'xhr-only', match: { url: 'https://api.example.com/v1/users', matchType: 'exact', method: '', resourceType: 'xmlhttprequest' } }),
  mkRule({ id: 'disabled', enabled: false, match: { url: 'https://api.example.com/v1/users', matchType: 'exact', method: '', resourceType: '' } }),
  mkRule({ id: 'in-disabled-group', groupId: 'g2', match: { url: 'https://api.example.com/v1/users', matchType: 'exact', method: '', resourceType: '' } }),
];
const GROUPS = [
  { id: 'default', enabled: true },
  { id: 'g2', enabled: false },
];
const MATCH_CASES: Array<{ name: string; url: string; method: string; rtype: string }> = [
  { name: 'exact+domain（GET/fetch）', url: 'https://api.example.com/v1/users', method: 'GET', rtype: 'fetch' },
  { name: 'POST → 仅 domain（exact 限 GET）', url: 'https://api.example.com/v1/users', method: 'POST', rtype: 'fetch' },
  { name: 'xhr → exact+domain+xhr-only', url: 'https://api.example.com/v1/users', method: 'GET', rtype: 'xmlhttprequest' },
  { name: '单段 TLD 规则不命中子域', url: 'https://foo.com/x', method: 'GET', rtype: 'fetch' },
  { name: 'regex 子域命中', url: 'https://x.cdn.net/a.js', method: 'GET', rtype: 'fetch' },
  { name: 'contains special', url: 'https://site.io/special/thing', method: 'GET', rtype: 'fetch' },
  { name: 'contains submit（POST）', url: 'https://site.io/submit', method: 'POST', rtype: 'fetch' },
  { name: 'contains submit（GET 不命中）', url: 'https://site.io/submit', method: 'GET', rtype: 'fetch' },
];

describe('drift guard: golden 冻结基准 vs engine.ts 单一引擎源', () => {
  it.each(REQ_CASES)('applyReq — $name', (c) => {
    const r = real.applyReq(c.url, c.headers, c.body, c.actions);
    // engine 侧省略 opts：ctx.crypto/onInjectError 是纯副作用，不进返回值；
    // REQ_CASES 无一用到 ctx.crypto，故与 golden（恒设 ctx.crypto）返回逐字等价。
    const m = engine.applyReq(c.url, c.headers, c.body, c.actions);
    expect(r).toEqual(m);
  });

  it.each(RESP_CASES)('applyResp — $name', (c) => {
    const r = real.applyResp(c.status, c.statusText, c.headers, c.body, c.actions);
    const m = engine.applyResp(c.status, c.statusText, c.headers, c.body, c.actions);
    expect(r).toEqual(m);
  });

  it.each(SIGN_CASES)('detectSignHeaders — $name', (c) => {
    expect(real.detectSignHeaders(c.headers)).toEqual(engine.detectSignHeaders(c.headers));
  });

  it.each(MATCH_CASES)('getMatchingRules — $name', (c) => {
    real.setState(RULES, GROUPS);
    // engine 是模块级单例：syncRules 播种 + 开启门控（与 golden setState 内含的 ACTIVE/GLOBAL_ENABLED=true 对齐）
    engine.syncRules(RULES, GROUPS);
    engine.setActive(true);
    engine.setGlobalEnabled(true);
    const rIds = real.getMatchingRules(c.url, c.method, c.rtype).map((x) => x.id).sort();
    const mIds = engine.getMatchingRules(c.url, c.method, c.rtype).map((x) => x.id).sort();
    expect(rIds).toEqual(mIds);
  });
});
