import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
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
