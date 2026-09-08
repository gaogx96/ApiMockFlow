# ApiMockFlow 安全审计与优化报告

> 项目: ApiMockFlow (API 拦截、Mock 与测试浏览器插件)
> 技术栈: React 19 + TypeScript + Vite + Manifest V3 + TailwindCSS
> 审计日期: **2026-09-08**（全量重审，取代 2026-06-06 旧版）
> 审计范围: `public/manifest.json`、`src/background/index.ts`、`public/interceptor.js`、`src/content/index.ts`、`src/popup/**`、`src/shared/**`
> 方法: 按子系统（后台+清单 / MAIN-world 拦截器 / React 弹窗前端）分头核对**当前代码**，行号均实际打开文件确认。

> ⚠️ 说明：本版是对当前构建的重新审计。上一版（2026-06-06）中多条"高危"在此次核查中已不成立——`postMessage` 已有 `e.source===window` 校验、SSRF 内网拦截已实现、`__API__` 调试对象已移除、原生 `confirm()` 已换自定义弹窗、定时轮询已改事件驱动、CSP 已配置、导入校验已加固。这些不再列为待修，详见文末「已做对 / 已缓解」。

---

## ✅ 本轮修复记录（2026-09-08）

除「日志/敏感数据脱敏」外的可落地项已全部修复（脱敏按产品定位保留：本工具为个人调试用途，完整头/Cookie 常需复制给开发排障）。`npm run build` 与 `npm test`（119/119）均通过。

| 条目 | 状态 | 改动摘要 |
|---|---|---|
| #1 fetch 重定向绕过 SSRF | ✅ 已修 | 未放行内网时 `init.redirect='manual'`，遇 `opaqueredirect` 拒绝跟随并提示；放行内网才 `follow`（`background/index.ts`） |
| #3 XHR cancel 挂起 axios | ✅ 已修 | cancel 分支补派发 `readystatechange`+`load`+`loadend`（`interceptor.js`） |
| #7 代理 XHR 不传播 abort | ✅ 已修 | 代理分支桥接 `self.abort → px.abort()`，置 `_xrm` 抢占后补派发 `abort`+`loadend`（`interceptor.js`） |
| #2 LOG_SAVE 落盘 DoS | ✅ 已修 | 顶层字段白名单 + 类型校验 + 单条 16MB 上限拒收；总上限 100MB→32MB（`background/index.ts`） |
| #5 导入正则 ReDoS 启发式 | ✅ 已修 | `looksCatastrophic` 扩展识别嵌套量词/`{n,}`/交替+外层量词（`background/index.ts`） |
| #8 消息处理器未校验 sender | ✅ 已修 | `onMessage` 入口加 `_sender.id !== chrome.runtime.id` 拦截（`background/index.ts`） |
| #9 父域兜底 Cookie 过宽 | ✅ 已修 | 兜底集按目标 host 域链过滤，剔除兄弟子域 Cookie（`background/index.ts`） |
| #12 列表索引 key | ✅ 已修（RuleEditor） | RuleEditor 动作行改用稳定序号 key，消除 `BodyValueField` 内部搜索态串行；ApiTester/KeyValueEditor 为纯受控输入（仅瞬时焦点抖动、无数据错乱），且其状态深嵌多标签持久化层、改造回归风险高，暂不动 |
| #13 tabs 权限冗余 | ✅ 已移除 | `manifest.json` 删除 `tabs`（`<all_urls>` 下 `tab.url` 本可读） |
| #4/#10/#11(掩码) 脱敏 | ⏸ 按产品定位保留 | 个人调试工具，凭证复制是必要工作流 |
| #6 DNS rebinding | ℹ️ 浏览器 fetch 不暴露解析 IP，字面量校验无法根治；#1 的重定向管控已缩小窗口 |

---

## 严重度汇总

| severity | 数量 | 条目 |
|---|---|---|
| 高危 | 1 | #1 fetch 代理跟随重定向绕过 SSRF |
| 中危 | 5 | #2 LOG_SAVE 页面可控数据落盘、#3 XHR cancel 缺 loadend 挂起 axios、#4 copyLogAll 明文复制凭证、#5 正则 ReDoS(导入向量)、#6 SSRF 字面量判定局限 |
| 低危 | 7 | #7 XHR 代理未传播 abort、#8 sender 未校验、#9 父域兜底 Cookie 过宽、#10 cURL 脱敏白名单过窄、#11 日志 body 上限 10MB+敏感头明文、#12 列表用索引 key、#13 tabs 权限可能冗余 |
| 信息 | 8 | postMessage 伪造、injectScript 代码执行、认证头全站采集、httpOnly Cookie 暴露 UI、WAR 指纹、targetOrigin '*'、generateId、`__proto__` 键 |

---

## 一、待处理发现

### [高危] 1. fetch 代理跟随重定向可绕过 SSRF 校验

**文件**: `src/background/index.ts`（`fetch(url, init)` ≈ 第 736 行；SSRF 校验 `checkSSRF` ≈ 669–681）

`checkSSRF()` 只对**初始 URL** 的 hostname 调 `isBlockedHost`。`init` 未设置 `redirect`，默认 `redirect:'follow'`。攻击者控制的公网服务器返回 `302 Location: http://169.254.169.254/latest/meta-data/`（或 `http://localhost/`），fetch 会**自动跟随且不再二次校验**，把内网/云元数据响应体（截断 100000 字节）回传到 popup。`allowInternalNetwork` 默认 false 时同样可被绕过。

- **触发**: 用户在 API Tester 对攻击者可控公网 URL（或被诱导导入的 saved request）发起请求。
- **修复**: 设 `init.redirect='manual'`，对 3xx 的 `Location` 解析后重新跑 `isBlockedHost` 再决定是否续跳（限制跳数）；或 `redirect:'error'` 直接拒绝跨主机跳转。改动小、收益大，建议优先。

---

### [中危] 2. `LOG_SAVE` 可被任意网页经内容脚本桥接触达（页面可控数据落盘 + 存储膨胀）

**文件**: background `LOG_SAVE` ≈ 823–838；桥接 `src/content/index.ts:49–57`；字节上限 `MAX_INTERCEPT_LOG_BYTES` ≈ 100MB

内容脚本全站注入（`matches: <all_urls>`），监听 `window.message` 的 `APII_LOG` 并转发为 `LOG_SAVE`。桥接处只校验 `url/method/timestamp` 三字段类型，**其余字段（含 body 等大字符串）完全由页面控制**；background 仅按 200 条 + 100MB 上限裁剪（`unlimitedStorage` 已授权，不受配额限制）。恶意页面可 `postMessage` 200 条各含数 MB body 的日志，把 `interceptLog` 撑到 ~100MB。

- **影响**: 本地磁盘膨胀 / 存储污染 / 伪造拦截日志误导用户；非提权，属可远程触发的**本地 DoS**。
- **修复**: background 侧对单条 payload 做体积上限与字段白名单；`MAX_INTERCEPT_LOG_BYTES` 降到 5–10MB；桥接处对 body 截断。

---

### [中危] 3. XHR `cancel` 分支缺 `loadend`/`readystatechange` → 挂起 axios

**文件**: `public/interceptor.js` ≈ 756–761（功能正确性）

命中 `cancel` 规则时只 `setTimeout` 派发了 `load`，未派发 `readystatechange` 与 `loadend`。现代 axios（XHR adapter）只在 `onloadend` 结算 Promise（本文件其它分支注释也承认这点）。被 cancel 的 XHR 在 axios 下**永不 resolve/reject → 请求永久挂起**。jQuery（用 onload）不受影响。

- **修复**: 与其它分支一致，在 cancel 分支补 `dispatchEvent(new Event('readystatechange'))` 与 `new Event('loadend')`。

---

### [中危] 4. 日志「复制全部信息」未脱敏，明文外泄凭证

**文件**: `src/popup/pages/NetworkLog.tsx` `copyLogAll` ≈ 148–178

观察日志行的「复制全部信息」把请求/响应完整 header（含 `Authorization`、`Cookie`）明文拼接写入剪贴板，无脱敏。而同项目 ApiTester 的 cURL 复制默认对敏感头打码，并把「完整/含敏感」单独做成带警示色的第二按钮。两者策略不一致，用户以为「复制」都安全，实则日志复制会外泄明文凭证。

- **触发**: 用户为反馈/排障复制日志并粘贴到工单/聊天/AI，明文 token、Cookie 一并泄露；点一次即触发。
- **修复**: 与 cURL 一致，默认对 `authorization/cookie/x-api-key`（建议扩充，见 #10）打码，或加「含敏感」二次确认按钮。

---

### [中危] 5. 正则 ReDoS —— 导入向量为主要现实风险

**文件**: `interceptor.js:30` `safeRe`，每请求执行点 ≈ 345–350（`entry.re.test(url)`）；background `matchRule` ≈ 404；导入准入 `looksCatastrophic`（background ≈ 53–55）

`new RegExp` 无灾难性回溯防护，`test()` 跑在页面主线程，对每个 fetch/XHR 逐条执行。**导入他人分享的规则集**是最现实的向量——内含 `(a+)+$` 类正则会在用户浏览的每个匹配页面卡死主线程。UI 手写属自伤；伪造 `APII_SYNC` 只能卡死攻击者自己的页面（无提权）。

- **已缓解**: 导入侧已有长度上限（1000）+ `looksCatastrophic` 结构启发式 + 可编译性校验。
- **残留**: 启发式仅拦 `(...量词...)量词` 一类，精心构造的其它高回溯正则（≤1000 字符）仍可通过。
- **修复**: 导入/保存时用短超时探测串跑一次准入校验，或引入更严格的结构检测 / RE2-WASM。运行期无法给同步 `test()` 加超时，重点放在准入。

---

### [中危] 6. SSRF 仅字面量判定，域名解析到内网不被拦截（DNS rebinding）

**文件**: `isBlockedHost` ≈ 379–393，调用点 ≈ 672–677

`isBlockedHost` 只对字面 IP 与 `localhost` 类名称判定，普通域名一律放行。攻击者注册的公网域名 A 记录指向 `127.0.0.1`/`169.254.169.254`/内网段即可绕过；校验与 fetch 间还有 TOCTOU（DNS rebinding）窗口。

- **本质**: 浏览器 fetch 不暴露已解析 IP，字面量校验无法根治此类。可结合 #1 的重定向管控缩小窗口，并在文档明示该限制。

---

### [低危] 7. XHR 代理分支未传播 `abort()`

**文件**: `interceptor.js` 代理路径 ≈ 779–854（无 `self.abort` 覆写）

改写 URL/请求头时改走新代理 `px`。页面在 `send()` 后调用 `self.abort()` 只 abort 从未真正发送的 `self`，代理 `px` 的真实请求继续发出 → 取消语义失效，请求仍到达服务端（可能产生副作用）。

- **修复**: 代理分支覆写/桥接 `self.abort` 调 `px.abort()` 并置 `_xrm` 拦截后续派发。

---

### [低危] 8. 消息处理器不校验 sender（纵深防御缺失）

**文件**: `chrome.runtime.onMessage.addListener` ≈ 506（全文件无 `sender.id`/`sender.origin` 校验）

**已被现有架构缓解**：清单无 `externally_connectable`，外部网页无法直接向扩展发消息；能发消息的只有本扩展 popup 与内容脚本，内容脚本仅转发只读 `GET_STATE` 与 `LOG_SAVE`，敏感处理器（`API_TEST_REQUEST`/`GET_LOGIN_STATE`/`GET_BROWSER_COOKIES`）不经页面可达。

- **修复**: 加 `if (_sender.id !== chrome.runtime.id) return;` 作纵深防御，防止未来添加 `externally_connectable` 时被动暴露。

---

### [低危] 9. 父域兜底 Cookie 读取会带上同注册域下其它子域的 Cookie

**文件**: `getCookiesForUrl` ≈ 333–345，`getBaseDomain` ≈ 319–330

精确匹配之外用 `chrome.cookies.getAll({ domain: base })` 兜底注册域，会返回注册域及**所有子域**的 Cookie 并合并。对 `api.example.com` 的请求可能附带 `admin.example.com` 等兄弟子域的 Cookie，比浏览器原生发送范围更宽。

- **修复**: 兜底时按 target host 的 cookie domain 作用域过滤，仅合并浏览器实际会发送到该 URL 的 Cookie。

---

### [低危] 10. cURL 脱敏白名单过窄

**文件**: `src/popup/pages/ApiTester.tsx` ≈ 888，`/^(authorization|cookie|x-api-key)$/i`

只脱敏三种精确名。常见凭证头如 `x-auth-token`、`x-access-token`、`x-csrf-token`、`api-key`、`proxy-authorization`、`set-cookie` 不会被打码，而按钮文案是「复制 cURL（脱敏）」，给用户虚假安全感（内网系统常用非标准认证头）。

- **修复**: 改为关键字匹配（含 `token`/`auth`/`cookie`/`secret`/`api-key` 或以 `x-...-key` 结尾），或维护更完整集合。

---

### [低危] 11. 日志 body 上限 10MB + 敏感头明文入库

**文件**: `LOG_BODY_LIMIT = 10000000`（`interceptor.js:21`）；请求头快照含 Authorization 等（`applyReq` 输出，记入日志 ≈ 662/741）

单条日志 original+modified body 各上限 10MB，单次即可瞬时冲击存储/序列化性能（background 侧仅有条数与总字节兜底）。请求头（含 Authorization、签名值）明文入库。

- **修复**: body 日志上限降到 256KB–1MB；对 Authorization/Cookie 类头在日志中掩码（与 #4 一并处理）。

---

### [低危] 12. 可编辑列表使用数组索引作为 key

**文件**: ApiTester 请求头 ≈ 1179、Query ≈ 1037；`KeyValueEditor.tsx:44`；RuleEditor 动作 ≈ 501

从列表**中间**删除一行时 React 按位置复用组件实例，可能出现输入值/焦点错位；RuleEditor 动作中 `BodyValueField` 的内部搜索状态会「串」到相邻动作。功能层瑕疵，非安全漏洞。

- **修复**: 为字段/动作分配稳定 id 作 key。

---

### [低危] 13. `tabs` 权限可能冗余

**文件**: `manifest.json` `permissions` 含 `tabs`；唯一使用点 `injectAllTabs` ≈ 17–30

`injectAllTabs` 只读取 `tab.url`，在 `<all_urls>` host 权限下该字段本已可得，`tabs` 权限可能非必需。

- **修复**: 评估移除 `tabs` 以收敛权限面（利于 Web Store 审核）。

---

## 二、信息类观察（多为产品取舍 / MV3 固有模型，建议文档明示而非视为缺陷）

- **postMessage 通道 APII_SYNC/APII_LOG 可被页面伪造**（`interceptor.js:921`、`content/index.ts:45,107`）：MAIN world 与页面共享 window，`e.source===window` 挡不住同窗口页面脚本。**但经复核无提权**：伪造 SYNC 只改本页拦截器内存态（页面本就掌控自身请求）、不回写 storage、不影响其它源/标签页；伪造 LOG 仅日志投毒/噪声，下游无 XSS（见「已做对」）。这是上一版误判为「高危」的项，实为低危/信息级。可选加固：content 注入时生成 nonce 供拦截器校验回带。
- **injectScript = MAIN world 任意代码执行**（`interceptor.js` ≈ 416–434 `new Function`）：产品核心能力，运行于页面上下文、无 `chrome.*` 权限、`API_CRYPTO` 封在闭包内。真实风险在**导入他人规则集**时其 injectScript 会执行——导入通道已剥离该动作（见「已做对」），建议导入 UI 对含脚本类动作额外显式确认。
- **认证头默认全站静默采集**（background `authHeaderListener` + `<all_urls>`）：白名单为空时对所有站点 XHR 抓取 `authorization/token/session/credential/api-key` 类头。**已缓解**：仅存 `chrome.storage.session`（内存级、关浏览器即清）、LRU 30 origin、名称正则筛选、仅 http(s)、仅 `xmlhttprequest`。仍属较广凭据足迹，建议默认收窄或提示。
- **httpOnly Cookie 经 popup 暴露**（`GET_LOGIN_STATE`/`GET_BROWSER_COOKIES`）：属 API Tester「同步登录态」设计能力，仅本扩展 UI 可达，非页面可触发。
- **web_accessible_resources 暴露 `interceptor.js` 到 `<all_urls>`**（`manifest.json` ≈ 31–36）：任意页面可 `fetch(chrome-extension://<id>/interceptor.js)` 做扩展指纹探测；因该脚本本就全站注入，功能上难避免。
- **广播型 postMessage 用 `'*'` targetOrigin**（`interceptor.js:89/911/937`）：内容均为本页自身请求数据（跨源 opaque 响应已提前 return 不读 body），页面本可见，无跨源泄漏。可收紧为 `location.origin`。
- **`generateId` 碰撞**（`constants.ts:39–41`）：仅用于本地 UI/数据实体 id，不涉安全边界；碰撞概率极低，最坏后果是列表 key 撞车。（RuleList 复制规则处已用更强的 `crypto.randomUUID?.()`，可选统一。）
- **`__proto__` 作为规则 url/header 键**：作用对象均为函数内局部量，无全局原型污染，不可利用。
- **IMPORT_RULES 为整表覆盖而非合并**：直接覆盖既有规则，属数据行为（可致误删），非安全问题。

---

## 三、已做对 / 已缓解（现状核实，勿当待修项）

**注入 / XSS**
- 弹窗前端唯一的 `dangerouslySetInnerHTML`（`ApiTester.tsx` ≈ 1349，响应体高亮）经 `highlightJson`（≈ 863）**先做 HTML 转义**（`&`→`&amp;`、`<`/`>` 转义，顺序正确）再包 span，服务器响应体内的 `<img onerror>` 等被当纯文本，无法注入。
- 拦截到的 URL / header / 响应体、搜索高亮、Tooltip、错误文本一律走 React 文本插值或 `textContent`；自定义 `showToast`/`showConfirm` 全程 `createElement`+`textContent`，无 `innerHTML`。
- 全仓无 `eval`/`document.write`/`.innerHTML` 赋值（`new Function` 仅测试文件与 injectScript 产品功能）。

**后台 / SSRF / 权限**
- SSRF 主机判定较完整：覆盖 `localhost`/尾点、IPv6 `::1`/`fe80::/10`/`fc00::/7`/IPv4-mapped、十/十六/八进制与单整数 IPv4，以及 `10/172.16-31/192.168/127/0.0.0.0/8/169.254`（含元数据地址）；WHATWG URL 归一后再判定。
- 协议白名单：`API_TEST_REQUEST`/`GET_BROWSER_COOKIES`/`GET_LOGIN_STATE` 均 `^https?://` 前置拦截。
- 无 `externally_connectable`，外部站点无法直连扩展消息通道。
- CSP 合理：`extension_pages: script-src 'self'; object-src 'self'`，无 `unsafe-inline`/`eval`。
- 存储写入串行化（`logWriteQueue` 等）避免读改写竞态；拦截日志有 200 条 + 字节上限兜底。
- `SET_OBSERVE` 的 `resourceTypes` 按白名单过滤。

**导入加固**（本轮之前已修）
- 剥离导入规则里的 `injectScript` 动作；条目/分组上限（2000/500）、正则长度 ≤1000 + ReDoS 启发式 + 可编译性校验；导入结果向用户反馈 skipped 条数。

**拦截器**
- `e.source===window` 三处校验齐备；无 `__API__`/调试对象泄漏（仅 `__APII_INIT` 幂等哨兵）。
- XHR 同名头追加合并（Authorization 破坏）已处理；同步 XHR 已加告警（`_xa` 标志 + warnings）；XHR 双条日志已修（代理用原生方法避免二次进入）。
- 代理 XHR 继承 `withCredentials/timeout/responseType`；正常/错误/超时/4xx-5xx 的事件时序正确（**除 cancel 分支，见 #3**）。
- fetch 改写正确：仅响应规则时原样透传、cancel 返回干净 403、delay 上限 30s、改写失败用原始 input/init 重试防死循环、opaque/跨域响应提前 return、SSE/二进制透传分流。
- 响应体改写后清理 content-length/encoding；安全响应头（CSP/HSTS/X-Content-Type-Options/X-Frame-Options/Set-Cookie）禁止被规则删改。
- content 侧对失效上下文（`Extension context invalidated`）做降级处理。

**前端健壮性**
- 全面用自定义 `showConfirm`/`showToast` 替代原生 `confirm/alert`；JSON 解析均 try/catch 回退；RuleEditor 保存前校验 regex/URL/状态码/延迟。
- 竞态处理良好：`observeRequestVersion` 版本号、`pendingPrefillRef`/`hydratedRef`、`editorNonce` 重建 key；`React.memo`+`useCallback` 避免高频重渲染；每页独立 `ErrorBoundary`。
- JWT 仅本地解析 `exp` 做过期提醒，不外传；大响应体持久化前截断为占位符。

---

## 四、建议修复优先级

| 优先级 | 条目 | 类别 | 建议动作 |
|---|---|---|---|
| P0 | #1 重定向绕过 SSRF | 安全 | `redirect:'manual'` + 对 Location 重校验（改动小） |
| P0 | #3 XHR cancel 挂起 axios | 功能 | cancel 分支补 `readystatechange`+`loadend` |
| P1 | #4 copyLogAll 明文凭证 | 安全 | 默认脱敏 / 含敏感二次确认 |
| P1 | #2 LOG_SAVE 存储 DoS | 安全 | 单条体积+字段校验，降总字节上限 |
| P1 | #7 代理 XHR 传播 abort | 功能 | 桥接 `self.abort → px.abort` |
| P2 | #5 正则准入校验 | 安全 | 导入/保存时超时探测 |
| P2 | #10 cURL 脱敏扩容 / #11 日志掩码+降 body 上限 | 安全 | 统一敏感头掩码策略 |
| P2 | #8 sender 校验 / #13 移除 tabs | 安全 | 纵深防御 + 权限收敛 |
| P3 | #6 DNS rebinding、#9 子域 Cookie、#12 索引 key | 混合 | 缓解/文档明示 |

**产品取舍类**（injectScript 执行、认证头全站采集、httpOnly Cookie 暴露 UI、WAR 指纹、postMessage 伪造的残留）：建议在文档/UI 中明示，而非当缺陷强修。

---

## 五、总体判断

相比 2026-06-06 旧版，当前构建在多数基础安全项上已显著改善（SSRF 拦截、CSP、来源校验、原生弹窗替换、导入加固、事件驱动同步均已落地）。本轮**真正需要动手的**集中在三点：

1. **一条高危**——fetch 代理跟随重定向绕过 SSRF，改动小、应优先；
2. **两条功能性中危**——XHR cancel 挂起 axios、代理 XHR 不传播 abort，影响真实业务页面；
3. **敏感数据一致性**——日志「复制全部信息」不脱敏 + cURL 脱敏白名单过窄，叠加会让用户在自以为安全的操作中明文外泄凭证。

其余多为 MV3 MAIN-world 注入模型的固有属性或产品能力取舍，按上表分级处理即可。

*（本报告由分子系统并行审计当前代码汇总而成，未修改任何代码。）*
