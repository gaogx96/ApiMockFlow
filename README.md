# API Interceptor —— 修改请求与响应数据的浏览器插件

> 功能类似 Requestly，支持拦截并修改 API 请求参数和响应数据，规则可保存、启用/关停。

---

## 功能特性

| 功能 | 说明 |
|------|------|
| ✅ 修改请求 URL / Query 参数 | 支持 设置 / 替换 / 删除 |
| ✅ 修改请求头（Request Headers） | 支持 设置 / 追加 / 删除 / 替换 |
| ✅ 修改请求体（Request Body） | 支持 替换 / 设置 |
| ✅ 修改响应头（Response Headers） | 支持 设置 / 追加 / 删除 |
| ✅ 修改响应体（Response Body） | 支持 替换 / 设置（JSON/HTML 等） |
| ✅ 修改响应状态码 | 支持修改为任意 HTTP 状态码 |
| ✅ 重定向请求 | 将请求重定向到另一个 URL |
| ✅ 拦截（取消）请求 | 直接取消匹配的请求 |
| ✅ URL 匹配 | 精确匹配 / 包含匹配 / 正则匹配 / 域名匹配 |
| ✅ 规则分组 | 按项目分组，整组启停，颜色标识 |
| ✅ 全局开关 | 一键暂停/恢复所有规则 |
| ✅ 单条规则启停 | 每条规则独立开关 |
| ✅ 导入/导出规则 | JSON 格式，支持团队共享 |
| ✅ 请求拦截日志 | 记录命中规则的请求，对比修改前后数据 |
| ✅ 规则搜索 | 按名称或 URL 快速过滤 |

---

## 安装到 Chrome

1. 打开 Chrome 浏览器，地址栏输入：`chrome://extensions/`
2. 右上角开启 **「开发者模式」**
3. 点击 **「加载已解压的扩展程序」**
4. 选择本项目下的 `dist/` 文件夹
5. 插件安装完成，点击工具栏图标即可使用

---

## 使用说明

### 创建规则

1. 点击工具栏中的 **API Interceptor** 图标打开弹窗
2. 点击 **「+ 新建」** 按钮
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
7. 点击 **「创建规则」** 保存

### 管理规则

- **启停规则**：点击规则卡片上的开关 Toggle
- **编辑规则**：点击 ✏️ 图标
- **删除规则**：点击 🗑️ 图标
- **按分组过滤**：点击分组标签
- **搜索规则**：顶部搜索框输入关键词

### 查看拦截日志

1. 点击弹窗顶部的 **「日志」** 标签
2. 查看所有被规则命中的请求记录
3. 点击单条日志展开，查看修改前后的请求和响应对比
4. 点击 **「清空」** 清除所有日志

### 导入/导出规则

- **导出**：点击底部 **「📤 导出规则」**，生成 JSON 文件
- **导入**：点击底部 **「📥 导入规则」**，选择 JSON 文件

---

## 技术架构

```
maplocal/
├── public/
│   └── manifest.json          # 插件清单（Manifest V3）
├── src/
│   ├── background/
│   │   └── index.ts          # Service Worker：规则引擎、消息处理
│   ├── content/
│   │   └── index.ts          # Content Script：拦截 fetch/XHR
│   ├── popup/
│   │   ├── App.tsx           # 主应用组件
│   │   ├── main.tsx          # 入口
│   │   ├── index.html        # 弹窗 HTML
│   │   └── pages/
│   │       ├── RuleList.tsx   # 规则列表页
│   │       ├── RuleEditor.tsx # 规则编辑页
│   │       └── LogViewer.tsx # 拦截日志页
│   ├── shared/
│   │   ├── types.ts          # TypeScript 类型定义
│   │   ├── storage.ts        # chrome.storage 封装
│   │   └── constants.ts     # 常量与工具函数
│   └── styles/
│       └── global.css        # 全局样式（Tailwind）
├── dist/                      # 构建产物（Chrome 加载此目录）
├── package.json
├── tsconfig.json
├── vite.config.ts            # Vite 构建配置
├── tailwind.config.js
└── postcss.config.js
```

### 请求拦截原理

```
页面发起请求 (fetch / XMLHttpRequest)
        │
        ▼
Content Script 拦截
        │
        ├── 向 Background 查询匹配规则
        │
        ▼
应用请求修改（URL/Headers/Body）
        │
        ▼
发送真实请求
        │
        ▼
应用响应修改（Headers/Body/StatusCode）
        │
        ▼
返回修改后的响应给页面
        │
        ▼
上报拦截日志到 Background
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

# 构建产物在 dist/ 目录，直接在 chrome://extensions/ 加载
```

---

## 注意事项

- **Manifest V3** 不支持 `webRequestBlocking`，响应体修改通过 Content Script 重写 `fetch` / `XMLHttpRequest` 实现
- 只拦截页面级请求（fetch/xhr），不拦截浏览器地址栏直访的请求
- 跨域请求需要服务端支持 CORS，或修改响应头添加 CORS 头
- 规则数据保存在 `chrome.storage.local`，清除浏览器数据时会丢失

---

## 许可证

MIT
