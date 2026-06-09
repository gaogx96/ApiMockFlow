# ApiMockFlow 安全审计与优化报告

> 项目: ApiMockFlow (API 拦截、Mock 与测试浏览器插件)
> 技术栈: React 19 + TypeScript + Vite + Manifest V3 + TailwindCSS
> 审计日期: 2026-06-06

---

## 一、安全漏洞分析

### [高危] 1. 正则表达式 DoS (Regular Expression Denial of Service)

**文件**: `public/interceptor.js` (第 15, 30, 68, 81 行)
**文件**: `src/background/index.ts` (第 41 行)

用户可通过规则编辑器输入恶意正则（如 `(a+)+$`）导致 ReDoS 攻击。虽然 `safeRe()` 做了 try-catch，但正常正则仍可能触发回溯爆炸，冻结浏览器主线程。

**影响**: 攻击者可构造正则导致标签页卡死，影响用户体验。

**修复建议**: 引入 `safe-regex` 或 `xregexp` 限制正则复杂度，或在正则执行时设置超时。

---

### [高危] 2. `postMessage` 无来源验证 (Cross-origin Message Injection)

**文件**: `public/interceptor.js` (第 146 行)
**文件**: `src/content/index.ts` (第 21, 69 行)

```javascript
// interceptor.js - 没有任何来源检查
window.addEventListener('message', function (e) {
  if (!e.data) return;
  if (e.data.type === 'APII_SYNC') { ... }  // 直接处理！
});

// content/index.ts - 同样无来源检查
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'APII_RCOUNT') { ... }
  if (e.data && e.data.type === 'APII_READY') { ... }
});
```

任何第三方网站（恶意页面）都可以通过 `window.postMessage({type: 'APII_SYNC', ...})` 向 interceptor.js 注入假规则数据，实现：
- 劫持目标网站的 API 请求
- 篡改响应数据窃取敏感信息
- 将请求重定向到恶意服务器

**修复建议**: 在 `postMessage` 回调中添加来源验证：

```javascript
window.addEventListener('message', function (e) {
  if (e.source !== window) return;  // 只接受同一窗口的消息
  // 或验证 origin: if (!e.origin.startsWith('chrome-extension://')) return;
});
```

---

### [高危] 3. `chrome.storage.local` 导入规则无 JSON Schema 校验

**文件**: `src/background/index.ts` (第 131-142 行)

```typescript
if (t === 'IMPORT_RULES') {
  try {
    const d = JSON.parse(msg.payload);
    // 直接存储，无 schema 验证
    if (d.rules && Array.isArray(d.rules)) ps.push(storageSet('rules', d.rules));
```

导入的 JSON 未经任何格式校验。恶意导入数据可包含：
- 超大正则表达式（触发 ReDoS，见漏洞 #1）
- 海量规则条目（耗尽 chrome.storage 配额，默认 5MB）
- 构造的 `match: {url: '', matchType: 'regex'}` 等异常数据

**修复建议**: 导入时做 schema 校验，限制规则数量、正则长度、正则复杂度。

---

### [中危] 4. `fetch` 代理可被用于 SSRF

**文件**: `src/background/index.ts` (第 144-164 行)

```typescript
if (t === 'API_TEST_REQUEST') {
  const { method, url, headers, body } = msg.payload;
  fetch(url, init).then(async (resp) => { ... });
```

这是 API Tester 功能的代理请求。虽然仅插件内部可调，但仍允许访问任意 URL（包括内网地址如 `http://192.168.1.1/`、`http://localhost:6379/`）。

**影响**: 恶意网站通过注入规则/请求触发此功能时，可探测内网服务。

**修复建议**: 限制可访问的域名白名单，排除私有 IP 段。

---

### [中危] 5. 敏感数据暴露于 `__API__` 调试对象

**文件**: `public/interceptor.js` (第 162 行)

```javascript
window.__API__ = {
  test: function () { return 'OK'; },
  count: function () { return _reqCount; },
  active: function () { return ACTIVE; },
  fetch: function () { return window.fetch === interceptedFetch; }
};
```

所有页面的 JS 上下文均可访问 `window.__API__`，可探测插件是否启用、请求计数等。生产环境应移除此调试对象。

---

### [中危] 6. XHR 拦截器中的临时 XHR 泄露

**文件**: `public/interceptor.js` (第 116 行)

```javascript
var px = new NATIVE_XHR();
px.open(om, rm.url, true);
// ...
px.send(rm.body !== undefined ? rm.body : body);
```

重定向场景下创建了临时 XHR 对象但从未关闭/清理。在高频率请求场景下可能导致内存泄漏。

---

### [低危] 7. `confirm()` 阻塞主线程

**文件**: `src/popup/pages/RuleList.tsx` (第 30 行)

```typescript
if (!confirm('确定删除此规则？')) return;
```

阻塞用户界面。建议使用自定义确认对话框。

---

### [低危] 8. `chrome.storage` 回调嵌套过深 (Callback Hell)

**文件**: `src/background/index.ts` 全文

整个文件几乎全是回调嵌套，代码可读性和可维护性差。深层嵌套也增加了遗漏 `return true` 导致异步消息响应丢失的风险。

---

## 二、代码质量问题

### 1. Content Script 中 TypeScript 代码未转换

**文件**: `src/content/index.ts`

Content Script 使用了 `chrome.runtime.lastError`（TypeScript 类型 `any`）和 `setInterval` 返回值赋值给 `var` 类型。虽然编译能通过（`@types/chrome` 提供声明），但 `var` 和 `any` 的使用降低了类型安全性。

### 2. `generateId()` 碰撞风险

**文件**: `src/shared/constants.ts`

```typescript
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
```

- 仅 13 位随机字符 + 时间戳
- `Math.random()` 非加密安全
- 高并发（tab 同时操作）时可能碰撞
- 建议在 `Date.now()` 后追加随机数位数

### 3. 硬编码字符串过多

多处使用魔术字符串：
- `src/content/index.ts`: `'APII_RCOUNT'`, `'APII_SYNC'`, `'APII_READY'`
- `src/background/index.ts`: 15+ 种消息类型

应集中定义为常量，便于维护。

### 4. `vite.config.ts` 构建后操作不可靠

**文件**: `vite.config.ts` (第 8-18 行)

```typescript
writeBundle() {
  const src = resolve(__dirname, 'dist/src/popup/index.html');
  const dst = resolve(__dirname, 'dist/popup.html');
  if (existsSync(src)) {
    renameSync(src, dst);
```

使用 `renameSync` 在 `writeBundle` 中移动文件。这在多入口构建时可能竞态，且 `rmdirSync` 可能删除未清理的目录。建议改用 `rollupOptions.output.dir` 直接指定输出路径。

### 5. `minify: false` 生产未压缩

**文件**: `vite.config.ts` (第 42 行)

```typescript
minify: false,
```

即使生产构建也未启用压缩。应改为 `minify: 'terser'` 或至少 `'esbuild'`，可将体积减少 60-70%。

---

## 三、性能优化点

### 1. Content Script 同步轮询效率低

**文件**: `src/content/index.ts` (第 76 行)

```typescript
syncTimer = setInterval(syncAll, 1500);
```

每 1.5 秒向 background 发送一次消息获取全部状态。应在规则变更时通过 `chrome.storage.onChanged` 事件驱动同步，而非定时轮询。

### 2. Background 每次规则匹配都读取全部规则

**文件**: `src/background/index.ts` (第 47-58 行)

```typescript
async function getMatching(url, method, rtype) {
  const [rules, rawGroups] = await Promise.all([
    storageGet<Rule[]>('rules', []),
    storageGet<RuleGroup[]>('groups', [])
  ]);
```

每次 fetch/XHR 请求都要读取 storage 并遍历所有规则做匹配。规则多时性能差。

**建议**:
- 将规则缓存到 background 的内存变量中
- 使用 `chrome.storage.onChanged` 更新缓存
- 对正则匹配规则做预编译（RegExp 对象复用）

### 3. Interceptor.js 中正则表达式重复编译

**文件**: `public/interceptor.js` 多处

每条规则每次匹配都会执行 `new RegExp(ruleUrl)` 编译。建议：
- 在收到 SYNC 消息时对正则规则预编译
- 缓存编译后的正则对象

### 4. XHR 拦截器逻辑过于复杂

**文件**: `public/interceptor.js` (第 96-119 行)

`send()` 方法的 patch 包含 30+ 行的内联逻辑，可读性极差且难以维护。建议拆分为独立函数。

---

## 四、Manifest V3 合规性

### 1. `host_permissions: ["<all_urls>"]` 过于宽泛

Chrome Web Store 审核可能拒绝此权限。建议精确列出需要的 URL 模式，或使用 `permissions: ["webRequest"]` 替代部分功能。

### 2. 缺少 `content_security_policy`

V3 推荐使用 `content_security_policy` 限制内联脚本。当前未设置 CSP，建议添加。

### 3. README 与实际文件结构不一致

README 中提到了 `LogViewer.tsx`，但项目中没有此文件。README 结构与实际不符。

---

## 五、建议优化优先级

| 优先级 | 问题 | 类别 | 建议动作 |
|--------|------|------|----------|
| P0 | postMessage 无来源验证 | 安全 | 添加 `e.source !== window` 检查 |
| P0 | 正则 DoS | 安全 | 限制正则复杂度，预编译缓存 |
| P1 | 导入规则无 schema 校验 | 安全 | 添加 JSON Schema 验证 |
| P1 | fetch 代理 SSRF | 安全 | 域名白名单过滤 |
| P2 | 定时轮询改为事件驱动 | 性能 | 使用 `chrome.storage.onChanged` |
| P2 | Background 规则内存缓存 | 性能 | 避免每次匹配读 storage |
| P2 | 启用生产 minify | 性能 | `minify: 'esbuild'` |
| P3 | 正则预编译缓存 | 性能 | interceptor.js 预编译 |
| P3 | 移除调试对象 `__API__` | 安全 | 生产构建移除 |
| P3 | README 同步 | 文档 | 更新与实际代码一致 |

---

## 六、总结

ApiMockFlow 是一个设计良好的 API 拦截/测试工具，架构思路（main-world interceptor 绕过 extension context 限制）很聪明。主要风险集中在 **postMessage 来源验证缺失** 和 **正则表达式安全性** 两个方面，需要在发布前修复。性能上，将 storage 读取代为内存缓存 + 事件驱动，可在规则数量增长时保持响应速度。
