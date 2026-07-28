import { useEffect, useRef } from 'react';

export interface SegmentWaveProps {
  samples: Float32Array; // 归一化 [-1,1] 单声道采样
  width?: number;
  height?: number;
  color?: string;
}

// 轻量峰值波形：每像素取桶内峰值，画对称竖条
export function SegmentWave({ samples, width = 220, height = 36, color = '#4c8dff' }: SegmentWaveProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    const mid = height / 2;
    const bucket = Math.max(1, Math.floor(samples.length / width));
    for (let x = 0; x < width; x++) {
      const start = x * bucket;
      if (start >= samples.length) break;
      let peak = 0;
      for (let i = start; i < Math.min(start + bucket, samples.length); i++) {
        const v = Math.abs(samples[i]!);
        if (v > peak) peak = v;
      }
      const h = Math.max(1, peak * mid);
      ctx.fillRect(x, mid - h, 1, h * 2);
    }
  }, [samples, width, height, color]);
  return <canvas ref={ref} width={width} height={height} className="segment-wave" />;
}
