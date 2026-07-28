import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

// §6.6：每 session 一个 JSONL 追加流，崩溃不丢已落盘部分
export class SessionLogFiles {
  private streams = new Map<string, WriteStream>();

  constructor(private dataDir: string) {}

  get sessionsDir(): string {
    return join(this.dataDir, 'logs', 'sessions');
  }

  sinkFor(sessionId: string): (line: string) => void {
    return (line) => {
      let s = this.streams.get(sessionId);
      if (!s) {
        mkdirSync(this.sessionsDir, { recursive: true });
        s = createWriteStream(join(this.sessionsDir, `${sessionId}.jsonl`), { flags: 'a' });
        this.streams.set(sessionId, s);
      }
      s.write(line + '\n');
    };
  }

  closeAll(): Promise<void> {
    const all = [...this.streams.values()].map(
      (s) => new Promise<void>((r) => s.end(() => r())),
    );
    this.streams.clear();
    return Promise.all(all).then(() => undefined);
  }
}
