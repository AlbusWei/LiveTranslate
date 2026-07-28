import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // Electron 打包后用 file:// 加载，资源必须相对路径
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
});
