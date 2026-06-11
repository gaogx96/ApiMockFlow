import { ApiRequest } from './api-types';

export type ImportFormat = 'curl' | 'httpie' | 'openapi' | 'unknown';

export function detectFormat(input: string): ImportFormat {
  const t = input.trim();
  if (/^curl\s/i.test(t)) return 'curl';
  if (/^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+https?:\/\//i.test(t)) return 'httpie';
  if (/^https?:\/\//i.test(t) && /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/i.test(t)) return 'httpie';
  if (/\bopenapi\s*:\s*["']?3\./i.test(t) || (/\b"paths"\s*:/.test(t) && /\b"responses"\s*:/.test(t))) return 'openapi';
  return 'unknown';
}

// Tokenize a cURL command: split into tokens handling quotes and escapes
function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === "'" || s[i] === '"') {
      const quote = s[i]; i++;
      let t = '';
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < s.length && s[i + 1] === quote) { t += quote; i += 2; }
        else { t += s[i]; i++; }
      }
      i++; // skip closing quote
      tokens.push(t);
    } else if (s[i] === '\\' && i + 1 < s.length) {
      i++;
      let t = '';
      while (i < s.length && !/\s/.test(s[i])) { t += s[i]; i++; }
      tokens.push(t);
    } else {
      let t = '';
      while (i < s.length && !/\s/.test(s[i])) { t += s[i]; i++; }
      tokens.push(t);
    }
  }
  return tokens;
}

export function parseCurl(input: string): ApiRequest {
  const result: ApiRequest = { method: 'GET', url: '', headers: {}, bodyType: 'raw' };
  let s = input.replace(/\\\n/g, ' ').trim();

  // Remove leading "curl "
  s = s.replace(/^curl\s+/i, '');

  const tokens = tokenize(s);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // Method: -X / --request
    if ((t === '-X' || t === '--request') && i + 1 < tokens.length) {
      result.method = tokens[++i].toUpperCase();
      continue;
    }

    // Header: -H / --header
    if ((t === '-H' || t === '--header') && i + 1 < tokens.length) {
      const hv = tokens[++i];
      const sepIdx = hv.indexOf(':');
      if (sepIdx > 0) {
        result.headers[hv.slice(0, sepIdx).trim()] = hv.slice(sepIdx + 1).trim();
      }
      continue;
    }

    // Body: -d / --data / --data-raw / --data-binary
    // Also handle compact form: -dfoo=bar (without space)
    if ((t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') && i + 1 < tokens.length) {
      result.body = tokens[++i];
      if (!result.method || result.method === 'GET') result.method = 'POST';
      continue;
    }
    if (/^-d(?!elete$)(.+)/.test(t) && t.length > 2) {
      result.body = t.slice(2);
      if (!result.method || result.method === 'GET') result.method = 'POST';
      continue;
    }
    // Handle --data=value / --data-raw=value compact form
    if (/^--data(?:-raw|-binary|-urlencode)?=(.+)/i.test(t)) {
      result.body = t.substring(t.indexOf('=') + 1);
      if (!result.method || result.method === 'GET') result.method = 'POST';
      continue;
    }

    // URL encoded body: --data-urlencode
    if (t === '--data-urlencode' && i + 1 < tokens.length) {
      result.body = tokens[++i];
      result.bodyType = 'urlencoded';
      if (!result.method || result.method === 'GET') result.method = 'POST';
      continue;
    }

    // Cookie: -b / --cookie
    if ((t === '-b' || t === '--cookie') && i + 1 < tokens.length) {
      result.headers['Cookie'] = tokens[++i];
      continue;
    }
    // Compact: -b<value> (no space)
    if (/^-b(.+)/.test(t) && t.length > 2) {
      result.headers['Cookie'] = t.slice(2);
      continue;
    }

    // Compressed
    if (t === '--compressed') continue;

    // Connect timeout, max-time, etc — skip flag + value
    if (/^--?(?:connect-timeout|max-time|retry|user|proxy|referer|user-agent|output|silent|location|insecure|include|head|verbose|fail|show-error|http\d)/i.test(t)) {
      if (!/^--?(?:silent|location|insecure|include|head|verbose|fail|show-error|compressed)$/i.test(t)) i++; // skip value
      continue;
    }

    // URL: bare URL or -url / --url
    if (t === '--url' && i + 1 < tokens.length) {
      result.url = tokens[++i];
      continue;
    }

    // Bare URL (first https?:// token, or first bare token after curl)
    if (/^https?:\/\//i.test(t) && !result.url) {
      result.url = t;
      continue;
    }
  }

  // If no URL found by token scan, try regex on original input
  if (!result.url) {
    const m = s.match(/['"]?(https?:\/\/[^\s'"]+)['"]?/i);
    if (m) result.url = m[1];
  }

  // Clean URL
  result.url = (result.url || '').replace(/^['"]|['"]$/g, '');

  return result;
}

export function parseHttpie(input: string): ApiRequest {
  const result: ApiRequest = { method: 'GET', url: '', headers: {}, bodyType: 'raw' };
  const t = input.trim();

  const methodMatch = t.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+/i);
  if (methodMatch) result.method = methodMatch[1].toUpperCase();

  const urlMatch = t.match(/https?:\/\/\S+/i);
  if (urlMatch) result.url = urlMatch[0];

  // Headers: Key:Value
  const hdrRe = /([\w-]+):\s*(\S+)/g;
  let hm: RegExpExecArray | null;
  while ((hm = hdrRe.exec(t)) !== null) {
    const k = hm[1], v = hm[2];
    if (!/^https?:/i.test(k) && !/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i.test(k)) {
      result.headers[k] = v;
    }
  }

  // Body: := or raw JSON after a space
  const bodyIdx = t.indexOf(':=');
  if (bodyIdx >= 0) {
    result.body = t.slice(bodyIdx + 2).trim();
  }

  return result;
}

export function parseOpenAPI(input: string): ApiRequest[] {
  const requests: ApiRequest[] = [];
  let spec: any;
  try { spec = JSON.parse(input); } catch { return []; }
  if (!spec.paths) return [];

  const baseUrl = (spec.servers && spec.servers[0] && spec.servers[0].url) || '';

  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, detail] of Object.entries(methods as Record<string, any>)) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(method)) continue;
      const req: ApiRequest = {
        method: method.toUpperCase(),
        url: baseUrl + path,
        headers: {},
        bodyType: 'raw',
      };
      if (detail.parameters) {
        const qp = (detail.parameters as any[]).filter((p: any) => p.in === 'query');
        if (qp.length > 0) {
          const params = qp.map((p: any) => `${p.name}=${p.example || ''}`).join('&');
          req.url += '?' + params;
        }
        const hdrs = (detail.parameters as any[]).filter((p: any) => p.in === 'header');
        hdrs.forEach((h: any) => { req.headers[h.name] = h.example || ''; });
      }
      if (detail.requestBody?.content?.['application/json']?.example) {
        req.body = JSON.stringify(detail.requestBody.content['application/json'].example, null, 2);
        req.headers['Content-Type'] = 'application/json';
      } else if (detail.requestBody?.content?.['application/json']?.schema) {
        // Generate example from schema
        req.body = JSON.stringify(generateExample(detail.requestBody.content['application/json'].schema), null, 2);
        req.headers['Content-Type'] = 'application/json';
      }
      if (detail.summary) req.headers['x-summary'] = detail.summary;
      requests.push(req);
    }
  }

  return requests;
}

function generateExample(schema: any): any {
  if (!schema) return {};
  if (schema.example !== undefined) return schema.example;
  switch (schema.type) {
    case 'object': {
      const obj: any = {};
      if (schema.properties) {
        for (const [k, v] of Object.entries(schema.properties)) {
          obj[k] = generateExample(v);
        }
      }
      return obj;
    }
    case 'array': return schema.items ? [generateExample(schema.items)] : [];
    case 'string': return schema.enum?.[0] || 'string';
    case 'integer':
    case 'number': return schema.enum?.[0] || 0;
    case 'boolean': return false;
    default: return null;
  }
}

export function parseImport(input: string): { format: ImportFormat; requests: ApiRequest[] } {
  const format = detectFormat(input);
  switch (format) {
    case 'curl': return { format, requests: [parseCurl(input)] };
    case 'httpie': return { format, requests: [parseHttpie(input)] };
    case 'openapi': return { format, requests: parseOpenAPI(input) };
    default: return { format: 'unknown', requests: [] };
  }
}
