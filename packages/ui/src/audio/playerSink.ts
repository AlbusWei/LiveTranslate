export interface PlayerSink {
  play(wavBytes: Uint8Array): Promise<void>; // 再次调用先停掉上一次
  stop(): void;
  setSink(deviceId: string): Promise<void>;
}

export function createPlayerSink(): PlayerSink {
  const el = new Audio();
  let url: string | null = null;
  const stop = (): void => {
    el.pause();
    el.currentTime = 0;
    if (url) {
      URL.revokeObjectURL(url);
      url = null;
    }
  };
  return {
    async play(wavBytes) {
      stop();
      // 拷一份拿到确定的 ArrayBuffer 背底（Uint8Array<ArrayBufferLike> 不能直接作 BlobPart）
      url = URL.createObjectURL(new Blob([new Uint8Array(wavBytes).buffer], { type: 'audio/wav' }));
      el.src = url;
      await el.play();
    },
    stop,
    async setSink(deviceId) {
      const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (sinkable.setSinkId) await sinkable.setSinkId(deviceId);
    },
  };
}
