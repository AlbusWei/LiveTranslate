import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';

export type SessionMode = 'solo' | 'filedub' | 'interpreter' | 'meeting';

export interface SessionRow {
  id: string; mode: SessionMode; config_json: string;
  started_at: number; ended_at: number | null; usage_json: string | null;
}

export interface SegmentRow {
  id: number; session_id: string; seq: number;
  vad_start_ms: number | null; vad_end_ms: number | null;
  source_text: string; target_text: string;
  source_lang: string | null; emotion: string | null;
  audio_path: string | null; usage_json: string | null;
}

export interface SessionLogRow {
  session_id: string; file_path: string; mode: string;
  started_at: number; ended_at: number | null;
  event_count: number; error_count: number;
}

export class Storage {
  constructor(private db: Db, private dataDir: string) {}

  createSession(s: { id: string; mode: SessionMode; configJson: string; startedAt: number }): void {
    this.db.prepare('INSERT INTO sessions (id, mode, config_json, started_at) VALUES (?, ?, ?, ?)')
      .run(s.id, s.mode, s.configJson, s.startedAt);
  }

  finishSession(id: string, end: { endedAt: number; usageJson: string }): void {
    this.db.prepare('UPDATE sessions SET ended_at = ?, usage_json = ? WHERE id = ?')
      .run(end.endedAt, end.usageJson, id);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  listSessions(mode?: SessionMode): SessionRow[] {
    // node:sqlite 适配：all() 返回 Record<string, SQLOutputValue>[]，需经 unknown 断言
    return mode
      ? (this.db.prepare('SELECT * FROM sessions WHERE mode = ? ORDER BY started_at DESC').all(mode) as unknown as SessionRow[])
      : (this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all() as unknown as SessionRow[]);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    rmSync(join(this.dataDir, 'audio', id), { recursive: true, force: true });
  }

  saveSegmentAudio(sessionId: string, seq: number, wavBytes: Uint8Array): string {
    const dir = join(this.dataDir, 'audio', sessionId);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${seq}.wav`);
    writeFileSync(p, wavBytes);
    return p;
  }

  insertSegment(seg: {
    sessionId: string; seq: number; vadStartMs: number | null; vadEndMs: number | null;
    sourceText: string; targetText: string; sourceLang: string | null; emotion: string | null;
    audioPath: string | null; usageJson: string | null;
  }): void {
    this.db.prepare(`INSERT INTO segments
      (session_id, seq, vad_start_ms, vad_end_ms, source_text, target_text, source_lang, emotion, audio_path, usage_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(seg.sessionId, seg.seq, seg.vadStartMs, seg.vadEndMs, seg.sourceText, seg.targetText,
        seg.sourceLang, seg.emotion, seg.audioPath, seg.usageJson);
  }

  listSegments(sessionId: string): SegmentRow[] {
    return this.db.prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY seq').all(sessionId) as unknown as SegmentRow[];
  }

  upsertSessionLog(row: { sessionId: string; filePath: string; mode: string; startedAt: number; endedAt: number | null; eventCount: number; errorCount: number }): void {
    this.db.prepare(`INSERT INTO session_logs (session_id, file_path, mode, started_at, ended_at, event_count, error_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET ended_at = excluded.ended_at, event_count = excluded.event_count, error_count = excluded.error_count`)
      .run(row.sessionId, row.filePath, row.mode, row.startedAt, row.endedAt, row.eventCount, row.errorCount);
  }

  getSessionLog(sessionId: string): SessionLogRow | undefined {
    return this.db.prepare('SELECT * FROM session_logs WHERE session_id = ?').get(sessionId) as SessionLogRow | undefined;
  }
}
