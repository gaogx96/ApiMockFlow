import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { existsSync, renameSync, rmdirSync } from 'fs';

export default defineConfig({
  plugins: [react(), {
    name: 'move-html',
    writeBundle() {
      // Move popup.html
      const src = resolve(__dirname, 'dist/src/popup/index.html');
      const dst = resolve(__dirname, 'dist/popup.html');
      if (existsSync(src)) {
        renameSync(src, dst);
        try { rmdirSync(dirname(src)); } catch {}
        try { rmdirSync(dirname(dirname(src))); } catch {}
      }
      // Move popup-fullscreen.html
      const src2 = resolve(__dirname, 'dist/src/popup-fullscreen/index.html');
      const dst2 = resolve(__dirname, 'dist/popup-fullscreen.html');
      if (existsSync(src2)) {
        renameSync(src2, dst2);
      }
    },
  }],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@popup': resolve(__dirname, 'src/popup'),
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        'popup-fullscreen': resolve(__dirname, 'src/popup-fullscreen/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'popup.css') return 'assets/popup.css';
          return 'assets/[name].[ext]';
        },
      },
    },
    minify: false,
    sourcemap: true,
  },
});
