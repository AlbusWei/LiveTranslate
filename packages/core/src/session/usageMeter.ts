import type { Usage } from '../protocol/types';

export interface UsageFlat {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  input_tokens_details: { text_tokens: number; audio_tokens: number };
  output_tokens_details: { text_tokens: number; audio_tokens: number };
}

const ZERO: UsageFlat = {
  total_tokens: 0, input_tokens: 0, output_tokens: 0,
  input_tokens_details: { text_tokens: 0, audio_tokens: 0 },
  output_tokens_details: { text_tokens: 0, audio_tokens: 0 },
};

const flat = (u: Usage): UsageFlat => ({
  total_tokens: u.total_tokens,
  input_tokens: u.input_tokens,
  output_tokens: u.output_tokens,
  input_tokens_details: { text_tokens: u.input_tokens_details.text_tokens, audio_tokens: u.input_tokens_details.audio_tokens },
  output_tokens_details: { text_tokens: u.output_tokens_details.text_tokens, audio_tokens: u.output_tokens_details.audio_tokens ?? 0 },
});

const minus = (a: UsageFlat, b: UsageFlat): UsageFlat => ({
  total_tokens: a.total_tokens - b.total_tokens,
  input_tokens: a.input_tokens - b.input_tokens,
  output_tokens: a.output_tokens - b.output_tokens,
  input_tokens_details: {
    text_tokens: a.input_tokens_details.text_tokens - b.input_tokens_details.text_tokens,
    audio_tokens: a.input_tokens_details.audio_tokens - b.input_tokens_details.audio_tokens,
  },
  output_tokens_details: {
    text_tokens: a.output_tokens_details.text_tokens - b.output_tokens_details.text_tokens,
    audio_tokens: a.output_tokens_details.audio_tokens - b.output_tokens_details.audio_tokens,
  },
});

const plus = (a: UsageFlat, b: UsageFlat): UsageFlat => ({
  total_tokens: a.total_tokens + b.total_tokens,
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  input_tokens_details: {
    text_tokens: a.input_tokens_details.text_tokens + b.input_tokens_details.text_tokens,
    audio_tokens: a.input_tokens_details.audio_tokens + b.input_tokens_details.audio_tokens,
  },
  output_tokens_details: {
    text_tokens: a.output_tokens_details.text_tokens + b.output_tokens_details.text_tokens,
    audio_tokens: a.output_tokens_details.audio_tokens + b.output_tokens_details.audio_tokens,
  },
});

export interface UsageSnapshot {
  sessionTotal: UsageFlat; // 当前 session 累积（= 服务端最后一个累积 usage）
  globalTotal: UsageFlat; // 本次会话（含轮换过的 session）总和
  lastDelta: UsageFlat; // 最近一个 response 的增量
}

export class UsageMeter {
  private sessionCumulative: UsageFlat = ZERO;
  private rotatedTotal: UsageFlat = ZERO; // 已轮换 session 的累积总和（P13）
  private last: UsageFlat = ZERO;

  applyUsage(u: Usage): UsageSnapshot {
    const cur = flat(u);
    this.last = minus(cur, this.sessionCumulative); // P6：累积值差分
    this.sessionCumulative = cur;
    return this.snapshot();
  }

  startNewSession(): void {
    this.rotatedTotal = plus(this.rotatedTotal, this.sessionCumulative);
    this.sessionCumulative = ZERO;
    this.last = ZERO;
  }

  snapshot(): UsageSnapshot {
    return {
      sessionTotal: this.sessionCumulative,
      globalTotal: plus(this.rotatedTotal, this.sessionCumulative),
      lastDelta: this.last,
    };
  }
}
