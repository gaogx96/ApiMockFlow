import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// 石墨薄雾字体：Hanken Grotesk（界面）+ Space Mono（URL/代码）。
// 本地 woff2 打包进 dist，满足扩展 CSP（不走 CDN）。
import '@fontsource/hanken-grotesk/400.css';
import '@fontsource/hanken-grotesk/500.css';
import '@fontsource/hanken-grotesk/600.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/700.css';
import '../styles/global.css';

// 独立窗口模式（?window=1）：让 body 填满窗口，覆盖 popup 的固定尺寸。
// 同步执行（早于 React 渲染），避免 640px → 满宽的布局闪烁。
if (new URLSearchParams(location.search).get('window') === '1') {
  document.body.classList.add('panel-window');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
