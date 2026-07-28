import { describe, it, expect } from 'vitest';
import { parseJwtExpiry, humanizeDuration } from '../shared/jwt';

// base64url 编码（Node 16+ 支持 'base64url'）
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
// 构造一个结构合法的 JWT（签名段随意，本地只读 payload 不验签）
function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.c2ln`;
}

describe('parseJwtExpiry', () => {
  it('解析标准 JWT 的 exp（秒 → 毫秒）', () => {
    const jwt = makeJwt({ sub: 'u1', exp: 1700000000 });
    expect(parseJwtExpiry(jwt)).toBe(1700000000 * 1000);
  });

  it('剥离 "Bearer " 前缀后再解析', () => {
    const jwt = makeJwt({ exp: 1700000000 });
    expect(parseJwtExpiry('Bearer ' + jwt)).toBe(1700000000 * 1000);
    expect(parseJwtExpiry('bearer ' + jwt)).toBe(1700000000 * 1000);
    expect(parseJwtExpiry('JWT ' + jwt)).toBe(1700000000 * 1000);
  });

  it('解析含非 ASCII 字符的 payload（UTF-8 还原）', () => {
    const jwt = makeJwt({ name: '张三', exp: 1699999999 });
    expect(parseJwtExpiry(jwt)).toBe(1699999999 * 1000);
  });

  it('空字符串返回 null', () => {
    expect(parseJwtExpiry('')).toBeNull();
  });

  it('不透明 token（非三段式）返回 null', () => {
    expect(parseJwtExpiry('abcdef123456')).toBeNull();
    expect(parseJwtExpiry('a.b')).toBeNull();
    expect(parseJwtExpiry('a.b.c.d')).toBeNull();
  });

  it('payload 不含 exp 返回 null', () => {
    expect(parseJwtExpiry(makeJwt({ sub: 'u1' }))).toBeNull();
  });

  it('exp 非数字返回 null', () => {
    expect(parseJwtExpiry(makeJwt({ exp: '1700000000' }))).toBeNull();
    expect(parseJwtExpiry(makeJwt({ exp: null }))).toBeNull();
  });

  it('exp 为 Infinity/NaN 返回 null', () => {
    // Infinity/NaN 经 JSON.stringify 会变成 null，isFinite 兜底
    const jwt = `${b64url({})}.${b64url({ exp: 1e999 })}.sig`;
    expect(parseJwtExpiry(jwt)).toBeNull();
  });

  it('payload 段非法 base64 返回 null', () => {
    expect(parseJwtExpiry('aaa.@@@invalid@@@.bbb')).toBeNull();
  });

  it('payload 非 JSON 返回 null', () => {
    const notJson = Buffer.from('not-json').toString('base64url');
    expect(parseJwtExpiry(`h.${notJson}.s`)).toBeNull();
  });

  it('带前缀但本体仍非 JWT 时返回 null', () => {
    expect(parseJwtExpiry('Bearer opaque-token')).toBeNull();
  });
});

describe('humanizeDuration', () => {
  it('秒级', () => {
    expect(humanizeDuration(0)).toBe('0 秒');
    expect(humanizeDuration(59_000)).toBe('59 秒');
    expect(humanizeDuration(999)).toBe('0 秒');
  });

  it('分钟级', () => {
    expect(humanizeDuration(60_000)).toBe('1 分钟');
    expect(humanizeDuration(59 * 60_000)).toBe('59 分钟');
  });

  it('整点小时不显示多余的 "0 分钟"（回归：曾错显 "1 小时 0 分钟"）', () => {
    expect(humanizeDuration(60 * 60_000)).toBe('1 小时');
    expect(humanizeDuration(2 * 60 * 60_000)).toBe('2 小时');
  });

  it('小时 + 分钟', () => {
    expect(humanizeDuration(90 * 60_000)).toBe('1 小时 30 分钟');
    expect(humanizeDuration(61 * 60_000)).toBe('1 小时 1 分钟');
  });

  it('整天不显示多余的 "0 小时"', () => {
    expect(humanizeDuration(24 * 60 * 60_000)).toBe('1 天');
    expect(humanizeDuration(2 * 24 * 60 * 60_000)).toBe('2 天');
  });

  it('天 + 小时', () => {
    expect(humanizeDuration(25 * 60 * 60_000)).toBe('1 天 1 小时');
  });

  it('取绝对值（已过期的负时长）', () => {
    expect(humanizeDuration(-60 * 60_000)).toBe('1 小时');
    expect(humanizeDuration(-90 * 60_000)).toBe('1 小时 30 分钟');
  });
});
