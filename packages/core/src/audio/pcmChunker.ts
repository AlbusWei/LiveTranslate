const CHUNK_BYTES = 3200; // P7：100ms @16k/16bit/mono

export class PcmChunker {
  private buffer = new Uint8Array(0);

  constructor(private emit: (chunk: ArrayBuffer) => void) {}

  push(pcm: Int16Array): void {
    const incoming = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const merged = new Uint8Array(this.buffer.length + incoming.length);
    merged.set(this.buffer);
    merged.set(incoming, this.buffer.length);
    let off = 0;
    while (merged.length - off >= CHUNK_BYTES) {
      this.emit(merged.slice(off, off + CHUNK_BYTES).buffer);
      off += CHUNK_BYTES;
    }
    this.buffer = merged.slice(off);
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.emit(this.buffer.slice().buffer);
      this.buffer = new Uint8Array(0);
    }
  }
}
