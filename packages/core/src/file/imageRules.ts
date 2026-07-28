import type { PipelineFrame } from './filePipeline';

export const MAX_FRAME_BYTES = 190 * 1024; // P11：base64 编码前 ≤190KB
export const MAX_FRAME_FPS = 2; // P11：≤2 张/秒（T20 抽帧 fps 参数限定 1|2）

export function rawBytesOfBase64(b64: string): number {
  if (b64.length === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length * 3) / 4 - padding;
}

export function filterOversizedFrames(frames: PipelineFrame[]): { kept: PipelineFrame[]; droppedTimesMs: number[] } {
  const kept: PipelineFrame[] = [];
  const droppedTimesMs: number[] = [];
  for (const f of frames) {
    if (rawBytesOfBase64(f.jpegBase64) > MAX_FRAME_BYTES) droppedTimesMs.push(f.timeMs);
    else kept.push(f);
  }
  return { kept, droppedTimesMs };
}
