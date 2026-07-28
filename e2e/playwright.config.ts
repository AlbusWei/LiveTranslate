import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  workers: 1, // mock 上游 / 网关 / SQLite 为共享单例，必须串行
  use: {
    baseURL: 'http://127.0.0.1:5173',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${resolve(__dirname, 'fixtures', 'zh-sample.wav')}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'pnpm --filter @livetranslate/ui build && tsx mock/boot.ts',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
