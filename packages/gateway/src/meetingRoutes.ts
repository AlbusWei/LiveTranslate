import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from './server';
import type { Storage } from './storage';

export interface MeetingDeps {
  storage: Storage;
}

const json = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const query = (req: IncomingMessage): URLSearchParams =>
  new URL(req.url ?? '/', 'http://localhost').searchParams;

export function registerMeetingRoutes(routes: Map<string, RouteHandler>, deps: MeetingDeps): void {
  routes.set('POST /meetings', (_req, res, body) => {
    const b = JSON.parse(body) as { id: string; roster: string[]; targetLanguage: string; createdAt: number };
    deps.storage.createMeeting({
      id: b.id, rosterJson: JSON.stringify(b.roster), targetLanguage: b.targetLanguage, createdAt: b.createdAt,
    });
    json(res, 200, { meeting: deps.storage.getMeeting(b.id) });
  });

  routes.set('GET /meetings', (_req, res) => {
    json(res, 200, { meetings: deps.storage.listMeetings() });
  });

  routes.set('GET /meeting', (req, res) => {
    const meeting = deps.storage.getMeeting(query(req).get('id') ?? '');
    if (!meeting) {
      json(res, 404, { error: 'meeting_not_found' });
      return;
    }
    json(res, 200, { meeting });
  });

  routes.set('POST /meeting-turns', (_req, res, body) => {
    const b = JSON.parse(body) as { meetingId: string; speaker: string; sessionId: string; seq: number };
    deps.storage.addMeetingTurn({ meetingId: b.meetingId, speaker: b.speaker, sessionId: b.sessionId, seq: b.seq });
    json(res, 200, { ok: true });
  });

  routes.set('GET /meeting-turns', (req, res) => {
    json(res, 200, { turns: deps.storage.listMeetingTurnTexts(query(req).get('meetingId') ?? '') });
  });
}
