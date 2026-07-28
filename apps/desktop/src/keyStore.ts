import { safeStorage, app } from 'electron';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyStore } from '@livetranslate/gateway';

export class SafeStorageKeyStore implements KeyStore {
  private file = join(app.getPath('userData'), 'apikey.enc');
  // 回退策略：safeStorage 不可用（如 CI/无 DPAPI 环境）时只存内存，不落盘明文
  private memoryKey: string | null = null;

  getKey(): string | null {
    if (!safeStorage.isEncryptionAvailable()) return this.memoryKey;
    if (!existsSync(this.file)) return null;
    try {
      return safeStorage.decryptString(readFileSync(this.file));
    } catch {
      return null; // 文件损坏/换机器 DPAPI 解不开：视为未配置，由用户重填
    }
  }

  setKey(key: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[keyStore] safeStorage unavailable; key kept in memory only (not persisted)');
      this.memoryKey = key;
      return;
    }
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(this.file, safeStorage.encryptString(key));
  }

  clearKey(): void {
    this.memoryKey = null;
    rmSync(this.file, { force: true });
  }
}
