import { downsampleTo16kPcm16, PcmChunker } from '@livetranslate/core';
import workletUrl from './pcm16-worklet.js?url';

export interface MicCaptureOptions {
  deviceId?: string;
  echoCancellation?: boolean; // 实时翻译机/会议开启（D6）
  onChunk: (pcm3200: ArrayBuffer) => void;
  onLevel?: (rms: number) => void; // 音量条（Task 28 接入）
}

export interface MicCaptureHandle {
  stop(): void;
  pause(): void; // R4：暂停=停止产出 chunk，采集链保持
  resume(): void;
}

export async function startMicCapture(opts: MicCaptureOptions): Promise<MicCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      echoCancellation: opts.echoCancellation ?? true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(workletUrl);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm16-capture');
  let paused = false;
  const chunker = new PcmChunker(opts.onChunk);
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (paused) return;
    const f32 = e.data;
    if (opts.onLevel) {
      let sum = 0;
      for (let i = 0; i < f32.length; i++) sum += f32[i]! * f32[i]!;
      opts.onLevel(Math.sqrt(sum / f32.length));
    }
    chunker.push(downsampleTo16kPcm16(f32, ctx.sampleRate));
  };
  source.connect(node);
  node.connect(ctx.destination); // worklet 需接入图才会调度；输出静音（不回放输入）
  return {
    stop: () => {
      node.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
    pause: () => { paused = true; },
    resume: () => { paused = false; },
  };
}
