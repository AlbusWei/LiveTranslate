import type { WsLike } from '@livetranslate/core';

// 浏览器原生 WebSocket → WsLike（WsTransport 注入用）
export function browserWsFactory(url: string): WsLike {
  const ws = new WebSocket(url);
  const like: WsLike = {
    send: (d: string) => ws.send(d),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => like.onopen?.();
  ws.onmessage = (e) => like.onmessage?.(String(e.data));
  ws.onclose = () => like.onclose?.();
  ws.onerror = (e) => like.onerror?.(e);
  return like;
}
