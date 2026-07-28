import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { preview } from 'vite';
import { createGatewayServer, EnvKeyStore, SettingsStore } from '@livetranslate/gateway';
import { startMockUpstream } from './upstream';

async function main(): Promise<void> {
  await startMockUpstream(9601);

  // 每次全新临时数据目录：SQLite/事件日志/设置互不污染，用例可重复运行
  const dataDir = mkdtempSync(join(tmpdir(), 'lt-e2e-'));
  process.env.DASHSCOPE_API_KEY = 'sk-e2e-fake'; // EnvKeyStore 读取，mock 不校验
  process.env.LT_UPSTREAM_SCHEME = 'ws'; // mediaJobs 直连也指向明文 mock

  const settings = new SettingsStore(join(dataDir, 'settings.json'), new EnvKeyStore());
  settings.update({ workspaceHost: '127.0.0.1:9601', protocolPreference: 'ws' });

  await createGatewayServer({ settings, dataDir, port: 8788, upstreamScheme: 'ws' });

  const uiRoot = resolve(process.cwd(), '..', 'packages', 'ui');
  await preview({
    root: uiRoot,
    preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  });
  console.log('[e2e] mock upstream :9601, gateway :8788, ui preview :5173');
}

void main();
