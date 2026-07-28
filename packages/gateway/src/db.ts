// 已批准偏差：本机无 better-sqlite3 编译链，改用 Node 内置 node:sqlite（DatabaseSync）。
// 经 process.getBuiltinModule 运行时获取：vite 5 的内置模块表尚不认识 node:sqlite，静态 import 会被误解析。
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const { DatabaseSync: SqliteDatabase } = process.getBuiltinModule('node:sqlite');

export type Db = DatabaseSync;

// spec §6.2 + §6.6；所有时间为 epoch ms
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('solo','filedub','interpreter','meeting')),
  config_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  usage_json TEXT
);
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  vad_start_ms INTEGER,
  vad_end_ms INTEGER,
  source_text TEXT NOT NULL DEFAULT '',
  target_text TEXT NOT NULL DEFAULT '',
  source_lang TEXT,
  emotion TEXT,
  audio_path TEXT,
  usage_json TEXT,
  UNIQUE(session_id, seq)
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  roster_json TEXT NOT NULL,
  target_language TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meeting_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media_jobs (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  frame_config_json TEXT NOT NULL,
  artifacts_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','done','failed')),
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_logs (
  session_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  event_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_mode ON sessions(mode, started_at DESC);
`;

export function openDb(filePath: string): Db {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new SqliteDatabase(filePath); // 外键约束 node:sqlite 默认开启
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
