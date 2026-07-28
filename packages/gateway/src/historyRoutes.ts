import { existsSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { RouteHandler } from './server';
import type { SessionMode, Storage } from './storage';

export interface HistoryDeps {
  storage: Storage;
  dataDir: string;
}

export function logFilePath(dataDir: string, sessionId: string): string {
  return join(dataDir, 'logs', 'sessions', `${sessionId}.jsonl`); // 与 SessionLogFiles.sessionsDir（T8）同一约定
}

const json = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

export function registerHistoryRoutes(routes: Map<string, RouteHandler>, deps: HistoryDeps): void {
  routes.set('POST /sessions', (_req, res, body) => {
    const b = JSON.parse(body) as { id: string; mode: SessionMode; configJson: string; startedAt: number };
    deps.storage.createSession({ id: b.id, mode: b.mode, configJson: b.configJson, startedAt: b.startedAt });
    json(res, 200, { ok: true });
  });

  routes.set('POST /segments', (_req, res, body) => {
    const b = JSON.parse(body) as {
      sessionId: string; seq: number; vadStartMs: number | null; vadEndMs: number | null;
      sourceText: string; targetText: string; sourceLang: string | null; emotion: string | null;
      usageJson: string | null; wavBase64?: string;
    };
    const audioPath = b.wavBase64
      ? deps.storage.saveSegmentAudio(b.sessionId, b.seq, new Uint8Array(Buffer.from(b.wavBase64, 'base64')))
      : null;
    deps.storage.insertSegment({
      sessionId: b.sessionId, seq: b.seq, vadStartMs: b.vadStartMs, vadEndMs: b.vadEndMs,
      sourceText: b.sourceText, targetText: b.targetText, sourceLang: b.sourceLang,
      emotion: b.emotion, audioPath, usageJson: b.usageJson,
    });
    json(res, 200, { ok: true, audioPath });
  });

  routes.set('POST /sessions/finish', (_req, res, body) => {
    const b = JSON.parse(body) as { id: string; endedAt: number; usageJson: string };
    deps.storage.finishSession(b.id, { endedAt: b.endedAt, usageJson: b.usageJson });
    const file = logFilePath(deps.dataDir, b.id);
    const row = deps.storage.getSession(b.id);
    if (existsSync(file) && row) {
      // spec §6.6：session_logs 只是索引，日志本体留在 JSONL 文件
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
      const errors = lines.filter((l) => (JSON.parse(l) as { type?: string }).type === 'error').length;
      deps.storage.upsertSessionLog({
        sessionId: b.id, filePath: file, mode: row.mode, startedAt: row.started_at,
        endedAt: b.endedAt, eventCount: lines.length, errorCount: errors,
      });
    }
    json(res, 200, { ok: true });
  });
}
