# LiveTranslate

基于阿里云百炼 Qwen realtime 模型的实时语音翻译工具，提供单人转写翻译、文件配音、会议热座三种模式，支持 WebRTC / WebSocket 双传输自动降级与译文语音克隆播放。

## 功能

- **单人模式（Solo）**：麦克风流式采集 → 实时 ASR + 翻译 → 译文与回放按钮，覆盖式转写展示。
- **文件配音（File Dubbing）**：上传音视频 → 全速预处理（抽音轨/抽帧）→ 双栏工作台对照源/译 → 导出 SRT、双语 TXT、配音 WAV。
- **会议热座（Meeting）**：两人各一轮发言的状态机协调，always-on 克隆播放，结束产出双语 Markdown/TXT 导出。
- **传输策略**：自动优先 WebRTC（RTP 音频 DataChannel），失败回退 WebSocket；UI 通道指示器实时显示。
- **密钥安全**：桌面端走 Electron safeStorage（DPAPI 加密落盘），独立进程走环境变量，全程不明文持久化。
- **可观测性**：每会话 JSONL 事件日志、用量仪表盘、会话轮换策略（token/错误/暂停阈值）。

## 技术栈

| 层 | 技术 |
|----|------|
| 语言 | TypeScript（严格模式） |
| 包管理 | pnpm 9 workspaces |
| 前端 | React 18 + Vite 5 |
| 桌面壳 | Electron 35 + electron-builder |
| 网关 | Node.js（http/ws）、node:sqlite |
| 音视频 | WebRTC DataChannel、ws、ffmpeg（打包二进制回退） |
| 测试 | Vitest（单元）+ Playwright（e2e） |

## 项目结构

```
packages/
  core/      协议归一化、音频处理、会话编排、文件管线、会议协调
  gateway/   HTTP/WS 网关：relay、设置存储、媒体任务、历史/导出路由
  ui/        React 前端：Solo / FileDub / Meeting / Interpreter 页面
apps/
  desktop/   Electron 主进程 + preload + 打包配置
  web/       独立进程便捷启动器（concurrently 跑网关 + UI dev）
e2e/         Playwright 套件（solo / filedub / meeting）+ mock 上游
tools/       活体冒烟脚本（直连真实上游）
docs/        设计规格与实现计划
```

## 前置要求

- Node.js 20+
- pnpm 9+
- 文件配音需要 ffmpeg（桌面端已打包 `@ffmpeg-installer` 静态二进制，PATH 不可用时自动回退）

## 快速开始

```bash
# 安装依赖
pnpm install

# 配置 API Key（网关独立进程模式读取环境变量）
cp .env .env.local   # 或新建 .env.local
# 编辑 .env.local：DASHSCOPE_API_KEY=sk-xxxx
# 可选：LT_WORKSPACE_HOST={ws-id}.cn-beijing.maas.aliyuncs.com

# Web 独立进程开发（同时启动网关 + UI dev server）
pnpm --filter @livetranslate/web dev
# 浏览器打开 http://localhost:5173

# 或仅启动前端（连接已运行的网关）
pnpm --filter @livetranslate/ui dev
```

桌面端开发：

```bash
pnpm --filter @livetranslate/desktop dev
# 可选验收/调试开关：
#   LT_FAKE_MEDIA=1                          Chromium 假设备
#   LT_FAKE_AUDIO_FILE=path/to.wav           假音频采集
#   LT_UI_DEV_URL=http://localhost:5173     加载 vite dev server
```

## 构建

```bash
# 全量类型检查
pnpm typecheck

# 前端生产构建
pnpm build:web

# 桌面端打包（构建 UI + 拷贝 + electron-builder，输出 release/）
pnpm dist:desktop
```

## 测试

```bash
# 全部单元测试（core + gateway + ui）
pnpm test

# e2e（启动 mock 上游，跑 Playwright 套件）
pnpm --filter @livetranslate/e2e test
```

## 活体冒烟（可选）

手动触发的 CI 工作流，直连真实百炼上游验证连通性与完整翻译回合，需在 GitHub Secrets 配置 `DASHSCOPE_API_KEY`：

```bash
# 本地等价命令
DASHSCOPE_API_KEY=sk-xxx node tools/live-smoke.mjs <16k-mono-s16le.wav> [--expect-turn]
```

## 许可证

[Apache-2.0](LICENSE)
