import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer } from './server';
import { SettingsStore, EnvKeyStore } from './settings';

// 公共导出（桌面内嵌用，Task 12）
export { createGatewayServer, type GatewayHandle, type GatewayOptions, type RouteHandler } from './server';
export { SettingsStore, EnvKeyStore, DEFAULT_SETTINGS, type AppSettings, type KeyStore, type HotwordTable } from './settings';

// 独立进程模式（网页调试端）：显式开关，桌面内嵌 import 时不得副作用启动
if (process.env.LT_GATEWAY_STANDALONE === '1') {
  const dataDir = process.env.LT_DATA_DIR ?? join(homedir(), '.livetranslate');
  const settings = new SettingsStore(join(dataDir, 'settings.json'), new EnvKeyStore());
  const port = Number(process.env.LT_GATEWAY_PORT ?? 8788);

  void createGatewayServer({ settings, dataDir, port }).then((h) => {
    console.log(`[gateway] listening on http://127.0.0.1:${h.port} (data: ${dataDir})`);
    // 优雅退出：关日志追加流，不丢已缓冲行
    const shutdown = (): void => {
      void h.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
