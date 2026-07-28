import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

// 已批准偏差：开发机 PATH 上无 ffmpeg，回退链 = env 覆盖 → 打包二进制（@ffmpeg-installer /
// @ffprobe-installer，win32-x64 静态构建）→ PATH 名。打包包缺失（如未来精简安装）时仍退回 PATH。
// esbuild CJS 打包（Electron 桌面壳）后 import.meta.url 为空：退回模块自带 require（B9 修复）
// 双模块兼容：desktop tsconfig module=CommonJS 下 import.meta 不合法，但 require 恒在、该分支为死代码；
// ESM 上下文（gateway tsx/vitest）走 import.meta.url 合成 require。
// 用 @ts-ignore 而非 @ts-expect-error：ESM 下该行无错可抑制，@ts-expect-error 会误报“未使用”。
// @ts-ignore
const nodeRequire: NodeRequire = typeof require === 'function' ? require : createRequire(import.meta.url);

function bundledPath(pkg: string): string | null {
  try {
    return (nodeRequire(pkg) as { path: string }).path;
  } catch {
    return null;
  }
}

export function resolveFfmpeg(): FfmpegPaths {
  return {
    ffmpeg: process.env.LT_FFMPEG_PATH ?? bundledPath('@ffmpeg-installer/ffmpeg') ?? 'ffmpeg',
    ffprobe: process.env.LT_FFPROBE_PATH ?? bundledPath('@ffprobe-installer/ffprobe') ?? 'ffprobe',
  };
}

function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => err.push(c));
    p.on('error', reject); // 二进制不存在等
    p.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`));
    });
  });
}

export async function probeDurationSeconds(input: string): Promise<number> {
  const out = await run(resolveFfmpeg().ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input,
  ]);
  const n = Number(out.toString().trim());
  if (!Number.isFinite(n)) throw new Error(`ffprobe: unparsable duration for ${input}`);
  return n;
}

// 抽音轨 + 重采样：任意容器/编码 → 16k/16bit/mono 裸 PCM（P7 输入格式）
export async function extractPcm16k(input: string): Promise<Uint8Array> {
  const out = await run(resolveFfmpeg().ffmpeg, [
    '-v', 'error', '-i', input, '-vn',
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', 'pipe:1',
  ]);
  return new Uint8Array(out);
}

export interface ExtractedFrame {
  timeMs: number;
  jpeg: Buffer;
}

// 按 fps 抽帧，缩到 ≤720p（宽保持偶数）；体积规则（≤190KB）在 imageRules（T26）校验
export async function extractFrames(input: string, opts: { fps: 1 | 2; workDir: string }): Promise<ExtractedFrame[]> {
  mkdirSync(opts.workDir, { recursive: true });
  await run(resolveFfmpeg().ffmpeg, [
    '-v', 'error', '-y', '-i', input,
    '-vf', `fps=${opts.fps},scale=-2:'min(720,ih)'`,
    '-q:v', '7',
    join(opts.workDir, 'frame_%05d.jpg'),
  ]);
  const files = readdirSync(opts.workDir).filter((f) => f.endsWith('.jpg')).sort();
  return files.map((f, i) => ({
    timeMs: Math.round((i / opts.fps) * 1000),
    jpeg: readFileSync(join(opts.workDir, f)),
  }));
}
