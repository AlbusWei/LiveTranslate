import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer } from './server';
import { SettingsStore, EnvKeyStore } from './settings';

const dataDir = process.env.LT_DATA_DIR ?? join(homedir(), '.livetranslate');
const settings = new SettingsStore(join(dataDir, 'settings.json'), new EnvKeyStore());
const port = Number(process.env.LT_GATEWAY_PORT ?? 8788);

createGatewayServer({ settings, dataDir, port }).then((h) => {
  console.log(`[gateway] listening on http://127.0.0.1:${h.port} (data: ${dataDir})`);
});
