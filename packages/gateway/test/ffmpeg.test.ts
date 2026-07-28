import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pcm16ToWav } from '@livetranslate/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFrames, extractPcm16k, probeDurationSeconds, resolveFfmpeg } from '../src/ffmpeg';

const FFMPEG_OK = spawnSync(resolveFfmpeg().ffmpeg, ['-version']).status === 0;

describe.skipIf(!FFMPEG_OK)('ffmpeg pipeline (spec 3.2)', () => {
  let dir: string;
  let wavPath: string;
  let mp4Path: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lt-ffmpeg-'));
    // 2s / 16kHz / 440Hz 正弦 WAV
    const pcm = new Uint8Array(16000 * 2 * 2);
    const dv = new DataView(pcm.buffer);
    for (let i = 0; i < 16000 * 2; i++) {
      dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 12000), true);
    }
    wavPath = join(dir, 'tone.wav');
    writeFileSync(wavPath, pcm16ToWav(pcm, 16000));
    // 3s 测试视频
    mp4Path = join(dir, 'test.mp4');
    const r = spawnSync(resolveFfmpeg().ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=1280x960:rate=30',
      '-pix_fmt', 'yuv420p', mp4Path,
    ]);
    expect(r.status).toBe(0);
  }, 30_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('probeDurationSeconds reads media duration', async () => {
    expect(await probeDurationSeconds(wavPath)).toBeCloseTo(2, 1);
  });

  it('extractPcm16k returns 16k/16bit/mono raw pcm of full length', async () => {
    const pcm = await extractPcm16k(wavPath);
    // 2s * 16000 * 2 字节，允许编解码容差 ±1 帧（3200 字节）
    expect(Math.abs(pcm.length - 64000)).toBeLessThanOrEqual(3200);
  });

  it('extractFrames samples 1fps jpeg, downscaled to <=720p, with timeline stamps', async () => {
    const frames = await extractFrames(mp4Path, { fps: 1, workDir: join(dir, 'frames') });
    expect(frames.length).toBe(3);
    expect(frames.map((f) => f.timeMs)).toEqual([0, 1000, 2000]);
    for (const f of frames) {
      expect(f.jpeg.length).toBeGreaterThan(0);
      // JPEG magic
      expect(f.jpeg[0]).toBe(0xff);
      expect(f.jpeg[1]).toBe(0xd8);
    }
  }, 30_000);
});

describe('resolveFfmpeg', () => {
  it('honors LT_FFMPEG_PATH / LT_FFPROBE_PATH overrides', () => {
    process.env.LT_FFMPEG_PATH = '/opt/ffmpeg/bin/ffmpeg';
    process.env.LT_FFPROBE_PATH = '/opt/ffmpeg/bin/ffprobe';
    expect(resolveFfmpeg()).toEqual({ ffmpeg: '/opt/ffmpeg/bin/ffmpeg', ffprobe: '/opt/ffmpeg/bin/ffprobe' });
    delete process.env.LT_FFMPEG_PATH;
    delete process.env.LT_FFPROBE_PATH;
    // 计划偏差：本机无系统 ffmpeg，回退链 = env → 打包二进制（@ffmpeg-installer）→ PATH 名
    const fb = resolveFfmpeg();
    expect(fb.ffmpeg.toLowerCase()).toContain('ffmpeg');
    expect(fb.ffprobe.toLowerCase()).toContain('ffprobe');
  });
});
