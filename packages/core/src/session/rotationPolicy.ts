export const ROTATE_INPUT_TOKENS = 40000; // P13：超过则轮换
export const ROTATE_PAUSE_MS = 10 * 60 * 1000; // spec §5.4：暂停超 10 分钟轮换

export interface RotationInput {
  sessionInputTokens: number; // UsageMeter.snapshot().sessionTotal.input_tokens
  hadError: boolean;
  pausedSinceMs: number | null; // 未暂停为 null
  now: number;
}

export type RotationReason = 'tokens' | 'error' | 'paused';

export function shouldRotate(input: RotationInput): RotationReason | null {
  if (input.hadError) return 'error';
  if (input.sessionInputTokens > ROTATE_INPUT_TOKENS) return 'tokens';
  if (input.pausedSinceMs !== null && input.now - input.pausedSinceMs > ROTATE_PAUSE_MS) return 'paused';
  return null;
}
