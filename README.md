# ApiMockFlow

Chrome 浏览器扩展 — API 请求拦截、Mock 数据注入、接口调试一体化工具。

---

## 功能

**请求拦截与 Mock**
- 修改请求 URL / Header / Body
- 修改响应 Header / Body / 状态码
- 重定向、拦截（取消）请求
- 延迟响应模拟（毫秒级）
- 注入自定义 JavaScript 脚本

**规则匹配**
- 4 种匹配模式：精确 / 包含 / 正则 / 域名
- 按 HTTP 方法和资源类型过滤
- 规则分组管理，整组启停
- 预编译正则索引，高性能匹配

**拦截日志**
- 实时显示被拦截的请求
- 原始 vs 修改后请求/响应对比
- 一键从日志创建规则

**API 测试器**
- 多 Tab 请求界面
- cURL / HTTPie / OpenAPI 3.x 导入
- 请求/响应体 JSON 格式化、自动修复与压缩
- 响应体展示框随内容自适应高度
- 响应 JSON 语法高亮
- 请求历史与已保存请求

**其他**
- 暗色模式
- 规则编辑器全屏模式
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
npm test             # 运行单测（vitest，107 个用例）
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
│   ├── App.tsx               # 主布局（顶部 Tab 导航）
│   ├── ErrorBoundary.tsx     # 渲染错误兜底
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
│   ├── engine.test.ts        # 引擎/规则匹配单测
│   ├── json-format.test.ts   # JSON 格式化/修复/压缩单测
│   └── jwt.test.ts           # JWT 解析单测
└── styles/global.css         # 全局样式 + 暗色模式
```

---

## 安全设计

- SSRF 防护：API 测试器拦截 IPv4/IPv6 私有地址
- 安全 Header 保护：CSP、HSTS、Set-Cookie 等不可被规则移除
- 导入校验：规则数量限制、字段校验、injectScript 自动剥离
- 响应体截断：Mock 响应 2MB 上限，API 测试响应 100KB 截断
- 生产构建：esbuild 压缩、sourcemap 关闭、console 已清理

---

## 许可证

MIT
