import { mkdtempSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import { registerMeetingRoutes } from '../src/meetingRoutes';
import type { RouteHandler } from '../src/server';
import { Storage } from '../src/storage';

function fakeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  const res = {
    writeHead: (code: number) => { statusCode = code; return res; },
    end: (data?: string) => { if (data !== undefined) chunks.push(data); },
  } as unknown as ServerResponse;
  return { res, json: () => JSON.parse(chunks.join('')) as Record<string, unknown>, status: () => statusCode };
}

const fakeReq = (url: string) => ({ url }) as never;

let storage: Storage;
let routes: Map<string, RouteHandler>;

beforeEach(() => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lt-meeting-'));
  storage = new Storage(openDb(join(dataDir, 'app.db')), dataDir);
  routes = new Map();
  registerMeetingRoutes(routes, { storage });
});

describe('meeting routes', () => {
  it('creates a meeting and lists it', async () => {
    const create = fakeRes();
    await routes.get('POST /meetings')!(fakeReq('/meetings'), create.res,
      JSON.stringify({ id: 'm1', roster: ['Alice', 'Bob'], targetLanguage: 'en', createdAt: 1753668000000 }));
    expect(create.status()).toBe(200);

    const list = fakeRes();
    await routes.get('GET /meetings')!(fakeReq('/meetings'), list.res, '');
    const meetings = list.json().meetings as Array<{ id: string; roster_json: string }>;
    expect(meetings[0]!.id).toBe('m1');
    expect(JSON.parse(meetings[0]!.roster_json)).toEqual(['Alice', 'Bob']);
  });

  it('records turns and returns joined texts', async () => {
    storage.createMeeting({ id: 'm2', rosterJson: '["Alice"]', targetLanguage: 'en', createdAt: 1 });
    storage.createSession({ id: 'sess_mt_2', mode: 'meeting', configJson: '{}', startedAt: 1 });
    storage.insertSegment({
      sessionId: 'sess_mt_2', seq: 3, vadStartMs: 0, vadEndMs: 4600,
      sourceText: '大家好。', targetText: 'Hello everyone.', sourceLang: 'zh', emotion: 'neutral',
      audioPath: null, usageJson: null,
    });

    const post = fakeRes();
    await routes.get('POST /meeting-turns')!(fakeReq('/meeting-turns'), post.res,
      JSON.stringify({ meetingId: 'm2', speaker: 'Alice', sessionId: 'sess_mt_2', seq: 3 }));
    expect(post.status()).toBe(200);

    const get = fakeRes();
    await routes.get('GET /meeting-turns')!(fakeReq('/meeting-turns?meetingId=m2'), get.res, '');
    const turns = get.json().turns as Array<{ speaker: string; target_text: string }>;
    expect(turns).toEqual([{ speaker: 'Alice', source_text: '大家好。', target_text: 'Hello everyone.', source_lang: 'zh' }]);
  });

  it('404s for an unknown meeting', async () => {
    const get = fakeRes();
    await routes.get('GET /meeting')!(fakeReq('/meeting?id=nope'), get.res, '');
    expect(get.status()).toBe(404);
  });
});
