import { describe, it, expect } from 'vitest';
import { matchUrl, getMatchingRules, applyReq, applyResp, detectSignHeaders } from './engine';
import { Rule, Action } from '../shared/types';

// === Helper to create test rules ===
function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1', name: 'test', groupId: 'default', enabled: true,
    createdAt: 0, updatedAt: 0,
    match: { url: '/api', matchType: 'contains', method: '', resourceType: '' },
    actions: [],
    ...overrides,
  };
}

function makeAction(overrides: Partial<Action> = {}): Action {
  return { type: 'modifyResponseBody', operate: 'set', key: '', value: '', ...overrides };
}

// ============================================================
// TEST 1: matchUrl — normal flow with all 4 match types
// ============================================================
describe('matchUrl', () => {
  it('exact: matches identical URLs, rejects different URLs', () => {
    expect(matchUrl('https://a.com/api', 'exact', 'https://a.com/api')).toBe(true);
    expect(matchUrl('https://a.com/api', 'exact', 'https://a.com/api/v2')).toBe(false);
    expect(matchUrl('https://a.com/api', 'exact', 'https://b.com/api')).toBe(false);
  });

  it('contains: matches substring anywhere in URL', () => {
    expect(matchUrl('/api/user', 'contains', 'https://a.com/api/user/123')).toBe(true);
    expect(matchUrl('/api/user', 'contains', 'https://a.com/other')).toBe(false);
    expect(matchUrl('', 'contains', 'https://a.com/anything')).toBe(true); // empty string always matches
  });

  it('regex: matches pattern, rejects non-matches, handles invalid regex gracefully', () => {
    expect(matchUrl('/api/\\d+', 'regex', 'https://a.com/api/123')).toBe(true);
    expect(matchUrl('/api/\\d+', 'regex', 'https://a.com/api/abc')).toBe(false);
    // Invalid regex should not crash, just return false
    expect(matchUrl('[invalid', 'regex', 'https://a.com/api')).toBe(false);
  });

  it('domain: matches exact domain and subdomains', () => {
    expect(matchUrl('example.com', 'domain', 'https://example.com/path')).toBe(true);
    expect(matchUrl('example.com', 'domain', 'https://api.example.com/path')).toBe(true);
    expect(matchUrl('example.com', 'domain', 'https://notexample.com/path')).toBe(false);
    expect(matchUrl('example.com', 'domain', 'https://other.com/path')).toBe(false);
  });
});

// ============================================================
// TEST 2: getMatchingRules — filters by enabled, group, method, resourceType
// ============================================================
describe('getMatchingRules', () => {
  const groups = [{ id: 'default', enabled: true }, { id: 'disabled', enabled: false }];

  it('returns only enabled rules in enabled groups', () => {
    const rules = [
      makeRule({ id: 'r1', enabled: true, groupId: 'default' }),
      makeRule({ id: 'r2', enabled: false, groupId: 'default' }),
      makeRule({ id: 'r3', enabled: true, groupId: 'disabled' }),
    ];
    const result = getMatchingRules(rules, groups, 'https://a.com/api', 'GET', 'fetch');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r1');
  });

  it('filters by HTTP method when specified', () => {
    const rules = [
      makeRule({ id: 'r1', match: { url: '/api', matchType: 'contains', method: 'POST', resourceType: '' } }),
      makeRule({ id: 'r2', match: { url: '/api', matchType: 'contains', method: 'GET', resourceType: '' } }),
    ];
    const result = getMatchingRules(rules, groups, 'https://a.com/api', 'GET', 'fetch');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r2');
  });

  it('ignores method filter when rule method is empty (matches all)', () => {
    const rules = [
      makeRule({ id: 'r1', match: { url: '/api', matchType: 'contains', method: '', resourceType: '' } }),
    ];
    const result = getMatchingRules(rules, groups, 'https://a.com/api', 'DELETE', 'fetch');
    expect(result).toHaveLength(1);
  });

  it('returns empty array when no rules match', () => {
    const rules = [makeRule({ match: { url: '/other', matchType: 'exact', method: '', resourceType: '' } })];
    expect(getMatchingRules(rules, groups, 'https://a.com/api', 'GET', 'fetch')).toHaveLength(0);
  });
});

// ============================================================
// TEST 3: applyReq — request body rewriting (normal + boundary)
// ============================================================
describe('applyReq', () => {
  it('set operation replaces entire body', () => {
    const result = applyReq('https://a.com', {}, 'old body', [
      makeAction({ type: 'modifyRequestBody', operate: 'set', value: 'new body' }),
    ]);
    expect(result.body).toBe('new body');
    expect(result.url).toBe('https://a.com');
  });

  it('replace operation does regex substitution on body', () => {
    const result = applyReq('https://a.com', {}, '{"name":"Alice","age":30}', [
      makeAction({ type: 'modifyRequestBody', operate: 'replace', key: '"age":\\d+', value: '"age":25' }),
    ]);
    expect(result.body).toBe('{"name":"Alice","age":25}');
  });

  it('deletes content-length header when body is modified', () => {
    const result = applyReq('https://a.com', { 'content-length': '100', 'content-type': 'application/json' }, 'old', [
      makeAction({ type: 'modifyRequestBody', operate: 'set', value: 'new' }),
    ]);
    expect(result.headers['content-length']).toBeUndefined();
    expect(result.headers['content-type']).toBe('application/json'); // preserved
  });

  it('does NOT delete content-length when body is NOT modified', () => {
    const result = applyReq('https://a.com', { 'content-length': '100' }, 'body', [
      makeAction({ type: 'modifyRequestHeader', operate: 'set', key: 'X-Custom', value: 'val' }),
    ]);
    expect(result.headers['content-length']).toBe('100');
  });

  it('cancel action sets cancelled flag', () => {
    const result = applyReq('https://a.com', {}, 'body', [makeAction({ type: 'cancel' })]);
    expect(result.cancelled).toBe(true);
  });

  it('delay action caps at 30000ms', () => {
    const result = applyReq('https://a.com', {}, 'body', [makeAction({ type: 'delay', value: '999999' })]);
    expect(result.delayMs).toBe(30000);
  });

  it('redirect replaces URL', () => {
    const result = applyReq('https://a.com', {}, 'body', [makeAction({ type: 'redirect', operate: 'set', value: 'https://b.com' })]);
    expect(result.url).toBe('https://b.com');
  });
});

// ============================================================
// TEST 4: applyResp — response rewriting with protected headers
// ============================================================
describe('applyResp', () => {
  it('set operation replaces response body', () => {
    const result = applyResp(200, 'OK', { 'content-type': 'application/json' }, '{"old":true}', [
      makeAction({ type: 'modifyResponseBody', operate: 'set', value: '{"new":true}' }),
    ]);
    expect(result.body).toBe('{"new":true}');
    expect(result.status).toBe(200);
  });

  it('replace operation does regex substitution on response body', () => {
    const result = applyResp(200, 'OK', {}, 'Hello Alice, Hello Bob', [
      makeAction({ type: 'modifyResponseBody', operate: 'replace', key: 'Hello', value: 'Hi' }),
    ]);
    expect(result.body).toBe('Hi Alice, Hi Bob');
  });

  it('modifyStatusCode changes status and sets statusText', () => {
    const result = applyResp(200, 'OK', {}, 'body', [
      makeAction({ type: 'modifyStatusCode', operate: 'set', value: '404' }),
    ]);
    expect(result.status).toBe(404);
    expect(result.statusText).toBe('');
  });

  it('modifyStatusCode with 2xx sets statusText to OK', () => {
    const result = applyResp(404, 'Not Found', {}, 'body', [
      makeAction({ type: 'modifyStatusCode', operate: 'set', value: '201' }),
    ]);
    expect(result.status).toBe(201);
    expect(result.statusText).toBe('OK');
  });

  it('blocks entire header operation when key matches a protected header name', () => {
    const result = applyResp(200, 'OK', {
      'content-security-policy': "default-src 'self'",
      'strict-transport-security': 'max-age=31536000',
      'set-cookie': 'session=abc',
      'x-custom': 'keep',
    }, 'body', [
      makeAction({ type: 'modifyResponseHeader', operate: 'remove', key: '.*' }), // matches protected names
    ]);
    // When key matches ANY protected header, the entire operation is skipped (security by default)
    expect(result.headers['content-security-policy']).toBe("default-src 'self'");
    expect(result.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(result.headers['set-cookie']).toBe('session=abc');
    expect(result.headers['x-custom']).toBe('keep'); // also preserved because operation was blocked
  });

  it('removes non-protected headers when key does NOT match any protected name', () => {
    const result = applyResp(200, 'OK', {
      'x-request-id': 'remove-me',
      'x-trace': 'also-remove',
      'content-security-policy': "default-src 'self'",
    }, 'body', [
      makeAction({ type: 'modifyResponseHeader', operate: 'remove', key: '^x-request' }), // only matches x-request-*, not any protected name
    ]);
    expect(result.headers['x-request-id']).toBeUndefined();
    expect(result.headers['x-trace']).toBe('also-remove'); // not matched by key
    expect(result.headers['content-security-policy']).toBe("default-src 'self'"); // protected
  });

  it('handles invalid regex in header key without crashing (Vuln #1 fix)', () => {
    // This used to crash with SyntaxError before the fix
    const result = applyResp(200, 'OK', { 'x-custom': 'val' }, 'body', [
      makeAction({ type: 'modifyResponseHeader', operate: 'remove', key: '[' }), // invalid regex
    ]);
    // Should not crash, header should be preserved (invalid regex doesn't match)
    expect(result.headers['x-custom']).toBe('val');
    expect(result.status).toBe(200);
  });

  it('strips content-length and content-encoding when body changes', () => {
    const result = applyResp(200, 'OK', {
      'content-length': '100',
      'content-encoding': 'gzip',
      'content-type': 'application/json',
    }, 'old body', [
      makeAction({ type: 'modifyResponseBody', operate: 'set', value: 'new body' }),
    ]);
    expect(result.headers['content-length']).toBeUndefined();
    expect(result.headers['content-encoding']).toBeUndefined();
    expect(result.headers['content-type']).toContain('charset=utf-8');
  });
});

// ============================================================
// TEST 5: Edge cases — empty inputs, malformed data, extreme values
// ============================================================
describe('edge cases', () => {
  it('matchUrl with empty URL', () => {
    expect(matchUrl('', 'contains', 'https://a.com')).toBe(true);
    expect(matchUrl('', 'exact', '')).toBe(true);
    expect(matchUrl('', 'regex', 'anything')).toBe(true); // empty regex matches everything
  });

  it('applyReq with empty actions array returns unchanged request', () => {
    const result = applyReq('https://a.com', { 'x-test': 'val' }, 'body', []);
    expect(result.url).toBe('https://a.com');
    expect(result.headers['x-test']).toBe('val');
    expect(result.body).toBe('body');
    expect(result.cancelled).toBe(false);
    expect(result.delayMs).toBe(0);
  });

  it('applyResp with empty actions array returns unchanged response', () => {
    const result = applyResp(200, 'OK', { 'x-test': 'val' }, 'body', []);
    expect(result.status).toBe(200);
    expect(result.headers['x-test']).toBe('val');
    expect(result.body).toBe('body');
  });

  it('applyReq with undefined body skips body modification', () => {
    const result = applyReq('https://a.com', {}, undefined, [
      makeAction({ type: 'modifyRequestBody', operate: 'set', value: 'new' }),
    ]);
    expect(result.body).toBeUndefined(); // body was undefined, so set is skipped
  });

  it('getMatchingRules with empty rules array returns empty', () => {
    expect(getMatchingRules([], [{ id: 'default', enabled: true }], 'https://a.com', 'GET', 'fetch')).toEqual([]);
  });

  it('getMatchingRules with empty groups uses default group', () => {
    const rules = [makeRule({ groupId: 'default' })];
    const result = getMatchingRules(rules, [], 'https://a.com/api', 'GET', 'fetch');
    expect(result).toHaveLength(1);
  });

  it('applyReq handles header append with existing value', () => {
    const result = applyReq('https://a.com', { 'Accept': 'text/html' }, 'body', [
      makeAction({ type: 'modifyRequestHeader', operate: 'append', key: 'Accept', value: 'application/json' }),
    ]);
    expect(result.headers['Accept']).toBe('text/html, application/json');
  });

  it('applyReq handles header append with no existing value', () => {
    const result = applyReq('https://a.com', {}, 'body', [
      makeAction({ type: 'modifyRequestHeader', operate: 'append', key: 'X-New', value: 'val' }),
    ]);
    expect(result.headers['X-New']).toBe('val');
  });

  it('delay with 0 or negative value results in 0 delay', () => {
    const result = applyReq('https://a.com', {}, 'body', [makeAction({ type: 'delay', value: '0' })]);
    expect(result.delayMs).toBe(0);
  });

  it('modifyStatusCode with out-of-range value is ignored', () => {
    const result = applyResp(200, 'OK', {}, 'body', [
      makeAction({ type: 'modifyStatusCode', operate: 'set', value: '999' }),
    ]);
    expect(result.status).toBe(200); // 999 is out of 200-599 range
  });

  it('modifyStatusCode with 1xx value is ignored (Response 构造器不支持 <200)', () => {
    const result = applyResp(200, 'OK', {}, 'body', [
      makeAction({ type: 'modifyStatusCode', operate: 'set', value: '101' }),
    ]);
    expect(result.status).toBe(200);
  });

  it('modifyStatusCode with non-numeric value is ignored', () => {
    const result = applyResp(200, 'OK', {}, 'body', [
      makeAction({ type: 'modifyStatusCode', operate: 'set', value: 'abc' }),
    ]);
    expect(result.status).toBe(200);
  });
});

// ============================================================
// TEST: detectSignHeaders — 只报基于 body 的签名头，不误报静态凭证
// ============================================================
describe('detectSignHeaders', () => {
  it('flags name-based signature headers', () => {
    expect(detectSignHeaders({ 'X-Sign': 'abc' })).toEqual(['X-Sign']);
    expect(detectSignHeaders({ 'X-Signature': 'abc' })).toEqual(['X-Signature']);
    expect(detectSignHeaders({ 'Content-MD5': 'abc' })).toEqual(['Content-MD5']);
    expect(detectSignHeaders({ 'x-ca-signature': 'abc' })).toEqual(['x-ca-signature']);
    expect(detectSignHeaders({ 'X-Gorgon': 'abc' })).toEqual(['X-Gorgon']);
    expect(detectSignHeaders({ 'digest': 'sha-256=xxx' })).toEqual(['digest']);
  });

  it('does NOT flag static credentials (the 401 false-positive we removed)', () => {
    expect(detectSignHeaders({ 'Authorization': 'Bearer eyJhbGciOi...' })).toEqual([]);
    expect(detectSignHeaders({ 'Authorization': 'Basic dXNlcjpwYXNz' })).toEqual([]);
    // 用户实际场景：Authorization 是一个不透明 token（UUID 形态），非签名
    expect(detectSignHeaders({ 'Authorization': 'ec934e82-af26-4d50-a477-108613359931' })).toEqual([]);
    expect(detectSignHeaders({ 'X-Design-Note': 'anything' })).toEqual([]); // 含 'sign' 子串但非独立词，不误报
  });

  it('flags Authorization only when its value is a body-based signature (SigV4/HMAC)', () => {
    expect(detectSignHeaders({ 'Authorization': 'AWS4-HMAC-SHA256 Credential=...,SignedHeaders=host,Signature=abc' }))
      .toEqual(['Authorization']);
    expect(detectSignHeaders({ 'Authorization': 'HMAC-SHA256 Signature=abc' })).toEqual(['Authorization']);
  });
});

// ============================================================
// TEST: applyReq — 今日新增的 injectScript 排序 / body 变更 / 签名告警
// ============================================================
describe('applyReq — injectScript ordering & sign warnings', () => {
  it('runs injectScript LAST even when authored before body edits', () => {
    // 规则里 injectScript 写在 modifyRequestBody 之前，仍应看到已替换后的 body
    const result = applyReq('https://a.com', {}, 'hello world', [
      makeAction({ type: 'injectScript', value: "ctx.headers['x-seen-body'] = ctx.body;" }),
      makeAction({ type: 'modifyRequestBody', operate: 'replace', key: 'world', value: 'earth' }),
    ]);
    expect(result.body).toBe('hello earth');
    expect(result.headers['x-seen-body']).toBe('hello earth'); // 证明 inject 在 body 改写之后运行
  });

  it('injectScript can rewrite body and it clears content-length', () => {
    const result = applyReq('https://a.com', { 'content-length': '11' }, 'hello world', [
      makeAction({ type: 'injectScript', value: "ctx.body = ctx.body.toUpperCase();" }),
    ]);
    expect(result.body).toBe('HELLO WORLD');
    expect(result.headers['content-length']).toBeUndefined();
  });

  it('injectScript can replace the whole headers object', () => {
    const result = applyReq('https://a.com', { 'a': '1' }, 'x', [
      makeAction({ type: 'injectScript', value: "ctx.headers = { b: '2' };" }),
    ]);
    expect(result.headers).toEqual({ b: '2' }); // 旧键被清掉
  });

  it('warns when body changed + sign header present + no injectScript', () => {
    const result = applyReq('https://a.com', { 'X-Sign': 'old' }, 'body', [
      makeAction({ type: 'modifyRequestBody', operate: 'set', value: 'new' }),
    ]);
    expect(result.warnings && result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain('X-Sign');
  });

  it('does NOT warn when an injectScript is present (assumed to re-sign)', () => {
    const result = applyReq('https://a.com', { 'X-Sign': 'old' }, 'body', [
      makeAction({ type: 'modifyRequestBody', operate: 'set', value: 'new' }),
      makeAction({ type: 'injectScript', value: "ctx.headers['X-Sign'] = 'recomputed';" }),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.headers['X-Sign']).toBe('recomputed');
  });

  it('does NOT warn when body unchanged even if sign header present', () => {
    const result = applyReq('https://a.com', { 'X-Sign': 'old' }, 'body', [
      makeAction({ type: 'modifyRequestHeader', operate: 'set', key: 'X-Other', value: '1' }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('does NOT warn when body changed but no sign header (plain body edit — the user scenario)', () => {
    const result = applyReq('https://a.com', { 'Authorization': 'some-uuid-token' }, '观察', [
      makeAction({ type: 'modifyRequestBody', operate: 'replace', key: '观察', value: '观测' }),
    ]);
    expect(result.body).toBe('观测');
    expect(result.warnings).toEqual([]); // Authorization 是不透明 token，不应误报
  });
});
