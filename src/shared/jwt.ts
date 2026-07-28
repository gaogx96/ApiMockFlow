// JWT 工具：仅用于本地读取 token 的过期时间（exp），不做签名校验。
// 只有标准 JWT（三段式、payload 为 base64url JSON 且含 exp）才能解析；
// 不透明 token（opaque）无法本地判断过期，返回 null。

function base64UrlDecode(input: string): string | null {
  try {
    let s = input.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad) s += '='.repeat(4 - pad);
    const bin = atob(s);
    // 还原 UTF-8（payload 可能含非 ASCII 字符）
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 解析 JWT 的过期时间。
 * @returns 过期时间（毫秒时间戳），无法解析或非 JWT 时返回 null。
 */
export function parseJwtExpiry(token: string): number | null {
  if (!token) return null;
  let t = token.trim();
  // 去掉常见前缀，如 "Bearer eyJ..."、"JWT eyJ..."
  const sp = t.split(/\s+/);
  if (sp.length === 2 && /^(bearer|jwt|token)$/i.test(sp[0])) t = sp[1];

  const parts = t.split('.');
  if (parts.length !== 3) return null;

  const payload = base64UrlDecode(parts[1]);
  if (!payload) return null;
  try {
    const obj = JSON.parse(payload);
    if (typeof obj.exp === 'number' && isFinite(obj.exp)) return obj.exp * 1000;
  } catch {
    return null;
  }
  return null;
}

/** 把毫秒时长格式化为中文（如 "1 小时 5 分钟"）。取绝对值。 */
export function humanizeDuration(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000);
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} 小时` : `${h} 小时 ${m % 60} 分钟`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} 天` : `${d} 天 ${h % 24} 小时`;
}
