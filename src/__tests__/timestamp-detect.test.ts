import { describe, it, expect } from 'vitest';
import { detectTimestamps, applyTimestamps } from '../shared/timestamp-detect';
import { ApiRequest } from '../shared/api-types';

function req(partial: Partial<ApiRequest>): ApiRequest {
  return { method: 'GET', url: '', headers: {}, bodyType: 'raw', ...partial };
}

describe('detectTimestamps', () => {
  it('识别 URL query 中的 10 位秒级时间戳', () => {
    const c = detectTimestamps(req({ url: 'https://x.test/api?ts=1700000000&id=abc' }));
    expect(c).toHaveLength(1);
    expect(c[0].original).toBe('1700000000');
    expect(c[0].token).toBe('{{$ts}}');
    expect(c[0].loc.kind).toBe('url');
  });

  it('识别 13 位毫秒级时间戳', () => {
    const c = detectTimestamps(req({ url: 'https://x.test/api?t=1700000000000' }));
    expect(c).toHaveLength(1);
    expect(c[0].token).toBe('{{$tsMs}}');
  });

  it('识别带时区的 ISO8601', () => {
    const c = detectTimestamps(req({ body: '{"time":"2021-11-14T22:13:20Z"}' }));
    expect(c).toHaveLength(1);
    expect(c[0].token).toBe('{{$isoTs}}');
    expect(c[0].original).toBe('2021-11-14T22:13:20Z');
  });

  it('识别请求头值中的时间戳', () => {
    const c = detectTimestamps(req({ headers: { 'X-Timestamp': '1700000000' } }));
    expect(c).toHaveLength(1);
    expect(c[0].loc).toEqual({ kind: 'header', name: 'X-Timestamp' });
  });

  it('跳过 Authorization/Cookie 等敏感请求头', () => {
    const c = detectTimestamps(req({
      headers: { Authorization: 'Bearer 1700000000', Cookie: 'sid=1700000000' },
    }));
    expect(c).toHaveLength(0);
  });

  it('跳过 query 中签名/令牌类敏感键', () => {
    const c = detectTimestamps(req({ url: 'https://x.test/api?sign=1700000000&token=1700000001' }));
    expect(c).toHaveLength(0);
  });

  it('不误伤 JWT 段内数字', () => {
    const jwt = 'eyJhbGc1700000000eyJzdWIi.abc';
    const c = detectTimestamps(req({ body: jwt }));
    expect(c).toHaveLength(0);
  });

  it('不误伤 11 位手机号 / 更长数字串', () => {
    const c = detectTimestamps(req({ url: 'https://x.test/u?phone=13800000000&big=170000000000000' }));
    expect(c).toHaveLength(0);
  });

  it('不误伤小数中的数字', () => {
    const c = detectTimestamps(req({ body: '{"v":1700000000.5}' }));
    expect(c).toHaveLength(0);
  });

  it('范围外的 10 位数不计入（如过大）', () => {
    const c = detectTimestamps(req({ url: 'https://x.test/?n=9999999999' }));
    expect(c).toHaveLength(0);
  });

  it('多个候选各自独立', () => {
    const c = detectTimestamps(req({
      url: 'https://x.test/api?ts=1700000000',
      headers: { 'X-Ts': '1700000001' },
      body: '{"created":"2021-11-14T22:13:20Z"}',
    }));
    expect(c).toHaveLength(3);
  });
});

describe('applyTimestamps', () => {
  it('替换选中候选为占位符，保留其余文本', () => {
    const r = req({ url: 'https://x.test/api?ts=1700000000&id=abc' });
    const c = detectTimestamps(r);
    const out = applyTimestamps(r, c, new Set(c.map((x) => x.id)));
    expect(out.url).toBe('https://x.test/api?ts={{$ts}}&id=abc');
  });

  it('未选中的候选保持原样', () => {
    const r = req({ url: 'https://x.test/api?a=1700000000&b=1700000001' });
    const c = detectTimestamps(r);
    const out = applyTimestamps(r, c, new Set([c[0].id]));
    // 仅第一个被替换
    expect(out.url).toBe('https://x.test/api?a={{$ts}}&b=1700000001');
  });

  it('同字段多候选按下标从后往前替换不错位', () => {
    const r = req({ body: '{"a":1700000000,"b":1700000001}' });
    const c = detectTimestamps(r);
    const out = applyTimestamps(r, c, new Set(c.map((x) => x.id)));
    expect(out.body).toBe('{"a":{{$ts}},"b":{{$ts}}}');
  });

  it('替换请求头值', () => {
    const r = req({ headers: { 'X-Ts': 'v=1700000000' } });
    const c = detectTimestamps(r);
    const out = applyTimestamps(r, c, new Set(c.map((x) => x.id)));
    expect(out.headers['X-Ts']).toBe('v={{$ts}}');
  });

  it('空选择返回原请求', () => {
    const r = req({ url: 'https://x.test/api?ts=1700000000' });
    const c = detectTimestamps(r);
    const out = applyTimestamps(r, c, new Set());
    expect(out).toBe(r);
  });

  it('不修改原对象', () => {
    const r = req({ url: 'https://x.test/api?ts=1700000000' });
    const c = detectTimestamps(r);
    applyTimestamps(r, c, new Set(c.map((x) => x.id)));
    expect(r.url).toBe('https://x.test/api?ts=1700000000');
  });
});
