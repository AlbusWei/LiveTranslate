// 活体冒烟：直连百炼 realtime 上游，验证 P2/P3 骨干（可选 --expect-turn 验完整翻译回合）。
// 用法：DASHSCOPE_API_KEY=sk-xxx node tools/live-smoke.mjs <16k单声道PCM16.wav> [--expect-turn]
// 可选环境变量：LT_WORKSPACE_HOST（缺省 dashscope.aliyuncs.com）
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const MODEL = 'qwen3.5-livetranslate-flash-realtime';
const CHUNK_BYTES = 3200; // P7：100ms @16k16bit mono
const apiKey = process.env.DASHSCOPE_API_KEY;
const host = process.env.LT_WORKSPACE_HOST ?? 'dashscope.aliyuncs.com';
const [wavPath, flag] = process.argv.slice(2);
const expectTurn = flag === '--expect-turn';

if (!apiKey) { console.error('missing DASHSCOPE_API_KEY'); process.exit(1); }
if (!wavPath) { console.error('usage: node tools/live-smoke.mjs <wav> [--expect-turn]'); process.exit(1); }

function readPcmFromWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12; let fmt = null; let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  if (fmt.rate !== 16000 || fmt.channels !== 1 || fmt.bits !== 16) {
    throw new Error(`need 16k mono s16le, got ${fmt.rate}Hz/${fmt.channels}ch/${fmt.bits}bit`);
  }
  return data;
}

const pcm = readPcmFromWav(wavPath);
const counts = new Map();
const bump = (t) => counts.set(t, (counts.get(t) ?? 0) + 1);
let lastUsage = null;

const ws = new WebSocket(`wss://${host}/api-ws/v1/realtime?model=${MODEL}`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const hardTimeout = setTimeout(() => { console.error('FAIL: 60s hard timeout'); process.exit(1); }, 60_000);

ws.on('message', (raw) => {
  const ev = JSON.parse(String(raw));
  bump(ev.type);
  if (ev.type === 'session.created') {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice: 'Tina',
        sample_rate: 16000,
        input_audio_format: 'pcm',
        input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
        translation: { language: 'en' },
      },
    }));
  }
  if (ev.type === 'session.updated' && (counts.get('session.updated') ?? 0) === 1) {
    for (let off = 0; off < pcm.length; off += CHUNK_BYTES) { // P8：全速推流，无 sleep
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(off, off + CHUNK_BYTES).toString('base64') }));
    }
    // 留 8s 给服务端出完本回合再 finish（连通档也走同一路径，只是不会有 response）
    setTimeout(() => ws.send(JSON.stringify({ type: 'session.finish' })), 8_000);
  }
  if (ev.type === 'response.done' && ev.response?.usage) lastUsage = ev.response.usage;
  if (ev.type === 'session.finished') ws.close(); // P3：服务端不断链，客户端主动 close
  if (ev.type === 'error') console.error('server error event:', JSON.stringify(ev));
});

ws.on('close', () => {
  clearTimeout(hardTimeout);
  console.log('event counts:', Object.fromEntries(counts));
  if (lastUsage) console.log('last usage (session 累积值, P6):', JSON.stringify(lastUsage));
  const baseOk = (counts.get('session.created') ?? 0) >= 1
    && (counts.get('session.updated') ?? 0) >= 1
    && (counts.get('session.finished') ?? 0) >= 1;
  const turnOk = !expectTurn
    || ((counts.get('conversation.item.input_audio_transcription.completed') ?? 0) >= 1
      && (counts.get('response.done') ?? 0) >= 1);
  if (baseOk && turnOk) { console.log(`PASS (${expectTurn ? 'full turn' : 'connectivity'})`); process.exit(0); }
  console.error(`FAIL: baseOk=${baseOk} turnOk=${turnOk}`);
  process.exit(1);
});

ws.on('error', (err) => { console.error('ws error:', err.message); process.exit(1); });
