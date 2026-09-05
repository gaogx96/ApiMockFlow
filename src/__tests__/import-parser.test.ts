import { describe, it, expect } from 'vitest';
import {
  detectFormat, parseCurl, parseHttpie, parseOpenAPI, parseImport, parseMultipartBody,
} from '../shared/import-parser';

// ============================================================
// detectFormat
// ============================================================
describe('detectFormat', () => {
  it('识别 curl', () => {
    expect(detectFormat('curl https://a.com')).toBe('curl');
    expect(detectFormat('  CURL -X POST https://a.com')).toBe('curl');
  });

  it('识别带 method 的 httpie', () => {
    expect(detectFormat('GET https://a.com/x')).toBe('httpie');
    expect(detectFormat('post https://a.com')).toBe('httpie');
  });

  it('识别 openapi（openapi: 3. 头）', () => {
    expect(detectFormat('openapi: 3.0.1\npaths:')).toBe('openapi');
  });

  it('识别 openapi（JSON 含 paths + responses）', () => {
    expect(detectFormat('{"paths": {"/x": {}}, "responses": {}}')).toBe('openapi');
  });

  it('无法识别的输入 → unknown', () => {
    expect(detectFormat('hello world')).toBe('unknown');
    expect(detectFormat('')).toBe('unknown');
  });
});

// ============================================================
// parseCurl
// ============================================================
describe('parseCurl', () => {
  it('解析 multipart raw body 为字段数组', () => {
    const boundary = '----TestBoundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n2020482\r\n--${boundary}\r\nContent-Disposition: form-data; name="empty"\r\n\r\n\r\n--${boundary}--\r\n`;
    expect(parseMultipartBody(body, `multipart/form-data; boundary=${boundary}`)).toEqual([
      { name: 'id', value: '2020482' },
      { name: 'empty', value: '' },
    ]);
  });

  it('裸 URL，默认 GET', () => {
    const r = parseCurl('curl https://api.example.com/users');
    expect(r.method).toBe('GET');
    expect(r.url).toBe('https://api.example.com/users');
  });

  it('-X 指定 method（大写归一）', () => {
    expect(parseCurl('curl -X post https://a.com').method).toBe('POST');
    expect(parseCurl('curl --request delete https://a.com').method).toBe('DELETE');
  });

  it('-H / --header 解析请求头', () => {
    const r = parseCurl('curl https://a.com -H "Content-Type: application/json" -H "Authorization: Bearer xyz"');
    expect(r.headers['Content-Type']).toBe('application/json');
    expect(r.headers['Authorization']).toBe('Bearer xyz');
  });

  it('-d 带 body 且无显式 method 时自动置 POST', () => {
    const r = parseCurl(`curl https://a.com -d '{"a":1}'`);
    expect(r.method).toBe('POST');
    expect(r.body).toBe('{"a":1}');
  });

  it('-d 不覆盖已显式指定的 method', () => {
    const r = parseCurl(`curl -X PUT https://a.com -d 'x=1'`);
    expect(r.method).toBe('PUT');
    expect(r.body).toBe('x=1');
  });

  it('--data-raw / --data-binary 作为 body', () => {
    expect(parseCurl(`curl https://a.com --data-raw 'raw'`).body).toBe('raw');
    expect(parseCurl(`curl https://a.com --data-binary 'bin'`).body).toBe('bin');
  });

  it('-F 文件字段标记为不支持，避免静默当作文本重放', () => {
    const r = parseCurl(`curl https://a.com -F 'file=@C:/tmp/demo.png' -F 'name=test'`);
    expect(r.bodyType).toBe('multipart');
    expect(r.unsupported?.[0]).toContain('文件字段 file');
  });

  it('--data=value 紧凑形式', () => {
    const r = parseCurl('curl https://a.com --data=hello');
    expect(r.body).toBe('hello');
    expect(r.method).toBe('POST');
  });

  it('--data-urlencode（带空格）设置 bodyType=urlencoded', () => {
    const r = parseCurl(`curl https://a.com --data-urlencode 'q=hello'`);
    expect(r.body).toBe('q=hello');
    expect(r.bodyType).toBe('urlencoded');
    expect(r.method).toBe('POST');
  });

  it('-b / --cookie 写入 Cookie 头', () => {
    expect(parseCurl(`curl https://a.com -b 'sid=abc'`).headers['Cookie']).toBe('sid=abc');
    expect(parseCurl(`curl https://a.com --cookie 'sid=abc'`).headers['Cookie']).toBe('sid=abc');
  });

  it('-b 紧凑形式（无空格）', () => {
    expect(parseCurl('curl https://a.com -bsid=abc').headers['Cookie']).toBe('sid=abc');
  });

  it('--url 显式 URL', () => {
    expect(parseCurl('curl --url https://a.com/api').url).toBe('https://a.com/api');
  });

  it('跳过 --compressed 及带值 flag（--max-time / -o）不误当 URL/body', () => {
    const r = parseCurl('curl --compressed --max-time 30 -o out.txt https://a.com/real');
    expect(r.url).toBe('https://a.com/real');
    expect(r.body).toBeUndefined();
  });

  it('多行（反斜杠续行）', () => {
    const r = parseCurl('curl https://a.com \\\n  -X POST \\\n  -H "X-K: v"');
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://a.com');
    expect(r.headers['X-K']).toBe('v');
  });

  it('去除 URL 两端残留引号', () => {
    expect(parseCurl(`curl "https://a.com/x"`).url).toBe('https://a.com/x');
  });

  it('无冒号的 header 值被忽略（不产生空键）', () => {
    const r = parseCurl('curl https://a.com -H "MalformedHeader"');
    expect(Object.keys(r.headers)).toHaveLength(0);
  });
});

// ============================================================
// parseHttpie
// ============================================================
describe('parseHttpie', () => {
  it('提取 method 与 URL', () => {
    const r = parseHttpie('GET https://api.example.com/users');
    expect(r.method).toBe('GET');
    expect(r.url).toBe('https://api.example.com/users');
  });

  it('默认 method 为 GET（无显式 method）', () => {
    const r = parseHttpie('https://a.com/x');
    expect(r.method).toBe('GET');
    expect(r.url).toBe('https://a.com/x');
  });

  it('解析 Key:Value 请求头，且不把 method/URL 当 header', () => {
    const r = parseHttpie('POST https://api.example.com/login X-Api-Key:secret');
    expect(r.method).toBe('POST');
    expect(r.url).toBe('https://api.example.com/login');
    expect(r.headers['X-Api-Key']).toBe('secret');
    expect(r.headers['POST']).toBeUndefined();
    expect(Object.keys(r.headers).some(k => /^https?/i.test(k))).toBe(false);
  });

  it(':= 提取 body', () => {
    const r = parseHttpie('POST https://a.com/x role:=admin');
    expect(r.body).toBe('admin');
  });
});

// ============================================================
// parseOpenAPI
// ============================================================
describe('parseOpenAPI', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/users': {
        get: {
          summary: '获取用户列表',
          parameters: [
            { name: 'page', in: 'query', example: 2 },
            { name: 'X-Trace', in: 'header', example: 't123' },
          ],
          responses: { '200': {} },
        },
        post: {
          requestBody: {
            content: { 'application/json': { example: { name: 'a' } } },
          },
          responses: { '201': {} },
        },
      },
      '/items/{id}': {
        put: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
                },
              },
            },
          },
          responses: { '200': {} },
        },
      },
    },
  });

  it('无效 JSON → 空数组', () => {
    expect(parseOpenAPI('{not json')).toEqual([]);
  });

  it('无 paths → 空数组', () => {
    expect(parseOpenAPI('{"openapi":"3.0.0"}')).toEqual([]);
  });

  it('展开每个 path × method，拼接 baseUrl', () => {
    const reqs = parseOpenAPI(spec);
    // GET /users, POST /users, PUT /items/{id}
    expect(reqs).toHaveLength(3);
    const get = reqs.find(r => r.method === 'GET')!;
    expect(get.url).toBe('https://api.example.com/v1/users?page=2');
    expect(get.headers['X-Trace']).toBe('t123');
    expect(get.headers['x-summary']).toBe('获取用户列表');
  });

  it('requestBody.example 生成 body + Content-Type', () => {
    const post = parseOpenAPI(spec).find(r => r.method === 'POST')!;
    expect(post.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(post.body!)).toEqual({ name: 'a' });
  });

  it('无 example 时按 schema 生成示例 body', () => {
    const put = parseOpenAPI(spec).find(r => r.method === 'PUT')!;
    expect(JSON.parse(put.body!)).toEqual({ id: 0, tags: ['string'] });
  });

  it('忽略非 HTTP 方法的键（如 parameters/summary 挂在 path 级）', () => {
    const s = JSON.stringify({
      paths: { '/x': { get: { responses: {} }, summary: 'ignore-me', parameters: [] } },
    });
    const reqs = parseOpenAPI(s);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].method).toBe('GET');
  });
});

// ============================================================
// parseImport（分发器）
// ============================================================
describe('parseImport', () => {
  it('curl → 单个请求', () => {
    const { format, requests } = parseImport('curl https://a.com');
    expect(format).toBe('curl');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://a.com');
  });

  it('httpie → 单个请求', () => {
    const { format, requests } = parseImport('GET https://a.com/x');
    expect(format).toBe('httpie');
    expect(requests[0].method).toBe('GET');
  });

  it('openapi → 多个请求', () => {
    const spec = JSON.stringify({
      openapi: '3.0.0',
      paths: { '/a': { get: { responses: {} } }, '/b': { post: { responses: {} } } },
    });
    const { format, requests } = parseImport(spec);
    expect(format).toBe('openapi');
    expect(requests).toHaveLength(2);
  });

  it('无法识别 → 空结果', () => {
    const { format, requests } = parseImport('random text');
    expect(format).toBe('unknown');
    expect(requests).toHaveLength(0);
  });
});
