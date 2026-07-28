// 桌面：preload 注入 window.livetranslate（Task 12）；网页：固定本地网关端口
export interface PlatformBridge {
  gatewayHttpBase(): string; // 如 http://127.0.0.1:8788
  gatewayWsUrl(): string; // 如 ws://127.0.0.1:8788/realtime
  isDesktop(): boolean;
}

declare global {
  interface Window {
    livetranslate?: { gatewayPort: number };
  }
}

export function getPlatform(): PlatformBridge {
  const desktopPort = window.livetranslate?.gatewayPort;
  const port = desktopPort ?? 8788;
  return {
    gatewayHttpBase: () => `http://127.0.0.1:${port}`,
    gatewayWsUrl: () => `ws://127.0.0.1:${port}/realtime`,
    isDesktop: () => desktopPort !== undefined,
  };
}
