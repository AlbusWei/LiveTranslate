// AudioWorkletProcessor：把输入声道 Float32 块原样抛回主线程（重采样在主线程用 core 做，保持 worklet 最小）
class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) {
      this.port.postMessage(ch.slice(0));
    }
    return true;
  }
}
registerProcessor('pcm16-capture', Pcm16CaptureProcessor);
