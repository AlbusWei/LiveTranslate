import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { createGatewayServer, type GatewayHandle, SettingsStore } from '@livetranslate/gateway';
import { SafeStorageKeyStore } from './keyStore';

// 验收/调试：Chromium fake media（须在 app ready 前追加开关）
if (process.env.LT_FAKE_MEDIA === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (process.env.LT_FAKE_AUDIO_FILE) {
    // LT_FAKE_AUDIO_LOOP=1 循环播放（暂停/重置等长流程验收）；默认 %noloop 播一次
    const suffix = process.env.LT_FAKE_AUDIO_LOOP === '1' ? '' : '%noloop';
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${process.env.LT_FAKE_AUDIO_FILE}${suffix}`);
  }
}

let gatewayPort = 0;
let gatewayHandle: GatewayHandle | null = null;

async function boot(): Promise<void> {
  const dataDir = app.getPath('userData');
  const settings = new SettingsStore(join(dataDir, 'settings.json'), new SafeStorageKeyStore());
  const gateway = await createGatewayServer({ settings, dataDir, port: 0 }); // 随机端口，避免冲突
  gatewayHandle = gateway;
  gatewayPort = gateway.port;

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  if (process.env.LT_UI_DEV_URL) {
    await win.loadURL(process.env.LT_UI_DEV_URL); // 开发：vite dev server
  } else {
    await win.loadFile(join(__dirname, '..', 'ui', 'index.html')); // 打包：ui 构建产物（Task 35 拷入）
  }

  // 验收钩子：显式指定脚本时驱动窗口自动化（截图等），脚本不进源码树
  if (process.env.LT_ACCEPT_SCRIPT) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(process.env.LT_ACCEPT_SCRIPT) as { run(ctx: { win: BrowserWindow; gatewayPort: number; app: typeof app }): Promise<void> };
    await mod.run({ win, gatewayPort, app });
  }
}

// sendSync 同步应答：preload 必须在页面脚本前拿到端口，异步 invoke 有竞态
ipcMain.on('lt:gateway-port', (e) => {
  e.returnValue = gatewayPort;
});

app.whenReady().then(() => boot().catch((err) => console.error('[desktop] boot failed:', err)));
app.on('before-quit', () => {
  void gatewayHandle?.close().catch(() => {});
  gatewayHandle = null;
});
app.on('window-all-closed', () => app.quit());
