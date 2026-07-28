import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import {
  BYTES_PER_MS_24K, OUTPUT_SAMPLE_RATE, buildBilingualTxt, buildSrt, computeDubTimeline,
  mixdownDubPcm, pcm16ToWav, type DubSegmentTiming, type SrtCue,
} from '@livetranslate/core';
import type { RouteHandler } from './server';
import type { Storage } from './storage';

const query = (url: string | undefined, key: string): string =>
  new URL(url ?? '', 'http://gateway.local').searchParams.get(key) ?? '';

const notFound = (res: ServerResponse): void => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'session_not_found' }));
};

const sendText = (res: ServerResponse, filename: string, body: string): void => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.end(body);
};

export function registerExportRoutes(routes: Map<string, RouteHandler>, deps: { storage: Storage }): void {
  routes.set('GET /export/srt', (req, res) => {
    const sessionId = query(req.url, 'sessionId');
    if (!deps.storage.getSession(sessionId)) { notFound(res); return; }
    // spec §5.2：字幕贴原时间轴（VAD 起止），不受配音顺延影响
    const cues: SrtCue[] = deps.storage.listSegments(sessionId)
      .filter((s) => s.vad_start_ms !== null && s.vad_end_ms !== null)
      .map((s) => ({ startMs: s.vad_start_ms!, endMs: s.vad_end_ms!, text: s.target_text }));
    sendText(res, `${sessionId}.srt`, buildSrt(cues));
  });

  routes.set('GET /export/txt', (req, res) => {
    const sessionId = query(req.url, 'sessionId');
    if (!deps.storage.getSession(sessionId)) { notFound(res); return; }
    const entries = deps.storage.listSegments(sessionId)
      .map((s) => ({ sourceText: s.source_text, targetText: s.target_text }));
    sendText(res, `${sessionId}.txt`, buildBilingualTxt(entries));
  });

  routes.set('GET /export/dub-wav', (req, res) => {
    const sessionId = query(req.url, 'sessionId');
    if (!deps.storage.getSession(sessionId)) { notFound(res); return; }
    const timings: DubSegmentTiming[] = [];
    const audioBySeq = new Map<number, Uint8Array>();
    let totalMs = 0;
    for (const s of deps.storage.listSegments(sessionId)) {
      if (!s.audio_path || s.vad_start_ms === null || s.vad_end_ms === null) continue;
      const pcm = new Uint8Array(readFileSync(s.audio_path)).subarray(44); // 去 WAV 头
      audioBySeq.set(s.seq, pcm);
      timings.push({
        seq: s.seq, srcStartMs: s.vad_start_ms, srcEndMs: s.vad_end_ms,
        dubDurationMs: Math.round(pcm.length / BYTES_PER_MS_24K),
      });
      totalMs = Math.max(totalMs, s.vad_end_ms);
    }
    const wav = pcm16ToWav(
      mixdownDubPcm({ placements: computeDubTimeline(timings), audioBySeq, totalMs }),
      OUTPUT_SAMPLE_RATE,
    );
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Disposition': `attachment; filename="${sessionId}-dub.wav"`,
    });
    res.end(Buffer.from(wav));
  });
}
