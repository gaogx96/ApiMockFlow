import { defineConfig } from 'vite';
import { resolve } from 'path';

// 第二个构建：把运行时层 + 引擎（../engine/engine）以 lib/IIFE 打成
// 单文件自包含 dist/interceptor.js —— 无 import/export/代码分割，MAIN world
// <script src> 注入才不会崩。主构建（vite.config.ts）不动，本配置追加执行。
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  publicDir: false, // 不重复拷 public/（主构建已处理）
  build: {
    outDir: 'dist',
    emptyOutDir: false, // 主 vite build 已清过 dist，勿再清
    minify: false, // 保持可读、可与 golden 逐行 diff
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/interceptor/index.js'),
      formats: ['iife'],
      name: '__APII_BUNDLE', // iife 必填；无导出，该全局恒 undefined、无害
      fileName: () => 'interceptor.js',
    },
    rollupOptions: { output: { entryFileNames: 'interceptor.js' } },
  },
});
