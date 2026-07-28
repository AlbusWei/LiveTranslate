import { existsSync, readFileSync, rmSync } from 'node:fs';
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

  const query = (req: { url?: string }): URLSearchParams =>
    new URL(req.url ?? '', 'http://gateway.local').searchParams;

  routes.set('GET /sessions', (req, res) => {
    const mode = query(req).get('mode');
    json(res, 200, { sessions: deps.storage.listSessions(mode ? (mode as SessionMode) : undefined) });
  });

  routes.set('GET /segments', (req, res) => {
    json(res, 200, { segments: deps.storage.listSegments(query(req).get('sessionId') ?? '') });
  });

  routes.set('GET /segment-audio', (req, res) => {
    const q = query(req);
    const seq = Number(q.get('seq'));
    const row = deps.storage.listSegments(q.get('sessionId') ?? '').find((s) => s.seq === seq);
    if (!row?.audio_path || !existsSync(row.audio_path)) {
      json(res, 404, { error: 'audio_not_found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(readFileSync(row.audio_path));
  });

  routes.set('GET /session-log', (req, res) => {
    const file = logFilePath(deps.dataDir, query(req).get('sessionId') ?? '');
    if (!existsSync(file)) {
      json(res, 404, { error: 'log_not_found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(readFileSync(file));
  });

  routes.set('POST /sessions/delete', (_req, res, body) => {
    const b = JSON.parse(body) as { id: string };
    deps.storage.deleteSession(b.id); // 级联删 segments（T16 外键 CASCADE）
    rmSync(join(deps.dataDir, 'audio', b.id), { recursive: true, force: true });
    // 事件日志文件按 spec §6.6 保留策略保留，由用户手动清理
    json(res, 200, { ok: true });
  });
}
