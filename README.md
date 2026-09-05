# ApiMockFlow

Chrome 浏览器扩展 — API 请求拦截、Mock 数据注入、接口调试一体化工具。

> 当前版本 **v1.7.0** · [下载最新 Release](https://github.com/gaogx96/ApiMockFlow/releases/latest)

---

## 功能

**请求拦截与 Mock**
- 修改请求 URL / Header / Body
- 修改响应 Header / Body / 状态码
- 重定向、拦截（取消）请求
- 延迟响应模拟（毫秒级）
- 注入自定义 JavaScript 脚本（`ctx = { url, headers, body, crypto }`，恒在请求体/头改写之后执行；内置同步 `crypto`：md5 / sha1 / sha256 / hmacSha1 / hmacSha256 / base64，可用改写后的 body 重算签名头）

**规则匹配**
- 4 种匹配模式：精确 / 包含 / 正则 / 域名
- 按 HTTP 方法和资源类型过滤
- 规则分组管理，整组启停，支持删除分组（规则自动移入默认分组）
- 规则复制：一键复制规则生成禁用副本，快速创建变体
- 预编译正则索引，高性能匹配

**拦截日志**
- 实时显示被拦截的请求
- 原始 vs 修改后请求/响应对比
- 一键从日志创建规则
- 签名风险诊断：请求体被改写但带有基于 body 的签名头（且未用 injectScript 重算）时，标记 ⚠ 并提示服务端校验可能失败（常表现为 401 跳登录）

**API 测试器**
- 多 Tab 请求界面
- cURL / HTTPie / OpenAPI 3.x 导入
- 请求/响应体 JSON 格式化、自动修复与压缩
- 响应体展示框随内容自适应高度
- 响应智能诊断：401/403/404/429/5xx/超时/JSON 异常自动提示
- 一键同步浏览器登录态（Cookie + 认证头）；当认证头（如 Authorization）与某 Cookie 同值时自动跟随实时 Cookie 校正，避免重新登录 token 轮换后同步仍 401
- 请求历史与已保存请求，支持一键复制 cURL（脱敏/完整两种模式）
- 请求失败也会记录到历史，方便排查
- 响应 JSON 语法高亮

**其他**
- 石墨薄雾主题：亮 / 暗双主题，一键切换
- 独立窗口模式：完整界面可在独立浏览器窗口中打开（`?window=1`）
- Toast 通知（替代 alert/confirm）
- 页面 Badge 显示实时拦截数
- 安装后自动注入已有标签页（无需刷新）

---

## 安装

1. 从 [Releases](https://github.com/gaogx96/ApiMockFlow/releases) 下载最新 zip
2. 解压
3. Chrome 地址栏输入 `chrome://extensions/`
4. 开启 **开发者模式**
5. 点击 **加载已解压的扩展程序**，选择解压后的文件夹

---

## 开发

```bash
npm install          # 安装依赖
npm run dev          # 开发模式
npm run build        # 生产构建（esbuild 压缩，输出到 dist/）
npm test             # 运行单测（vitest，119 个用例）
```

---

## 技术架构

```
页面 fetch/XHR
    ↓
interceptor.js（主世界注入，预编译正则索引匹配）
    ↓
应用请求修改 → 发送真实请求 → 应用响应修改
    ↓
返回修改后的响应给页面
```

```
src/
├── background/index.ts      # Service Worker：规则引擎、消息处理、API 代理
├── content/index.ts          # Content Script：状态同步、Badge、脚本注入
├── popup/
│   ├── App.tsx               # 主布局（顶部 Tab 导航、主题切换、独立窗口入口）
│   ├── ErrorBoundary.tsx     # 渲染错误兜底
│   ├── compositor.ts         # 弹窗合成器“推迟呈现”节流绕过
│   ├── components/           # 共享 UI 组件（Icon/Select/TabStrip/SearchBar/KeyValueEditor/Tooltip）
│   └── pages/
│       ├── RuleList.tsx      # 规则列表（搜索防抖、分组筛选）
│       ├── RuleEditor.tsx    # 规则编辑器（全屏模式支持）
│       ├── ApiTester.tsx     # API 测试器（多 Tab、JSON 高亮）
│       └── NetworkLog.tsx    # 拦截日志（diff 对比）
├── shared/
│   ├── types.ts              # 类型定义
│   ├── toast.ts              # Toast/Confirm 通知
│   ├── import-parser.ts      # cURL/HTTPie/OpenAPI 解析
│   └── constants.ts          # 常量
├── __tests__/
│   ├── engine.ts             # 匹配引擎（可测试模块）
│   ├── engine.test.ts        # 引擎/规则匹配、injectScript 排序与签名告警单测
│   ├── import-parser.test.ts # cURL/HTTPie/OpenAPI 解析单测
│   ├── json-format.test.ts   # JSON 格式化/修复/压缩单测
│   └── jwt.test.ts           # JWT 解析单测
└── styles/global.css         # 全局样式 + 石墨薄雾 亮/暗双主题
```

---

## 安全设计

- SSRF 防护：API 测试器拦截 IPv4/IPv6 私有地址
- 安全 Header 保护：CSP、HSTS、Set-Cookie 等不可被规则移除
- 导入校验：规则数量限制、字段校验、injectScript 自动剥离
- 响应体截断：Mock 响应 2MB 上限，API 测试响应 100KB 截断
- 生产构建：esbuild 压缩、sourcemap 关闭、console 已清理

---

## 更新日志

### v1.7.0
- **石墨薄雾 UI 改版**：全新亮/暗双主题，一键切换；新增共享组件（Icon/Select/TabStrip/SearchBar/KeyValueEditor/Tooltip），弹窗改圆角浮卡布局
- 移除废弃的全屏模式，改用独立窗口模式（`?window=1`）
- 引擎修复：XHR 代理改头/改 URL 只记一条规则日志；responseType 感知的 Mock 投递（json 解析为对象 / text / 二进制回退）；改请求不改响应场景正确回传；修复请求改写破坏鉴权导致的 401
- 弹窗合成器“推迟呈现”节流绕过：展开分组、保存/导入/白名单对话框不再延迟数秒上屏
- 拦截日志分视图刷新独立 / 持久化 / 冻结；API 测试页标签持久化 / 重命名 / 分组

---

## 许可证

MIT
