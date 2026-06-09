# ApiMockFlow —— 请求拦截、Mock 与 API 测试浏览器插件

> 修改请求参数和响应数据，内置 API 测试工具，支持 cURL / HTTPie / OpenAPI 导入。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| 修改请求 URL / Query 参数 | 支持 设置 / 替换 / 删除 |
| 修改请求头（Request Headers） | 支持 设置 / 追加 / 删除 / 替换 |
| 修改请求体（Request Body） | 支持 替换 / 设置 |
| 修改响应头（Response Headers） | 支持 设置 / 追加 / 删除 / 替换 |
| 修改响应体（Response Body） | 支持 替换 / 设置（JSON/HTML 等） |
| 修改响应状态码 | 支持修改为任意 HTTP 状态码 |
| 重定向请求 | 将请求重定向到另一个 URL |
| 拦截（取消）请求 | 直接取消匹配的请求 |
| URL 匹配 | 精确匹配 / 包含匹配 / 正则匹配 / 域名匹配 |
| 规则分组 | 按项目分组，整组启停，颜色标识 |
| 全局开关 | 一键暂停/恢复所有规则，图标自动切换 |
| 单条规则启停 | 每条规则独立开关 |
| 导入/导出规则 | JSON 格式，支持团队共享 |
| 规则搜索 | 按名称或 URL 快速过滤 |
| API 测试 | 类似 Postman，发送 HTTP 请求并查看响应 |
| 多请求 Tab | 同时维护多个 API 请求，独立发送 |
| 保存请求 | 常用请求保存复用 |
| 格式导入 | 支持 cURL、HTTPie、OpenAPI 3.x 格式导入 |

---

## 安装到 Chrome

1. 打开 Chrome 浏览器，地址栏输入 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目下的 `dist/` 文件夹
5. 插件安装完成，点击工具栏图标即可使用

---

## 使用说明

### 创建规则

1. 点击插件图标打开弹窗
2. 点击 **新建规则** 按钮
3. 填写规则名称
4. 选择或新建分组
5. 设置 **匹配条件**：
   - 匹配方式：精确匹配 / 包含匹配 / 正则匹配 / 域名匹配
   - URL 匹配值：输入要匹配的 URL 特征
   - 请求方法：可选过滤（GET/POST/PUT/DELETE 等）
   - 资源类型：可选过滤（xhr/fetch/script 等）
6. 添加 **修改动作**（可添加多个）：
   - 修改请求 URL
   - 修改请求头
   - 修改请求体
   - 修改响应头
   - 修改响应体
   - 修改状态码
   - 重定向
   - 拦截请求
7. 点击 **创建规则** 保存

### 管理规则

- 点击规则卡片的开关切换启停状态
- 点击规则进入编辑
- 右上角按钮删除规则
- 点击分组标签按分组过滤
- 顶部搜索框输入关键词搜索

### 导入/导出规则

- **导出**：点击底部 **导出** 按钮，生成 JSON 文件
- **导入**：点击底部 **导入** 按钮，选择 JSON 文件

### API 测试

1. 侧边栏切换到 **API 测试**
2. 选择请求方法、输入 URL、设置 Headers 和 Body
3. 点击 **发送** 查看响应
4. 点击 **书签** 图标保存常用请求
5. 支持粘贴 cURL / HTTPie / OpenAPI 并一键解析
6. 点击 **+** 新建 Tab，同时测试多个接口

---

## 技术架构

```
maplocal/
├── public/
│   ├── manifest.json            # 插件清单（Manifest V3）
│   ├── interceptor.js           # 主世界拦截器（fetch/XHR 劫持）
│   └── icons/                   # 插件图标
├── src/
│   ├── background/
│   │   └── index.ts             # Service Worker：规则引擎、消息代理
│   ├── content/
│   │   └── index.ts             # Content Script：状态同步、脚本注入
│   ├── popup/
│   │   ├── App.tsx              # 主应用组件
│   │   ├── main.tsx             # 入口
│   │   ├── index.html           # 弹窗 HTML
│   │   └── pages/
│   │       ├── RuleList.tsx      # 规则列表页
│   │       ├── RuleEditor.tsx    # 规则编辑页
│   │       └── ApiTester.tsx    # API 测试页
│   ├── shared/
│   │   ├── types.ts             # 类型定义
│   │   ├── api-types.ts         # API 测试类型
│   │   ├── import-parser.ts     # cURL/HTTPie/OpenAPI 解析器
│   │   └── constants.ts         # 常量与工具函数
│   └── styles/
│       └── global.css           # 全局样式
├── dist/                         # 构建产物（Chrome 加载此目录）
├── package.json
├── tsconfig.json
├── vite.config.ts               # Vite 构建配置
├── tailwind.config.js
└── postcss.config.js
```

### 请求拦截原理

```
页面发起请求 (fetch / XMLHttpRequest)
        |
        v
主世界 interceptor.js 劫持
        |
        ├── 本地规则匹配（零延迟，无需异步桥接）
        |       RULES 数组由 Content Script 定期同步 + 变更即时推送
        |
        v
应用请求修改（URL / Headers / Body）
        |
        v
发送真实请求（调用原生 fetch / XHR）
        |
        v
应用响应修改（Headers / Body / StatusCode）
        |
        v
返回修改后的响应给页面
```

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式（热更新）
npm run dev

# 生产构建
npm run build

# 构建产物在 dist/ 目录，在 chrome://extensions/ 加载
```

---

## 注意事项

- Manifest V3，响应体修改通过主世界脚本注入劫持 fetch / XMLHttpRequest 实现
- 只拦截页面级请求（fetch/xhr），不拦截浏览器地址栏直访的请求
- 规则数据保存在 `chrome.storage.local`，清除浏览器数据时会丢失
- 全局开关关闭后，页面请求恢复正常，不受任何影响

---

## 许可证

MIT
