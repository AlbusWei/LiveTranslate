import { WebSocketServer, type WebSocket } from 'ws';

const FULL_SOURCE = '今天天气很好，我们一起去公园散步。';
const FULL_TARGET = "The weather is very nice today, let's go for a walk in the park together.  "; // 真实日志含尾部两空格
const SILENCE_240MS_24K = Buffer.alloc(240 * 48).toString('base64'); // P9：24kHz PCM16 ≈ 48 字节/ms
const RESPONSE_DELAY_MS = 3500; // 晚于会议用例点「结束发言」的时点，让 translating 态可观察

let connSeq = 0;

export function startMockUpstream(port: number): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ port, host: '127.0.0.1', path: '/api-ws/v1/realtime' });
  wss.on('connection', (socket: WebSocket) => {
    connSeq += 1;
    const sessionId = `sess_e2e_${connSeq}`;
    let armed = true; // 收到音频 append 即回放一个标准回合，response.done 后重新开启
    let turn = 0; // usage 为 session 累积值（P6），按回合数倍增
    let pendingResponse: (() => void) | null = null;
    let responseTimer: NodeJS.Timeout | null = null;
    const send = (obj: Record<string, unknown>): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };

    send({ type: 'session.created', session: { id: sessionId } });

    const sendResponsePart = (): void => {
      pendingResponse = null;
      if (responseTimer !== null) { clearTimeout(responseTimer); responseTimer = null; }
      turn += 1;
      const responseId = `resp_e2e_${connSeq}_${turn}`;
      send({ type: 'response.created', response: { id: responseId } });
      send({ type: 'response.audio_transcript.text', response_id: responseId, text: 'The weather is', stash: ' very nice today' });
      send({ type: 'response.audio.delta', response_id: responseId, delta: SILENCE_240MS_24K });
      send({ type: 'response.audio_transcript.text', response_id: responseId, text: FULL_TARGET, stash: '' });
      send({ type: 'response.audio_transcript.done', transcript: FULL_TARGET });
      send({
        type: 'response.done',
        response: {
          id: responseId,
          status: 'completed',
          usage: { // 单回合 169/85/84（§0.1 真实样例）× 回合数 = 累积值，UsageMeter 差分后每回合正好 +169
            total_tokens: 169 * turn,
            input_tokens: 85 * turn,
            output_tokens: 84 * turn,
            input_tokens_details: { text_tokens: 50 * turn, audio_tokens: 35 * turn },
            output_tokens_details: { text_tokens: 33 * turn, audio_tokens: 51 * turn },
          },
        },
      });
      armed = true;
    };

    socket.on('message', (raw) => {
      let msg: { type?: string };
      try { msg = JSON.parse(String(raw)) as { type?: string }; } catch { return; }
      if (msg.type === 'session.update') {
        send({ type: 'session.updated', session: { id: sessionId } });
        return;
      }
      if (msg.type === 'input_audio_buffer.append' && armed) {
        armed = false;
        const itemId = `item_e2e_${connSeq}_${turn + 1}`;
        send({ type: 'input_audio_buffer.speech_started', item_id: itemId, audio_start_ms: 300 });
        send({ type: 'conversation.item.input_audio_transcription.text', item_id: itemId, text: '今天天气', stash: '很好', language: 'zh', emotion: 'neutral' });
        send({ type: 'conversation.item.input_audio_transcription.text', item_id: itemId, text: FULL_SOURCE, stash: '', language: 'zh', emotion: 'neutral' });
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: FULL_SOURCE });
        send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId, audio_end_ms: 4600 });
        pendingResponse = sendResponsePart;
        responseTimer = setTimeout(sendResponsePart, RESPONSE_DELAY_MS);
        return;
      }
      if (msg.type === 'session.finish') {
        if (pendingResponse !== null) pendingResponse(); // 冲刷：文件管道全速推完立刻 finish，译文段必须先于 finished 送达
        send({ type: 'session.finished', session: { id: sessionId } });
        return;
      }
    });

    socket.on('close', () => {
      if (responseTimer !== null) clearTimeout(responseTimer);
    });
  });
  return new Promise((resolve) => wss.on('listening', () => resolve(wss)));
}
