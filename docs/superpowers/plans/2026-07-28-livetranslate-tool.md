# LiveTranslate Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 qwen3.5-livetranslate-flash-realtime 交付三端一致（Windows / macOS / Web 调试端）的同声传译体验工具，完整落地单人测试、文件配音 + 实时翻译机、会议热座三大模式（M1–M6 全量）。
**Architecture:** pnpm monorepo：`packages/core`（纯 TS 协议与领域逻辑，全部可单测）+ `packages/gateway`（Node 网关：API Key 持有、WS 中继、SDP 代理、ffmpeg、SQLite、事件日志）+ `packages/ui`（共享 React 界面）+ `apps/desktop`（Electron，内嵌网关）+ `apps/web`（网页调试端壳）。协议接入层 `ITranslateTransport` 可插拔：WsTransport 全场景保底，WebRtcTransport 麦克风增强，失败自动降级。
**Tech Stack:** TypeScript 5 / React 18 + Vite 5 / Electron 33 + electron-builder / better-sqlite3 / ws / vitest / Playwright / ffmpeg（桌面原生二进制，网页端降级仅音轨）。

---

## 0. 全局约定（所有任务必须遵守）

- 设计唯一权威依据：`docs/superpowers/specs/2026-07-28-livetranslate-tool-design.md`（下称 spec）。本计划中所有协议行为均忠实于 spec §2 实测事实。
- 包管理器 pnpm ≥ 9，Node ≥ 20。workspace 包名：`@livetranslate/core`、`@livetranslate/gateway`、`@livetranslate/ui`、`@livetranslate/desktop`、`@livetranslate/web`、`@livetranslate/e2e`。
- 测试命令统一形态：
  - 整包：`pnpm --filter @livetranslate/core test`（= `vitest run`）
  - 单文件：`pnpm --filter @livetranslate/core exec vitest run test/<name>.test.ts`
- TDD 节奏：每个可单测组件都是「写失败测试 → 运行确认失败 → 最小实现 → 运行确认通过 → commit」。UI 页面类任务：实现 → 手工验证清单 → commit（E2E 在 M6 Task 36 统一补齐，代码在该任务内给全）。
- git 提交在仓库根执行；Windows PowerShell 下多命令用 `;` 分隔。commit message 用本计划各任务给出的原文。
- **类型唯一来源**：跨包共享的接口（`SessionConfig`、`ITranslateTransport`、`NormalizedEvent`、`Usage`、`Segment` 等）只定义在 `packages/core/src/protocol/types.ts` 与 `packages/core/src/session/transcriptModel.ts`，其余包一律 import，禁止重复定义。
- `scratch/` 在 `.gitignore` 中，属临时实验区。计划所需的真实事件 fixture 已在 Task 2 中以文件内容形式全文给出（内容取自 `scratch/ws-events.log`、`scratch/ws-events-audio.log` 真实记录），直接创建进 `packages/core/test/fixtures/`（正式受版本管理目录）；E2E 用的 wav fixture 在 Task 36 用 ffmpeg 现场生成进 `e2e/fixtures/`（不依赖 `scratch/`，mock 上游回放真实事件结构，无需真实语音）。
- API Key 永不硬编码、永不落日志（含事件日志，见 SessionLogger 实现）；活体冒烟只读 `DASHSCOPE_API_KEY` 环境变量。

## 0.1 协议事实速查（源自 spec §2 + 真实日志，写协议代码前必读）

| # | 事实 | 代码约束 |
|---|---|---|
| P1 | URL `wss://{workspaceHost}/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime`，`Authorization: Bearer <KEY>` header | 仅网关持 Key；渲染端连网关中继 |
| P2 | 连接即收 `session.created`；`session.update` 全参数回显为 `session.updated` | `connect()` = 建连 → 等 created → 发 update → 等 updated |
| P3 | `session.finish` → 服务端回 `session.finished` 但**不断链** | `finish()` 等到 finished 后客户端主动 `close()`，10s 超时兜底强制断开 |
| P4 | 译文增量：文本模态 `response.text.text`、音频模态 `response.audio_transcript.text`，均为 `text`(已确认全量) + `stash`(暂存预测) **双字段全量刷新，stash 会回撤** | 渲染必须整段覆盖式重绘，禁止追加拼接 |
| P5 | ASR 原文 `conversation.item.input_audio_transcription.text/.completed`，含 `language`、`emotion` | 需开启 `input_audio_transcription.model:"qwen3-asr-flash-realtime"` |
| P6 | 段落 = 一次 response 生命周期（`response.created`→`response.done`）；`response.done.usage` 为 **session 累积值** | UsageMeter 必须差分 |
| P7 | 输入 PCM16/16kHz/mono，base64 经 `input_audio_buffer.append`，3200 字节 = 100ms/块 | pcmChunker 固定 3200 |
| P8 | **全速推流可行**（≥12x 吞吐、零限流、VAD 边界一致） | 文件模式 append 循环**无 sleep** |
| P9 | 输出音频 **24kHz/16bit/mono PCM**，base64 经 `response.audio.delta` 增量返回 | AudioSegmenter 按 responseId 拼接，WAV 头写 24000 |
| P10 | 音色复刻 `enable_voice_clone:true` + `voice:"default"` + `voice_clone_options.frequency:"once"|"always"`；always 逐段跟随说话人 | 配音/翻译机默认 once，会议固定 always |
| P11 | 图像 `input_image_buffer.append`，JPG ≤2张/秒、≤190KB(base64 前)、建议≤720p，**必须在首次音频 append 之后** | FilePipeline 强制该顺序 |
| P12 | 热词 `session.translation.corpus.phrases` | SessionConfig 透传 |
| P13 | 上下文上限 53,248（输入 49,152）→ 会议模式输入 token > 40,000 轮换 session | rotationPolicy |

真实事件样例（`response.done`，音频模态，注意 usage 为累积值）：

```json
{"event_id":"event_GSBKybnFkPkNR8rcY3YSY","type":"response.done","response":{"id":"resp_MlgY53L3GmUfaCHIxXiHh","object":"realtime.response","conversation_id":"conv_PsWwzeG5voY2Gd6fphrTq","status":"completed","modalities":["text","audio"],"voice":"Tina","output_audio_format":"pcm","output":[{"id":"item_EZ1S6QABBkxhDTc361p5n","object":"realtime.item","type":"message","status":"completed","role":"assistant","content":[{"type":"audio","transcript":"The weather is very nice today, let's go for a walk in the park together.  "}]}],"usage":{"total_tokens":169,"input_tokens":85,"output_tokens":84,"input_tokens_details":{"text_tokens":50,"audio_tokens":35},"output_tokens_details":{"text_tokens":33,"audio_tokens":51}}}}
```

## 0.2 File Structure（全量，标注创建里程碑）

```
LivetranslateTool/
├── package.json                       # 根：workspace 脚本聚合（M1/T1）
├── pnpm-workspace.yaml                # workspace 声明（M1/T1）
├── tsconfig.base.json                 # 严格模式共享 TS 配置（M1/T1）
├── .gitignore                        # 追加 node_modules/dist/release 等（M1/T1）
├── tools/
│   └── live-smoke.mjs                 # 活体冒烟脚本（scratch/ws-exp.mjs 演进版）（M6/T37）
├── .github/workflows/live-smoke.yml   # 手动触发的活体冒烟 CI（M6/T37）
├── packages/
│   ├── core/                          # 纯 TS，无 DOM/Node 强依赖，vitest 全覆盖
│   │   ├── package.json / tsconfig.json（M1/T1）
│   │   ├── src/index.ts               # 公共导出面（M1/T1，随任务追加导出）
│   │   ├── src/protocol/
│   │   │   ├── types.ts               # SessionConfig/Usage/ServerEvent/NormalizedEvent/ITranslateTransport（M1/T2）
│   │   │   ├── emitter.ts             # 微型类型化事件总线（M1/T3）
│   │   │   ├── normalize.ts           # 原始服务端事件 → NormalizedEvent（M1/T3）
│   │   │   ├── wsTransport.ts         # WS 实现（注入 WsFactory，浏览器/Node 通用）（M1/T4）
│   │   │   ├── webrtcTransport.ts     # WebRTC 实现（M6/T34）
│   │   │   └── transportFactory.ts    # 协议选择 + R5 自动降级（M6/T34）
│   │   ├── src/session/
│   │   │   ├── transcriptModel.ts     # 段落状态机 text/stash/done（M1/T5）
│   │   │   ├── sessionLogger.ts       # §6.6 JSONL 事件日志（M1/T6）
│   │   │   ├── usageMeter.ts          # usage 差分聚合（M2/T15）
│   │   │   ├── audioSegmenter.ts      # response→24k PCM 段（M2/T14）
│   │   │   ├── sessionOrchestrator.ts # 会话编排/重连/暂停/重置（M2/T17）
│   │   │   └── rotationPolicy.ts      # session 轮换判定（M5/T31）
│   │   ├── src/audio/
│   │   │   ├── base64.ts              # Uint8Array<->base64（M1/T4）
│   │   │   ├── wav.ts                 # PCM16→WAV 封装/时长（M2/T14）
│   │   │   ├── resample.ts            # Float32 48k→Int16 16k（M1/T13）
│   │   │   └── pcmChunker.ts          # 3200 字节分块器（M1/T13）
│   │   ├── src/file/
│   │   │   ├── filePipeline.ts        # 全速推流预处理（M3/T21）
│   │   │   ├── dubTimeline.ts         # 顺延漂移时间轴（M3/T22）
│   │   │   ├── dubMixdown.ts          # 漂移时间轴离线混音 PCM（M3/T25）
│   │   │   ├── srt.ts                 # SRT 生成（M3/T25）
│   │   │   └── imageRules.ts          # 抽帧频率/体积校验（M3/T26）
│   │   ├── src/meeting/
│   │   │   ├── meetingCoordinator.ts  # 热座状态机（M5/T30）
│   │   │   └── meetingExport.ts       # 双语 Markdown/TXT 导出（M5/T33）
│   │   ├── src/i18n/languages.ts      # 60 语种清单 + 音频支持标记（M1/T13）
│   │   └── test/
│   │       ├── fixtures/
│   │       │   ├── session-created.json     # 真实 session.created（M1/T2）
│   │       │   ├── session-updated.json     # 真实 session.updated（M1/T2）
│   │       │   ├── text-turn.jsonl          # 真实文本模态完整回合（M1/T2）
│   │       │   ├── audio-turn.jsonl         # 真实音频模态回合（delta 截断）（M1/T2）
│   │       │   └── usage-sequence.json      # 真实 4 连 response 累积 usage（M1/T2）
│   │       └── *.test.ts                    # 各模块同名测试（随任务创建）
│   ├── gateway/
│   │   ├── package.json / tsconfig.json（M1/T7）
│   │   ├── src/index.ts               # standalone 启动入口（网页调试端用）（M1/T7）
│   │   ├── src/server.ts              # http+ws 服务组装/路由注册（M1/T7）
│   │   ├── src/settings.ts            # 设置持久化 + KeyStore 抽象（M1/T7）
│   │   ├── src/logFiles.ts            # JSONL FileSink + 日志目录管理（M1/T8）
│   │   ├── src/relay.ts               # /realtime WS 中继（Bearer 注入 + 日志 tap）（M1/T8）
│   │   ├── src/selfCheck.ts           # 连接自检（M1/T9）
│   │   ├── src/db.ts                  # better-sqlite3 schema（M2/T16）
│   │   ├── src/storage.ts             # sessions/segments/音频文件 CRUD（M2/T16）
│   │   ├── src/historyRoutes.ts       # 历史落库/查询路由（M2/T18 写入侧、T19 查询侧）
│   │   ├── src/ffmpeg.ts              # ffmpeg/ffprobe 子进程管理（M3/T20）
│   │   ├── src/mediaJobs.ts           # 文件预处理作业（M3/T21）
│   │   ├── src/exportRoutes.ts        # SRT/TXT/混音 WAV 导出（M3/T25）
│   │   ├── src/meetingRoutes.ts       # 会议 CRUD（M5/T32）
│   │   ├── src/sdpProxy.ts            # WebRTC SDP 交换代理（M6/T34）
│   │   └── test/*.test.ts
│   └── ui/                            # 共享 React 应用（桌面加载构建产物；本身即网页调试端页面）
│       ├── package.json / tsconfig.json / vite.config.ts / index.html（M1/T10）
│       ├── src/main.tsx / App.tsx / styles.css   # 壳 + 路由（M1/T10）
│       ├── src/platform.ts            # PlatformBridge（desktop IPC / web fetch）（M1/T10）
│       ├── src/wsFactory.ts           # 浏览器 WebSocket → WsLike 适配（M2/T18）
│       ├── src/rtcFactory.ts          # 浏览器 RTCPeerConnection → PeerLike 适配（M6/T34）
│       ├── src/api.ts                 # 网关 REST/WS 客户端（M1/T11）
│       ├── src/state/settingsStore.ts # 设置读写 store（M1/T11）
│       ├── src/state/dubPlayback.ts   # 配音回放控制器（注入时钟，可测）（M3/T24）
│       ├── src/audio/micCapture.ts    # getUserMedia+AudioWorklet 采集（M1/T13）
│       ├── src/audio/pcm16-worklet.js # AudioWorkletProcessor（M1/T13）
│       ├── src/audio/playerSink.ts    # WAV blob + setSinkId 播放（M2/T18）
│       ├── src/audio/streamPlayer.ts  # Web Audio 流式播放队列绑定（M4/T27）
│       ├── src/audio/rms.ts           # RMS 音量计算纯函数（M4/T28）
│       ├── src/components/
│       │   ├── TranscriptView.tsx     # text/stash 覆盖渲染（M1/T13）
│       │   ├── SegmentCard.tsx        # 段落卡片+▶回放（M2/T18）
│       │   ├── UsageDashboard.tsx     # token/延迟仪表盘（M2/T18）
│       │   ├── DevicePicker.tsx       # 设备下拉（M4/T28）
│       │   ├── VolumeMeter.tsx        # 实时音量条（M4/T28）
│       │   └── DriftBar.tsx           # 配音漂移可视化（M3/T24）
│       ├── src/wizard/
│       │   ├── wizardRules.ts         # 疑似扬声器判定 + 测试音生成（M4/T28）
│       │   └── ChannelWizard.tsx      # 三步声道向导（M4/T28）
│       ├── src/pages/
│       │   ├── SoloPage.tsx           # 单人测试（M1/T13 文本版，M2/T18 完整版）
│       │   ├── FileDubPage.tsx        # 文件配音双栏工作台（M3/T23）
│       │   ├── InterpreterPage.tsx    # 实时翻译机（M4/T28 向导版，T29 完整版）
│       │   ├── MeetingPage.tsx        # 会议模式（M5/T33）
│       │   ├── HistoryPage.tsx        # 历史（M2/T19）
│       │   └── SettingsPage.tsx       # 设置（M1/T11）
│       └── test/*.test.ts             # 纯逻辑单测（store/控制器）
├── apps/
│   ├── desktop/
│   │   ├── package.json / tsconfig.json（M1/T12）
│   │   ├── src/main.ts                # BrowserWindow + 内嵌网关（M1/T12）
│   │   ├── src/preload.ts             # PlatformBridge 暴露（M1/T12）
│   │   ├── src/keyStore.ts            # safeStorage KeyStore 实现（M1/T12）
│   │   ├── electron-builder.yml       # win/mac 打包（M6/T35）
│   │   └── resources/icon.png         # 应用图标（M6/T35）
│   └── web/
│       └── package.json               # 调试端聚合脚本：并跑 gateway+ui dev（M1/T10）
└── e2e/
    ├── package.json / playwright.config.ts（M6/T36）
    ├── mock/upstream.ts               # mock 百炼 WS 回放器（真实事件结构）（M6/T36）
    ├── mock/boot.ts                   # 一键起 mock 上游 + 网关 + ui preview（M6/T36）
    ├── fixtures/zh-sample.wav         # ffmpeg 生成：假麦克风输入（M6/T36）
    ├── fixtures/dub-input.wav         # ffmpeg 生成：配音源文件（M6/T36）
    └── tests/{solo.spec.ts, filedub.spec.ts, meeting.spec.ts}（M6/T36）
```

## 0.3 任务索引（37 个任务 × 6 里程碑）

| 里程碑 | 任务 | 内容 |
|---|---|---|
| M1 骨架 | T1 | Monorepo 脚手架 + core 包骨架 |
| | T2 | 协议类型 + 真实事件 fixture |
| | T3 | 事件总线 + 事件归一化 normalize |
| | T4 | base64 + WsTransport（P2/P3 生命周期） |
| | T5 | TranscriptModel（P4 覆盖渲染） |
| | T6 | SessionLogger（spec §6.6，必做且前置） |
| | T7 | gateway 骨架 + 设置持久化 + KeyStore |
| | T8 | /realtime WS 中继 + 日志 tap |
| | T9 | 连接自检 selfCheck |
| | T10 | ui 脚手架 + 路由壳 + web 调试端壳 |
| | T11 | 设置页 + 自检按钮 + 热词表管理 |
| | T12 | Electron 壳 + safeStorage + 内嵌网关 |
| | T13 | 麦克风采集 + 单人测试文本流跑通（M1 出口） |
| M2 单人测试完整 | T14 | wav.ts + AudioSegmenter（P9） |
| | T15 | UsageMeter（P6 差分，真实 usage 序列驱动） |
| | T16 | SQLite schema + StorageAdapter + 音频落盘 |
| | T17 | SessionOrchestrator（R2/R3/R4 + 延迟指标） |
| | T18 | 单人测试完整页（段回放/暂停重置/仪表盘/落库） |
| | T19 | 历史页 + 事件日志入口 |
| M3 文件配音 | T20 | ffmpeg 管道（抽音轨/重采样/抽帧） |
| | T21 | FilePipeline 全速预处理 + mediaJobs |
| | T22 | dubTimeline 顺延漂移 |
| | T23 | 双栏工作台 + 原声播放 |
| | T24 | 配音播放控制器 + 漂移可视化 |
| | T25 | 导出：SRT / 双语 TXT / 混音 WAV |
| | T26 | 抽帧视觉增强开关 + 网页端降级 |
| M4 实时翻译机 | T27 | 流式播放队列 PlaybackQueue |
| | T28 | 三步声道向导（强制） |
| | T29 | 全屏字幕运行界面 |
| M5 会议模式 | T30 | MeetingCoordinator 热座状态机 |
| | T31 | rotationPolicy + session 无感轮换 |
| | T32 | 会议存储 + 路由 |
| | T33 | 会议页 + 双语导出 |
| M6 收口 | T34 | SDP 代理 + WebRtcTransport + 自动降级 |
| | T35 | electron-builder 三端打包 |
| | T36 | Playwright E2E 三模式 |
| | T37 | live-smoke 工具 + CI + 终检 |

---

# Milestone 1：骨架

## Task 1: Monorepo 脚手架 + core 包骨架

**Files:**
- Create: `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`
- Modify: `.gitignore`
- Create: `packages/core/package.json`、`packages/core/tsconfig.json`、`packages/core/src/index.ts`、`packages/core/test/sanity.test.ts`

**Step 1: 创建根配置文件**

- [ ] `package.json`：

```json
{
  "name": "livetranslate-tool",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "test": "pnpm -r --if-present test",
    "build": "pnpm -r --if-present build",
    "typecheck": "pnpm -r --if-present typecheck"
  }
}
```

- [ ] `pnpm-workspace.yaml`：

```yaml
packages:
  - packages/*
  - apps/*
  - e2e
```

- [ ] `tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

- [ ] `.gitignore` 末尾追加：

```
node_modules/
dist/
release/
*.tsbuildinfo
.env.local
```

**Step 2: 创建 core 包**

- [ ] `packages/core/package.json`：

```json
{
  "name": "@livetranslate/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.4",
    "vitest": "^2.1.1"
  }
}
```

- [ ] `packages/core/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["vitest/globals"] },
  "include": ["src", "test"]
}
```

- [ ] `packages/core/src/index.ts`：

```ts
export const CORE_VERSION = '0.1.0';
```

- [ ] `packages/core/test/sanity.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { CORE_VERSION } from '../src/index';

describe('workspace sanity', () => {
  it('core package resolves', () => {
    expect(CORE_VERSION).toBe('0.1.0');
  });
});
```

**Step 3: 安装并验证**

- [ ] 运行 `pnpm install`，预期无错误、生成 `pnpm-lock.yaml`。
- [ ] 运行 `pnpm --filter @livetranslate/core test`，预期输出 `1 passed`。
- [ ] 运行 `pnpm --filter @livetranslate/core typecheck`，预期无输出（成功）。

**Step 4: Commit**

- [ ] `git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore pnpm-lock.yaml packages/core; git commit -m "chore: monorepo scaffold with core package"`

## Task 2: 协议类型 + 真实事件 fixture

fixture 内容全部取自真实冒烟日志（`scratch/ws-events.log` 文本模态、`scratch/ws-events-audio.log` 音频模态）。`response.audio.delta` 的 base64 负载按真实首包前缀截断（仅用于结构断言，不做音频内容断言）。

**Files:**
- Create: `packages/core/src/protocol/types.ts`
- Create: `packages/core/test/fixtures/session-created.json`、`session-updated.json`、`text-turn.jsonl`、`audio-turn.jsonl`、`usage-sequence.json`
- Create: `packages/core/test/fixtures.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试**

- [ ] `packages/core/test/fixtures.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerEvent, Usage } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJson = <T>(f: string): T => JSON.parse(readFileSync(join(FIX, f), 'utf8')) as T;
const readJsonl = (f: string): ServerEvent[] =>
  readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServerEvent);

describe('real protocol fixtures', () => {
  it('session.created carries default server config', () => {
    const ev = readJson<ServerEvent>('session-created.json');
    expect(ev.type).toBe('session.created');
    const session = (ev as { session: Record<string, unknown> }).session;
    expect(session.voice).toBe('Tina');
    expect(session.sample_rate).toBe(16000);
  });

  it('text-turn contains full response lifecycle ending with session.finished', () => {
    const evs = readJsonl('text-turn.jsonl');
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe('session.created');
    expect(types).toContain('response.created');
    expect(types).toContain('response.text.text');
    expect(types).toContain('response.done');
    expect(types[types.length - 1]).toBe('session.finished');
  });

  it('text/stash are dual full-refresh fields (stash retract sample present)', () => {
    const evs = readJsonl('text-turn.jsonl');
    const asr = evs.filter((e) => e.type === 'conversation.item.input_audio_transcription.text') as Array<
      ServerEvent & { text: string; stash: string }
    >;
    // 真实回撤样本：stash "今天。" 之后被 "今天天气" 覆盖（句号被回撤）
    expect(asr.map((e) => e.stash)).toEqual(['今天', '今天。', '今天天气']);
    expect(asr.every((e) => e.text === '')).toBe(true);
  });

  it('usage-sequence is session-cumulative (monotonic totals)', () => {
    const seq = readJson<Usage[]>('usage-sequence.json');
    expect(seq.length).toBe(4);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!.total_tokens).toBeGreaterThan(seq[i - 1]!.total_tokens);
      expect(seq[i]!.input_tokens_details.audio_tokens).toBeGreaterThan(seq[i - 1]!.input_tokens_details.audio_tokens);
    }
  });

  it('audio-turn carries audio.delta with base64 payload and audio usage', () => {
    const evs = readJsonl('audio-turn.jsonl');
    const deltas = evs.filter((e) => e.type === 'response.audio.delta') as Array<ServerEvent & { delta: string }>;
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas[0]!.delta.length % 4).toBe(0);
    const done = evs.find((e) => e.type === 'response.done') as ServerEvent & {
      response: { usage: Usage };
    };
    expect(done.response.usage.output_tokens_details.audio_tokens).toBe(51);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/fixtures.test.ts` → 预期 FAIL：`Cannot find module '../src/protocol/types'`。

**Step 3: 实现类型 + 落地 fixture**

- [ ] `packages/core/src/protocol/types.ts`：

```ts
// 与 session.update 线协议字段一一对应（snake_case），spec §4.2。
export type Modality = 'text' | 'audio';
export type VoiceCloneFrequency = 'never' | 'once' | 'always';

export interface SessionConfig {
  modalities: Modality[];
  voice: string; // 预设音色（如 'Tina'）；复刻时必须为 'default'
  enable_voice_clone?: boolean;
  voice_clone_options?: { frequency: VoiceCloneFrequency };
  sample_rate: 16000;
  input_audio_format: 'pcm';
  input_audio_transcription: {
    model: 'qwen3-asr-flash-realtime';
    language?: string; // 缺省 = 自动检测
  };
  translation: {
    language: string;
    corpus?: { phrases: Array<{ source: string; target: string }> };
  };
}

// response.done.usage 真实结构（session 累积值，spec §2.4 / P6）
export interface Usage {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  input_tokens_details: { text_tokens: number; audio_tokens: number };
  output_tokens_details: { text_tokens: number; audio_tokens?: number };
}

// 原始服务端事件：开放结构，具体字段在 normalize.ts 收敛
export interface ServerEvent {
  event_id?: string;
  type: string;
  [key: string]: unknown;
}

// 归一化内部事件（TranscriptModel/AudioSegmenter/UsageMeter 的唯一输入）
export type NormalizedEvent =
  | { kind: 'session-created'; sessionId: string }
  | { kind: 'session-updated' }
  | { kind: 'session-finished' }
  | { kind: 'speech-started'; itemId: string; audioStartMs: number }
  | { kind: 'speech-stopped'; itemId: string; audioEndMs: number }
  | { kind: 'asr-delta'; itemId: string; text: string; stash: string; language: string | null; emotion: string | null }
  | { kind: 'asr-completed'; itemId: string; transcript: string; language: string | null; emotion: string | null }
  | { kind: 'response-created'; responseId: string }
  | { kind: 'translation-delta'; responseId: string; text: string; stash: string }
  | { kind: 'translation-done'; responseId: string; text: string }
  | { kind: 'audio-delta'; responseId: string; base64: string }
  | { kind: 'response-done'; responseId: string; usage: Usage | null }
  | { kind: 'server-error'; code: string; message: string; raw: ServerEvent };

export type NormalizedKind = NormalizedEvent['kind'];

export type RawDirection = 'c2s' | 's2c';

// spec §4.1 ITranslateTransport
export interface ITranslateTransport {
  connect(cfg: SessionConfig): Promise<void>; // 建连 + session.update + 等待 session.updated
  updateSession(patch: Partial<SessionConfig>): Promise<void>;
  appendAudio(pcm16: ArrayBuffer): void; // WS: base64 append；WebRTC: 写入音轨
  appendImage(jpegBase64: string): void; // 统一走事件通道
  finish(): Promise<void>; // session.finish → 等 session.finished → close（10s 兜底）
  abort(): void; // 立即断开（重置用）
  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void;
  onRaw(cb: (dir: RawDirection, payload: ServerEvent) => void): () => void; // SessionLogger tap
  readonly kind: 'ws' | 'webrtc';
  getRemoteAudio(): MediaStream | null; // webrtc 专用；ws 恒 null
}
```

- [ ] `packages/core/test/fixtures/session-created.json`（真实记录原文）：

```json
{"event_id":"event_04cIDHwiM-gHSc0rSktQG","type":"session.created","session":{"sample_rate":16000,"output_audio_format":"pcm","modalities":["text","audio"],"id":"sess_WvWctgpr1Qpcjq53Spt0p","turn_detection":{"type":"server_vad","silence_duration_ms":1000,"threshold":0.2},"translation":{"language":"en"},"model":"qwen3.5-livetranslate-flash-realtime","voice":"Tina","input_audio_format":"pcm","object":"realtime.session"}}
```

- [ ] `packages/core/test/fixtures/session-updated.json`（真实记录原文）：

```json
{"event_id":"event_LeMzktihD8XBww4cfuH3h","type":"session.updated","session":{"id":"sess_WvWctgpr1Qpcjq53Spt0p","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime","modalities":["text"],"voice":"Tina","input_audio_format":"pcm","output_audio_format":"pcm","input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"zh"},"turn_detection":{"type":"server_vad","threshold":0.2,"silence_duration_ms":1000,"create_response":true,"interrupt_response":true},"translation":{"language":"en"},"sample_rate":16000}}
```

- [ ] `packages/core/test/fixtures/text-turn.jsonl`（16 行，全部为真实事件原文，按真实顺序）：

```
{"event_id":"event_04cIDHwiM-gHSc0rSktQG","type":"session.created","session":{"sample_rate":16000,"output_audio_format":"pcm","modalities":["text","audio"],"id":"sess_WvWctgpr1Qpcjq53Spt0p","turn_detection":{"type":"server_vad","silence_duration_ms":1000,"threshold":0.2},"translation":{"language":"en"},"model":"qwen3.5-livetranslate-flash-realtime","voice":"Tina","input_audio_format":"pcm","object":"realtime.session"}}
{"event_id":"event_LeMzktihD8XBww4cfuH3h","type":"session.updated","session":{"id":"sess_WvWctgpr1Qpcjq53Spt0p","object":"realtime.session","model":"qwen3.5-livetranslate-flash-realtime","modalities":["text"],"voice":"Tina","input_audio_format":"pcm","output_audio_format":"pcm","input_audio_transcription":{"model":"qwen3-asr-flash-realtime","language":"zh"},"turn_detection":{"type":"server_vad","threshold":0.2,"silence_duration_ms":1000,"create_response":true,"interrupt_response":true},"translation":{"language":"en"},"sample_rate":16000}}
{"event_id":"event_KQp4J3V5I6hoTtyoLGIqQ","type":"input_audio_buffer.speech_started","audio_start_ms":0,"item_id":"item_FH6AWn7AAj9uQqTZtTH8s"}
{"event_id":"event_KAP6cLbLKmWw3TufLGOHK","type":"conversation.item.input_audio_transcription.text","item_id":"item_FH6AWn7AAj9uQqTZtTH8s","content_index":0,"text":"","stash":"今天","language":"zh","emotion":"neutral"}
{"event_id":"event_IyBtabABrpMBq28MpSweC","type":"conversation.item.input_audio_transcription.text","item_id":"item_FH6AWn7AAj9uQqTZtTH8s","content_index":0,"text":"","stash":"今天。","language":"zh","emotion":"neutral"}
{"event_id":"event_UmV28XdNica78g9rBsiPI","type":"conversation.item.input_audio_transcription.text","item_id":"item_FH6AWn7AAj9uQqTZtTH8s","content_index":0,"text":"","stash":"今天天气","language":"zh","emotion":"neutral"}
{"event_id":"event_Tp8oJsVkvtM1knjv7tPOR","type":"response.created","response":{"id":"resp_C7BkFOHX9LQHXjIc4RWPJ","object":"realtime.response","conversation_id":"","status":"in_progress","modalities":["text"],"voice":"Tina","output_audio_format":"pcm","output":[]}}
{"event_id":"event_VFgzUwsFdvAQlXUagzkBg","type":"response.text.text","response_id":"resp_C7BkFOHX9LQHXjIc4RWPJ","item_id":"item_U4r3ZbvN3OxFIfRCv4YJN","output_index":0,"content_index":0,"text":"","stash":"Today"}
{"event_id":"event_NecAdVRH7xNoX3FpCd1xX","type":"response.text.text","response_id":"resp_C7BkFOHX9LQHXjIc4RWPJ","item_id":"item_U4r3ZbvN3OxFIfRCv4YJN","output_index":0,"content_index":0,"text":"The weather is very nice today,","stash":""}
{"event_id":"event_EXnvfeogexu7Xc7ShlDkj","type":"response.text.text","response_id":"resp_C7BkFOHX9LQHXjIc4RWPJ","item_id":"item_U4r3ZbvN3OxFIfRCv4YJN","output_index":0,"content_index":0,"text":"The weather is very nice today,","stash":" let's go for a walk in the park together."}
{"event_id":"event_TW4lKHezmFtlNpKdBjPnv","type":"input_audio_buffer.speech_stopped","audio_end_ms":4600,"item_id":"item_FH6AWn7AAj9uQqTZtTH8s"}
{"text":"The weather is very nice today, let's go for a walk in the park together.  ","event_id":"event_HOZou6FMGod3u1wNwhWa5","type":"response.text.done","response_id":"resp_C7BkFOHX9LQHXjIc4RWPJ","item_id":"item_U4r3ZbvN3OxFIfRCv4YJN","output_index":0,"content_index":0}
{"event_id":"event_XFfjaraKaFDSsC3qcjD3I","type":"conversation.item.input_audio_transcription.completed","item_id":"item_FH6AWn7AAj9uQqTZtTH8s","content_index":0,"transcript":"今天天气很好，我们一起去公园散步。","language":"zh","emotion":"neutral"}
{"event_id":"event_JJCNEnhGsf2oVqfpvXk5J","type":"response.content_part.done","response_id":"resp_C7BkFOHX9LQHXjIc4RWPJ","item_id":"item_U4r3ZbvN3OxFIfRCv4YJN","output_index":0,"content_index":0,"part":{"type":"text","text":"The weather is very nice today, let's go for a walk in the park together.  "}}
{"event_id":"event_Ax8JnFdDpmipJWrbqjD7h","type":"response.done","response":{"id":"resp_C7BkFOHX9LQHXjIc4RWPJ","object":"realtime.response","conversation_id":"conv_AAE53CKKlQ7Rc88lL2CCG","status":"completed","modalities":["text"],"voice":"Tina","output_audio_format":"pcm","output":[{"id":"item_U4r3ZbvN3OxFIfRCv4YJN","object":"realtime.item","type":"message","status":"completed","role":"assistant","content":[{"type":"text","text":"The weather is very nice today, let's go for a walk in the park together.  "}]}],"usage":{"total_tokens":118,"input_tokens":85,"output_tokens":33,"input_tokens_details":{"text_tokens":50,"audio_tokens":35},"output_tokens_details":{"text_tokens":33}}}}
{"event_id":"event_KUxFd6MLbPFxiFQ9m9loU","type":"session.finished"}
```

- [ ] `packages/core/test/fixtures/audio-turn.jsonl`（9 行；两条 `response.audio.delta` 的 `delta` 为真实首包前 88 字符（Base64 4 对齐截断，真实单包长 20692），其余全部为真实事件原文）：

```
{"event_id":"event_USf1cTpfzPnFDlDCikzcL","type":"input_audio_buffer.speech_started","audio_start_ms":0,"item_id":"item_C5mMCl3pJ817oFtlWdKwG"}
{"event_id":"event_IDQQM6ScnePupAxVfkpEZ","type":"response.created","response":{"id":"resp_MlgY53L3GmUfaCHIxXiHh","object":"realtime.response","conversation_id":"","status":"in_progress","modalities":["text","audio"],"voice":"Tina","output_audio_format":"pcm","output":[]}}
{"event_id":"event_Zqr4kFEgeYjPiQ6VybPGd","type":"response.audio_transcript.text","response_id":"resp_MlgY53L3GmUfaCHIxXiHh","item_id":"item_EZ1S6QABBkxhDTc361p5n","output_index":0,"content_index":0,"text":"","stash":"Today"}
{"event_id":"event_YPsHuwf6cbToC1fn1qmAH","type":"response.audio.delta","response_id":"resp_MlgY53L3GmUfaCHIxXiHh","item_id":"item_EZ1S6QABBkxhDTc361p5n","output_index":0,"content_index":0,"delta":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
{"event_id":"event_Qf3V1zS8TB7iicvNLuvZH","type":"response.audio.delta","response_id":"resp_MlgY53L3GmUfaCHIxXiHh","item_id":"item_EZ1S6QABBkxhDTc361p5n","output_index":0,"content_index":0,"delta":"AdaB2YHlwfIF/bMDfws/Fx8ffyH/J38vvzS/NH8yvzW/Mn8yPyk/In8YPxB/CXcBzv9Z+lH0wfBh8eHvIfCR8rn5"}
{"event_id":"event_V3y7Kse6qIjaaFK5Czpgo","type":"response.audio_transcript.done","response_id":"resp_MlgY53L3GmUfaCHIxXiHh","item_id":"item_EZ1S6QABBkxhDTc361p5n","output_index":0,"content_index":0,"transcript":"The weather is very nice today, let's go for a walk in the park together.  "}
{"event_id":"event_Kc29HgdQN3kyCKOu1URPk","type":"response.audio.done","response_id":"resp_MlgY53L3GmUfaCHIxXiHh","item_id":"item_EZ1S6QABBkxhDTc361p5n","output_index":0,"content_index":0}
{"event_id":"event_Qe8JFYMdCSLZnaIbok4mY","type":"input_audio_buffer.speech_stopped","audio_end_ms":4600,"item_id":"item_C5mMCl3pJ817oFtlWdKwG"}
{"event_id":"event_GSBKybnFkPkNR8rcY3YSY","type":"response.done","response":{"id":"resp_MlgY53L3GmUfaCHIxXiHh","object":"realtime.response","conversation_id":"conv_PsWwzeG5voY2Gd6fphrTq","status":"completed","modalities":["text","audio"],"voice":"Tina","output_audio_format":"pcm","output":[{"id":"item_EZ1S6QABBkxhDTc361p5n","object":"realtime.item","type":"message","status":"completed","role":"assistant","content":[{"type":"audio","transcript":"The weather is very nice today, let's go for a walk in the park together.  "}]}],"usage":{"total_tokens":169,"input_tokens":85,"output_tokens":84,"input_tokens_details":{"text_tokens":50,"audio_tokens":35},"output_tokens_details":{"text_tokens":33,"audio_tokens":51}}}}
```

- [ ] `packages/core/test/fixtures/usage-sequence.json`（真实 4 连 response 累积 usage，来自音频模态冒烟日志）：

```json
[
  {"total_tokens":169,"input_tokens":85,"output_tokens":84,"input_tokens_details":{"text_tokens":50,"audio_tokens":35},"output_tokens_details":{"text_tokens":33,"audio_tokens":51}},
  {"total_tokens":436,"input_tokens":197,"output_tokens":239,"input_tokens_details":{"text_tokens":113,"audio_tokens":84},"output_tokens_details":{"text_tokens":89,"audio_tokens":150}},
  {"total_tokens":697,"input_tokens":308,"output_tokens":389,"input_tokens_details":{"text_tokens":175,"audio_tokens":133},"output_tokens_details":{"text_tokens":148,"audio_tokens":241}},
  {"total_tokens":972,"input_tokens":434,"output_tokens":538,"input_tokens_details":{"text_tokens":245,"audio_tokens":189},"output_tokens_details":{"text_tokens":211,"audio_tokens":327}}
]
```

- [ ] 修改 `packages/core/src/index.ts` 为：

```ts
export const CORE_VERSION = '0.1.0';
export * from './protocol/types';
```

**Step 4: 运行确认通过**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/fixtures.test.ts` → 预期 `5 passed`。
- [ ] `pnpm --filter @livetranslate/core typecheck` → 预期无输出。

**Step 5: Commit**

- [ ] `git add packages/core; git commit -m "feat(core): protocol types and real event fixtures"`

## Task 3: 事件总线 + 事件归一化 normalize

**Files:**
- Create: `packages/core/src/protocol/emitter.ts`、`packages/core/src/protocol/normalize.ts`
- Create: `packages/core/test/emitter.test.ts`、`packages/core/test/normalize.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试（emitter）**

- [ ] `packages/core/test/emitter.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { Emitter } from '../src/protocol/emitter';

type TestMap = { foo: number; bar: string };

describe('Emitter', () => {
  it('delivers payload to subscribers of the same key only', () => {
    const em = new Emitter<TestMap>();
    const onFoo = vi.fn();
    const onBar = vi.fn();
    em.on('foo', onFoo);
    em.on('bar', onBar);
    em.emit('foo', 42);
    expect(onFoo).toHaveBeenCalledWith(42);
    expect(onBar).not.toHaveBeenCalled();
  });

  it('unsubscribe function removes the handler', () => {
    const em = new Emitter<TestMap>();
    const cb = vi.fn();
    const off = em.on('foo', cb);
    off();
    em.emit('foo', 1);
    expect(cb).not.toHaveBeenCalled();
  });

  it('clear() removes all handlers', () => {
    const em = new Emitter<TestMap>();
    const cb = vi.fn();
    em.on('bar', cb);
    em.clear();
    em.emit('bar', 'x');
    expect(cb).not.toHaveBeenCalled();
  });
});
```

**Step 2: 写失败测试（normalize，真实 fixture 驱动）**

- [ ] `packages/core/test/normalize.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeServerEvent } from '../src/protocol/normalize';
import type { NormalizedEvent, ServerEvent } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJsonl = (f: string): ServerEvent[] =>
  readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServerEvent);
const normalizeAll = (f: string): NormalizedEvent[] =>
  readJsonl(f).map(normalizeServerEvent).filter((e): e is NormalizedEvent => e !== null);

describe('normalizeServerEvent (driven by real fixtures)', () => {
  it('maps text-turn.jsonl to the expected kind sequence (content_part.done is dropped)', () => {
    const kinds = normalizeAll('text-turn.jsonl').map((e) => e.kind);
    expect(kinds).toEqual([
      'session-created', 'session-updated', 'speech-started',
      'asr-delta', 'asr-delta', 'asr-delta',
      'response-created', 'translation-delta', 'translation-delta', 'translation-delta',
      'speech-stopped', 'translation-done', 'asr-completed',
      'response-done', 'session-finished',
    ]);
  });

  it('asr-delta keeps text/stash/language/emotion (incl. real stash retract)', () => {
    const asr = normalizeAll('text-turn.jsonl').filter((e) => e.kind === 'asr-delta');
    expect(asr.map((e) => e.kind === 'asr-delta' && e.stash)).toEqual(['今天', '今天。', '今天天气']);
    const first = asr[0]!;
    if (first.kind !== 'asr-delta') throw new Error('unreachable');
    expect(first.language).toBe('zh');
    expect(first.emotion).toBe('neutral');
  });

  it('translation-done carries the final text; response-done carries cumulative usage', () => {
    const evs = normalizeAll('text-turn.jsonl');
    const done = evs.find((e) => e.kind === 'translation-done');
    if (done?.kind !== 'translation-done') throw new Error('missing translation-done');
    expect(done.text).toBe("The weather is very nice today, let's go for a walk in the park together.  ");
    const rd = evs.find((e) => e.kind === 'response-done');
    if (rd?.kind !== 'response-done') throw new Error('missing response-done');
    expect(rd.usage?.total_tokens).toBe(118);
  });

  it('audio modality: audio_transcript.text → translation-delta; audio.delta → audio-delta; audio.done is dropped', () => {
    const evs = normalizeAll('audio-turn.jsonl');
    const kinds = evs.map((e) => e.kind);
    expect(kinds).toEqual([
      'speech-started', 'response-created', 'translation-delta',
      'audio-delta', 'audio-delta', 'translation-done',
      'speech-stopped', 'response-done',
    ]);
    const delta = evs.find((e) => e.kind === 'audio-delta');
    if (delta?.kind !== 'audio-delta') throw new Error('missing audio-delta');
    expect(delta.responseId).toBe('resp_MlgY53L3GmUfaCHIxXiHh');
    expect(delta.base64.length % 4).toBe(0);
  });

  it('error event → server-error; unknown type → null', () => {
    const err = normalizeServerEvent({ type: 'error', error: { code: 'invalid_request', message: 'bad' } });
    expect(err).toEqual({
      kind: 'server-error', code: 'invalid_request', message: 'bad',
      raw: { type: 'error', error: { code: 'invalid_request', message: 'bad' } },
    });
    expect(normalizeServerEvent({ type: 'rate_limits.updated' })).toBeNull();
  });
});
```

**Step 3: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/emitter.test.ts test/normalize.test.ts` → 预期 FAIL：`Cannot find module '../src/protocol/emitter'` 与 `Cannot find module '../src/protocol/normalize'`。

**Step 4: 最小实现**

- [ ] `packages/core/src/protocol/emitter.ts`：

```ts
export type Handler<T> = (payload: T) => void;

export class Emitter<EventMap extends Record<string, unknown>> {
  private handlers = new Map<keyof EventMap, Set<Handler<never>>>();

  on<K extends keyof EventMap>(key: K, cb: Handler<EventMap[K]>): () => void {
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(cb as Handler<never>);
    return () => {
      set.delete(cb as Handler<never>);
    };
  }

  emit<K extends keyof EventMap>(key: K, payload: EventMap[K]): void {
    this.handlers.get(key)?.forEach((cb) => (cb as Handler<EventMap[K]>)(payload));
  }

  clear(): void {
    this.handlers.clear();
  }
}
```

- [ ] `packages/core/src/protocol/normalize.ts`：

```ts
import type { NormalizedEvent, ServerEvent, Usage } from './types';

type Rec = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// 原始服务端事件 → 归一化事件；与业务无关的事件（content_part/audio.done/rate_limits 等）返回 null。
// 事件名与字段全部来自真实冒烟日志（P4/P5/P6/P9）。
export function normalizeServerEvent(ev: ServerEvent): NormalizedEvent | null {
  switch (ev.type) {
    case 'session.created':
      return { kind: 'session-created', sessionId: str((ev.session as Rec | undefined)?.id) };
    case 'session.updated':
      return { kind: 'session-updated' };
    case 'session.finished':
      return { kind: 'session-finished' };
    case 'input_audio_buffer.speech_started':
      return { kind: 'speech-started', itemId: str(ev.item_id), audioStartMs: num(ev.audio_start_ms) };
    case 'input_audio_buffer.speech_stopped':
      return { kind: 'speech-stopped', itemId: str(ev.item_id), audioEndMs: num(ev.audio_end_ms) };
    case 'conversation.item.input_audio_transcription.text':
      return {
        kind: 'asr-delta', itemId: str(ev.item_id), text: str(ev.text), stash: str(ev.stash),
        language: strOrNull(ev.language), emotion: strOrNull(ev.emotion),
      };
    case 'conversation.item.input_audio_transcription.completed':
      return {
        kind: 'asr-completed', itemId: str(ev.item_id), transcript: str(ev.transcript),
        language: strOrNull(ev.language), emotion: strOrNull(ev.emotion),
      };
    case 'response.created':
      return { kind: 'response-created', responseId: str((ev.response as Rec | undefined)?.id) };
    case 'response.text.text':
    case 'response.audio_transcript.text':
      return { kind: 'translation-delta', responseId: str(ev.response_id), text: str(ev.text), stash: str(ev.stash) };
    case 'response.text.done':
      return { kind: 'translation-done', responseId: str(ev.response_id), text: str(ev.text) };
    case 'response.audio_transcript.done':
      return { kind: 'translation-done', responseId: str(ev.response_id), text: str(ev.transcript) };
    case 'response.audio.delta':
      return { kind: 'audio-delta', responseId: str(ev.response_id), base64: str(ev.delta) };
    case 'response.done': {
      const resp = ev.response as Rec | undefined;
      return { kind: 'response-done', responseId: str(resp?.id), usage: (resp?.usage as Usage | undefined) ?? null };
    }
    case 'error': {
      const err = (ev.error as Rec | undefined) ?? ev;
      return { kind: 'server-error', code: str(err.code ?? err.type), message: str(err.message), raw: ev };
    }
    default:
      return null;
  }
}
```

- [ ] `packages/core/src/index.ts` 追加两行导出：

```ts
export { Emitter } from './protocol/emitter';
export { normalizeServerEvent } from './protocol/normalize';
```

**Step 5: 运行确认通过**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/emitter.test.ts test/normalize.test.ts` → 预期 `8 passed`。

**Step 6: Commit**

- [ ] `git add packages/core; git commit -m "feat(core): typed emitter and server event normalization"`

## Task 4: base64 工具 + WsTransport（P2/P3 生命周期）

WsTransport 接受注入的 `wsFactory`（返回浏览器 WebSocket 兼容的 `WsLike`），测试用 FakeWs 回放真实 fixture，不碰网络。渲染端实际连接的是网关中继 URL（Task 8），URL 由调用方传入。

**Files:**
- Create: `packages/core/src/audio/base64.ts`、`packages/core/src/protocol/wsTransport.ts`
- Create: `packages/core/test/base64.test.ts`、`packages/core/test/wsTransport.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试（base64）**

- [ ] `packages/core/test/base64.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { bytesToBase64, base64ToBytes } from '../src/audio/base64';

describe('base64', () => {
  it('round-trips arbitrary bytes', () => {
    const src = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(src))).toEqual(src);
  });

  it('handles a 3200-byte PCM chunk (P7 chunk size)', () => {
    const chunk = new Uint8Array(3200).map((_, i) => i % 256);
    const b64 = bytesToBase64(chunk);
    expect(b64.length % 4).toBe(0);
    expect(base64ToBytes(b64)).toEqual(chunk);
  });

  it('decodes the real first audio.delta prefix', () => {
    const real = 'AdaB2YHlwfIF/bMDfws/Fx8ffyH/J38vvzS/NH8yvzW/Mn8yPyk/In8YPxB/CXcBzv9Z+lH0wfBh8eHvIfCR8rn5';
    const bytes = base64ToBytes(real);
    expect(bytes.length).toBe(66);
  });
});
```

**Step 2: 写失败测试（WsTransport）**

- [ ] `packages/core/test/wsTransport.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WsTransport, type WsLike } from '../src/protocol/wsTransport';
import type { ServerEvent, SessionConfig } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJsonl = (f: string): ServerEvent[] =>
  readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServerEvent);

class FakeWs implements WsLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  // 测试辅助
  open(): void { this.onopen?.(); }
  push(ev: ServerEvent): void { this.onmessage?.(JSON.stringify(ev)); }
}

const CFG: SessionConfig = {
  modalities: ['text'],
  voice: 'Tina',
  sample_rate: 16000,
  input_audio_format: 'pcm',
  input_audio_transcription: { model: 'qwen3-asr-flash-realtime', language: 'zh' },
  translation: { language: 'en' },
};

function setup() {
  const fake = new FakeWs();
  const t = new WsTransport({ url: 'ws://gateway.test/realtime', wsFactory: () => fake });
  return { fake, t };
}

describe('WsTransport', () => {
  it('connect(): open → session.created → sends session.update → resolves on session.updated (P2)', async () => {
    const { fake, t } = setup();
    const p = t.connect(CFG);
    fake.open();
    fake.push({ type: 'session.created', session: { id: 'sess_1' } });
    expect(JSON.parse(fake.sent[0]!)).toEqual({ type: 'session.update', session: CFG });
    fake.push({ type: 'session.updated' });
    await expect(p).resolves.toBeUndefined();
    expect(t.kind).toBe('ws');
    expect(t.getRemoteAudio()).toBeNull();
  });

  it('replays the full real text turn and emits normalized events in order', async () => {
    const { fake, t } = setup();
    const kinds: string[] = [];
    (['asr-delta', 'translation-delta', 'translation-done', 'response-done', 'session-finished'] as const)
      .forEach((k) => t.on(k, (ev) => kinds.push(ev.kind)));
    const p = t.connect(CFG);
    fake.open();
    for (const ev of readJsonl('text-turn.jsonl')) fake.push(ev);
    await p;
    expect(kinds.filter((k) => k === 'asr-delta').length).toBe(3);
    expect(kinds.filter((k) => k === 'translation-delta').length).toBe(3);
    expect(kinds[kinds.length - 1]).toBe('session-finished');
  });

  it('appendAudio(): base64-encodes into input_audio_buffer.append (P7)', async () => {
    const { fake, t } = setup();
    const p = t.connect(CFG);
    fake.open();
    fake.push({ type: 'session.created', session: { id: 'sess_1' } });
    fake.push({ type: 'session.updated' });
    await p;
    const pcm = new Uint8Array(3200).fill(7);
    t.appendAudio(pcm.buffer);
    const msg = JSON.parse(fake.sent[1]!) as { type: string; audio: string };
    expect(msg.type).toBe('input_audio_buffer.append');
    expect(msg.audio.length).toBe(Math.ceil(3200 / 3) * 4);
  });

  it('appendImage(): sends input_image_buffer.append (P11)', async () => {
    const { fake, t } = setup();
    const p = t.connect(CFG);
    fake.open();
    fake.push({ type: 'session.created', session: { id: 'sess_1' } });
    fake.push({ type: 'session.updated' });
    await p;
    t.appendImage('aGVsbG8=');
    expect(JSON.parse(fake.sent[1]!)).toEqual({ type: 'input_image_buffer.append', image: 'aGVsbG8=' });
  });

  it('finish(): sends session.finish, closes AFTER session.finished (P3 client-side close)', async () => {
    const { fake, t } = setup();
    const p = t.connect(CFG);
    fake.open();
    fake.push({ type: 'session.created', session: { id: 'sess_1' } });
    fake.push({ type: 'session.updated' });
    await p;
    const fin = t.finish();
    expect(JSON.parse(fake.sent[1]!)).toEqual({ type: 'session.finish' });
    expect(fake.closed).toBe(false); // 服务端不断链，客户端必须自己 close
    fake.push({ type: 'session.finished' });
    await fin;
    expect(fake.closed).toBe(true);
  });

  it('finish(): force-closes after 10s if session.finished never arrives (P3 timeout)', async () => {
    vi.useFakeTimers();
    try {
      const { fake, t } = setup();
      const p = t.connect(CFG);
      fake.open();
      fake.push({ type: 'session.created', session: { id: 'sess_1' } });
      fake.push({ type: 'session.updated' });
      await p;
      const fin = t.finish();
      await vi.advanceTimersByTimeAsync(10_000);
      await fin;
      expect(fake.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onRaw taps both directions for SessionLogger', async () => {
    const { fake, t } = setup();
    const taps: Array<[string, string]> = [];
    t.onRaw((dir, payload) => taps.push([dir, payload.type]));
    const p = t.connect(CFG);
    fake.open();
    fake.push({ type: 'session.created', session: { id: 'sess_1' } });
    fake.push({ type: 'session.updated' });
    await p;
    expect(taps).toEqual([
      ['s2c', 'session.created'],
      ['c2s', 'session.update'],
      ['s2c', 'session.updated'],
    ]);
  });
});
```

**Step 3: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/base64.test.ts test/wsTransport.test.ts` → 预期 FAIL：`Cannot find module '../src/audio/base64'` 与 `Cannot find module '../src/protocol/wsTransport'`。

**Step 4: 最小实现**

- [ ] `packages/core/src/audio/base64.ts`（Node 与浏览器通用，不依赖 Buffer）：

```ts
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const REVERSE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) REVERSE[ALPHABET.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += ALPHABET[b0 >> 2]! + ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]!;
    out += i + 1 < bytes.length ? ALPHABET[((b1 & 15) << 2) | (b2 >> 6)]! : '=';
    out += i + 2 < bytes.length ? ALPHABET[b2 & 63]! : '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const outLen = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = REVERSE[clean.charCodeAt(i)]!;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
```

- [ ] `packages/core/src/protocol/wsTransport.ts`：

```ts
import { Emitter } from './emitter';
import { normalizeServerEvent } from './normalize';
import { bytesToBase64 } from '../audio/base64';
import type {
  ITranslateTransport, NormalizedEvent, NormalizedKind, RawDirection, ServerEvent, SessionConfig,
} from './types';

// 浏览器 WebSocket / Node ws 都能适配的最小接口；测试用 FakeWs 实现。
export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
}

export interface WsTransportOptions {
  url: string; // 网关中继地址（Task 8），非百炼直连；Key 永不经过渲染端
  wsFactory: (url: string) => WsLike;
  finishTimeoutMs?: number; // P3 兜底，默认 10s
}

type EventMap = { [K in NormalizedKind]: Extract<NormalizedEvent, { kind: K }> };

export class WsTransport implements ITranslateTransport {
  readonly kind = 'ws' as const;
  private ws: WsLike | null = null;
  private emitter = new Emitter<EventMap>();
  private rawTaps = new Set<(dir: RawDirection, payload: ServerEvent) => void>();
  private finishTimeoutMs: number;

  constructor(private opts: WsTransportOptions) {
    this.finishTimeoutMs = opts.finishTimeoutMs ?? 10_000;
  }

  connect(cfg: SessionConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.opts.wsFactory(this.opts.url);
      this.ws = ws;
      let settled = false;
      ws.onerror = (err) => {
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      ws.onmessage = (data) => {
        const ev = JSON.parse(data) as ServerEvent;
        this.rawTaps.forEach((tap) => tap('s2c', ev));
        if (ev.type === 'session.created') {
          this.sendJson({ type: 'session.update', session: cfg });
        }
        if (ev.type === 'session.updated' && !settled) {
          settled = true;
          resolve();
        }
        const norm = normalizeServerEvent(ev);
        if (norm) this.emitter.emit(norm.kind, norm as never);
      };
      ws.onopen = () => {
        // 百炼在建连后主动推 session.created（P2），这里无需发送任何东西
      };
      ws.onclose = () => {
        this.ws = null;
      };
    });
  }

  updateSession(patch: Partial<SessionConfig>): Promise<void> {
    this.sendJson({ type: 'session.update', session: patch });
    return Promise.resolve();
  }

  appendAudio(pcm16: ArrayBuffer): void {
    this.sendJson({ type: 'input_audio_buffer.append', audio: bytesToBase64(new Uint8Array(pcm16)) });
  }

  appendImage(jpegBase64: string): void {
    this.sendJson({ type: 'input_image_buffer.append', image: jpegBase64 });
  }

  finish(): Promise<void> {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        off();
        ws.close(); // P3 兜底：服务端永不断链，超时强制断开
        resolve();
      }, this.finishTimeoutMs);
      const off = this.emitter.on('session-finished', () => {
        clearTimeout(timer);
        off();
        ws.close(); // P3：收到 finished 后客户端主动 close
        resolve();
      });
      this.sendJson({ type: 'session.finish' });
    });
  }

  abort(): void {
    this.ws?.close();
    this.ws = null;
  }

  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void {
    return this.emitter.on(kind, cb);
  }

  onRaw(cb: (dir: RawDirection, payload: ServerEvent) => void): () => void {
    this.rawTaps.add(cb);
    return () => this.rawTaps.delete(cb);
  }

  getRemoteAudio(): MediaStream | null {
    return null;
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (!this.ws) throw new Error('WsTransport: not connected');
    this.rawTaps.forEach((tap) => tap('c2s', obj as ServerEvent));
    this.ws.send(JSON.stringify(obj));
  }
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { bytesToBase64, base64ToBytes } from './audio/base64';
export { WsTransport, type WsLike, type WsTransportOptions } from './protocol/wsTransport';
```

**Step 5: 运行确认通过**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/base64.test.ts test/wsTransport.test.ts` → 预期 `10 passed`。

**Step 6: Commit**

- [ ] `git add packages/core; git commit -m "feat(core): WsTransport with real-protocol lifecycle (P2/P3)"`

## Task 5: TranscriptModel（P4 覆盖渲染状态机）

段落状态机（spec §4.4）：`translating`（text+stash 覆盖刷新）→ `done`（固化）；断线时进行中段落标 `interrupted`（R3）。输入为 NormalizedEvent，输出为不可变段落快照数组，供 React 直接渲染。

**Files:**
- Create: `packages/core/src/session/transcriptModel.ts`
- Create: `packages/core/test/transcriptModel.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试**

- [ ] `packages/core/test/transcriptModel.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptModel } from '../src/session/transcriptModel';
import { normalizeServerEvent } from '../src/protocol/normalize';
import type { ServerEvent } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJsonl = (f: string): ServerEvent[] =>
  readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServerEvent);

function feed(model: TranscriptModel, f: string): void {
  for (const ev of readJsonl(f)) {
    const n = normalizeServerEvent(ev);
    if (n) model.apply(n);
  }
}

describe('TranscriptModel', () => {
  it('replays the real text turn into one done segment with source and target', () => {
    const m = new TranscriptModel();
    feed(m, 'text-turn.jsonl');
    const segs = m.getSegments();
    expect(segs.length).toBe(1);
    const s = segs[0]!;
    expect(s.status).toBe('done');
    expect(s.seq).toBe(1);
    expect(s.responseId).toBe('resp_C7BkFOHX9LQHXjIc4RWPJ');
    expect(s.sourceText).toBe('今天天气很好，我们一起去公园散步。');
    expect(s.targetText).toBe("The weather is very nice today, let's go for a walk in the park together.  ");
    expect(s.sourceLang).toBe('zh');
    expect(s.emotion).toBe('neutral');
    expect(s.vadStartMs).toBe(0);
    expect(s.vadEndMs).toBe(4600);
    expect(s.usage?.total_tokens).toBe(118);
  });

  it('overwrite semantics: stash retract replaces the whole field, never appends (P4)', () => {
    const m = new TranscriptModel();
    m.apply({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
    m.apply({ kind: 'asr-delta', itemId: 'i1', text: '', stash: '今天。', language: 'zh', emotion: 'neutral' });
    m.apply({ kind: 'asr-delta', itemId: 'i1', text: '', stash: '今天天气', language: 'zh', emotion: 'neutral' });
    const s = m.getSegments()[0]!;
    expect(s.sourceStash).toBe('今天天气'); // 句号被回撤，不是 '今天。今天天气'
    expect(s.sourceText).toBe('');
  });

  it('translation-delta before speech-stopped binds to the current open segment', () => {
    const m = new TranscriptModel();
    m.apply({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
    m.apply({ kind: 'response-created', responseId: 'r1' });
    m.apply({ kind: 'translation-delta', responseId: 'r1', text: 'Hello', stash: ' wor' });
    const s = m.getSegments()[0]!;
    expect(s.responseId).toBe('r1');
    expect(s.targetText).toBe('Hello');
    expect(s.targetStash).toBe(' wor');
    expect(s.status).toBe('translating');
  });

  it('response-done fixes the segment and clears stash', () => {
    const m = new TranscriptModel();
    m.apply({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
    m.apply({ kind: 'response-created', responseId: 'r1' });
    m.apply({ kind: 'translation-delta', responseId: 'r1', text: '', stash: 'Hi' });
    m.apply({ kind: 'translation-done', responseId: 'r1', text: 'Hi there' });
    m.apply({ kind: 'response-done', responseId: 'r1', usage: null });
    const s = m.getSegments()[0]!;
    expect(s.status).toBe('done');
    expect(s.targetText).toBe('Hi there');
    expect(s.targetStash).toBe('');
  });

  it('markInterrupted() flags in-flight segments only (R3)', () => {
    const m = new TranscriptModel();
    m.apply({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
    m.apply({ kind: 'response-created', responseId: 'r1' });
    m.apply({ kind: 'translation-done', responseId: 'r1', text: 'done one' });
    m.apply({ kind: 'response-done', responseId: 'r1', usage: null });
    m.apply({ kind: 'speech-started', itemId: 'i2', audioStartMs: 5000 });
    m.apply({ kind: 'response-created', responseId: 'r2' });
    m.markInterrupted();
    const [a, b] = m.getSegments();
    expect(a!.status).toBe('done');
    expect(b!.status).toBe('interrupted');
  });

  it('audio turn: consecutive turns get increasing seq; listener fires on every change', () => {
    const m = new TranscriptModel();
    const snapshots: number[] = [];
    m.onChange(() => snapshots.push(m.getSegments().length));
    feed(m, 'audio-turn.jsonl');
    expect(m.getSegments()[0]!.seq).toBe(1);
    expect(snapshots.length).toBeGreaterThan(0);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/transcriptModel.test.ts` → 预期 FAIL：`Cannot find module '../src/session/transcriptModel'`。

**Step 3: 最小实现**

- [ ] `packages/core/src/session/transcriptModel.ts`：

```ts
import type { NormalizedEvent, Usage } from '../protocol/types';

export type SegmentStatus = 'listening' | 'translating' | 'done' | 'interrupted';

export interface TranscriptSegment {
  seq: number; // 1 起的会话内序号
  itemId: string | null; // VAD 段 item id
  responseId: string | null;
  status: SegmentStatus;
  sourceText: string; // ASR 已确认
  sourceStash: string; // ASR 暂存（浅灰斜体渲染）
  targetText: string; // 译文已确认
  targetStash: string; // 译文暂存
  sourceLang: string | null;
  emotion: string | null;
  vadStartMs: number | null;
  vadEndMs: number | null;
  usage: Usage | null; // 注意：session 累积值（P6），差分在 UsageMeter 做
  firstDeltaAt: number | null; // 首字延迟打点（epoch ms）
  doneAt: number | null;
}

function blank(seq: number): TranscriptSegment {
  return {
    seq, itemId: null, responseId: null, status: 'listening',
    sourceText: '', sourceStash: '', targetText: '', targetStash: '',
    sourceLang: null, emotion: null, vadStartMs: null, vadEndMs: null,
    usage: null, firstDeltaAt: null, doneAt: null,
  };
}

export class TranscriptModel {
  private segments: TranscriptSegment[] = [];
  private listeners = new Set<() => void>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  apply(ev: NormalizedEvent): void {
    switch (ev.kind) {
      case 'speech-started': {
        const seg = blank(this.segments.length + 1);
        seg.itemId = ev.itemId;
        seg.vadStartMs = ev.audioStartMs;
        this.segments.push(seg);
        break;
      }
      case 'speech-stopped': {
        const seg = this.byItem(ev.itemId);
        if (seg) seg.vadEndMs = ev.audioEndMs;
        break;
      }
      case 'asr-delta': {
        const seg = this.byItem(ev.itemId) ?? this.open();
        if (!seg) break;
        seg.itemId = seg.itemId ?? ev.itemId;
        seg.sourceText = ev.text; // P4：整段覆盖，禁止拼接
        seg.sourceStash = ev.stash;
        seg.sourceLang = ev.language;
        seg.emotion = ev.emotion;
        break;
      }
      case 'asr-completed': {
        const seg = this.byItem(ev.itemId);
        if (!seg) break;
        seg.sourceText = ev.transcript;
        seg.sourceStash = '';
        seg.sourceLang = ev.language;
        seg.emotion = ev.emotion;
        break;
      }
      case 'response-created': {
        const seg = this.open() ?? this.pushBlank();
        seg.responseId = ev.responseId;
        seg.status = 'translating';
        break;
      }
      case 'translation-delta': {
        const seg = this.byResponse(ev.responseId);
        if (!seg) break;
        if (seg.firstDeltaAt === null) seg.firstDeltaAt = this.now();
        seg.targetText = ev.text; // P4：整段覆盖
        seg.targetStash = ev.stash;
        break;
      }
      case 'translation-done': {
        const seg = this.byResponse(ev.responseId);
        if (!seg) break;
        seg.targetText = ev.text;
        seg.targetStash = '';
        break;
      }
      case 'response-done': {
        const seg = this.byResponse(ev.responseId);
        if (!seg) break;
        seg.usage = ev.usage;
        seg.status = 'done'; // R2：response.done 到达即结算
        seg.doneAt = this.now();
        break;
      }
      case 'session-created':
      case 'session-updated':
      case 'session-finished':
      case 'audio-delta': // 音频归 AudioSegmenter（Task 14），文本模型不处理
      case 'server-error':
        break;
    }
    this.listeners.forEach((l) => l());
  }

  markInterrupted(): void {
    for (const seg of this.segments) {
      if (seg.status === 'listening' || seg.status === 'translating') seg.status = 'interrupted';
    }
    this.listeners.forEach((l) => l());
  }

  getSegments(): readonly TranscriptSegment[] {
    return this.segments;
  }

  reset(): void {
    this.segments = [];
    this.listeners.forEach((l) => l());
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private byItem(itemId: string): TranscriptSegment | undefined {
    return this.segments.find((s) => s.itemId === itemId);
  }

  private byResponse(responseId: string): TranscriptSegment | undefined {
    return this.segments.find((s) => s.responseId === responseId);
  }

  private open(): TranscriptSegment | undefined {
    return [...this.segments].reverse().find((s) => s.status === 'listening' || s.status === 'translating');
  }

  private pushBlank(): TranscriptSegment {
    const seg = blank(this.segments.length + 1);
    this.segments.push(seg);
    return seg;
  }
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { TranscriptModel, type TranscriptSegment, type SegmentStatus } from './session/transcriptModel';
```

**Step 4: 运行确认通过**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/transcriptModel.test.ts` → 预期 `6 passed`。

**Step 5: Commit**

- [ ] `git add packages/core; git commit -m "feat(core): TranscriptModel with overwrite-style text/stash state machine"`

## Task 6: SessionLogger（spec §6.6 会话事件日志，必做且前置）

纯逻辑层：接收 raw 事件（来自 transport.onRaw 或网关 relay tap），格式化为 JSONL 行写入注入的 sink。文件 sink（追加流）在网关 Task 8 接入。

**Files:**
- Create: `packages/core/src/session/sessionLogger.ts`
- Create: `packages/core/test/sessionLogger.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试**

- [ ] `packages/core/test/sessionLogger.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { SessionLogger, fnv1a } from '../src/session/sessionLogger';

function collect() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe('SessionLogger (spec 6.6)', () => {
  it('writes {ts, dir, type, payload} JSONL lines', () => {
    const { lines, sink } = collect();
    const log = new SessionLogger({ sink, now: () => 1722153600000 });
    log.record('s2c', { type: 'session.created', session: { id: 'sess_1' } });
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: 1722153600000, dir: 's2c', type: 'session.created',
      payload: { type: 'session.created', session: { id: 'sess_1' } },
    });
  });

  it('truncates input_audio_buffer.append base64 to <b64 len+fnv1a> by default', () => {
    const { lines, sink } = collect();
    const log = new SessionLogger({ sink, now: () => 0 });
    const audio = 'QUJDREVGRw=='.repeat(50);
    log.record('c2s', { type: 'input_audio_buffer.append', audio });
    const payload = (JSON.parse(lines[0]!) as { payload: { audio: string } }).payload;
    expect(payload.audio).toBe(`<b64 len=${audio.length} fnv1a=${fnv1a(audio)}>`);
  });

  it('truncates response.audio.delta the same way; keeps full payload when fullAudio=true', () => {
    const { lines, sink } = collect();
    const full = new SessionLogger({ sink, now: () => 0, fullAudio: true });
    full.record('s2c', { type: 'response.audio.delta', response_id: 'r1', delta: 'AAAA' });
    expect((JSON.parse(lines[0]!) as { payload: { delta: string } }).payload.delta).toBe('AAAA');
    const trunc = new SessionLogger({ sink, now: () => 0 });
    trunc.record('s2c', { type: 'response.audio.delta', response_id: 'r1', delta: 'AAAA' });
    expect((JSON.parse(lines[1]!) as { payload: { delta: string } }).payload.delta).toBe(`<b64 len=4 fnv1a=${fnv1a('AAAA')}>`);
  });

  it('records synthetic _lifecycle events (reconnect/downgrade/rotation)', () => {
    const { lines, sink } = collect();
    const log = new SessionLogger({ sink, now: () => 5 });
    log.lifecycle('reconnect', { attempt: 2, delayMs: 1000 });
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: 5, dir: 'c2s', type: '_lifecycle',
      payload: { action: 'reconnect', attempt: 2, delayMs: 1000 },
    });
  });

  it('never logs Authorization/api key fields (secret scrub)', () => {
    const { lines, sink } = collect();
    const log = new SessionLogger({ sink, now: () => 0 });
    log.record('c2s', { type: '_lifecycle', authorization: 'Bearer sk-secret', apiKey: 'sk-secret', note: 'ok' });
    const payload = (JSON.parse(lines[0]!) as { payload: Record<string, unknown> }).payload;
    expect(payload.authorization).toBe('<redacted>');
    expect(payload.apiKey).toBe('<redacted>');
    expect(payload.note).toBe('ok');
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/sessionLogger.test.ts` → 预期 FAIL：`Cannot find module '../src/session/sessionLogger'`。

**Step 3: 最小实现**

- [ ] `packages/core/src/session/sessionLogger.ts`：

```ts
import type { RawDirection, ServerEvent } from '../protocol/types';

// 体积控制（spec §6.6）：音频 base64 默认截断为长度+哈希
const AUDIO_FIELD_BY_TYPE: Record<string, string> = {
  'input_audio_buffer.append': 'audio',
  'response.audio.delta': 'delta',
  'input_image_buffer.append': 'image',
};
const SECRET_FIELDS = new Set(['authorization', 'apikey', 'api_key', 'bearer']);

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface SessionLoggerOptions {
  sink: (line: string) => void; // 文件追加流在网关层注入（Task 8 FileSink）
  now?: () => number;
  fullAudio?: boolean; // 设置页“完整音频负载”开关
}

export class SessionLogger {
  private now: () => number;
  private fullAudio: boolean;

  constructor(private opts: SessionLoggerOptions) {
    this.now = opts.now ?? Date.now;
    this.fullAudio = opts.fullAudio ?? false;
  }

  record(dir: RawDirection, payload: ServerEvent): void {
    this.opts.sink(JSON.stringify({
      ts: this.now(), dir, type: payload.type, payload: this.sanitize(payload),
    }));
  }

  lifecycle(action: string, detail: Record<string, unknown> = {}): void {
    this.record('c2s', { type: '_lifecycle', action, ...detail });
  }

  private sanitize(payload: ServerEvent): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const audioField = this.fullAudio ? undefined : AUDIO_FIELD_BY_TYPE[payload.type];
    for (const [k, v] of Object.entries(payload)) {
      if (SECRET_FIELDS.has(k.toLowerCase())) {
        out[k] = '<redacted>';
      } else if (k === audioField && typeof v === 'string') {
        out[k] = `<b64 len=${v.length} fnv1a=${fnv1a(v)}>`;
      } else {
        out[k] = v;
      }
    }
    return out;
  }
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { SessionLogger, fnv1a, type SessionLoggerOptions } from './session/sessionLogger';
```

**Step 4: 运行确认通过**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/sessionLogger.test.ts` → 预期 `5 passed`。
- [ ] 全包回归：`pnpm --filter @livetranslate/core test` → 预期全部通过（累计 30 条）。

**Step 5: Commit**

- [ ] `git add packages/core; git commit -m "feat(core): SessionLogger with audio payload truncation (spec 6.6)"`

## Task 7: gateway 骨架 + 设置持久化 + KeyStore

网关同时被 Electron 主进程内嵌（Task 12）与独立 Node 进程运行（网页调试端），所以 Key 存储抽象为 `KeyStore` 接口：桌面用 safeStorage 实现（Task 12），独立进程用 `.env.local`（D4：Key 不进浏览器）。非密设置存 JSON 文件。

**Files:**
- Create: `packages/gateway/package.json`、`packages/gateway/tsconfig.json`
- Create: `packages/gateway/src/settings.ts`
- Create: `packages/gateway/test/settings.test.ts`

**Step 1: 包骨架**

- [ ] `packages/gateway/package.json`：

```json
{
  "name": "@livetranslate/gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@livetranslate/core": "workspace:*",
    "better-sqlite3": "^11.3.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^20.14.0",
    "@types/ws": "^8.5.12",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vitest": "^2.1.1"
  }
}
```

- [ ] `packages/gateway/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node", "vitest/globals"] },
  "include": ["src", "test"]
}
```

**Step 2: 写失败测试**

- [ ] `packages/gateway/test/settings.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, DEFAULT_SETTINGS, type KeyStore } from '../src/settings';

class MemKeyStore implements KeyStore {
  private key: string | null = null;
  getKey(): string | null { return this.key; }
  setKey(k: string): void { this.key = k; }
  clearKey(): void { this.key = null; }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-settings-'));
});

describe('SettingsStore', () => {
  it('returns defaults when file is missing', () => {
    const s = new SettingsStore(join(dir, 'settings.json'), new MemKeyStore());
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists non-secret settings as JSON and reloads them', () => {
    const file = join(dir, 'settings.json');
    const s = new SettingsStore(file, new MemKeyStore());
    s.update({ workspaceHost: 'ws-abc.cn-beijing.maas.aliyuncs.com', targetLanguage: 'ja' });
    const reloaded = new SettingsStore(file, new MemKeyStore());
    expect(reloaded.get().workspaceHost).toBe('ws-abc.cn-beijing.maas.aliyuncs.com');
    expect(reloaded.get().targetLanguage).toBe('ja');
    // API Key 永不落入 settings.json（D4）
    expect(readFileSync(file, 'utf8')).not.toContain('sk-');
  });

  it('API key goes through KeyStore only; getMaskedKey() redacts middle', () => {
    const ks = new MemKeyStore();
    const s = new SettingsStore(join(dir, 'settings.json'), ks);
    s.setApiKey('sk-abcdef1234567890');
    expect(ks.getKey()).toBe('sk-abcdef1234567890');
    expect(s.getMaskedKey()).toBe('sk-a……7890');
    expect(s.hasApiKey()).toBe(true);
  });

  it('hot-word tables: named lists survive reload', () => {
    const file = join(dir, 'settings.json');
    const s = new SettingsStore(file, new MemKeyStore());
    s.update({
      hotwordTables: [{ name: '医疗', phrases: [{ source: '造影剂', target: 'contrast agent' }] }],
    });
    const reloaded = new SettingsStore(file, new MemKeyStore());
    expect(reloaded.get().hotwordTables[0]!.phrases[0]!.target).toBe('contrast agent');
  });
});
```

**Step 3: 运行确认失败**

- [ ] `pnpm install`（新包首次安装），然后 `pnpm --filter @livetranslate/gateway exec vitest run test/settings.test.ts` → 预期 FAIL：`Cannot find module '../src/settings'`。

**Step 4: 最小实现**

- [ ] `packages/gateway/src/settings.ts`：

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HotwordTable {
  name: string;
  phrases: Array<{ source: string; target: string }>;
}

// 非密设置（spec §6.3）；API Key 另走 KeyStore
export interface AppSettings {
  workspaceHost: string; // {ws-id}.cn-beijing.maas.aliyuncs.com
  protocolPreference: 'auto' | 'ws'; // 自动（优先 WebRTC）/ 强制 WS
  sourceLanguage: string | 'auto';
  targetLanguage: string;
  defaultVoice: string;
  hotwordTables: HotwordTable[];
  frameExtraction: { enabled: boolean; fps: 1 | 2 };
  fullAudioLogs: boolean; // §6.6 “完整音频负载”开关
}

export const DEFAULT_SETTINGS: AppSettings = {
  workspaceHost: '',
  protocolPreference: 'auto',
  sourceLanguage: 'auto',
  targetLanguage: 'en',
  defaultVoice: 'Tina',
  hotwordTables: [],
  frameExtraction: { enabled: true, fps: 1 },
  fullAudioLogs: false,
};

// Key 存储抽象：桌面 safeStorage（apps/desktop/src/keyStore.ts）；独立进程 EnvKeyStore
export interface KeyStore {
  getKey(): string | null;
  setKey(key: string): void;
  clearKey(): void;
}

export class EnvKeyStore implements KeyStore {
  // 网页调试端：Key 存于网关进程 .env.local（D4），进程内可覆写
  private override: string | null = null;
  getKey(): string | null {
    return this.override ?? process.env.DASHSCOPE_API_KEY ?? null;
  }
  setKey(key: string): void {
    this.override = key;
  }
  clearKey(): void {
    this.override = null;
  }
}

export class SettingsStore {
  private settings: AppSettings;

  constructor(private filePath: string, private keyStore: KeyStore) {
    this.settings = existsSync(filePath)
      ? { ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(filePath, 'utf8')) as Partial<AppSettings>) }
      : { ...DEFAULT_SETTINGS };
  }

  get(): AppSettings {
    return this.settings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8');
    return this.settings;
  }

  setApiKey(key: string): void {
    this.keyStore.setKey(key);
  }

  hasApiKey(): boolean {
    return this.keyStore.getKey() !== null;
  }

  getApiKey(): string | null {
    return this.keyStore.getKey();
  }

  getMaskedKey(): string {
    const k = this.keyStore.getKey();
    if (!k) return '';
    return `${k.slice(0, 4)}……${k.slice(-4)}`;
  }
}
```

**Step 5: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/settings.test.ts` → 预期 `4 passed`。
- [ ] `git add packages/gateway pnpm-lock.yaml; git commit -m "feat(gateway): settings store with pluggable KeyStore"`

## Task 8: /realtime WS 中继 + 日志 tap

网关核心：渲染端连 `ws://127.0.0.1:{port}/realtime`，网关向百炼建连（注入 Bearer，P1）并双向透传；同时把双向事件喳给 SessionLogger（文件 sink）。测试用本地 `ws` 服务器模拟百炼，不碰真网络。

**Files:**
- Create: `packages/gateway/src/logFiles.ts`、`packages/gateway/src/relay.ts`、`packages/gateway/src/server.ts`、`packages/gateway/src/index.ts`
- Create: `packages/gateway/test/relay.test.ts`

**Step 1: 写失败测试**

- [ ] `packages/gateway/test/relay.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer, type GatewayHandle } from '../src/server';
import { SettingsStore, type KeyStore } from '../src/settings';

class MemKeyStore implements KeyStore {
  private key: string | null = 'sk-test-key';
  getKey(): string | null { return this.key; }
  setKey(k: string): void { this.key = k; }
  clearKey(): void { this.key = null; }
}

let upstream: WebSocketServer;
let upstreamAuth: string | undefined;
let gateway: GatewayHandle;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'lt-relay-'));
  upstream = new WebSocketServer({ port: 0 });
  upstream.on('connection', (sock, req) => {
    upstreamAuth = req.headers.authorization;
    sock.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_relay_1' } }));
    sock.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string };
      if (msg.type === 'session.update') sock.send(JSON.stringify({ type: 'session.updated' }));
      if (msg.type === 'session.finish') sock.send(JSON.stringify({ type: 'session.finished' }));
    });
  });
  await new Promise<void>((r) => upstream.on('listening', r));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const settings = new SettingsStore(join(dataDir, 'settings.json'), new MemKeyStore());
  settings.update({ workspaceHost: `127.0.0.1:${upstreamPort}` });
  gateway = await createGatewayServer({ settings, dataDir, port: 0, upstreamScheme: 'ws' });
});

afterEach(async () => {
  await gateway.close();
  upstream.close();
});

function connectClient(): Promise<WebSocket> {
  const c = new WebSocket(`ws://127.0.0.1:${gateway.port}/realtime`);
  return new Promise((resolve, reject) => {
    c.on('open', () => resolve(c));
    c.on('error', reject);
  });
}

const nextMsg = (c: WebSocket): Promise<{ type: string }> =>
  new Promise((r) => c.once('message', (raw) => r(JSON.parse(String(raw)) as { type: string })));

describe('gateway /realtime relay', () => {
  it('injects Bearer from KeyStore and relays session.created to client (P1)', async () => {
    const c = await connectClient();
    const ev = await nextMsg(c);
    expect(ev.type).toBe('session.created');
    expect(upstreamAuth).toBe('Bearer sk-test-key');
    c.close();
  });

  it('relays client frames upstream and answers back (session.update round-trip)', async () => {
    const c = await connectClient();
    await nextMsg(c); // session.created
    c.send(JSON.stringify({ type: 'session.update', session: { modalities: ['text'] } }));
    const ev = await nextMsg(c);
    expect(ev.type).toBe('session.updated');
    c.close();
  });

  it('writes a JSONL session log keyed by upstream session id (spec 6.6)', async () => {
    const c = await connectClient();
    await nextMsg(c);
    c.send(JSON.stringify({ type: 'session.finish' }));
    await nextMsg(c); // session.finished
    c.close();
    await new Promise((r) => setTimeout(r, 100)); // 等追加流 flush
    const logDir = join(dataDir, 'logs', 'sessions');
    const files = readdirSync(logDir);
    expect(files).toContain('sess_relay_1.jsonl');
    const lines = readFileSync(join(logDir, 'sess_relay_1.jsonl'), 'utf8').trim().split('\n');
    const parsed = lines.map((l) => JSON.parse(l) as { dir: string; type: string });
    expect(parsed.some((e) => e.dir === 's2c' && e.type === 'session.created')).toBe(true);
    expect(parsed.some((e) => e.dir === 'c2s' && e.type === 'session.finish')).toBe(true);
    expect(readFileSync(join(logDir, 'sess_relay_1.jsonl'), 'utf8')).not.toContain('sk-test-key');
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/relay.test.ts` → 预期 FAIL：`Cannot find module '../src/server'`。

**Step 3: 最小实现**

- [ ] `packages/gateway/src/logFiles.ts`：

```ts
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

// §6.6：每 session 一个 JSONL 追加流，崩溃不丢已落盘部分
export class SessionLogFiles {
  private streams = new Map<string, WriteStream>();

  constructor(private dataDir: string) {}

  get sessionsDir(): string {
    return join(this.dataDir, 'logs', 'sessions');
  }

  sinkFor(sessionId: string): (line: string) => void {
    return (line) => {
      let s = this.streams.get(sessionId);
      if (!s) {
        mkdirSync(this.sessionsDir, { recursive: true });
        s = createWriteStream(join(this.sessionsDir, `${sessionId}.jsonl`), { flags: 'a' });
        this.streams.set(sessionId, s);
      }
      s.write(line + '\n');
    };
  }

  closeAll(): Promise<void> {
    const all = [...this.streams.values()].map(
      (s) => new Promise<void>((r) => s.end(() => r())),
    );
    this.streams.clear();
    return Promise.all(all).then(() => undefined);
  }
}
```

- [ ] `packages/gateway/src/relay.ts`：

```ts
import { WebSocket, type WebSocketServer } from 'ws';
import { SessionLogger } from '@livetranslate/core';
import type { ServerEvent } from '@livetranslate/core';
import type { SettingsStore } from './settings';
import type { SessionLogFiles } from './logFiles';

const MODEL = 'qwen3.5-livetranslate-flash-realtime';

export interface RelayOptions {
  settings: SettingsStore;
  logFiles: SessionLogFiles;
  upstreamScheme?: 'ws' | 'wss'; // 测试用 ws，生产默认 wss
}

export function attachRealtimeRelay(wss: WebSocketServer, opts: RelayOptions): void {
  const scheme = opts.upstreamScheme ?? 'wss';
  wss.on('connection', (client) => {
    const key = opts.settings.getApiKey();
    const host = opts.settings.get().workspaceHost;
    if (!key || !host) {
      client.send(JSON.stringify({ type: 'error', error: { code: 'gateway_not_configured', message: 'API Key 或 Workspace Host 未配置，请到设置页填写' } }));
      client.close();
      return;
    }
    const upstream = new WebSocket(`${scheme}://${host}/api-ws/v1/realtime?model=${MODEL}`, {
      headers: { Authorization: `Bearer ${key}` }, // P1：Key 只在网关侧出现
    });
    let logger: SessionLogger | null = null;
    const pendingC2s: ServerEvent[] = [];

    const ensureLogger = (sessionId: string): SessionLogger => {
      if (!logger) {
        logger = new SessionLogger({
          sink: opts.logFiles.sinkFor(sessionId),
          fullAudio: opts.settings.get().fullAudioLogs,
        });
        for (const ev of pendingC2s.splice(0)) logger.record('c2s', ev);
      }
      return logger;
    };

    upstream.on('message', (raw) => {
      const text = String(raw);
      const ev = JSON.parse(text) as ServerEvent;
      if (ev.type === 'session.created') {
        const sessionId = String((ev.session as { id?: string } | undefined)?.id ?? `sess_local_${Date.now()}`);
        ensureLogger(sessionId);
      }
      logger?.record('s2c', ev);
      if (client.readyState === WebSocket.OPEN) client.send(text);
    });
    client.on('message', (raw) => {
      const text = String(raw);
      const ev = JSON.parse(text) as ServerEvent;
      if (logger) logger.record('c2s', ev);
      else pendingC2s.push(ev);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else upstream.once('open', () => upstream.send(text));
    });
    upstream.on('close', (code) => {
      logger?.lifecycle('upstream-closed', { code });
      client.close();
    });
    upstream.on('error', (err) => {
      logger?.lifecycle('upstream-error', { message: err.message });
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'error', error: { code: 'upstream_error', message: err.message } }));
      }
      client.close();
    });
    client.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    });
  });
}
```

- [ ] `packages/gateway/src/server.ts`：

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { attachRealtimeRelay } from './relay';
import { SessionLogFiles } from './logFiles';
import type { SettingsStore } from './settings';

export interface GatewayOptions {
  settings: SettingsStore;
  dataDir: string;
  port: number; // 0 = 随机端口
  upstreamScheme?: 'ws' | 'wss';
}

export interface GatewayHandle {
  port: number;
  server: Server;
  close(): Promise<void>;
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void;

// 后续任务（T9/T18/T19/T25/T32/T34）向这张表注册 REST 路由
export const routes = new Map<string, RouteHandler>();

export async function createGatewayServer(opts: GatewayOptions): Promise<GatewayHandle> {
  const logFiles = new SessionLogFiles(opts.dataDir);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      const handler = routes.get(`${req.method} ${(req.url ?? '').split('?')[0]}`);
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      void handler(req, res, body);
    });
  });
  const wss = new WebSocketServer({ server, path: '/realtime' });
  attachRealtimeRelay(wss, { settings: opts.settings, logFiles, upstreamScheme: opts.upstreamScheme });
  await new Promise<void>((r) => server.listen(opts.port, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    server,
    close: async () => {
      await logFiles.closeAll();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
```

- [ ] `packages/gateway/src/index.ts`（独立进程入口，网页调试端用）：

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer } from './server';
import { SettingsStore, EnvKeyStore } from './settings';

const dataDir = process.env.LT_DATA_DIR ?? join(homedir(), '.livetranslate');
const settings = new SettingsStore(join(dataDir, 'settings.json'), new EnvKeyStore());
const port = Number(process.env.LT_GATEWAY_PORT ?? 8788);

createGatewayServer({ settings, dataDir, port }).then((h) => {
  console.log(`[gateway] listening on http://127.0.0.1:${h.port} (data: ${dataDir})`);
});
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/relay.test.ts` → 预期 `3 passed`。
- [ ] `git add packages/gateway; git commit -m "feat(gateway): realtime WS relay with bearer injection and session logs"`

## Task 9: 连接自检 selfCheck

瞬时 session 验证 Key/网络（spec §6.3）：建连 → 收 `session.created` → 立即 close，测往返延迟；注册为 REST 路由 `POST /self-check`。

**Files:**
- Create: `packages/gateway/src/selfCheck.ts`
- Create: `packages/gateway/test/selfCheck.test.ts`
- Modify: `packages/gateway/src/server.ts`（注册路由）

**Step 1: 写失败测试**

- [ ] `packages/gateway/test/selfCheck.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { runSelfCheck } from '../src/selfCheck';

let upstream: WebSocketServer | null = null;

afterEach(() => {
  upstream?.close();
  upstream = null;
});

async function startUpstream(behavior: 'ok' | 'silent' | 'reject'): Promise<number> {
  upstream = new WebSocketServer({ port: 0 });
  upstream.on('connection', (sock) => {
    if (behavior === 'ok') sock.send(JSON.stringify({ type: 'session.created', session: { id: 'sess_check' } }));
    if (behavior === 'reject') sock.close(1008, 'unauthorized');
  });
  await new Promise<void>((r) => upstream!.on('listening', r));
  return (upstream.address() as { port: number }).port;
}

describe('runSelfCheck', () => {
  it('ok: resolves with session id and round-trip latency', async () => {
    const port = await startUpstream('ok');
    const result = await runSelfCheck({ host: `127.0.0.1:${port}`, apiKey: 'sk-x', scheme: 'ws', timeoutMs: 2000 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.sessionId).toBe('sess_check');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('rejected connection: returns ok=false with reason', async () => {
    const port = await startUpstream('reject');
    const result = await runSelfCheck({ host: `127.0.0.1:${port}`, apiKey: 'sk-x', scheme: 'ws', timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('closed');
  });

  it('silent upstream: times out with ok=false', async () => {
    const port = await startUpstream('silent');
    const result = await runSelfCheck({ host: `127.0.0.1:${port}`, apiKey: 'sk-x', scheme: 'ws', timeoutMs: 300 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('timeout after 300ms');
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/selfCheck.test.ts` → 预期 FAIL：`Cannot find module '../src/selfCheck'`。

**Step 3: 最小实现**

- [ ] `packages/gateway/src/selfCheck.ts`：

```ts
import { WebSocket } from 'ws';

const MODEL = 'qwen3.5-livetranslate-flash-realtime';

export interface SelfCheckInput {
  host: string;
  apiKey: string;
  scheme?: 'ws' | 'wss';
  timeoutMs?: number;
}

export type SelfCheckResult =
  | { ok: true; sessionId: string; latencyMs: number }
  | { ok: false; reason: string };

export function runSelfCheck(input: SelfCheckInput): Promise<SelfCheckResult> {
  const scheme = input.scheme ?? 'wss';
  const timeoutMs = input.timeoutMs ?? 5000;
  const started = Date.now();
  return new Promise((resolve) => {
    const ws = new WebSocket(`${scheme}://${input.host}/api-ws/v1/realtime?model=${MODEL}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    });
    let settled = false;
    const settle = (result: SelfCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已断开 */ }
      resolve(result);
    };
    const timer = setTimeout(() => settle({ ok: false, reason: `timeout after ${timeoutMs}ms` }), timeoutMs);
    ws.on('message', (raw) => {
      const ev = JSON.parse(String(raw)) as { type: string; session?: { id?: string } };
      if (ev.type === 'session.created') {
        settle({ ok: true, sessionId: String(ev.session?.id ?? ''), latencyMs: Date.now() - started });
      }
    });
    ws.on('close', (code, reason) => settle({ ok: false, reason: `closed code=${code} ${String(reason)}` }));
    ws.on('error', (err) => settle({ ok: false, reason: err.message }));
  });
}
```

- [ ] `packages/gateway/src/server.ts` 在 `attachRealtimeRelay(...)` 调用后、`server.listen` 前插入路由注册（同时在文件头部追加 `import { runSelfCheck } from './selfCheck';`）：

```ts
  routes.set('GET /settings', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ settings: opts.settings.get(), maskedKey: opts.settings.getMaskedKey(), hasKey: opts.settings.hasApiKey() }));
  });
  routes.set('POST /settings', (_req, res, body) => {
    const parsed = JSON.parse(body) as { patch?: Record<string, unknown>; apiKey?: string };
    if (parsed.apiKey) opts.settings.setApiKey(parsed.apiKey);
    const settings = parsed.patch ? opts.settings.update(parsed.patch) : opts.settings.get();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ settings, maskedKey: opts.settings.getMaskedKey(), hasKey: opts.settings.hasApiKey() }));
  });
  routes.set('POST /self-check', async (_req, res) => {
    const key = opts.settings.getApiKey();
    const host = opts.settings.get().workspaceHost;
    const result = key && host
      ? await runSelfCheck({ host, apiKey: key })
      : { ok: false as const, reason: 'API Key 或 Workspace Host 未配置' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/selfCheck.test.ts` → 预期 `3 passed`；全包回归 `pnpm --filter @livetranslate/gateway test` → 预期 `10 passed`。
- [ ] `git add packages/gateway; git commit -m "feat(gateway): self-check endpoint and settings routes"`

## Task 10: ui 脚手架 + 路由壳 + 网页调试端壳

UI 为纯 React SPA，不直接持有 Key；通过 `PlatformBridge` 抿平桌面（IPC 拿网关端口）与网页（固定端口）差异。本任务只搭壳：五个路由页先放标题占位（后续任务逐个捧实），骨架代码本任务写全。

**Files:**
- Create: `packages/ui/package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`
- Create: `packages/ui/src/main.tsx`、`src/App.tsx`、`src/styles.css`、`src/platform.ts`
- Create: `apps/web/package.json`

**Step 1: 实现**

- [ ] `packages/ui/package.json`：

```json
{
  "name": "@livetranslate/ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@livetranslate/core": "workspace:*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "vitest": "^2.1.1"
  }
}
```

- [ ] `packages/ui/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["vite/client", "vitest/globals"] },
  "include": ["src", "test"]
}
```

- [ ] `packages/ui/vite.config.ts`：

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
});
```

- [ ] `packages/ui/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>LiveTranslate Tool</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] `packages/ui/src/platform.ts`：

```ts
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
```

- [ ] `packages/ui/src/App.tsx`：

```tsx
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { SoloPage } from './pages/SoloPage';
import { FileDubPage } from './pages/FileDubPage';
import { InterpreterPage } from './pages/InterpreterPage';
import { MeetingPage } from './pages/MeetingPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';

const NAV = [
  { to: '/', label: '单人测试' },
  { to: '/filedub', label: '翻译机·配音' },
  { to: '/interpreter', label: '实时翻译机' },
  { to: '/meeting', label: '会议' },
  { to: '/history', label: '历史' },
  { to: '/settings', label: '设置' },
];

export function App(): JSX.Element {
  return (
    <HashRouter>
      <div className="app-shell">
        <nav className="side-nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <main className="page-body">
          <Routes>
            <Route path="/" element={<SoloPage />} />
            <Route path="/filedub" element={<FileDubPage />} />
            <Route path="/interpreter" element={<InterpreterPage />} />
            <Route path="/meeting" element={<MeetingPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
```

- [ ] `packages/ui/src/main.tsx`：

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] `packages/ui/src/styles.css`：

```css
:root { color-scheme: dark; font-family: 'Segoe UI', 'PingFang SC', sans-serif; }
body { margin: 0; background: #12141a; color: #e8eaf0; }
.app-shell { display: flex; min-height: 100vh; }
.side-nav { width: 168px; padding: 16px 0; background: #1a1d26; display: flex; flex-direction: column; }
.side-nav a { color: #9aa1b2; padding: 10px 20px; text-decoration: none; }
.side-nav a.active { color: #fff; background: #262b3a; border-left: 3px solid #4c8dff; }
.page-body { flex: 1; padding: 24px; }
.stash { color: #8b93a7; font-style: italic; }
.segment-card { background: #1a1d26; border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
.segment-card .source { color: #9aa1b2; font-size: 13px; margin-bottom: 6px; }
.segment-card .target { font-size: 16px; line-height: 1.5; }
.segment-card .meta { color: #6b7280; font-size: 12px; margin-top: 6px; }
button { background: #4c8dff; color: #fff; border: 0; border-radius: 6px; padding: 8px 16px; cursor: pointer; }
button:disabled { background: #333a4d; color: #6b7280; cursor: not-allowed; }
button.secondary { background: #262b3a; }
input, select, textarea { background: #262b3a; color: #e8eaf0; border: 1px solid #333a4d; border-radius: 6px; padding: 8px; }
.warn-banner { background: #5c1f1f; color: #ffb4b4; padding: 10px 16px; border-radius: 6px; margin-bottom: 12px; }
```

- [ ] 六个页面占位文件（`packages/ui/src/pages/` 下，后续任务替换为完整实现），每个文件内容仅导出同名组件，以 `SoloPage.tsx` 为模板：

```tsx
export function SoloPage(): JSX.Element {
  return <h2>单人测试</h2>;
}
```

同样创建：`FileDubPage.tsx`（`<h2>翻译机·配音</h2>`）、`InterpreterPage.tsx`（`<h2>实时翻译机</h2>`）、`MeetingPage.tsx`（`<h2>会议</h2>`）、`HistoryPage.tsx`（`<h2>历史</h2>`）、`SettingsPage.tsx`（`<h2>设置</h2>`）。

- [ ] `apps/web/package.json`（调试端聚合脚本）：

```json
{
  "name": "@livetranslate/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "concurrently -n gateway,ui \"pnpm --filter @livetranslate/gateway dev\" \"pnpm --filter @livetranslate/ui dev\""
  },
  "devDependencies": {
    "concurrently": "^9.0.0"
  }
}
```

**Step 2: 手工验证**

- [ ] `pnpm install`，然后 `pnpm --filter @livetranslate/web dev`。
- [ ] 浏览器打开 `http://localhost:5173`：预期左侧出现 6 项导航，逐一点击切换，每页显示对应标题；控制台无报错。
- [ ] 终端预期出现 `[gateway] listening on http://127.0.0.1:8788`。
- [ ] `pnpm --filter @livetranslate/ui typecheck` → 预期无输出。

**Step 3: Commit**

- [ ] `git add packages/ui apps/web pnpm-lock.yaml; git commit -m "feat(ui): app shell with mode routing and web debug harness"`

## Task 11: 设置页 + 自检按钮 + 热词表管理

**Files:**
- Create: `packages/ui/src/api.ts`、`packages/ui/src/state/settingsStore.ts`
- Create: `packages/ui/test/settingsStore.test.ts`
- Rewrite: `packages/ui/src/pages/SettingsPage.tsx`

**Step 1: 写失败测试（store 纯逻辑）**

- [ ] `packages/ui/test/settingsStore.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { SettingsUiStore } from '../src/state/settingsStore';
import type { AppSettingsDto, GatewayApi } from '../src/api';

const BASE: AppSettingsDto = {
  workspaceHost: '', protocolPreference: 'auto', sourceLanguage: 'auto', targetLanguage: 'en',
  defaultVoice: 'Tina', hotwordTables: [], frameExtraction: { enabled: true, fps: 1 }, fullAudioLogs: false,
};

function fakeApi(overrides: Partial<GatewayApi> = {}): GatewayApi {
  return {
    getSettings: async () => ({ settings: BASE, maskedKey: '', hasKey: false }),
    postSettings: async (body) => ({
      settings: { ...BASE, ...(body.patch ?? {}) },
      maskedKey: body.apiKey ? 'sk-a……key1' : '',
      hasKey: Boolean(body.apiKey),
    }),
    selfCheck: async () => ({ ok: true, sessionId: 'sess_ui', latencyMs: 240 }),
    ...overrides,
  };
}

describe('SettingsUiStore', () => {
  it('load() pulls settings and key state from gateway', async () => {
    const s = new SettingsUiStore(fakeApi());
    await s.load();
    expect(s.state.settings.targetLanguage).toBe('en');
    expect(s.state.hasKey).toBe(false);
  });

  it('saveApiKey() posts key and updates masked display', async () => {
    const s = new SettingsUiStore(fakeApi());
    await s.load();
    await s.saveApiKey('sk-abcdefkey1');
    expect(s.state.maskedKey).toBe('sk-a……key1');
    expect(s.state.hasKey).toBe(true);
  });

  it('runSelfCheck() stores latency result; failure stores reason', async () => {
    const ok = new SettingsUiStore(fakeApi());
    await ok.runSelfCheck();
    expect(ok.state.selfCheck).toEqual({ ok: true, sessionId: 'sess_ui', latencyMs: 240 });
    const bad = new SettingsUiStore(fakeApi({ selfCheck: async () => ({ ok: false, reason: 'closed code=1008' }) }));
    await bad.runSelfCheck();
    expect(bad.state.selfCheck).toEqual({ ok: false, reason: 'closed code=1008' });
  });

  it('hotword table editing round-trips through postSettings', async () => {
    const s = new SettingsUiStore(fakeApi());
    await s.load();
    await s.saveSettings({ hotwordTables: [{ name: '会议', phrases: [{ source: '百炼', target: 'Model Studio' }] }] });
    expect(s.state.settings.hotwordTables[0]!.name).toBe('会议');
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/ui exec vitest run test/settingsStore.test.ts` → 预期 FAIL：`Cannot find module '../src/state/settingsStore'`。

**Step 3: 最小实现**

- [ ] `packages/ui/src/api.ts`：

```ts
import { getPlatform } from './platform';

export interface HotwordTableDto {
  name: string;
  phrases: Array<{ source: string; target: string }>;
}

// 与 packages/gateway/src/settings.ts 的 AppSettings 字段一一对应（网关是唯一真相源）
export interface AppSettingsDto {
  workspaceHost: string;
  protocolPreference: 'auto' | 'ws';
  sourceLanguage: string;
  targetLanguage: string;
  defaultVoice: string;
  hotwordTables: HotwordTableDto[];
  frameExtraction: { enabled: boolean; fps: 1 | 2 };
  fullAudioLogs: boolean;
}

export interface SettingsResponse {
  settings: AppSettingsDto;
  maskedKey: string;
  hasKey: boolean;
}

export type SelfCheckDto =
  | { ok: true; sessionId: string; latencyMs: number }
  | { ok: false; reason: string };

export interface GatewayApi {
  getSettings(): Promise<SettingsResponse>;
  postSettings(body: { patch?: Partial<AppSettingsDto>; apiKey?: string }): Promise<SettingsResponse>;
  selfCheck(): Promise<SelfCheckDto>;
}

export function createGatewayApi(): GatewayApi {
  const base = getPlatform().gatewayHttpBase();
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${path}`, init);
    if (!res.ok) throw new Error(`gateway ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    getSettings: () => json<SettingsResponse>('/settings'),
    postSettings: (body) => json<SettingsResponse>('/settings', { method: 'POST', body: JSON.stringify(body) }),
    selfCheck: () => json<SelfCheckDto>('/self-check', { method: 'POST', body: '{}' }),
  };
}
```

- [ ] `packages/ui/src/state/settingsStore.ts`：

```ts
import type { AppSettingsDto, GatewayApi, SelfCheckDto } from '../api';

export interface SettingsUiState {
  settings: AppSettingsDto;
  maskedKey: string;
  hasKey: boolean;
  selfCheck: SelfCheckDto | null;
  busy: boolean;
}

const INITIAL: AppSettingsDto = {
  workspaceHost: '', protocolPreference: 'auto', sourceLanguage: 'auto', targetLanguage: 'en',
  defaultVoice: 'Tina', hotwordTables: [], frameExtraction: { enabled: true, fps: 1 }, fullAudioLogs: false,
};

export class SettingsUiStore {
  state: SettingsUiState = { settings: INITIAL, maskedKey: '', hasKey: false, selfCheck: null, busy: false };
  private listeners = new Set<() => void>();

  constructor(private api: GatewayApi) {}

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(patch: Partial<SettingsUiState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  async load(): Promise<void> {
    const r = await this.api.getSettings();
    this.set({ settings: r.settings, maskedKey: r.maskedKey, hasKey: r.hasKey });
  }

  async saveSettings(patch: Partial<AppSettingsDto>): Promise<void> {
    this.set({ busy: true });
    const r = await this.api.postSettings({ patch });
    this.set({ settings: r.settings, busy: false });
  }

  async saveApiKey(apiKey: string): Promise<void> {
    this.set({ busy: true });
    const r = await this.api.postSettings({ apiKey });
    this.set({ maskedKey: r.maskedKey, hasKey: r.hasKey, busy: false });
  }

  async runSelfCheck(): Promise<void> {
    this.set({ busy: true, selfCheck: null });
    const result = await this.api.selfCheck();
    this.set({ selfCheck: result, busy: false });
  }
}
```

- [ ] `packages/ui/src/pages/SettingsPage.tsx`（替换占位）：

```tsx
import { useEffect, useMemo, useReducer, useState } from 'react';
import { createGatewayApi } from '../api';
import { SettingsUiStore } from '../state/settingsStore';

export function SettingsPage(): JSX.Element {
  const store = useMemo(() => new SettingsUiStore(createGatewayApi()), []);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [keyDraft, setKeyDraft] = useState('');
  const [hostDraft, setHostDraft] = useState('');

  useEffect(() => {
    const off = store.subscribe(force);
    void store.load().then(() => setHostDraft(store.state.settings.workspaceHost));
    return off;
  }, [store]);

  const { settings, maskedKey, hasKey, selfCheck, busy } = store.state;
  return (
    <div>
      <h2>设置</h2>
      <section>
        <h3>连接</h3>
        <label>
          API Key（当前：{hasKey ? maskedKey : '未配置'}）
          <input type="password" value={keyDraft} placeholder="sk-…" onChange={(e) => setKeyDraft(e.target.value)} />
        </label>
        <button disabled={busy || keyDraft.length === 0} onClick={() => { void store.saveApiKey(keyDraft); setKeyDraft(''); }}>保存 Key</button>
        <label>
          Workspace Host
          <input value={hostDraft} placeholder="ws-xxxx.cn-beijing.maas.aliyuncs.com" onChange={(e) => setHostDraft(e.target.value)} />
        </label>
        <button disabled={busy} onClick={() => void store.saveSettings({ workspaceHost: hostDraft })}>保存 Host</button>
        <button className="secondary" disabled={busy} onClick={() => void store.runSelfCheck()}>连接自检</button>
        {selfCheck && (selfCheck.ok
          ? <p>✅ 自检通过：session {selfCheck.sessionId}，往返 {selfCheck.latencyMs}ms</p>
          : <p className="warn-banner">❌ 自检失败：{selfCheck.reason}（401 请检查 Key，并参照百炼开通指引）</p>)}
      </section>
      <section>
        <h3>默认偏好</h3>
        <label>协议
          <select value={settings.protocolPreference} onChange={(e) => void store.saveSettings({ protocolPreference: e.target.value as 'auto' | 'ws' })}>
            <option value="auto">自动（优先 WebRTC）</option>
            <option value="ws">强制 WebSocket</option>
          </select>
        </label>
        <label>默认目标语言
          <input value={settings.targetLanguage} onChange={(e) => void store.saveSettings({ targetLanguage: e.target.value })} />
        </label>
        <label>默认音色
          <input value={settings.defaultVoice} onChange={(e) => void store.saveSettings({ defaultVoice: e.target.value })} />
        </label>
        <label>抽帧视觉增强
          <input type="checkbox" checked={settings.frameExtraction.enabled}
            onChange={(e) => void store.saveSettings({ frameExtraction: { ...settings.frameExtraction, enabled: e.target.checked } })} />
        </label>
        <label>事件日志记录完整音频负载
          <input type="checkbox" checked={settings.fullAudioLogs}
            onChange={(e) => void store.saveSettings({ fullAudioLogs: e.target.checked })} />
        </label>
      </section>
      <section>
        <h3>热词表</h3>
        {settings.hotwordTables.map((t, ti) => (
          <div key={t.name} className="segment-card">
            <strong>{t.name}</strong>
            {t.phrases.map((p, pi) => <div key={pi}>{p.source} → {p.target}</div>)}
            <button className="secondary" onClick={() => void store.saveSettings({ hotwordTables: settings.hotwordTables.filter((_, i) => i !== ti) })}>删除词表</button>
          </div>
        ))}
        <button onClick={() => {
          const name = window.prompt('词表名称？');
          if (!name) return;
          void store.saveSettings({ hotwordTables: [...settings.hotwordTables, { name, phrases: [] }] });
        }}>新建词表</button>
      </section>
    </div>
  );
}
```

**Step 4: 运行确认通过 + 手工验证 + Commit**

- [ ] `pnpm --filter @livetranslate/ui exec vitest run test/settingsStore.test.ts` → 预期 `4 passed`。
- [ ] 手工：`pnpm --filter @livetranslate/web dev` → 设置页能保存 Host（刷新后仍在）；无 Key 时点“连接自检”显示“API Key 或 Workspace Host 未配置”；填入真实 Key + Host 后自检显示 session id 与毫秒延迟。
- [ ] `git add packages/ui; git commit -m "feat(ui): settings page with self-check and hotword tables"`

## Task 12: Electron 壳 + safeStorage + 内嵌网关

**Files:**
- Create: `apps/desktop/package.json`、`apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/main.ts`、`apps/desktop/src/preload.ts`、`apps/desktop/src/keyStore.ts`

**Step 1: 实现**

- [ ] `apps/desktop/package.json`：

```json
{
  "name": "@livetranslate/desktop",
  "version": "0.1.0",
  "private": true,
  "main": "dist/main.cjs",
  "scripts": {
    "build": "esbuild src/main.ts src/preload.ts --bundle --platform=node --external:electron --external:better-sqlite3 --format=cjs --outdir=dist --out-extension:.js=.cjs",
    "dev": "pnpm build && electron .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@livetranslate/core": "workspace:*",
    "@livetranslate/gateway": "workspace:*",
    "better-sqlite3": "^11.3.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "electron": "^33.0.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.5.4"
  }
}
```

- [ ] `apps/desktop/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"], "module": "CommonJS", "moduleResolution": "Node" },
  "include": ["src"]
}
```

- [ ] `apps/desktop/src/keyStore.ts`（safeStorage 实现 KeyStore，D4）：

```ts
import { safeStorage, app } from 'electron';
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyStore } from '@livetranslate/gateway';

export class SafeStorageKeyStore implements KeyStore {
  private file = join(app.getPath('userData'), 'apikey.enc');

  getKey(): string | null {
    if (!existsSync(this.file)) return null;
    return safeStorage.decryptString(readFileSync(this.file));
  }

  setKey(key: string): void {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(this.file, safeStorage.encryptString(key));
  }

  clearKey(): void {
    rmSync(this.file, { force: true });
  }
}
```

- [ ] `apps/desktop/src/main.ts`：

```ts
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { createGatewayServer, SettingsStore } from '@livetranslate/gateway';
import { SafeStorageKeyStore } from './keyStore';

let gatewayPort = 0;

async function boot(): Promise<void> {
  const dataDir = app.getPath('userData');
  const settings = new SettingsStore(join(dataDir, 'settings.json'), new SafeStorageKeyStore());
  const gateway = await createGatewayServer({ settings, dataDir, port: 0 }); // 随机端口，避免冲突
  gatewayPort = gateway.port;

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  if (process.env.LT_UI_DEV_URL) {
    await win.loadURL(process.env.LT_UI_DEV_URL); // 开发：vite dev server
  } else {
    await win.loadFile(join(__dirname, '..', 'ui', 'index.html')); // 打包：ui 构建产物（Task 35 拷入）
  }
}

ipcMain.handle('lt:gateway-port', () => gatewayPort);

app.whenReady().then(boot);
app.on('window-all-closed', () => app.quit());
```

- [ ] `apps/desktop/src/preload.ts`：

```ts
import { contextBridge, ipcRenderer } from 'electron';

void (async () => {
  const gatewayPort = (await ipcRenderer.invoke('lt:gateway-port')) as number;
  contextBridge.exposeInMainWorld('livetranslate', { gatewayPort });
})();
```

- [ ] `packages/gateway/src/index.ts` 末尾追加公共导出（供桌面内嵌）：

```ts
export { createGatewayServer, routes, type GatewayHandle, type GatewayOptions, type RouteHandler } from './server';
export { SettingsStore, EnvKeyStore, DEFAULT_SETTINGS, type AppSettings, type KeyStore, type HotwordTable } from './settings';
```

并把文件顶部的启动逻辑包进条件：`if (process.env.LT_GATEWAY_STANDALONE === '1') { ... }`（桌面内嵌 import 时不得副作用启动；`apps/web` 的 dev 脚本改为 `\"cross-env LT_GATEWAY_STANDALONE=1 pnpm --filter @livetranslate/gateway dev\"`，并在 apps/web devDependencies 追加 `"cross-env": "^7.0.3"`）。

**Step 2: 手工验证**

- [ ] 终端 A：`pnpm --filter @livetranslate/ui dev`；终端 B（PowerShell）：`$env:LT_UI_DEV_URL='http://localhost:5173'; pnpm --filter @livetranslate/desktop dev`。
- [ ] 预期：Electron 窗口打开同一 UI；设置页保存 Key 后重启应用 Key 仍在（safeStorage 加密文件 `apikey.enc` 出现在 userData 目录），且 `settings.json` 中搜不到 Key 明文。
- [ ] DevTools Console 执行 `window.livetranslate` → 预期 `{ gatewayPort: <非零端口> }`。

**Step 3: Commit**

- [ ] `git add apps/desktop apps/web packages/gateway pnpm-lock.yaml; git commit -m "feat(desktop): electron shell with safeStorage key store and embedded gateway"`

## Task 13: 麦克风采集 + 单人测试文本流跑通（M1 出口）

本任务包含三块：可单测的重采样/分块/语种清单（core）、浏览器采集（ui，手工验证）、SoloPage 文本版（text/stash 覆盖渲染）。

**Files:**
- Create: `packages/core/src/audio/resample.ts`、`packages/core/src/audio/pcmChunker.ts`、`packages/core/src/i18n/languages.ts`
- Create: `packages/core/test/resample.test.ts`、`packages/core/test/pcmChunker.test.ts`、`packages/core/test/languages.test.ts`
- Create: `packages/ui/src/audio/micCapture.ts`、`packages/ui/src/audio/pcm16-worklet.js`、`packages/ui/src/components/TranscriptView.tsx`
- Rewrite: `packages/ui/src/pages/SoloPage.tsx`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试（core 三件套）**

- [ ] `packages/core/test/resample.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { downsampleTo16kPcm16 } from '../src/audio/resample';

describe('downsampleTo16kPcm16', () => {
  it('48k -> 16k keeps 1/3 of samples', () => {
    const input = new Float32Array(4800).fill(0.5);
    const out = downsampleTo16kPcm16(input, 48000);
    expect(out.length).toBe(1600);
    expect(out[0]).toBe(Math.round(0.5 * 32767));
  });

  it('clamps out-of-range floats to int16 bounds', () => {
    const out = downsampleTo16kPcm16(new Float32Array([1.5, -1.5, 0]), 16000);
    expect(Array.from(out)).toEqual([32767, -32768, 0]);
  });

  it('16k input passes through sample count unchanged', () => {
    expect(downsampleTo16kPcm16(new Float32Array(160), 16000).length).toBe(160);
  });
});
```

- [ ] `packages/core/test/pcmChunker.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { PcmChunker } from '../src/audio/pcmChunker';

describe('PcmChunker (P7: 3200 bytes = 100ms)', () => {
  it('buffers until 3200 bytes then emits fixed-size chunks', () => {
    const chunks: ArrayBuffer[] = [];
    const c = new PcmChunker((b) => chunks.push(b));
    c.push(new Int16Array(800)); // 1600B → 不发
    expect(chunks.length).toBe(0);
    c.push(new Int16Array(800)); // 累计 3200B → 发 1 块
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.byteLength).toBe(3200);
  });

  it('large input splits into multiple chunks with remainder buffered', () => {
    const chunks: ArrayBuffer[] = [];
    const c = new PcmChunker((b) => chunks.push(b));
    c.push(new Int16Array(4000)); // 8000B = 2塗3200 + 1600 缓存
    expect(chunks.length).toBe(2);
    c.flush();
    expect(chunks.length).toBe(3);
    expect(chunks[2]!.byteLength).toBe(1600);
  });
});
```

- [ ] `packages/core/test/languages.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { LANGUAGES, supportsAudioOutput } from '../src/i18n/languages';

describe('languages (spec 2.5: 60 languages, 29 with audio output)', () => {
  it('has 60 entries and exactly 29 audio-capable', () => {
    expect(LANGUAGES.length).toBe(60);
    expect(LANGUAGES.filter((l) => l.audio).length).toBe(29);
  });

  it('lookup helper works for known cases', () => {
    expect(supportsAudioOutput('en')).toBe(true);
    expect(supportsAudioOutput('zh')).toBe(true);
    expect(supportsAudioOutput('bo')).toBe(false);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/resample.test.ts test/pcmChunker.test.ts test/languages.test.ts` → 预期 FAIL：三个 `Cannot find module`。

**Step 3: 最小实现（core）**

- [ ] `packages/core/src/audio/resample.ts`：

```ts
// 采集链：AudioWorklet Float32 @设备采样率 → 16k Int16（spec §6.1）；直接抽取法，语音场景足够
export function downsampleTo16kPcm16(input: Float32Array, inputRate: number): Int16Array {
  const ratio = inputRate / 16000;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const v = input[Math.floor(i * ratio)]!;
    const clamped = Math.max(-1, Math.min(1, v));
    out[i] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
  }
  return out;
}
```

- [ ] `packages/core/src/audio/pcmChunker.ts`：

```ts
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
```

- [ ] `packages/core/src/i18n/languages.ts`（spec §2.5：29 种支持音频输出，31 种仅文本）：

```ts
export interface LanguageInfo {
  code: string;
  name: string;
  audio: boolean; // 目标语言是否支持音频输出
}

// 音频支持 29 种
const AUDIO: Array<[string, string]> = [
  ['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['es', '西班牙语'],
  ['fr', '法语'], ['de', '德语'], ['ru', '俄语'], ['pt', '葡萄牙语'], ['it', '意大利语'],
  ['ar', '阿拉伯语'], ['hi', '印地语'], ['id', '印尼语'], ['th', '泰语'], ['vi', '越南语'],
  ['ms', '马来语'], ['tr', '土耳其语'], ['nl', '荷兰语'], ['pl', '波兰语'], ['sv', '瑞典语'],
  ['da', '丹麦语'], ['no', '挪威语'], ['fi', '芬兰语'], ['cs', '捷克语'], ['el', '希腊语'],
  ['he', '希伯来语'], ['hu', '匈牙利语'], ['ro', '罗马尼亚语'], ['uk', '乌克兰语'],
];
// 仅文本 31 种
const TEXT_ONLY: Array<[string, string]> = [
  ['bn', '孟加拉语'], ['ur', '乌尔都语'], ['fa', '波斯语'], ['ta', '泰米尔语'], ['te', '泰卢固语'],
  ['mr', '马拉地语'], ['gu', '古吉拉特语'], ['kn', '卡纳达语'], ['ml', '马拉雅拉姆语'], ['pa', '旁遮普语'],
  ['si', '僧伽罗语'], ['my', '缅甸语'], ['km', '高棉语'], ['lo', '老挝语'], ['fil', '菲律宾语'],
  ['sw', '斯瓦希里语'], ['am', '阿姆哈拉语'], ['az', '阿塞拜疆语'], ['kk', '哈萨克语'], ['uz', '乌兹别克语'],
  ['mn', '蒙古语'], ['ne', '尼泊尔语'], ['sk', '斯洛伐克语'], ['sl', '斯洛文尼亚语'], ['hr', '克罗地亚语'],
  ['sr', '塞尔维亚语'], ['bg', '保加利亚语'], ['lt', '立陶宛语'], ['lv', '拉脱维亚语'], ['et', '爱沙尼亚语'],
  ['bo', '藏语'],
];

export const LANGUAGES: LanguageInfo[] = [
  ...AUDIO.map(([code, name]) => ({ code, name, audio: true })),
  ...TEXT_ONLY.map(([code, name]) => ({ code, name, audio: false })),
];

export function supportsAudioOutput(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code && l.audio);
}
```

> 注：语种清单以百炼官方文档为准，落地时若官方清单与此表有出入，以官方为准修正表项（测试断言的 60/29 总量来自 spec §2.5，不变）。

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { downsampleTo16kPcm16 } from './audio/resample';
export { PcmChunker } from './audio/pcmChunker';
export { LANGUAGES, supportsAudioOutput, type LanguageInfo } from './i18n/languages';
```

**Step 4: 运行确认通过**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/resample.test.ts test/pcmChunker.test.ts test/languages.test.ts` → 预期 `7 passed`。

**Step 5: 浏览器采集实现（ui，手工验证）**

- [ ] `packages/ui/src/audio/pcm16-worklet.js`（放在 `public/` 不可行，需经 `audioWorklet.addModule` 加载，故以源码目录 + `?url` 引入）：

```js
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
```

- [ ] `packages/ui/src/audio/micCapture.ts`：

```ts
import { downsampleTo16kPcm16, PcmChunker } from '@livetranslate/core';
import workletUrl from './pcm16-worklet.js?url';

export interface MicCaptureOptions {
  deviceId?: string;
  echoCancellation?: boolean; // 实时翻译机/会议开启（D6）
  onChunk: (pcm3200: ArrayBuffer) => void;
  onLevel?: (rms: number) => void; // 音量条（Task 28 接入）
}

export interface MicCaptureHandle {
  stop(): void;
  pause(): void; // R4：暂停=停止产出 chunk，采集链保持
  resume(): void;
}

export async function startMicCapture(opts: MicCaptureOptions): Promise<MicCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      echoCancellation: opts.echoCancellation ?? true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(workletUrl);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm16-capture');
  let paused = false;
  const chunker = new PcmChunker(opts.onChunk);
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (paused) return;
    const f32 = e.data;
    if (opts.onLevel) {
      let sum = 0;
      for (let i = 0; i < f32.length; i++) sum += f32[i]! * f32[i]!;
      opts.onLevel(Math.sqrt(sum / f32.length));
    }
    chunker.push(downsampleTo16kPcm16(f32, ctx.sampleRate));
  };
  source.connect(node);
  node.connect(ctx.destination); // worklet 需接入图才会调度；输出静音（不回放输入）
  return {
    stop: () => {
      node.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
    pause: () => { paused = true; },
    resume: () => { paused = false; },
  };
}
```

- [ ] `packages/ui/src/components/TranscriptView.tsx`（P4 覆盖渲染：text 正常色 + stash 浅灰斜体，整段重绘）：

```tsx
import type { TranscriptSegment } from '@livetranslate/core';

export function TranscriptView({ segments, extra }: {
  segments: readonly TranscriptSegment[];
  extra?: (seg: TranscriptSegment) => JSX.Element | null;
}): JSX.Element {
  return (
    <div>
      {segments.map((s) => (
        <div key={s.seq} className="segment-card">
          <div className="source">
            {s.sourceText}<span className="stash">{s.sourceStash}</span>
            {s.sourceLang && <em>［{s.sourceLang}{s.emotion ? ` · ${s.emotion}` : ''}］</em>}
          </div>
          <div className="target">
            {s.targetText}<span className="stash">{s.targetStash}</span>
            {s.status === 'interrupted' && <span className="stash">（中断）</span>}
          </div>
          {extra?.(s)}
        </div>
      ))}
    </div>
  );
}
```

- [ ] `packages/ui/src/pages/SoloPage.tsx`（文本版，M1 出口；M2/T18 再扩展为完整版）：

```tsx
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { TranscriptModel, WsTransport, type SessionConfig } from '@livetranslate/core';
import { getPlatform } from '../platform';
import { TranscriptView } from '../components/TranscriptView';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';

function browserWsFactory(url: string) {
  const ws = new WebSocket(url);
  const like = {
    send: (d: string) => ws.send(d),
    close: () => ws.close(),
    onopen: null as (() => void) | null,
    onmessage: null as ((data: string) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as ((err: unknown) => void) | null,
  };
  ws.onopen = () => like.onopen?.();
  ws.onmessage = (e) => like.onmessage?.(String(e.data));
  ws.onclose = () => like.onclose?.();
  ws.onerror = (e) => like.onerror?.(e);
  return like;
}

export function SoloPage(): JSX.Element {
  const model = useMemo(() => new TranscriptModel(), []);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [running, setRunning] = useState(false);
  const transportRef = useRef<WsTransport | null>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);

  useEffect(() => model.onChange(force), [model]);

  async function start(): Promise<void> {
    const cfg: SessionConfig = {
      modalities: ['text'],
      voice: 'Tina',
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
      translation: { language: 'en' },
    };
    const t = new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory });
    (['session-created', 'session-updated', 'session-finished', 'speech-started', 'speech-stopped',
      'asr-delta', 'asr-completed', 'response-created', 'translation-delta', 'translation-done',
      'audio-delta', 'response-done', 'server-error'] as const)
      .forEach((k) => t.on(k, (ev) => model.apply(ev)));
    await t.connect(cfg);
    transportRef.current = t;
    micRef.current = await startMicCapture({ onChunk: (b) => t.appendAudio(b) });
    setRunning(true);
  }

  async function stop(): Promise<void> {
    micRef.current?.stop();
    micRef.current = null;
    await transportRef.current?.finish();
    transportRef.current = null;
    setRunning(false);
  }

  return (
    <div>
      <h2>单人测试（文本流）</h2>
      {!running
        ? <button onClick={() => void start()}>开始</button>
        : <button onClick={() => void stop()}>结束</button>}
      <TranscriptView segments={model.getSegments()} />
    </div>
  );
}
```

**Step 6: 手工验证（M1 出口标准）**

- [ ] 前置：设置页已填真实 Key + Host，自检通过。
- [ ] SoloPage 点“开始”→ 浏览器请求麦克风权限 → 对麦克风说“今天天气很好，我们一起去公园散步”。
- [ ] 预期：说话过程中出现段落卡片，原文小字浅色流式刷新（可见斜体 stash 部分被回撤重写），译文大字流式刷新；停顿 1s 后段落固化，出现 `［zh · neutral］` 标签。
- [ ] 点“结束”→ 预期 10s 内按钮回到“开始”（session.finished 后客户端断链）；网关 `logs/sessions/` 下出现本次 session 的 JSONL，其中 append 事件音频字段已截断为 `<b64 len=… fnv1a=…>`。
- [ ] 同样流程在 Electron 窗口验证一遍（麦克风权限弹窗在系统层）。

**Step 7: Commit**

- [ ] `git add packages/core packages/ui; git commit -m "feat: solo text-flow end to end (M1 exit)"`

---

# Milestone 2：单人测试完整

## Task 14: wav.ts + AudioSegmenter（P9：24kHz 输出）

**Files:**
- Create: `packages/core/src/audio/wav.ts`、`packages/core/src/session/audioSegmenter.ts`
- Create: `packages/core/test/wav.test.ts`、`packages/core/test/audioSegmenter.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试**

- [ ] `packages/core/test/wav.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { pcm16ToWav, wavDurationSeconds } from '../src/audio/wav';

describe('wav (P9: output is 24kHz/16bit/mono)', () => {
  it('writes a 44-byte RIFF header with rate 24000', () => {
    const pcm = new Uint8Array(48000); // 1s @24k/16bit
    const wav = pcm16ToWav(pcm, 24000);
    expect(wav.length).toBe(44 + 48000);
    const dv = new DataView(wav.buffer);
    expect(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)).toBe('RIFF');
    expect(dv.getUint32(24, true)).toBe(24000); // sample rate
    expect(dv.getUint32(28, true)).toBe(48000); // byte rate = rate*2
    expect(dv.getUint16(22, true)).toBe(1); // mono
    expect(dv.getUint32(40, true)).toBe(48000); // data size
  });

  it('duration helper: 48000 bytes @24k = 1s', () => {
    expect(wavDurationSeconds(48000, 24000)).toBe(1);
  });
});
```

- [ ] `packages/core/test/audioSegmenter.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioSegmenter } from '../src/session/audioSegmenter';
import { normalizeServerEvent } from '../src/protocol/normalize';
import { base64ToBytes } from '../src/audio/base64';
import type { ServerEvent } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readJsonl = (f: string): ServerEvent[] =>
  readFileSync(join(FIX, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServerEvent);

describe('AudioSegmenter', () => {
  it('concatenates audio-delta bytes per responseId and finalizes on response-done', () => {
    const done: Array<{ responseId: string; pcm: Uint8Array }> = [];
    const seg = new AudioSegmenter((responseId, pcm) => done.push({ responseId, pcm }));
    for (const raw of readJsonl('audio-turn.jsonl')) {
      const n = normalizeServerEvent(raw);
      if (n) seg.apply(n);
    }
    expect(done.length).toBe(1);
    expect(done[0]!.responseId).toBe('resp_MlgY53L3GmUfaCHIxXiHh');
    const d1 = base64ToBytes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const d2 = base64ToBytes('AdaB2YHlwfIF/bMDfws/Fx8ffyH/J38vvzS/NH8yvzW/Mn8yPyk/In8YPxB/CXcBzv9Z+lH0wfBh8eHvIfCR8rn5');
    expect(done[0]!.pcm.length).toBe(d1.length + d2.length);
    expect(done[0]!.pcm.slice(d1.length)).toEqual(d2);
  });

  it('interleaved responses are kept apart', () => {
    const done: string[] = [];
    const seg = new AudioSegmenter((responseId) => done.push(responseId));
    seg.apply({ kind: 'audio-delta', responseId: 'rA', base64: 'AAAA' });
    seg.apply({ kind: 'audio-delta', responseId: 'rB', base64: 'BBBB' });
    seg.apply({ kind: 'audio-delta', responseId: 'rA', base64: 'CCCC' });
    seg.apply({ kind: 'response-done', responseId: 'rA', usage: null });
    seg.apply({ kind: 'response-done', responseId: 'rB', usage: null });
    expect(done).toEqual(['rA', 'rB']);
  });

  it('response-done without any audio (text-only turn) does not emit', () => {
    const done: string[] = [];
    const seg = new AudioSegmenter((responseId) => done.push(responseId));
    seg.apply({ kind: 'response-done', responseId: 'rText', usage: null });
    expect(done).toEqual([]);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/wav.test.ts test/audioSegmenter.test.ts` → 预期 FAIL：两个 `Cannot find module`。

**Step 3: 最小实现**

- [ ] `packages/core/src/audio/wav.ts`：

```ts
// PCM16LE mono → WAV；输出音频固定 24000（P9），参数化便于测试
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ascii(36, 'data');
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

export function wavDurationSeconds(pcmBytes: number, sampleRate: number): number {
  return pcmBytes / (sampleRate * 2);
}

export const OUTPUT_SAMPLE_RATE = 24000; // P9
```

- [ ] `packages/core/src/session/audioSegmenter.ts`：

```ts
import { base64ToBytes } from '../audio/base64';
import type { NormalizedEvent } from '../protocol/types';

// 按 responseId 拼接 audio-delta，response-done 时交付完整 24k PCM（P9）
export class AudioSegmenter {
  private buffers = new Map<string, Uint8Array[]>();

  constructor(private onSegment: (responseId: string, pcm24k: Uint8Array) => void) {}

  apply(ev: NormalizedEvent): void {
    if (ev.kind === 'audio-delta') {
      const list = this.buffers.get(ev.responseId) ?? [];
      list.push(base64ToBytes(ev.base64));
      this.buffers.set(ev.responseId, list);
    }
    if (ev.kind === 'response-done') {
      const list = this.buffers.get(ev.responseId);
      if (!list || list.length === 0) return;
      this.buffers.delete(ev.responseId);
      const total = list.reduce((n, b) => n + b.length, 0);
      const pcm = new Uint8Array(total);
      let off = 0;
      for (const b of list) {
        pcm.set(b, off);
        off += b.length;
      }
      this.onSegment(ev.responseId, pcm);
    }
  }

  reset(): void {
    this.buffers.clear();
  }
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { pcm16ToWav, wavDurationSeconds, OUTPUT_SAMPLE_RATE } from './audio/wav';
export { AudioSegmenter } from './session/audioSegmenter';
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/wav.test.ts test/audioSegmenter.test.ts` → 预期 `5 passed`。
- [ ] `git add packages/core; git commit -m "feat(core): 24k WAV encoding and per-response AudioSegmenter (P9)"`

## Task 15: UsageMeter（P6 差分，真实 usage 序列驱动）

**Files:**
- Create: `packages/core/src/session/usageMeter.ts`
- Create: `packages/core/test/usageMeter.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试**

- [ ] `packages/core/test/usageMeter.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageMeter } from '../src/session/usageMeter';
import type { Usage } from '../src/protocol/types';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SEQ = JSON.parse(readFileSync(join(FIX, 'usage-sequence.json'), 'utf8')) as Usage[];

describe('UsageMeter (P6: usage is session-cumulative, must diff)', () => {
  it('per-response delta from the real 169/436/697/972 sequence', () => {
    const m = new UsageMeter();
    const deltas = SEQ.map((u) => m.applyUsage(u).lastDelta.total_tokens);
    expect(deltas).toEqual([169, 267, 261, 275]);
  });

  it('session total equals the last cumulative value, not the sum of deltas doubled', () => {
    const m = new UsageMeter();
    for (const u of SEQ) m.applyUsage(u);
    const s = m.snapshot();
    expect(s.sessionTotal.total_tokens).toBe(972);
    expect(s.sessionTotal.input_tokens_details.audio_tokens).toBe(189);
    expect(s.sessionTotal.output_tokens_details.audio_tokens).toBe(327);
  });

  it('startNewSession() carries finished session totals into globalTotal (rotation, P13)', () => {
    const m = new UsageMeter();
    for (const u of SEQ) m.applyUsage(u);
    m.startNewSession();
    m.applyUsage(SEQ[0]!); // 新 session 重新从累积 169 开始
    const s = m.snapshot();
    expect(s.sessionTotal.total_tokens).toBe(169);
    expect(s.globalTotal.total_tokens).toBe(972 + 169);
  });

  it('null-safe: missing audio_tokens in output details treated as 0', () => {
    const m = new UsageMeter();
    const r = m.applyUsage({
      total_tokens: 118, input_tokens: 85, output_tokens: 33,
      input_tokens_details: { text_tokens: 50, audio_tokens: 35 },
      output_tokens_details: { text_tokens: 33 },
    });
    expect(r.lastDelta.output_tokens_details.audio_tokens).toBe(0);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/usageMeter.test.ts` → 预期 FAIL：`Cannot find module '../src/session/usageMeter'`。

**Step 3: 最小实现**

- [ ] `packages/core/src/session/usageMeter.ts`：

```ts
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
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { UsageMeter, type UsageFlat, type UsageSnapshot } from './session/usageMeter';
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/usageMeter.test.ts` → 预期 `4 passed`。
- [ ] `git add packages/core; git commit -m "feat(core): UsageMeter with cumulative-usage diffing (P6)"`

## Task 16: SQLite schema + StorageAdapter + 音频落盘

schema 完全对应 spec §6.2 + §6.6（session_logs 索引表）。WAL 模式，参数化查询。

**Files:**
- Create: `packages/gateway/src/db.ts`、`packages/gateway/src/storage.ts`
- Create: `packages/gateway/test/storage.test.ts`

**Step 1: 写失败测试**

- [ ] `packages/gateway/test/storage.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db';
import { Storage } from '../src/storage';

let storage: Storage;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'lt-store-'));
  storage = new Storage(openDb(join(dataDir, 'app.db')), dataDir);
});

describe('Storage', () => {
  it('creates a session and finishes it with cumulative usage', () => {
    storage.createSession({ id: 'sess_1', mode: 'solo', configJson: '{"translation":{"language":"en"}}', startedAt: 1000 });
    storage.finishSession('sess_1', { endedAt: 2000, usageJson: '{"total_tokens":972}' });
    const s = storage.getSession('sess_1');
    expect(s?.mode).toBe('solo');
    expect(s?.ended_at).toBe(2000);
    expect(JSON.parse(s!.usage_json!)).toEqual({ total_tokens: 972 });
  });

  it('saves segments with audio file and lists them ordered by seq', () => {
    storage.createSession({ id: 'sess_2', mode: 'solo', configJson: '{}', startedAt: 0 });
    const audioPath = storage.saveSegmentAudio('sess_2', 1, new Uint8Array([1, 2, 3, 4]));
    expect(existsSync(audioPath)).toBe(true);
    expect(audioPath.endsWith(join('audio', 'sess_2', '1.wav'))).toBe(true);
    storage.insertSegment({
      sessionId: 'sess_2', seq: 1, vadStartMs: 0, vadEndMs: 4600,
      sourceText: '今天天气很好，我们一起去公园散步。',
      targetText: "The weather is very nice today, let's go for a walk in the park together.  ",
      sourceLang: 'zh', emotion: 'neutral', audioPath, usageJson: '{"total_tokens":118}',
    });
    const segs = storage.listSegments('sess_2');
    expect(segs.length).toBe(1);
    expect(segs[0]!.audio_path).toBe(audioPath);
  });

  it('lists sessions by mode, newest first', () => {
    storage.createSession({ id: 'a', mode: 'solo', configJson: '{}', startedAt: 1 });
    storage.createSession({ id: 'b', mode: 'filedub', configJson: '{}', startedAt: 2 });
    storage.createSession({ id: 'c', mode: 'solo', configJson: '{}', startedAt: 3 });
    expect(storage.listSessions('solo').map((s) => s.id)).toEqual(['c', 'a']);
    expect(storage.listSessions().map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('session_logs index row (spec 6.6) upserts and reads back', () => {
    storage.upsertSessionLog({ sessionId: 'sess_3', filePath: '/logs/sessions/sess_3.jsonl', mode: 'solo', startedAt: 1, endedAt: 9, eventCount: 49, errorCount: 0 });
    const row = storage.getSessionLog('sess_3');
    expect(row?.event_count).toBe(49);
    storage.upsertSessionLog({ sessionId: 'sess_3', filePath: '/logs/sessions/sess_3.jsonl', mode: 'solo', startedAt: 1, endedAt: 20, eventCount: 80, errorCount: 1 });
    expect(storage.getSessionLog('sess_3')?.event_count).toBe(80);
  });

  it('deleteSession removes segments too', () => {
    storage.createSession({ id: 'd', mode: 'solo', configJson: '{}', startedAt: 1 });
    storage.insertSegment({ sessionId: 'd', seq: 1, vadStartMs: 0, vadEndMs: 100, sourceText: 'x', targetText: 'y', sourceLang: null, emotion: null, audioPath: null, usageJson: null });
    storage.deleteSession('d');
    expect(storage.getSession('d')).toBeUndefined();
    expect(storage.listSegments('d')).toEqual([]);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/storage.test.ts` → 预期 FAIL：`Cannot find module '../src/db'`。

**Step 3: 最小实现**

- [ ] `packages/gateway/src/db.ts`：

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

// spec §6.2 + §6.6；所有时间为 epoch ms
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('solo','filedub','interpreter','meeting')),
  config_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  usage_json TEXT
);
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  vad_start_ms INTEGER,
  vad_end_ms INTEGER,
  source_text TEXT NOT NULL DEFAULT '',
  target_text TEXT NOT NULL DEFAULT '',
  source_lang TEXT,
  emotion TEXT,
  audio_path TEXT,
  usage_json TEXT,
  UNIQUE(session_id, seq)
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  roster_json TEXT NOT NULL,
  target_language TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meeting_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media_jobs (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  frame_config_json TEXT NOT NULL,
  artifacts_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','done','failed')),
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_logs (
  session_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  event_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_mode ON sessions(mode, started_at DESC);
`;

export function openDb(filePath: string): Db {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
```

- [ ] `packages/gateway/src/storage.ts`：

```ts
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';

export type SessionMode = 'solo' | 'filedub' | 'interpreter' | 'meeting';

export interface SessionRow {
  id: string; mode: SessionMode; config_json: string;
  started_at: number; ended_at: number | null; usage_json: string | null;
}

export interface SegmentRow {
  id: number; session_id: string; seq: number;
  vad_start_ms: number | null; vad_end_ms: number | null;
  source_text: string; target_text: string;
  source_lang: string | null; emotion: string | null;
  audio_path: string | null; usage_json: string | null;
}

export interface SessionLogRow {
  session_id: string; file_path: string; mode: string;
  started_at: number; ended_at: number | null;
  event_count: number; error_count: number;
}

export class Storage {
  constructor(private db: Db, private dataDir: string) {}

  createSession(s: { id: string; mode: SessionMode; configJson: string; startedAt: number }): void {
    this.db.prepare('INSERT INTO sessions (id, mode, config_json, started_at) VALUES (?, ?, ?, ?)')
      .run(s.id, s.mode, s.configJson, s.startedAt);
  }

  finishSession(id: string, end: { endedAt: number; usageJson: string }): void {
    this.db.prepare('UPDATE sessions SET ended_at = ?, usage_json = ? WHERE id = ?')
      .run(end.endedAt, end.usageJson, id);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  listSessions(mode?: SessionMode): SessionRow[] {
    return mode
      ? (this.db.prepare('SELECT * FROM sessions WHERE mode = ? ORDER BY started_at DESC').all(mode) as SessionRow[])
      : (this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all() as SessionRow[]);
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    rmSync(join(this.dataDir, 'audio', id), { recursive: true, force: true });
  }

  saveSegmentAudio(sessionId: string, seq: number, wavBytes: Uint8Array): string {
    const dir = join(this.dataDir, 'audio', sessionId);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${seq}.wav`);
    writeFileSync(p, wavBytes);
    return p;
  }

  insertSegment(seg: {
    sessionId: string; seq: number; vadStartMs: number | null; vadEndMs: number | null;
    sourceText: string; targetText: string; sourceLang: string | null; emotion: string | null;
    audioPath: string | null; usageJson: string | null;
  }): void {
    this.db.prepare(`INSERT INTO segments
      (session_id, seq, vad_start_ms, vad_end_ms, source_text, target_text, source_lang, emotion, audio_path, usage_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(seg.sessionId, seg.seq, seg.vadStartMs, seg.vadEndMs, seg.sourceText, seg.targetText,
        seg.sourceLang, seg.emotion, seg.audioPath, seg.usageJson);
  }

  listSegments(sessionId: string): SegmentRow[] {
    return this.db.prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY seq').all(sessionId) as SegmentRow[];
  }

  upsertSessionLog(row: { sessionId: string; filePath: string; mode: string; startedAt: number; endedAt: number | null; eventCount: number; errorCount: number }): void {
    this.db.prepare(`INSERT INTO session_logs (session_id, file_path, mode, started_at, ended_at, event_count, error_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET ended_at = excluded.ended_at, event_count = excluded.event_count, error_count = excluded.error_count`)
      .run(row.sessionId, row.filePath, row.mode, row.startedAt, row.endedAt, row.eventCount, row.errorCount);
  }

  getSessionLog(sessionId: string): SessionLogRow | undefined {
    return this.db.prepare('SELECT * FROM session_logs WHERE session_id = ?').get(sessionId) as SessionLogRow | undefined;
  }
}
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/storage.test.ts` → 预期 `5 passed`。
- [ ] `git add packages/gateway; git commit -m "feat(gateway): sqlite schema and storage adapter (spec 6.2/6.6)"`

## Task 17: SessionOrchestrator（R2/R3/R4 + 延迟指标）

把 transport/模型/分段器/计量器编排到一起：负责启动、暂停/恢复（R4）、重置（R4）、指数退避重连（R3）、首字延迟打点。transport 工厂注入便于测试。

**Files:**
- Create: `packages/core/src/session/sessionOrchestrator.ts`
- Create: `packages/core/test/sessionOrchestrator.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试**

- [ ] `packages/core/test/sessionOrchestrator.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { SessionOrchestrator } from '../src/session/sessionOrchestrator';
import { Emitter } from '../src/protocol/emitter';
import type {
  ITranslateTransport, NormalizedEvent, NormalizedKind, RawDirection, ServerEvent, SessionConfig,
} from '../src/protocol/types';

type EventMap = { [K in NormalizedKind]: Extract<NormalizedEvent, { kind: K }> };

class FakeTransport implements ITranslateTransport {
  readonly kind = 'ws' as const;
  em = new Emitter<EventMap>();
  appended: ArrayBuffer[] = [];
  connectCalls = 0;
  finished = false;
  aborted = false;
  failNextConnect = false;
  connect(_cfg: SessionConfig): Promise<void> {
    this.connectCalls += 1;
    return this.failNextConnect ? Promise.reject(new Error('conn refused')) : Promise.resolve();
  }
  updateSession(): Promise<void> { return Promise.resolve(); }
  appendAudio(pcm16: ArrayBuffer): void { this.appended.push(pcm16); }
  appendImage(): void { /* 本测试不用 */ }
  finish(): Promise<void> { this.finished = true; return Promise.resolve(); }
  abort(): void { this.aborted = true; }
  on<K extends NormalizedKind>(kind: K, cb: (ev: EventMap[K]) => void): () => void { return this.em.on(kind, cb); }
  onRaw(_cb: (dir: RawDirection, payload: ServerEvent) => void): () => void { return () => undefined; }
  getRemoteAudio(): MediaStream | null { return null; }
  emit(ev: NormalizedEvent): void { this.em.emit(ev.kind, ev as never); }
}

const CFG: SessionConfig = {
  modalities: ['text'], voice: 'Tina', sample_rate: 16000, input_audio_format: 'pcm',
  input_audio_transcription: { model: 'qwen3-asr-flash-realtime' }, translation: { language: 'en' },
};

function setup(overrides: { failFirst?: boolean } = {}) {
  const transports: FakeTransport[] = [];
  const orch = new SessionOrchestrator({
    config: CFG,
    transportFactory: () => {
      const t = new FakeTransport();
      if (overrides.failFirst && transports.length === 0) t.failNextConnect = true;
      transports.push(t);
      return t;
    },
  });
  return { orch, transports };
}

describe('SessionOrchestrator', () => {
  it('start() connects and forwards audio; pause() gates appendAudio (R4)', async () => {
    const { orch, transports } = setup();
    await orch.start();
    orch.pushAudio(new ArrayBuffer(3200));
    orch.pause();
    orch.pushAudio(new ArrayBuffer(3200));
    orch.resume();
    orch.pushAudio(new ArrayBuffer(3200));
    expect(transports[0]!.appended.length).toBe(2); // 暂停期间的块被丢弃，session 保留
    expect(orch.state).toBe('running');
  });

  it('reset() aborts, clears model, starts a fresh session (R4)', async () => {
    const { orch, transports } = setup();
    await orch.start();
    transports[0]!.emit({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
    expect(orch.model.getSegments().length).toBe(1);
    await orch.reset();
    expect(transports[0]!.aborted).toBe(true);
    expect(orch.model.getSegments().length).toBe(0);
    expect(transports.length).toBe(2); // 新 session
  });

  it('stop() calls finish and transitions to idle', async () => {
    const { orch, transports } = setup();
    await orch.start();
    await orch.stop();
    expect(transports[0]!.finished).toBe(true);
    expect(orch.state).toBe('idle');
  });

  it('reconnects with exponential backoff 500/1000/2000/4000, max 5 (R3)', async () => {
    vi.useFakeTimers();
    try {
      const { orch, transports } = setup();
      await orch.start();
      transports[0]!.em.clear();
      orch.handleDisconnect(); // 模拟意外断线
      expect(orch.state).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(500);
      expect(transports.length).toBe(2);
      expect(orch.state).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks in-flight segments interrupted on disconnect (R3)', async () => {
    vi.useFakeTimers();
    try {
      const { orch, transports } = setup();
      await orch.start();
      transports[0]!.emit({ kind: 'speech-started', itemId: 'i1', audioStartMs: 0 });
      orch.handleDisconnect();
      expect(orch.model.getSegments()[0]!.status).toBe('interrupted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after 5 failed reconnects and reports error state (R3)', async () => {
    vi.useFakeTimers();
    try {
      const transports: FakeTransport[] = [];
      const orch = new SessionOrchestrator({
        config: CFG,
        transportFactory: () => {
          const t = new FakeTransport();
          t.failNextConnect = transports.length >= 0; // 首连之后全部失败
          if (transports.length === 0) t.failNextConnect = false;
          transports.push(t);
          return t;
        },
      });
      await orch.start();
      orch.handleDisconnect();
      await vi.advanceTimersByTimeAsync(500 + 1000 + 2000 + 4000 + 4000 + 1000);
      expect(orch.state).toBe('error');
      expect(transports.length).toBe(1 + 5);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/sessionOrchestrator.test.ts` → 预期 FAIL：`Cannot find module '../src/session/sessionOrchestrator'`。

**Step 3: 最小实现**

- [ ] `packages/core/src/session/sessionOrchestrator.ts`：

```ts
import { TranscriptModel } from './transcriptModel';
import type { ITranslateTransport, NormalizedKind, SessionConfig } from '../protocol/types';

export type OrchestratorState = 'idle' | 'running' | 'paused' | 'reconnecting' | 'error';

const BACKOFF_MS = [500, 1000, 2000, 4000, 4000]; // R3：上限 5 次
const ALL_KINDS: NormalizedKind[] = [
  'session-created', 'session-updated', 'session-finished', 'speech-started', 'speech-stopped',
  'asr-delta', 'asr-completed', 'response-created', 'translation-delta', 'translation-done',
  'audio-delta', 'response-done', 'server-error',
];

export interface OrchestratorOptions {
  config: SessionConfig;
  transportFactory: () => ITranslateTransport;
  onStateChange?: (state: OrchestratorState) => void;
}

export class SessionOrchestrator {
  readonly model = new TranscriptModel();
  state: OrchestratorState = 'idle';
  transport: ITranslateTransport | null = null;
  private paused = false;
  private offs: Array<() => void> = [];

  constructor(private opts: OrchestratorOptions) {}

  private setState(s: OrchestratorState): void {
    this.state = s;
    this.opts.onStateChange?.(s);
  }

  async start(): Promise<void> {
    const t = this.opts.transportFactory();
    this.transport = t;
    for (const k of ALL_KINDS) {
      this.offs.push(t.on(k, (ev) => this.model.apply(ev)));
    }
    await t.connect(this.opts.config);
    this.paused = false;
    this.setState('running');
  }

  pushAudio(pcm16: ArrayBuffer): void {
    if (this.state !== 'running' || this.paused) return; // R4：暂停=停止 append
    this.transport?.appendAudio(pcm16);
  }

  pause(): void {
    this.paused = true;
    this.setState('paused');
  }

  resume(): void {
    this.paused = false;
    this.setState('running');
  }

  async stop(): Promise<void> {
    await this.transport?.finish();
    this.teardown();
    this.setState('idle');
  }

  async reset(): Promise<void> {
    this.transport?.abort(); // R4：重置 = abort + 新 session + 清屏
    this.teardown();
    this.model.reset();
    await this.start();
  }

  handleDisconnect(): void {
    this.model.markInterrupted(); // R3：进行中段落标中断
    this.teardown();
    this.setState('reconnecting');
    this.scheduleReconnect(0);
  }

  private scheduleReconnect(attempt: number): void {
    if (attempt >= BACKOFF_MS.length) {
      this.setState('error');
      return;
    }
    setTimeout(() => {
      void this.start().catch(() => this.scheduleReconnect(attempt + 1));
    }, BACKOFF_MS[attempt]);
  }

  private teardown(): void {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.transport = null;
  }
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { SessionOrchestrator, type OrchestratorState, type OrchestratorOptions } from './session/sessionOrchestrator';
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/sessionOrchestrator.test.ts` → 预期 `6 passed`。
- [ ] `git add packages/core; git commit -m "feat(core): SessionOrchestrator with pause/reset/backoff-reconnect (R2-R4)"`

## Task 18: 单人测试完整页（段回放/暂停重置/仪表盘/落库）

把 spec §5.1 完整落地：配置面板（源/目标语言、"同时生成语音"开关、热词表选择）、段落卡片音频回放（**不自动播放**）、暂停/恢复/重置/结束（R4）、UsageDashboard 仪表盘（§6.4）、会话与段落落库（§6.2）。本任务分两个 commit：先做后端（网关落库路由 + orchestrator 事件透传），再做 UI 完整页。

**Files:**
- `packages/core/src/session/sessionOrchestrator.ts`（修改：`OrchestratorOptions.onEvent` 透传）
- `packages/core/test/sessionOrchestrator.test.ts`（追加 1 条测试）
- `packages/gateway/src/historyRoutes.ts`（新建：写入侧路由；T19 追加查询侧）
- `packages/gateway/src/server.ts`（修改：打开 SQLite、注册路由、Handle 暴露 storage）
- `packages/gateway/test/historyRoutes.test.ts`（新建）
- `packages/ui/src/audio/playerSink.ts`、`src/components/SegmentCard.tsx`、`src/components/UsageDashboard.tsx`（新建）
- `packages/ui/src/api.ts`（追加落库函数）
- `packages/ui/src/pages/SoloPage.tsx`（完整版重写）

**Step 1: 写失败测试（后端两处）**

- [ ] `packages/core/test/sessionOrchestrator.test.ts` 追加（放入既有 `describe` 内，`FakeTransport` 复用该文件已有实现）：

```ts
  it('forwards every normalized event to opts.onEvent (for AudioSegmenter/UsageMeter taps)', async () => {
    const t = new FakeTransport();
    const seen: string[] = [];
    const orch = new SessionOrchestrator({
      config: CONFIG,
      transportFactory: () => t,
      onEvent: (ev) => seen.push(ev.kind),
    });
    await orch.start();
    t.emit({ kind: 'session-created', sessionId: 'sess_tap' });
    t.emit({ kind: 'speech-started', itemId: 'item_tap', audioStartMs: 0 });
    expect(seen).toEqual(['session-created', 'speech-started']);
    // 模型同样收到（onEvent 是旁路 tap，不取代 model.apply）
    expect(orch.model.getSegments().length).toBeGreaterThan(0);
  });
```

- [ ] `packages/gateway/test/historyRoutes.test.ts`：

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayServer, type GatewayHandle } from '../src/server';
import { SettingsStore, type KeyStore } from '../src/settings';

class MemKeyStore implements KeyStore {
  private key: string | null = null;
  getKey(): string | null { return this.key; }
  setKey(k: string): void { this.key = k; }
  clearKey(): void { this.key = null; }
}

describe('history routes (write side, spec 6.2/6.6)', () => {
  let dir: string;
  let gw: GatewayHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lt-hist-'));
    const settings = new SettingsStore(join(dir, 'settings.json'), new MemKeyStore());
    gw = await createGatewayServer({ settings, dataDir: dir, port: 0 });
  });

  afterEach(async () => {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${gw.port}${path}`, { method: 'POST', body: JSON.stringify(body) });

  it('POST /sessions creates a session row readable via handle storage', async () => {
    const res = await post('/sessions', { id: 'sess_h1', mode: 'solo', configJson: '{}', startedAt: 1000 });
    expect(res.status).toBe(200);
    expect(gw.storage.getSession('sess_h1')?.mode).toBe('solo');
  });

  it('POST /segments stores wav bytes to audio dir and inserts segment row', async () => {
    await post('/sessions', { id: 'sess_h2', mode: 'solo', configJson: '{}', startedAt: 1000 });
    const wavBase64 = Buffer.from([0x52, 0x49, 0x46, 0x46]).toString('base64'); // 'RIFF'
    const res = await post('/segments', {
      sessionId: 'sess_h2', seq: 1, vadStartMs: 0, vadEndMs: 4600,
      sourceText: '今天天气很好，我们一起去公园散步。',
      targetText: "The weather is very nice today, let's go for a walk in the park together.  ",
      sourceLang: 'zh', emotion: 'neutral', usageJson: '{"total_tokens":169}', wavBase64,
    });
    expect(res.status).toBe(200);
    const segs = gw.storage.listSegments('sess_h2');
    expect(segs.length).toBe(1);
    expect(segs[0]!.audio_path?.endsWith(join('audio', 'sess_h2', '1.wav'))).toBe(true);
  });

  it('POST /sessions/finish sets ended_at/usage and upserts session_logs index from jsonl', async () => {
    await post('/sessions', { id: 'sess_h3', mode: 'solo', configJson: '{}', startedAt: 1000 });
    // 仿真 relay（T8）已写过的事件日志文件
    mkdirSync(join(dir, 'logs', 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'sessions', 'sess_h3.jsonl'),
      '{"ts":1,"dir":"c2s","type":"session.update","payload":{}}\n{"ts":2,"dir":"s2c","type":"error","payload":{}}\n');
    const res = await post('/sessions/finish', { id: 'sess_h3', endedAt: 9000, usageJson: '{"total_tokens":972}' });
    expect(res.status).toBe(200);
    expect(gw.storage.getSession('sess_h3')?.ended_at).toBe(9000);
    const log = gw.storage.getSessionLog('sess_h3');
    expect(log?.event_count).toBe(2);
    expect(log?.error_count).toBe(1);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/sessionOrchestrator.test.ts` → 预期 FAIL：新增用例 `expected [] to deeply equal ['session-created', 'speech-started']`（`onEvent` 尚不存在）。
- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/historyRoutes.test.ts` → 预期 FAIL：`expected 404 to be 200`（路由未注册）。

**Step 3: 最小实现**

- [ ] `packages/core/src/session/sessionOrchestrator.ts` 两处修改：

```ts
// 1) OrchestratorOptions 增加 onEvent 旁路 tap（UI 用它喂 AudioSegmenter/UsageMeter/落库）：
export interface OrchestratorOptions {
  config: SessionConfig;
  transportFactory: () => ITranslateTransport;
  onStateChange?: (state: OrchestratorState) => void;
  onEvent?: (ev: NormalizedEvent) => void;
}

// 2) start() 中订阅回调改为（同时在文件头 import type 追加 NormalizedEvent）：
    for (const k of ALL_KINDS) {
      this.offs.push(t.on(k, (ev) => {
        this.model.apply(ev);
        this.opts.onEvent?.(ev);
      }));
    }
```

- [ ] `packages/gateway/src/historyRoutes.ts`：

```ts
import { existsSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { RouteHandler } from './server';
import type { SessionMode, Storage } from './storage';

export interface HistoryDeps {
  storage: Storage;
  dataDir: string;
}

export function logFilePath(dataDir: string, sessionId: string): string {
  return join(dataDir, 'logs', 'sessions', `${sessionId}.jsonl`); // 与 SessionLogFiles.sessionsDir（T8）同一约定
}

const json = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

export function registerHistoryRoutes(routes: Map<string, RouteHandler>, deps: HistoryDeps): void {
  routes.set('POST /sessions', (_req, res, body) => {
    const b = JSON.parse(body) as { id: string; mode: SessionMode; configJson: string; startedAt: number };
    deps.storage.createSession({ id: b.id, mode: b.mode, configJson: b.configJson, startedAt: b.startedAt });
    json(res, 200, { ok: true });
  });

  routes.set('POST /segments', (_req, res, body) => {
    const b = JSON.parse(body) as {
      sessionId: string; seq: number; vadStartMs: number | null; vadEndMs: number | null;
      sourceText: string; targetText: string; sourceLang: string | null; emotion: string | null;
      usageJson: string | null; wavBase64?: string;
    };
    const audioPath = b.wavBase64
      ? deps.storage.saveSegmentAudio(b.sessionId, b.seq, new Uint8Array(Buffer.from(b.wavBase64, 'base64')))
      : null;
    deps.storage.insertSegment({
      sessionId: b.sessionId, seq: b.seq, vadStartMs: b.vadStartMs, vadEndMs: b.vadEndMs,
      sourceText: b.sourceText, targetText: b.targetText, sourceLang: b.sourceLang,
      emotion: b.emotion, audioPath, usageJson: b.usageJson,
    });
    json(res, 200, { ok: true, audioPath });
  });

  routes.set('POST /sessions/finish', (_req, res, body) => {
    const b = JSON.parse(body) as { id: string; endedAt: number; usageJson: string };
    deps.storage.finishSession(b.id, { endedAt: b.endedAt, usageJson: b.usageJson });
    const file = logFilePath(deps.dataDir, b.id);
    const row = deps.storage.getSession(b.id);
    if (existsSync(file) && row) {
      // spec §6.6：session_logs 只是索引，日志本体留在 JSONL 文件
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
      const errors = lines.filter((l) => (JSON.parse(l) as { type?: string }).type === 'error').length;
      deps.storage.upsertSessionLog({
        sessionId: b.id, filePath: file, mode: row.mode, startedAt: row.started_at,
        endedAt: b.endedAt, eventCount: lines.length, errorCount: errors,
      });
    }
    json(res, 200, { ok: true });
  });
}
```

- [ ] `packages/gateway/src/server.ts` 四处修改：

```ts
// 1) 文件头追加 import：
import { join } from 'node:path';
import { openDb } from './db';
import { Storage } from './storage';
import { registerHistoryRoutes } from './historyRoutes';

// 2) GatewayHandle 增加 storage 字段：
export interface GatewayHandle {
  port: number;
  server: Server;
  storage: Storage;
  close(): Promise<void>;
}

// 3) createGatewayServer 内、`const logFiles = ...` 之后追加：
  const db = openDb(join(opts.dataDir, 'livetranslate.db'));
  const storage = new Storage(db, opts.dataDir);
  registerHistoryRoutes(routes, { storage, dataDir: opts.dataDir });

// 4) 返回值增加 storage，close 中关闭 db（在 logFiles.closeAll() 之后）：
  return {
    port,
    server,
    storage,
    close: async () => {
      await logFiles.closeAll();
      db.close();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
```

**Step 4: 运行确认通过 + Commit（后端半程）**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/sessionOrchestrator.test.ts` → 预期 `7 passed`。
- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/historyRoutes.test.ts` → 预期 `3 passed`。
- [ ] `pnpm --filter @livetranslate/gateway exec vitest run` → 预期既有 relay/settings/selfCheck/storage 测试全部仍通过（无回归）。
- [ ] `git add packages/core packages/gateway; git commit -m "feat: session persistence routes and orchestrator onEvent tap"`

**Step 5: UI 实现（完整代码）**

- [ ] `packages/ui/src/wsFactory.ts`（把 T13 内联在 SoloPage 的 `browserWsFactory` 原样移入并共享，后续 T29/T33 复用）：

```ts
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
```

- [ ] `packages/ui/src/audio/playerSink.ts`（段落回放：WAV blob + `<audio>`，支持 setSinkId，spec §6.1）：

```ts
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
      url = URL.createObjectURL(new Blob([wavBytes], { type: 'audio/wav' }));
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
```

- [ ] `packages/ui/src/components/SegmentCard.tsx`（text/stash 覆盖渲染同 TranscriptView；▶ 回放不自动播放，spec §5.1）：

```tsx
import type { TranscriptSegment } from '@livetranslate/core';

export interface SegmentCardProps {
  segment: TranscriptSegment;
  audio?: { durationSec: number; onPlay: () => void } | null;
  tokensDelta?: number | null; // 会议模式（T33）传入每段增量 tokens
}

export function SegmentCard({ segment, audio, tokensDelta }: SegmentCardProps): JSX.Element {
  return (
    <div className={`segment-card status-${segment.status}`}>
      <div className="segment-source">
        <span>{segment.sourceText}</span>
        {segment.sourceStash && <span className="stash">{segment.sourceStash}</span>}
        {segment.status === 'done' && segment.sourceLang && (
          <span className="lang-tag">［{segment.sourceLang}{segment.emotion ? ` · ${segment.emotion}` : ''}］</span>
        )}
      </div>
      <div className="segment-target">
        <span>{segment.targetText}</span>
        {segment.targetStash && <span className="stash">{segment.targetStash}</span>}
        {segment.status === 'interrupted' && <span className="warn-banner">段落中断</span>}
      </div>
      <div className="segment-meta">
        {audio && <button onClick={audio.onPlay}>▶ {audio.durationSec.toFixed(1)}s</button>}
        {typeof tokensDelta === 'number' && <span className="usage-tag">+{tokensDelta} tok</span>}
      </div>
    </div>
  );
}
```

- [ ] `packages/ui/src/components/UsageDashboard.tsx`（spec §5.1 仪表盘 + §6.4 参考系数）：

```tsx
import type { UsageSnapshot } from '@livetranslate/core';

export interface UsageDashboardProps {
  snapshot: UsageSnapshot | null;
  firstDeltaLatencyMs: number | null;
  sessionSeconds: number;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

export function UsageDashboard({ snapshot, firstDeltaLatencyMs, sessionSeconds }: UsageDashboardProps): JSX.Element {
  const s = snapshot;
  const mm = Math.floor(sessionSeconds / 60);
  const ss = String(Math.floor(sessionSeconds % 60)).padStart(2, '0');
  return (
    <section className="usage-dashboard">
      <div className="metric"><span className="metric-label">会话 tokens</span><span className="metric-value">{fmt(s?.sessionTotal.total_tokens ?? 0)}</span></div>
      <div className="metric"><span className="metric-label">输入 音频/文本</span><span className="metric-value">{fmt(s?.sessionTotal.input_tokens_details.audio_tokens ?? 0)} / {fmt(s?.sessionTotal.input_tokens_details.text_tokens ?? 0)}</span></div>
      <div className="metric"><span className="metric-label">输出 音频/文本</span><span className="metric-value">{fmt(s?.sessionTotal.output_tokens_details.audio_tokens ?? 0)} / {fmt(s?.sessionTotal.output_tokens_details.text_tokens ?? 0)}</span></div>
      <div className="metric"><span className="metric-label">最近段增量</span><span className="metric-value">+{fmt(s?.lastDelta.total_tokens ?? 0)}</span></div>
      <div className="metric"><span className="metric-label">全局累计</span><span className="metric-value">{fmt(s?.globalTotal.total_tokens ?? 0)}</span></div>
      <div className="metric"><span className="metric-label">首字延迟</span><span className="metric-value">{firstDeltaLatencyMs === null ? '—' : `${firstDeltaLatencyMs} ms`}</span></div>
      <div className="metric"><span className="metric-label">会话时长</span><span className="metric-value">{mm}:{ss}</span></div>
      <div className="metric-note">参考系数：输入音频 ~7.4 token/s · 输出音频 ~12.5 token/s（spec §6.4）</div>
    </section>
  );
}
```

- [ ] `packages/ui/src/api.ts` 末尾追加（落库写入侧；路径/字段与 T18 网关路由一一对应）：

```ts
export interface CreateSessionBody {
  id: string;
  mode: 'solo' | 'filedub' | 'interpreter' | 'meeting';
  configJson: string;
  startedAt: number;
}

export interface SegmentBody {
  sessionId: string;
  seq: number;
  vadStartMs: number | null;
  vadEndMs: number | null;
  sourceText: string;
  targetText: string;
  sourceLang: string | null;
  emotion: string | null;
  usageJson: string | null;
  wavBase64?: string;
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}${path}`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`gateway ${path} -> HTTP ${res.status}`);
}

export const createSessionRecord = (b: CreateSessionBody): Promise<void> => postJson('/sessions', b);
export const finishSessionRecord = (b: { id: string; endedAt: number; usageJson: string }): Promise<void> => postJson('/sessions/finish', b);
export const postSegmentRecord = (b: SegmentBody): Promise<void> => postJson('/segments', b);
```

- [ ] `packages/ui/src/pages/SoloPage.tsx` 整文件重写为完整版：

```tsx
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AudioSegmenter, LANGUAGES, OUTPUT_SAMPLE_RATE, SessionOrchestrator, UsageMeter, WsTransport,
  bytesToBase64, pcm16ToWav, supportsAudioOutput, wavDurationSeconds,
  type NormalizedEvent, type OrchestratorState, type SessionConfig, type UsageSnapshot,
} from '@livetranslate/core';
import { getPlatform } from '../platform';
import { browserWsFactory } from '../wsFactory';
import { createGatewayApi, createSessionRecord, finishSessionRecord, postSegmentRecord, type AppSettingsDto } from '../api';
import { createPlayerSink } from '../audio/playerSink';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { SegmentCard } from '../components/SegmentCard';
import { UsageDashboard } from '../components/UsageDashboard';

interface SegmentAudio {
  wav: Uint8Array;
  durationSec: number;
}

export function SoloPage(): JSX.Element {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<OrchestratorState>('idle');
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [withAudio, setWithAudio] = useState(false); // 默认关（spec §5.1）
  const [hotwordTable, setHotwordTable] = useState('');
  const [hotwordTables, setHotwordTables] = useState<AppSettingsDto['hotwordTables']>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [firstDeltaLatencyMs, setFirstDeltaLatencyMs] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const orchRef = useRef<SessionOrchestrator | null>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const speechStartedAtRef = useRef<number | null>(null);
  const audioBySeqRef = useRef(new Map<number, SegmentAudio>());
  const meterRef = useRef(new UsageMeter());
  const sink = useMemo(() => createPlayerSink(), []);
  const segmenterRef = useRef(
    new AudioSegmenter((responseId, pcm24k) => {
      const seg = orchRef.current?.model.getSegments().find((s) => s.responseId === responseId);
      if (!seg) return;
      audioBySeqRef.current.set(seg.seq, {
        wav: pcm16ToWav(pcm24k, OUTPUT_SAMPLE_RATE), // P9：输出 24kHz
        durationSec: wavDurationSeconds(pcm24k.length, OUTPUT_SAMPLE_RATE),
      });
      force();
    }),
  );

  useEffect(() => {
    void createGatewayApi().getSettings().then((r) => setHotwordTables(r.settings.hotwordTables));
  }, []);

  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(force, 1000); // 会话时长计时
    return () => clearInterval(t);
  }, [startedAt]);

  function buildConfig(): SessionConfig {
    const table = hotwordTables.find((t) => t.name === hotwordTable);
    return {
      modalities: withAudio && supportsAudioOutput(targetLanguage) ? ['text', 'audio'] : ['text'],
      voice: 'Tina',
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        ...(sourceLanguage !== 'auto' ? { language: sourceLanguage } : {}),
      },
      translation: {
        language: targetLanguage,
        ...(table ? { corpus: { phrases: table.phrases } } : {}), // P12 热词
      },
    };
  }

  function persistDoneSegment(responseId: string): void {
    const sessionId = sessionIdRef.current;
    const seg = orchRef.current?.model.getSegments().find((s) => s.responseId === responseId);
    if (!sessionId || !seg) return;
    const audio = audioBySeqRef.current.get(seg.seq);
    void postSegmentRecord({
      sessionId, seq: seg.seq, vadStartMs: seg.vadStartMs, vadEndMs: seg.vadEndMs,
      sourceText: seg.sourceText, targetText: seg.targetText,
      sourceLang: seg.sourceLang, emotion: seg.emotion,
      usageJson: seg.usage ? JSON.stringify(seg.usage) : null,
      ...(audio ? { wavBase64: bytesToBase64(audio.wav) } : {}),
    });
  }

  function handleEvent(ev: NormalizedEvent): void {
    if (ev.kind === 'session-created') {
      sessionIdRef.current = ev.sessionId; // 用服务端 session id，与 relay 日志文件同键
      void createSessionRecord({ id: ev.sessionId, mode: 'solo', configJson: JSON.stringify(buildConfig()), startedAt: Date.now() });
    }
    if (ev.kind === 'speech-started') speechStartedAtRef.current = Date.now();
    if (ev.kind === 'translation-delta' && speechStartedAtRef.current !== null) {
      setFirstDeltaLatencyMs(Date.now() - speechStartedAtRef.current); // 当前段首字延迟
      speechStartedAtRef.current = null;
    }
    segmenterRef.current.apply(ev);
    if (ev.kind === 'response-done' && ev.usage) {
      setUsage(meterRef.current.applyUsage(ev.usage)); // P6 差分
      persistDoneSegment(ev.responseId); // R2：done 即结算落库
    }
  }

  async function start(): Promise<void> {
    const orch = new SessionOrchestrator({
      config: buildConfig(),
      transportFactory: () => new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory }),
      onStateChange: setState,
      onEvent: handleEvent,
    });
    orch.model.onChange(force);
    orchRef.current = orch;
    meterRef.current = new UsageMeter();
    audioBySeqRef.current = new Map();
    setUsage(null);
    setFirstDeltaLatencyMs(null);
    await orch.start();
    setStartedAt(Date.now());
    micRef.current = await startMicCapture({ onChunk: (b) => orch.pushAudio(b) });
  }

  function pause(): void {
    micRef.current?.pause();
    orchRef.current?.pause(); // R4：保连接停推流
  }

  function resume(): void {
    micRef.current?.resume();
    orchRef.current?.resume();
  }

  async function reset(): Promise<void> {
    audioBySeqRef.current = new Map();
    meterRef.current.startNewSession(); // 新 session 累积从零，全局累计保留
    await orchRef.current?.reset(); // R4：历史已落库不删除
  }

  async function stop(): Promise<void> {
    micRef.current?.stop();
    micRef.current = null;
    await orchRef.current?.stop(); // P3：finish → finished → 客户端 close
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      await finishSessionRecord({ id: sessionId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    }
    sessionIdRef.current = null;
    setStartedAt(null);
  }

  const segments = orchRef.current?.model.getSegments() ?? [];
  const running = state === 'running' || state === 'paused' || state === 'reconnecting';
  return (
    <div className="page-body solo-page">
      <section className="config-panel">
        <label>源语言
          <select value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)} disabled={running}>
            <option value="auto">自动检测</option>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <label>目标语言
          <select value={targetLanguage} disabled={running}
            onChange={(e) => { setTargetLanguage(e.target.value); if (!supportsAudioOutput(e.target.value)) setWithAudio(false); }}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={withAudio} disabled={running || !supportsAudioOutput(targetLanguage)}
            onChange={(e) => setWithAudio(e.target.checked)} />
          同时生成语音{!supportsAudioOutput(targetLanguage) && '（该目标语言仅支持文本）'}
        </label>
        <label>热词表
          <select value={hotwordTable} onChange={(e) => setHotwordTable(e.target.value)} disabled={running}>
            <option value="">不使用</option>
            {hotwordTables.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        </label>
      </section>
      <section className="controls">
        {!running && <button onClick={() => void start()}>开始</button>}
        {state === 'running' && <button onClick={pause}>暂停</button>}
        {state === 'paused' && <button onClick={resume}>恢复</button>}
        {running && <button onClick={() => void reset()}>重置</button>}
        {running && <button onClick={() => void stop()}>结束</button>}
        {state === 'reconnecting' && <span className="warn-banner">连接中断，正在重连……</span>}
        {state === 'error' && <span className="warn-banner">重连失败，请检查网络后重新开始</span>}
      </section>
      <UsageDashboard snapshot={usage} firstDeltaLatencyMs={firstDeltaLatencyMs}
        sessionSeconds={startedAt ? (Date.now() - startedAt) / 1000 : 0} />
      <section className="segments">
        {segments.map((seg) => {
          const audio = audioBySeqRef.current.get(seg.seq);
          return (
            <SegmentCard key={seg.seq} segment={seg}
              audio={audio ? { durationSec: audio.durationSec, onPlay: () => void sink.play(audio.wav) } : null} />
          );
        })}
      </section>
    </div>
  );
}
```

- [ ] `packages/ui/src/styles.css` 末尾追加：

```css
.config-panel { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.controls { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.usage-dashboard { display: flex; gap: 20px; flex-wrap: wrap; padding: 10px 14px; border: 1px solid #333; border-radius: 8px; margin-bottom: 16px; }
.metric { display: flex; flex-direction: column; }
.metric-label { font-size: 12px; color: #888; }
.metric-value { font-size: 18px; font-variant-numeric: tabular-nums; }
.metric-note { width: 100%; font-size: 12px; color: #666; }
.segment-source { font-size: 13px; color: #999; }
.segment-target { font-size: 17px; margin-top: 4px; }
.segment-meta { margin-top: 6px; display: flex; gap: 10px; align-items: center; }
.lang-tag { margin-left: 6px; font-size: 12px; color: #6a9; }
.usage-tag { font-size: 12px; color: #888; }
```

**Step 6: 手工验证（需要真实 Key，`pnpm --filter @livetranslate/web dev`）**

- [ ] 目标语言选中文/英语，勾选"同时生成语音"→ 对麦克风说一句话，停顿 1s：预期段落卡片固化后右下角出现 `▶ N.Ns` 按钮，点击后听到 24k 译文语音（**不自动播放**）。
- [ ] 目标语言切到仅文本语种（如 `yue` 之外的 TEXT_ONLY 项）：预期"同时生成语音"复选框置灰并显示提示。
- [ ] 说话过程中观察仪表盘：首字延迟出现数值；每段结束后"会话 tokens"单调递增、"最近段增量"为差分值（非累积值，P6）。
- [ ] 点"暂停"后继续说话：预期不产生新段落；"恢复"后正常。点"重置"：预期屏幕清空、仪表盘"会话 tokens"归零但"全局累计"保留。
- [ ] 点"结束"后检查网关数据目录：`livetranslate.db` 中 `sessions` 有本次记录且 `ended_at` 非空；`audio/{sessionId}/` 下有 `{seq}.wav`（开启语音时）；`logs/sessions/{sessionId}.jsonl` 存在。

**Step 7: Commit**

- [ ] `git add packages/ui; git commit -m "feat(ui): solo mode full page with playback, dashboard and persistence (M2)"`

## Task 19: 历史页 + 事件日志入口

spec §6.2（历史页：按模式浏览/搜索/重播/导出/删除）+ §6.6（每条会话附"查看事件日志"、支持导出单 session 日志）。本任务完成 M2。

**Files:**
- `packages/gateway/src/historyRoutes.ts`（追加查询侧路由）
- `packages/gateway/test/historyRoutes.test.ts`（追加查询侧用例）
- `packages/ui/src/api.ts`（追加查询函数）
- `packages/ui/src/pages/HistoryPage.tsx`（重写 T10 占位版）

**Step 1: 写失败测试**

- [ ] `packages/gateway/test/historyRoutes.test.ts` 追加 describe（复用文件内已有的 `MemKeyStore`；`beforeEach/afterEach` 与写入侧 describe 相同，重新声明一份）：

```ts
describe('history routes (read side, spec 6.2/6.6)', () => {
  let dir: string;
  let gw: GatewayHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lt-hist-r-'));
    const settings = new SettingsStore(join(dir, 'settings.json'), new MemKeyStore());
    gw = await createGatewayServer({ settings, dataDir: dir, port: 0 });
  });

  afterEach(async () => {
    await gw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path: string): Promise<Response> => fetch(`http://127.0.0.1:${gw.port}${path}`);

  it('GET /sessions lists newest first and filters by mode', async () => {
    gw.storage.createSession({ id: 'old', mode: 'solo', configJson: '{}', startedAt: 1000 });
    gw.storage.createSession({ id: 'new', mode: 'solo', configJson: '{}', startedAt: 2000 });
    gw.storage.createSession({ id: 'dub', mode: 'filedub', configJson: '{}', startedAt: 3000 });
    const all = await (await get('/sessions')).json() as { sessions: Array<{ id: string }> };
    expect(all.sessions.map((s) => s.id)).toEqual(['dub', 'new', 'old']);
    const solo = await (await get('/sessions?mode=solo')).json() as { sessions: Array<{ id: string }> };
    expect(solo.sessions.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('GET /segments returns rows for a session', async () => {
    gw.storage.createSession({ id: 's1', mode: 'solo', configJson: '{}', startedAt: 1000 });
    gw.storage.insertSegment({ sessionId: 's1', seq: 1, vadStartMs: 0, vadEndMs: 4600, sourceText: '你好', targetText: 'Hello', sourceLang: 'zh', emotion: 'neutral', audioPath: null, usageJson: null });
    const r = await (await get('/segments?sessionId=s1')).json() as { segments: Array<{ target_text: string }> };
    expect(r.segments[0]!.target_text).toBe('Hello');
  });

  it('GET /segment-audio streams the stored wav', async () => {
    gw.storage.createSession({ id: 's2', mode: 'solo', configJson: '{}', startedAt: 1000 });
    const p = gw.storage.saveSegmentAudio('s2', 1, new Uint8Array([1, 2, 3]));
    gw.storage.insertSegment({ sessionId: 's2', seq: 1, vadStartMs: null, vadEndMs: null, sourceText: 'a', targetText: 'b', sourceLang: null, emotion: null, audioPath: p, usageJson: null });
    const res = await get('/segment-audio?sessionId=s2&seq=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('GET /session-log returns raw jsonl text, 404 when missing', async () => {
    mkdirSync(join(dir, 'logs', 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'logs', 'sessions', 's3.jsonl'), '{"ts":1,"dir":"s2c","type":"session.created","payload":{}}\n');
    const ok = await get('/session-log?sessionId=s3');
    expect(ok.status).toBe(200);
    expect((await ok.text()).trim()).toContain('session.created');
    expect((await get('/session-log?sessionId=nope')).status).toBe(404);
  });

  it('POST /sessions/delete removes session, segments and audio dir', async () => {
    gw.storage.createSession({ id: 's4', mode: 'solo', configJson: '{}', startedAt: 1000 });
    const p = gw.storage.saveSegmentAudio('s4', 1, new Uint8Array([9]));
    gw.storage.insertSegment({ sessionId: 's4', seq: 1, vadStartMs: null, vadEndMs: null, sourceText: 'a', targetText: 'b', sourceLang: null, emotion: null, audioPath: p, usageJson: null });
    const res = await fetch(`http://127.0.0.1:${gw.port}/sessions/delete`, { method: 'POST', body: JSON.stringify({ id: 's4' }) });
    expect(res.status).toBe(200);
    expect(gw.storage.getSession('s4')).toBeUndefined();
    expect(existsSync(join(dir, 'audio', 's4'))).toBe(false);
  });
});
```

同时在该测试文件头部 import 行补充 `existsSync`：`import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';`。

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/historyRoutes.test.ts` → 预期 FAIL：新增 5 用例全部 `expected 404 to be 200`（查询路由未注册），既有 3 用例仍 PASS。

**Step 3: 最小实现**

- [ ] `packages/gateway/src/historyRoutes.ts` 修改：文件头 import 改为 `import { existsSync, readFileSync, rmSync } from 'node:fs';`，并在 `registerHistoryRoutes` 函数体末尾（`POST /sessions/finish` 注册之后）追加：

```ts
  const query = (req: { url?: string }): URLSearchParams =>
    new URL(req.url ?? '', 'http://gateway.local').searchParams;

  routes.set('GET /sessions', (req, res) => {
    const mode = query(req).get('mode');
    json(res, 200, { sessions: deps.storage.listSessions(mode ? (mode as SessionMode) : undefined) });
  });

  routes.set('GET /segments', (req, res) => {
    json(res, 200, { segments: deps.storage.listSegments(query(req).get('sessionId') ?? '') });
  });

  routes.set('GET /segment-audio', (req, res) => {
    const q = query(req);
    const seq = Number(q.get('seq'));
    const row = deps.storage.listSegments(q.get('sessionId') ?? '').find((s) => s.seq === seq);
    if (!row?.audio_path || !existsSync(row.audio_path)) {
      json(res, 404, { error: 'audio_not_found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(readFileSync(row.audio_path));
  });

  routes.set('GET /session-log', (req, res) => {
    const file = logFilePath(deps.dataDir, query(req).get('sessionId') ?? '');
    if (!existsSync(file)) {
      json(res, 404, { error: 'log_not_found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(readFileSync(file));
  });

  routes.set('POST /sessions/delete', (_req, res, body) => {
    const b = JSON.parse(body) as { id: string };
    deps.storage.deleteSession(b.id); // 级联删 segments（T16 外键 CASCADE）
    rmSync(join(deps.dataDir, 'audio', b.id), { recursive: true, force: true });
    // 事件日志文件按 spec §6.6 保留策略保留，由用户手动清理
    json(res, 200, { ok: true });
  });
```

**Step 4: 运行确认通过 + Commit（后端半程）**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/historyRoutes.test.ts` → 预期 `8 passed`。
- [ ] `git add packages/gateway; git commit -m "feat(gateway): history query routes with segment audio and session log access"`

**Step 5: UI 实现（完整代码）**

- [ ] `packages/ui/src/api.ts` 末尾追加：

```ts
export interface SessionDto {
  id: string;
  mode: 'solo' | 'filedub' | 'interpreter' | 'meeting';
  config_json: string;
  started_at: number;
  ended_at: number | null;
  usage_json: string | null;
}

export interface SegmentDto {
  id: number;
  session_id: string;
  seq: number;
  vad_start_ms: number | null;
  vad_end_ms: number | null;
  source_text: string;
  target_text: string;
  source_lang: string | null;
  emotion: string | null;
  audio_path: string | null;
  usage_json: string | null;
}

export async function fetchSessions(mode?: SessionDto['mode']): Promise<SessionDto[]> {
  const base = getPlatform().gatewayHttpBase();
  const res = await fetch(`${base}/sessions${mode ? `?mode=${mode}` : ''}`);
  if (!res.ok) throw new Error(`gateway /sessions -> HTTP ${res.status}`);
  return ((await res.json()) as { sessions: SessionDto[] }).sessions;
}

export async function fetchSegments(sessionId: string): Promise<SegmentDto[]> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/segments?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error(`gateway /segments -> HTTP ${res.status}`);
  return ((await res.json()) as { segments: SegmentDto[] }).segments;
}

export async function fetchSegmentAudio(sessionId: string, seq: number): Promise<Uint8Array> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/segment-audio?sessionId=${encodeURIComponent(sessionId)}&seq=${seq}`);
  if (!res.ok) throw new Error(`gateway /segment-audio -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchSessionLog(sessionId: string): Promise<string | null> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/session-log?sessionId=${encodeURIComponent(sessionId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gateway /session-log -> HTTP ${res.status}`);
  return res.text();
}

export const deleteSessionRecord = (id: string): Promise<void> => postJson('/sessions/delete', { id });
```

- [ ] `packages/ui/src/pages/HistoryPage.tsx` 整文件重写：

```tsx
import { useEffect, useMemo, useState } from 'react';
import {
  deleteSessionRecord, fetchSegmentAudio, fetchSegments, fetchSessionLog, fetchSessions,
  type SegmentDto, type SessionDto,
} from '../api';
import { createPlayerSink } from '../audio/playerSink';

const MODES = [
  { value: '', label: '全部' },
  { value: 'solo', label: '单人测试' },
  { value: 'filedub', label: '翻译机·配音' },
  { value: 'interpreter', label: '实时翻译机' },
  { value: 'meeting', label: '会议' },
] as const;

const stamp = (ms: number): string => new Date(ms).toLocaleString();

function download(name: string, mime: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function HistoryPage(): JSX.Element {
  const [mode, setMode] = useState<'' | SessionDto['mode']>('');
  const [search, setSearch] = useState('');
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [segments, setSegments] = useState<SegmentDto[]>([]);
  const [logText, setLogText] = useState<string | null>(null);
  const sink = useMemo(() => createPlayerSink(), []);

  const reload = (): void => {
    void fetchSessions(mode || undefined).then(setSessions);
  };

  useEffect(reload, [mode]);

  useEffect(() => {
    setLogText(null);
    if (!openId) {
      setSegments([]);
      return;
    }
    void fetchSegments(openId).then(setSegments);
  }, [openId]);

  const visible = sessions.filter((s) => !search || s.id.includes(search) || stamp(s.started_at).includes(search));

  const exportTxt = (): void => {
    if (!openId) return;
    const lines = segments.map((g) => `[${g.seq}] ${g.source_text}\n    ${g.target_text}`);
    download(`${openId}.txt`, 'text/plain;charset=utf-8', lines.join('\n\n') + '\n');
  };

  const showLog = (): void => {
    if (!openId) return;
    void fetchSessionLog(openId).then((t) => setLogText(t ?? '（未找到该 session 的事件日志文件）'));
  };

  const removeSession = (id: string): void => {
    if (!window.confirm(`删除会话 ${id}？段落与音频将一并删除（事件日志保留）。`)) return;
    void deleteSessionRecord(id).then(() => {
      if (openId === id) setOpenId(null);
      reload();
    });
  };

  return (
    <div className="page-body history-page">
      <section className="controls">
        {MODES.map((m) => (
          <button key={m.value} className={mode === m.value ? 'active' : ''} onClick={() => setMode(m.value)}>{m.label}</button>
        ))}
        <input placeholder="搜索 session id / 日期" value={search} onChange={(e) => setSearch(e.target.value)} />
      </section>
      <section className="history-list">
        {visible.map((s) => (
          <div key={s.id} className={`history-row ${openId === s.id ? 'open' : ''}`}>
            <button onClick={() => setOpenId(openId === s.id ? null : s.id)}>
              {stamp(s.started_at)} · {MODES.find((m) => m.value === s.mode)?.label} · {s.id}
            </button>
            <button onClick={() => removeSession(s.id)}>删除</button>
          </div>
        ))}
        {visible.length === 0 && <p>暂无历史会话</p>}
      </section>
      {openId && (
        <section className="history-detail">
          <div className="controls">
            <button onClick={exportTxt}>导出双语 TXT</button>
            <button onClick={showLog}>查看事件日志</button>
            {logText !== null && (
              <button onClick={() => download(`${openId}.jsonl`, 'text/plain;charset=utf-8', logText)}>导出日志</button>
            )}
          </div>
          {segments.map((g) => (
            <div key={g.id} className="segment-card status-done">
              <div className="segment-source">
                <span>{g.source_text}</span>
                {g.source_lang && <span className="lang-tag">［{g.source_lang}{g.emotion ? ` · ${g.emotion}` : ''}］</span>}
              </div>
              <div className="segment-target"><span>{g.target_text}</span></div>
              <div className="segment-meta">
                {g.audio_path && (
                  <button onClick={() => void fetchSegmentAudio(g.session_id, g.seq).then((b) => sink.play(b))}>▶ 重播</button>
                )}
              </div>
            </div>
          ))}
          {logText !== null && <pre className="log-view">{logText}</pre>}
        </section>
      )}
    </div>
  );
}
```

- [ ] `packages/ui/src/styles.css` 末尾追加：

```css
.history-row { display: flex; gap: 8px; margin-bottom: 4px; }
.history-row.open > button:first-child { font-weight: 600; }
.history-detail { margin-top: 12px; border-top: 1px solid #333; padding-top: 12px; }
.log-view { max-height: 320px; overflow: auto; background: #111; padding: 8px; font-size: 12px; }
```

**Step 6: 手工验证**

- [ ] 先在单人测试页跑完一次带语音的会话并"结束"，切到历史页：预期列表首行为刚才的会话；点"单人测试"模式筛选仍可见，点"会议"筛选后消失。
- [ ] 展开该会话：预期段落卡片显示原文/译文/语种标签；点 `▶ 重播` 能听到当段 24k 语音。
- [ ] 点"查看事件日志"：预期出现 JSONL 预览，首行含 `session.created`，`input_audio_buffer.append` 行的 `audio` 字段为 `<b64 len=… fnv1a=…>` 截断形式；"导出日志"能下载 .jsonl。
- [ ] "导出双语 TXT"：预期下载文本每段两行（原文 + 缩进译文）。
- [ ] "删除"后确认：列表移除；网关数据目录 `audio/{sessionId}/` 被删，`logs/sessions/{sessionId}.jsonl` 仍在（spec §6.6 保留策略）。

**Step 7: Commit（M2 出口）**

- [ ] `git add packages/ui; git commit -m "feat(ui): history page with replay, export and event log access (M2 exit)"`

---

# Milestone 3：文件配音

M3 出口（spec §8.3）：导入音视频 → 全速预处理 → 双栏工作台原声/配音两种播放 → SRT/TXT/混音 WAV 导出 → 视频抽帧视觉增强开关。

## Task 20: ffmpeg 管道（抽音轨/重采样/抽帧）

spec §3.2-3：网关管理 ffmpeg 子进程——音轨抽取重采样到 16k PCM16 mono，视频按 1–2fps 抽帧 JPEG（≤720p）。开发机需要 PATH 上有 `ffmpeg`/`ffprobe`（或设置 `LT_FFMPEG_PATH`/`LT_FFPROBE_PATH`）；测试用 `describe.skipIf` 在无 ffmpeg 环境自动跳过（CI 可控）。

**Files:**
- `packages/gateway/src/ffmpeg.ts`
- `packages/gateway/test/ffmpeg.test.ts`

**Step 1: 写失败测试**

- [ ] `packages/gateway/test/ffmpeg.test.ts`（测试素材现场合成：用 core 的 `pcm16ToWav` 生成 2s/16k 正弦 WAV；视频用 lavfi testsrc 生成）：

```ts
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pcm16ToWav } from '@livetranslate/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractFrames, extractPcm16k, probeDurationSeconds, resolveFfmpeg } from '../src/ffmpeg';

const FFMPEG_OK = spawnSync(resolveFfmpeg().ffmpeg, ['-version']).status === 0;

describe.skipIf(!FFMPEG_OK)('ffmpeg pipeline (spec 3.2)', () => {
  let dir: string;
  let wavPath: string;
  let mp4Path: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lt-ffmpeg-'));
    // 2s / 16kHz / 440Hz 正弦 WAV
    const pcm = new Uint8Array(16000 * 2 * 2);
    const dv = new DataView(pcm.buffer);
    for (let i = 0; i < 16000 * 2; i++) {
      dv.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 12000), true);
    }
    wavPath = join(dir, 'tone.wav');
    writeFileSync(wavPath, pcm16ToWav(pcm, 16000));
    // 3s 测试视频
    mp4Path = join(dir, 'test.mp4');
    const r = spawnSync(resolveFfmpeg().ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=1280x960:rate=30',
      '-pix_fmt', 'yuv420p', mp4Path,
    ]);
    expect(r.status).toBe(0);
  }, 30_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('probeDurationSeconds reads media duration', async () => {
    expect(await probeDurationSeconds(wavPath)).toBeCloseTo(2, 1);
  });

  it('extractPcm16k returns 16k/16bit/mono raw pcm of full length', async () => {
    const pcm = await extractPcm16k(wavPath);
    // 2s * 16000 * 2 字节，允许编解码容差 ±1 帧（3200 字节）
    expect(Math.abs(pcm.length - 64000)).toBeLessThanOrEqual(3200);
  });

  it('extractFrames samples 1fps jpeg, downscaled to <=720p, with timeline stamps', async () => {
    const frames = await extractFrames(mp4Path, { fps: 1, workDir: join(dir, 'frames') });
    expect(frames.length).toBe(3);
    expect(frames.map((f) => f.timeMs)).toEqual([0, 1000, 2000]);
    for (const f of frames) {
      expect(f.jpeg.length).toBeGreaterThan(0);
      // JPEG magic
      expect(f.jpeg[0]).toBe(0xff);
      expect(f.jpeg[1]).toBe(0xd8);
    }
  }, 30_000);
});

describe('resolveFfmpeg', () => {
  it('honors LT_FFMPEG_PATH / LT_FFPROBE_PATH overrides', () => {
    process.env.LT_FFMPEG_PATH = '/opt/ffmpeg/bin/ffmpeg';
    process.env.LT_FFPROBE_PATH = '/opt/ffmpeg/bin/ffprobe';
    expect(resolveFfmpeg()).toEqual({ ffmpeg: '/opt/ffmpeg/bin/ffmpeg', ffprobe: '/opt/ffmpeg/bin/ffprobe' });
    delete process.env.LT_FFMPEG_PATH;
    delete process.env.LT_FFPROBE_PATH;
    expect(resolveFfmpeg()).toEqual({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/ffmpeg.test.ts` → 预期 FAIL：`Cannot find module '../src/ffmpeg'`。

**Step 3: 最小实现**

- [ ] `packages/gateway/src/ffmpeg.ts`：

```ts
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

export function resolveFfmpeg(): FfmpegPaths {
  return {
    ffmpeg: process.env.LT_FFMPEG_PATH ?? 'ffmpeg',
    ffprobe: process.env.LT_FFPROBE_PATH ?? 'ffprobe',
  };
}

function run(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => err.push(c));
    p.on('error', reject); // 二进制不存在等
    p.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString().slice(-500)}`));
    });
  });
}

export async function probeDurationSeconds(input: string): Promise<number> {
  const out = await run(resolveFfmpeg().ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input,
  ]);
  const n = Number(out.toString().trim());
  if (!Number.isFinite(n)) throw new Error(`ffprobe: unparsable duration for ${input}`);
  return n;
}

// 抽音轨 + 重采样：任意容器/编码 → 16k/16bit/mono 裸 PCM（P7 输入格式）
export async function extractPcm16k(input: string): Promise<Uint8Array> {
  const out = await run(resolveFfmpeg().ffmpeg, [
    '-v', 'error', '-i', input, '-vn',
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', 'pipe:1',
  ]);
  return new Uint8Array(out);
}

export interface ExtractedFrame {
  timeMs: number;
  jpeg: Buffer;
}

// 按 fps 抽帧，缩到 ≤720p（宽保持偶数）；体积规则（≤190KB）在 imageRules（T26）校验
export async function extractFrames(input: string, opts: { fps: 1 | 2; workDir: string }): Promise<ExtractedFrame[]> {
  mkdirSync(opts.workDir, { recursive: true });
  await run(resolveFfmpeg().ffmpeg, [
    '-v', 'error', '-y', '-i', input,
    '-vf', `fps=${opts.fps},scale=-2:'min(720,ih)'`,
    '-q:v', '7',
    join(opts.workDir, 'frame_%05d.jpg'),
  ]);
  const files = readdirSync(opts.workDir).filter((f) => f.endsWith('.jpg')).sort();
  return files.map((f, i) => ({
    timeMs: Math.round((i / opts.fps) * 1000),
    jpeg: readFileSync(join(opts.workDir, f)),
  }));
}
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/ffmpeg.test.ts` → 预期 `4 passed`（无 ffmpeg 环境为 `1 passed | 3 skipped`）。
- [ ] `packages/gateway/package.json` 确认 `@livetranslate/core` 已在 dependencies（T16 引入过则跳过）；否则 `pnpm --filter @livetranslate/gateway add @livetranslate/core@workspace:*`。
- [ ] `git add packages/gateway; git commit -m "feat(gateway): ffmpeg pipeline for audio extraction and frame sampling"`

## Task 21: FilePipeline 全速预处理 + mediaJobs

spec §5.2：导入即全速推流（P8 无 sleep），图像按音频时间轴在对应 append 进度后发送（P11 首帧必须在首次音频 append 之后）；进度条按已收 `response.done` 的 vadEndMs 推进；产物分段记录 + 24k 音频段 + usage。先做 core 纯逻辑（commit 1），再做网关作业编排与落库（commit 2）。

**Files:**
- `packages/core/src/file/filePipeline.ts` + `packages/core/test/filePipeline.test.ts`
- `packages/gateway/src/mediaJobs.ts` + `packages/gateway/test/mediaJobs.test.ts`
- `packages/gateway/src/storage.ts`（追加 media_jobs 方法）+ `test/storage.test.ts`（追加用例）
- `packages/gateway/src/server.ts`（注册 media 路由）

**Step 1: 写失败测试（core）**

- [ ] `packages/core/test/filePipeline.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { runFilePipeline } from '../src/file/filePipeline';
import type { ITranslateTransport, NormalizedEvent, NormalizedKind, SessionConfig } from '../src/protocol/types';

const CONFIG: SessionConfig = {
  modalities: ['text', 'audio'],
  voice: 'default',
  enable_voice_clone: true,
  voice_clone_options: { frequency: 'once' }, // spec §5.2 默认保留原片音色
  sample_rate: 16000,
  input_audio_format: 'pcm',
  input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
  translation: { language: 'en' },
};

class ScriptedTransport implements ITranslateTransport {
  readonly kind = 'ws' as const;
  calls: string[] = [];
  imagesAfterAppend: number[] = []; // 发图时已完成的音频 append 数
  private appended = 0;
  private handlers = new Map<NormalizedKind, Array<(ev: never) => void>>();

  constructor(private script: NormalizedEvent[]) {}

  async connect(): Promise<void> { this.calls.push('connect'); }
  async updateSession(): Promise<void> { this.calls.push('update'); }
  appendAudio(): void { this.appended++; this.calls.push('audio'); }
  appendImage(): void { this.imagesAfterAppend.push(this.appended); this.calls.push('image'); }
  abort(): void { this.calls.push('abort'); }
  onRaw(): () => void { return () => {}; }
  getRemoteAudio(): MediaStream | null { return null; }

  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void {
    const arr = this.handlers.get(kind) ?? [];
    arr.push(cb as (ev: never) => void);
    this.handlers.set(kind, arr);
    return () => {};
  }

  async finish(): Promise<void> {
    this.calls.push('finish');
    for (const ev of this.script) {
      (this.handlers.get(ev.kind) ?? []).forEach((cb) => (cb as (e: NormalizedEvent) => void)(ev));
    }
  }
}

// 取自真实音频模态回合（audio-turn.jsonl 归一化后的形态；usage 为真实累积值 169）
const SCRIPT: NormalizedEvent[] = [
  { kind: 'session-created', sessionId: 'sess_file_1' },
  { kind: 'session-updated' },
  { kind: 'speech-started', itemId: 'item_f1', audioStartMs: 0 },
  { kind: 'asr-delta', itemId: 'item_f1', text: '今天天气很好，', stash: '我们', language: 'zh', emotion: 'neutral' },
  { kind: 'response-created', responseId: 'resp_f1' },
  { kind: 'translation-delta', responseId: 'resp_f1', text: 'The weather is very nice today,', stash: " let's" },
  { kind: 'audio-delta', responseId: 'resp_f1', base64: 'AdaB2YHlwfIF/gL4Adj/3P7g/+MBxwHZAtkA2P/G/7v/xACWAJUBhQGcAK7/pP6q/qb/PACJAF4AegDsAG8A' },
  { kind: 'speech-stopped', itemId: 'item_f1', audioEndMs: 4600 },
  { kind: 'translation-done', responseId: 'resp_f1', text: "The weather is very nice today, let's go for a walk in the park together.  " },
  { kind: 'asr-completed', itemId: 'item_f1', transcript: '今天天气很好，我们一起去公园散步。', language: 'zh', emotion: 'neutral' },
  {
    kind: 'response-done', responseId: 'resp_f1',
    usage: {
      total_tokens: 169, input_tokens: 85, output_tokens: 84,
      input_tokens_details: { text_tokens: 50, audio_tokens: 35 },
      output_tokens_details: { text_tokens: 33, audio_tokens: 51 },
    },
  },
  { kind: 'session-finished' },
];

describe('runFilePipeline (spec 5.2, P8/P11)', () => {
  it('pushes all audio full-speed with no timers, then finishes (P8)', async () => {
    vi.useFakeTimers(); // 若实现里有任何 sleep，此测试将超时挂死
    const t = new ScriptedTransport(SCRIPT);
    const result = await runFilePipeline({ pcm16k: new Uint8Array(32000), config: CONFIG, transport: t });
    vi.useRealTimers();
    // 32000 字节 = 10 块（3200 字节/块，P7）
    expect(t.calls.filter((c) => c === 'audio').length).toBe(10);
    expect(t.calls[0]).toBe('connect');
    expect(t.calls[t.calls.length - 1]).toBe('finish');
    expect(result.segments.length).toBe(1);
  });

  it('sends each frame only after the append covering its timestamp (P11)', async () => {
    const t = new ScriptedTransport(SCRIPT);
    await runFilePipeline({
      pcm16k: new Uint8Array(32000), // 1000ms
      frames: [
        { timeMs: 0, jpegBase64: 'ZnJhbWUw' },
        { timeMs: 450, jpegBase64: 'ZnJhbWUx' },
      ],
      config: CONFIG,
      transport: t,
    });
    // 首帧在第 1 块（覆盖 0–100ms）之后；450ms 帧在第 5 块（覆盖 400–500ms）之后
    expect(t.imagesAfterAppend).toEqual([1, 5]);
  });

  it('collects segments, per-response 24k audio and diffed usage from replay', async () => {
    const t = new ScriptedTransport(SCRIPT);
    const doneMs: number[] = [];
    const result = await runFilePipeline({
      pcm16k: new Uint8Array(32000), config: CONFIG, transport: t,
      onProgress: (ms) => doneMs.push(ms),
    });
    const seg = result.segments[0]!;
    expect(seg.targetText).toBe("The weather is very nice today, let's go for a walk in the park together.  ");
    expect(seg.sourceText).toBe('今天天气很好，我们一起去公园散步。');
    expect(seg.vadEndMs).toBe(4600);
    expect(result.audioByResponseId.get('resp_f1')!.length).toBe(66); // 88 字符 base64 = 66 字节
    expect(result.usage.lastDelta.total_tokens).toBe(169); // P6 差分（首段差分=累积值）
    expect(doneMs).toEqual([4600]);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/filePipeline.test.ts` → 预期 FAIL：`Cannot find module '../src/file/filePipeline'`。

**Step 3: 最小实现（core）**

- [ ] `packages/core/src/file/filePipeline.ts`：

```ts
import { AudioSegmenter } from '../session/audioSegmenter';
import { TranscriptModel, type TranscriptSegment } from '../session/transcriptModel';
import { UsageMeter, type UsageSnapshot } from '../session/usageMeter';
import type { ITranslateTransport, NormalizedEvent, NormalizedKind, SessionConfig } from '../protocol/types';

export interface PipelineFrame {
  timeMs: number;
  jpegBase64: string;
}

export interface FilePipelineInput {
  pcm16k: Uint8Array; // 16k/16bit/mono 全量
  frames?: PipelineFrame[];
  config: SessionConfig;
  transport: ITranslateTransport;
  onProgress?: (doneMs: number, totalMs: number) => void; // 已结算段的 vadEndMs
  onEvent?: (ev: NormalizedEvent) => void;
}

export interface FilePipelineResult {
  segments: TranscriptSegment[];
  audioByResponseId: Map<string, Uint8Array>; // 24k PCM（P9）
  usage: UsageSnapshot;
}

const CHUNK_BYTES = 3200; // P7：100ms/块
const CHUNK_MS = 100;
const KINDS: NormalizedKind[] = [
  'session-created', 'session-updated', 'session-finished', 'speech-started', 'speech-stopped',
  'asr-delta', 'asr-completed', 'response-created', 'translation-delta', 'translation-done',
  'audio-delta', 'response-done', 'server-error',
];

export async function runFilePipeline(input: FilePipelineInput): Promise<FilePipelineResult> {
  const model = new TranscriptModel();
  const audioByResponseId = new Map<string, Uint8Array>();
  const segmenter = new AudioSegmenter((responseId, pcm24k) => audioByResponseId.set(responseId, pcm24k));
  const meter = new UsageMeter();
  const totalMs = Math.round(input.pcm16k.length / 32); // 32 字节/ms @16k16bit mono
  let usage = meter.snapshot();

  const offs = KINDS.map((k) =>
    input.transport.on(k, (ev) => {
      model.apply(ev);
      segmenter.apply(ev);
      if (ev.kind === 'response-done') {
        if (ev.usage) usage = meter.applyUsage(ev.usage); // P6 差分
        const seg = model.getSegments().find((s) => s.responseId === ev.responseId);
        if (seg && seg.vadEndMs !== null) input.onProgress?.(seg.vadEndMs, totalMs);
      }
      input.onEvent?.(ev);
    }),
  );

  await input.transport.connect(input.config);

  // P8：全速推流，循环内无任何 sleep；P11：帧在覆盖其时间戳的 append 之后发送
  const frames = [...(input.frames ?? [])].sort((a, b) => a.timeMs - b.timeMs);
  let frameIdx = 0;
  let sentMs = 0;
  for (let off = 0; off < input.pcm16k.length; off += CHUNK_BYTES) {
    const chunk = input.pcm16k.slice(off, off + CHUNK_BYTES);
    input.transport.appendAudio(chunk.buffer as ArrayBuffer);
    sentMs += CHUNK_MS;
    while (frameIdx < frames.length && frames[frameIdx]!.timeMs < sentMs) {
      input.transport.appendImage(frames[frameIdx]!.jpegBase64);
      frameIdx++;
    }
  }

  await input.transport.finish(); // P3：finish → finished → 客户端 close
  offs.forEach((off) => off());
  return { segments: model.getSegments(), audioByResponseId, usage };
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { runFilePipeline, type FilePipelineInput, type FilePipelineResult, type PipelineFrame } from './file/filePipeline';
```

**Step 4: 运行确认通过 + Commit（core 半程）**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/filePipeline.test.ts` → 预期 `3 passed`。
- [ ] `git add packages/core; git commit -m "feat(core): full-speed file pipeline with frame interleaving (P8/P11)"`

**Step 5: storage 追加 media_jobs 方法（写失败测试）**

- [ ] `packages/gateway/test/storage.test.ts` 的 `describe('Storage', ...)` 末尾追加：

```ts
  it('media_jobs: pending → processing → done with artifacts (spec 5.2)', () => {
    storage.insertMediaJob({ id: 'job_1', sourcePath: '/media/job_1/in.mp4', frameConfigJson: '{"framesEnabled":true,"fps":1}', createdAt: 42 });
    expect(storage.getMediaJob('job_1')?.status).toBe('pending');
    storage.updateMediaJob('job_1', { status: 'processing' });
    expect(storage.getMediaJob('job_1')?.status).toBe('processing');
    storage.updateMediaJob('job_1', { status: 'done', sessionId: 'sess_j1', artifactsJson: '{"segmentCount":3}' });
    const row = storage.getMediaJob('job_1')!;
    expect(row.status).toBe('done');
    expect(row.session_id).toBe('sess_j1');
    expect(JSON.parse(row.artifacts_json!)).toEqual({ segmentCount: 3 });
    expect(storage.getMediaJob('nope')).toBeNull();
  });
```

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/storage.test.ts` → 预期 FAIL：`storage.insertMediaJob is not a function`。

**Step 6: storage 实现 media_jobs 方法**

- [ ] `packages/gateway/src/storage.ts` 追加行类型（放在 `SessionLogRow` 定义之后）与方法（放在 `getSessionLog` 之后、类结束前）：

```ts
export interface MediaJobRow {
  id: string; source_path: string; frame_config_json: string;
  artifacts_json: string | null;
  status: 'pending' | 'processing' | 'done' | 'failed';
  session_id: string | null; created_at: number;
}
```

```ts
  insertMediaJob(row: { id: string; sourcePath: string; frameConfigJson: string; createdAt: number }): void {
    this.db.prepare(`INSERT INTO media_jobs (id, source_path, frame_config_json, status, created_at) VALUES (?, ?, ?, 'pending', ?)`)
      .run(row.id, row.sourcePath, row.frameConfigJson, row.createdAt);
  }

  updateMediaJob(id: string, patch: { status: MediaJobRow['status']; sessionId?: string; artifactsJson?: string }): void {
    this.db.prepare('UPDATE media_jobs SET status = ?, session_id = COALESCE(?, session_id), artifacts_json = COALESCE(?, artifacts_json) WHERE id = ?')
      .run(patch.status, patch.sessionId ?? null, patch.artifactsJson ?? null, id);
  }

  getMediaJob(id: string): MediaJobRow | null {
    return (this.db.prepare('SELECT * FROM media_jobs WHERE id = ?').get(id) as MediaJobRow | undefined) ?? null;
  }
```

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/storage.test.ts` → 预期全部通过（含既有用例）。

**Step 7: mediaJobs 写失败测试**

- [ ] `packages/gateway/test/mediaJobs.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type {
  ITranslateTransport, NormalizedEvent, RawDirection, ServerEvent, SessionConfig,
} from '@livetranslate/core';
import { openDb } from '../src/db';
import { Storage } from '../src/storage';
import { SettingsStore, type KeyStore } from '../src/settings';
import { logFilePath } from '../src/historyRoutes';
import { jobProgress, processMediaJob, registerMediaRoutes, type MediaDeps } from '../src/mediaJobs';
import type { RouteHandler } from '../src/server';

class MemKeyStore implements KeyStore {
  private key: string | null = null;
  getKey(): string | null { return this.key; }
  setKey(key: string): void { this.key = key; }
  clearKey(): void { this.key = null; }
}

// 与 core/test/filePipeline.test.ts 同款脚本回放传输：finish() 时回放归一化事件，
// 并通过 onRaw 补发原始 session.created（processMediaJob 靠它拿 session id 开日志 sink）。
class ScriptedTransport implements ITranslateTransport {
  readonly kind = 'ws' as const;
  appendedChunks = 0;
  private handlers = new Map<string, Set<(ev: NormalizedEvent) => void>>();
  private rawTaps = new Set<(dir: RawDirection, payload: ServerEvent) => void>();
  constructor(private script: NormalizedEvent[]) {}
  connect(_cfg: SessionConfig): Promise<void> {
    this.rawTaps.forEach((cb) => cb('s2c', { type: 'session.created', session: { id: 'sess_media_1' } } as ServerEvent));
    return Promise.resolve();
  }
  updateSession(): Promise<void> { return Promise.resolve(); }
  appendAudio(): void { this.appendedChunks++; }
  appendImage(): void {}
  finish(): Promise<void> {
    for (const ev of this.script) {
      this.rawTaps.forEach((cb) => cb('s2c', { type: `replay.${ev.kind}` } as ServerEvent));
      this.handlers.get(ev.kind)?.forEach((cb) => cb(ev));
    }
    return Promise.resolve();
  }
  abort(): void {}
  on(kind: string, cb: (ev: never) => void): () => void {
    if (!this.handlers.has(kind)) this.handlers.set(kind, new Set());
    const set = this.handlers.get(kind)!;
    set.add(cb as (ev: NormalizedEvent) => void);
    return () => set.delete(cb as (ev: NormalizedEvent) => void);
  }
  onRaw(cb: (dir: RawDirection, payload: ServerEvent) => void): () => void {
    this.rawTaps.add(cb);
    return () => this.rawTaps.delete(cb);
  }
  getRemoteAudio(): MediaStream | null { return null; }
}

// 与 T21 core 测试同一份真实回放脚本（usage 累积值 169，66 字节 24k 音频）
const SCRIPT: NormalizedEvent[] = [
  { kind: 'session-created', sessionId: 'sess_media_1' },
  { kind: 'session-updated' },
  { kind: 'speech-started', itemId: 'item_f1', audioStartMs: 0 },
  { kind: 'asr-delta', itemId: 'item_f1', text: '今天天气很好，', stash: '我们', language: 'zh', emotion: 'neutral' },
  { kind: 'response-created', responseId: 'resp_f1' },
  { kind: 'translation-delta', responseId: 'resp_f1', text: 'The weather is very nice today,', stash: " let's" },
  { kind: 'audio-delta', responseId: 'resp_f1', base64: 'AdaB2YHlwfIF/gL4Adj/3P7g/+MBxwHZAtkA2P/G/7v/xACWAJUBhQGcAK7/pP6q/qb/PACJAF4AegDsAG8A' },
  { kind: 'speech-stopped', itemId: 'item_f1', audioEndMs: 4600 },
  { kind: 'asr-completed', itemId: 'item_f1', transcript: '今天天气很好，我们一起去公园散步。', language: 'zh', emotion: 'neutral' },
  { kind: 'translation-done', responseId: 'resp_f1', text: "The weather is very nice today, let's go for a walk in the park together.  " },
  {
    kind: 'response-done', responseId: 'resp_f1',
    usage: {
      total_tokens: 169, input_tokens: 85, output_tokens: 84,
      input_tokens_details: { text_tokens: 50, audio_tokens: 35 },
      output_tokens_details: { text_tokens: 33, audio_tokens: 51 },
    },
  },
  { kind: 'session-finished' },
];

function fakeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  const res = {
    writeHead: (code: number) => { statusCode = code; return res; },
    end: (data?: string) => { if (data !== undefined) chunks.push(data); },
  } as unknown as ServerResponse;
  return { res, json: () => JSON.parse(chunks.join('')) as Record<string, unknown>, status: () => statusCode };
}

let dataDir: string;
let deps: MediaDeps;
let ranJobs: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'lt-media-'));
  ranJobs = [];
  deps = {
    storage: new Storage(openDb(join(dataDir, 'app.db')), dataDir),
    settings: new SettingsStore(join(dataDir, 'settings.json'), new MemKeyStore()),
    dataDir,
    // 同步落盘的 sink，测试断言无需等待流刷新
    logFiles: {
      sinkFor: (sessionId: string) => {
        const file = logFilePath(dataDir, sessionId);
        mkdirSync(dirname(file), { recursive: true });
        return (line: string) => appendFileSync(file, `${line}\n`);
      },
    },
    runner: (jobId) => ranJobs.push(jobId),
  };
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe('registerMediaRoutes', () => {
  it('POST /media-jobs saves upload, inserts pending row and kicks runner', () => {
    const routes = new Map<string, RouteHandler>();
    registerMediaRoutes(routes, deps);
    const { res, json, status } = fakeRes();
    void routes.get('POST /media-jobs')!({} as never, res, JSON.stringify({
      fileName: 'talk.mp3', dataBase64: Buffer.from('fake-mp3-bytes').toString('base64'),
      isVideo: false, targetLanguage: 'en', voiceClone: false, voice: 'Tina', framesEnabled: false,
    }));
    expect(status()).toBe(200);
    const jobId = json().jobId as string;
    expect(ranJobs).toEqual([jobId]);
    const row = deps.storage.getMediaJob(jobId)!;
    expect(row.status).toBe('pending');
    expect(row.source_path).toBe(join(dataDir, 'media', jobId, 'talk.mp3'));
    expect(readFileSync(row.source_path, 'utf8')).toBe('fake-mp3-bytes');
    expect(JSON.parse(row.frame_config_json)).toEqual({
      isVideo: false, framesEnabled: false, fps: 1, sourceLanguage: null,
      targetLanguage: 'en', voiceClone: false, voice: 'Tina',
    });
  });

  it('GET /media-job returns row + progress, 404 when missing', () => {
    const routes = new Map<string, RouteHandler>();
    registerMediaRoutes(routes, deps);
    deps.storage.insertMediaJob({ id: 'job_g', sourcePath: '/x', frameConfigJson: '{}', createdAt: 1 });
    jobProgress.set('job_g', { doneMs: 4600, totalMs: 9000 });
    const ok = fakeRes();
    void routes.get('GET /media-job')!({ url: '/media-job?id=job_g' } as never, ok.res, '');
    expect(ok.status()).toBe(200);
    expect((ok.json().job as { id: string }).id).toBe('job_g');
    expect(ok.json().progress).toEqual({ doneMs: 4600, totalMs: 9000 });
    const miss = fakeRes();
    void routes.get('GET /media-job')!({ url: '/media-job?id=nope' } as never, miss.res, '');
    expect(miss.status()).toBe(404);
  });
});

describe('processMediaJob', () => {
  it('runs full-speed pipeline, persists filedub session/segments/wav/log and marks done', async () => {
    deps.storage.insertMediaJob({
      id: 'job_p', sourcePath: join(dataDir, 'in.wav'),
      frameConfigJson: JSON.stringify({
        isVideo: false, framesEnabled: false, fps: 1, sourceLanguage: null,
        targetLanguage: 'en', voiceClone: true, voice: 'Tina',
      }),
      createdAt: 1,
    });
    const t = new ScriptedTransport(SCRIPT);
    await processMediaJob(deps, 'job_p', {
      extract: () => Promise.resolve({ pcm16k: new Uint8Array(32000), frames: [] }), // 1000ms → 10 块
      transportFactory: () => t,
    });
    expect(t.appendedChunks).toBe(10); // P7/P8：3200 字节/块、全速推完

    const job = deps.storage.getMediaJob('job_p')!;
    expect(job.status).toBe('done');
    expect(job.session_id).toBe('sess_media_1'); // 服务端 session id 与日志/落库同键
    expect(JSON.parse(job.artifacts_json!)).toEqual({ totalMs: 1000, segmentCount: 1 });

    const session = deps.storage.getSession('sess_media_1')!;
    expect(session.mode).toBe('filedub');
    expect((JSON.parse(session.usage_json!) as { total_tokens: number }).total_tokens).toBe(169);
    // P10：once 复刻时 voice 必须为 "default"
    const cfg = JSON.parse(session.config_json) as SessionConfig;
    expect(cfg.voice).toBe('default');
    expect(cfg.voice_clone_options).toEqual({ frequency: 'once' });

    const segs = deps.storage.listSegments('sess_media_1');
    expect(segs.length).toBe(1);
    expect(segs[0]!.target_text).toBe("The weather is very nice today, let's go for a walk in the park together.  ");
    expect(segs[0]!.audio_path).not.toBeNull();
    expect(readFileSync(segs[0]!.audio_path!).length).toBe(44 + 66); // WAV 头 + 66 字节 24k PCM（P9）

    const logRow = deps.storage.getSessionLog('sess_media_1')!;
    expect(existsSync(logRow.file_path)).toBe(true);
    expect(logRow.event_count).toBe(1 + SCRIPT.length); // 原始 session.created + 回放事件
    expect(logRow.error_count).toBe(0);
  });

  it('marks job failed and records error when pipeline throws', async () => {
    deps.storage.insertMediaJob({
      id: 'job_f', sourcePath: join(dataDir, 'missing.wav'),
      frameConfigJson: JSON.stringify({
        isVideo: false, framesEnabled: false, fps: 1, sourceLanguage: null,
        targetLanguage: 'en', voiceClone: false, voice: 'Tina',
      }),
      createdAt: 1,
    });
    await processMediaJob(deps, 'job_f', {
      extract: () => Promise.reject(new Error('ffmpeg exited with code 1')),
    });
    const job = deps.storage.getMediaJob('job_f')!;
    expect(job.status).toBe('failed');
    expect(JSON.parse(job.artifacts_json!)).toEqual({ error: 'Error: ffmpeg exited with code 1' });
  });
});
```

**Step 9: 最小实现（mediaJobs.ts）**

- [ ] `packages/gateway/src/mediaJobs.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import {
  OUTPUT_SAMPLE_RATE, SessionLogger, WsTransport, pcm16ToWav, runFilePipeline,
  type ITranslateTransport, type PipelineFrame, type RawDirection, type ServerEvent,
  type SessionConfig, type WsLike,
} from '@livetranslate/core';
import WebSocket from 'ws';
import { extractFrames, extractPcm16k } from './ffmpeg';
import { logFilePath } from './historyRoutes';
import type { RouteHandler } from './server';
import type { SessionLogFiles } from './logFiles';
import type { SettingsStore } from './settings';
import type { Storage } from './storage';

const MODEL = 'qwen3.5-livetranslate-flash-realtime';

// 持久化在 media_jobs.frame_config_json 里的作业配置（含抽帧与翻译参数）
export interface MediaJobConfig {
  isVideo: boolean;
  framesEnabled: boolean; // spec 5.2：抽帧视觉增强开关（默认开，仅视频生效）
  fps: 1 | 2;
  sourceLanguage: string | null;
  targetLanguage: string;
  voiceClone: boolean; // spec 5.2：once 复刻
  voice: string;
}

export interface MediaJobRequest {
  fileName: string;
  dataBase64: string;
  isVideo: boolean;
  sourceLanguage?: string; // 缺省 = 自动检测
  targetLanguage: string;
  voiceClone: boolean;
  voice: string;
  framesEnabled: boolean;
}

export interface MediaJobProgress { doneMs: number; totalMs: number }

// 进度只存内存（桌面单机体量小）；完成后 UI 改读 artifacts_json
export const jobProgress = new Map<string, MediaJobProgress>();

export interface MediaDeps {
  storage: Storage;
  settings: SettingsStore;
  dataDir: string;
  logFiles: Pick<SessionLogFiles, 'sinkFor'>;
  runner?: (jobId: string) => void; // 测试注入；默认 fire-and-forget processMediaJob
}

// P1：文件模式在网关进程内直连上游（不经 /realtime 中继），Key 仅在这里出现
export function nodeWsFactory(apiKey: string): (url: string) => WsLike {
  return (url) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const like: WsLike = {
      send: (data) => ws.send(data),
      close: () => ws.close(),
      onopen: null, onmessage: null, onclose: null, onerror: null,
    };
    ws.on('open', () => like.onopen?.());
    ws.on('message', (data) => like.onmessage?.(String(data)));
    ws.on('close', () => like.onclose?.());
    ws.on('error', (err) => like.onerror?.(err));
    return like;
  };
}

export interface ProcessOverrides {
  extract?: (sourcePath: string, cfg: MediaJobConfig) => Promise<{ pcm16k: Uint8Array; frames: PipelineFrame[] }>;
  transportFactory?: () => ITranslateTransport;
}

async function defaultExtract(sourcePath: string, cfg: MediaJobConfig): Promise<{ pcm16k: Uint8Array; frames: PipelineFrame[] }> {
  const pcm16k = await extractPcm16k(sourcePath);
  let frames: PipelineFrame[] = [];
  if (cfg.isVideo && cfg.framesEnabled) {
    const extracted = await extractFrames(sourcePath, { fps: cfg.fps, workDir: join(dirname(sourcePath), 'frames') });
    frames = extracted.map((f) => ({ timeMs: f.timeMs, jpegBase64: f.jpeg.toString('base64') }));
  }
  return { pcm16k, frames };
}

export async function processMediaJob(deps: MediaDeps, jobId: string, overrides: ProcessOverrides = {}): Promise<void> {
  const job = deps.storage.getMediaJob(jobId);
  if (!job) return;
  const cfg = JSON.parse(job.frame_config_json) as MediaJobConfig;
  deps.storage.updateMediaJob(jobId, { status: 'processing' });
  try {
    const { pcm16k, frames } = await (overrides.extract ?? defaultExtract)(job.source_path, cfg);
    const totalMs = Math.round(pcm16k.length / 32); // 32 字节/ms @16k16bit mono
    jobProgress.set(jobId, { doneMs: 0, totalMs });

    let transport: ITranslateTransport;
    if (overrides.transportFactory) {
      transport = overrides.transportFactory();
    } else {
      const host = deps.settings.get().workspaceHost;
      const key = deps.settings.getApiKey();
      if (!host || !key) throw new Error('gateway_not_configured：API Key 或 Workspace Host 未配置');
      transport = new WsTransport({
        url: `wss://${host}/api-ws/v1/realtime?model=${MODEL}`,
        wsFactory: nodeWsFactory(key),
      });
    }

    // spec 6.6：文件模式同样落全量事件日志；拿到服务端 session id 前先缓冲（同 relay 的 pending 模式）
    let logger: SessionLogger | null = null;
    let sessionId: string | null = null;
    const pending: Array<[RawDirection, ServerEvent]> = [];
    const offRaw = transport.onRaw((dir, payload) => {
      if (!logger) {
        if (payload.type === 'session.created') {
          sessionId = (payload as { session?: { id?: string } }).session?.id ?? `job_${jobId}`;
          logger = new SessionLogger({
            sink: deps.logFiles.sinkFor(sessionId),
            fullAudio: deps.settings.get().fullAudioLogs,
          });
          for (const [d, p] of pending) logger.record(d, p);
          pending.length = 0;
        } else {
          pending.push([dir, payload]);
          return;
        }
      }
      logger.record(dir, payload);
    });

    // P10：复刻时 voice 必须为 "default"；spec 5.2：配音用 once 复刻
    const sessionConfig: SessionConfig = {
      modalities: ['text', 'audio'],
      voice: cfg.voiceClone ? 'default' : cfg.voice,
      enable_voice_clone: cfg.voiceClone,
      ...(cfg.voiceClone ? { voice_clone_options: { frequency: 'once' as const } } : {}),
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        ...(cfg.sourceLanguage ? { language: cfg.sourceLanguage } : {}),
      },
      translation: { language: cfg.targetLanguage },
    };

    const startedAt = Date.now();
    const result = await runFilePipeline({
      pcm16k, frames, config: sessionConfig, transport,
      onProgress: (doneMs, total) => jobProgress.set(jobId, { doneMs, totalMs: total }),
    });
    offRaw();

    // 落库与实时会话同构：HistoryPage/导出（T25）复用同一套数据
    const sid = sessionId ?? `job_${jobId}`;
    deps.storage.createSession({ id: sid, mode: 'filedub', configJson: JSON.stringify(sessionConfig), startedAt });
    for (const seg of result.segments) {
      const pcm24k = seg.responseId ? result.audioByResponseId.get(seg.responseId) : undefined;
      const audioPath = pcm24k
        ? deps.storage.saveSegmentAudio(sid, seg.seq, pcm16ToWav(pcm24k, OUTPUT_SAMPLE_RATE)) // P9：24k PCM → WAV
        : null;
      deps.storage.insertSegment({
        sessionId: sid, seq: seg.seq, vadStartMs: seg.vadStartMs, vadEndMs: seg.vadEndMs,
        sourceText: seg.sourceText, targetText: seg.targetText, sourceLang: seg.sourceLang,
        emotion: seg.emotion, audioPath, usageJson: seg.usage ? JSON.stringify(seg.usage) : null,
      });
    }
    const endedAt = Date.now();
    deps.storage.finishSession(sid, { endedAt, usageJson: JSON.stringify(result.usage.sessionTotal) });

    const file = logFilePath(deps.dataDir, sid);
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
      const errors = lines.filter((l) => (JSON.parse(l) as { type?: string }).type === 'error').length;
      deps.storage.upsertSessionLog({
        sessionId: sid, filePath: file, mode: 'filedub', startedAt, endedAt,
        eventCount: lines.length, errorCount: errors,
      });
    }

    deps.storage.updateMediaJob(jobId, {
      status: 'done', sessionId: sid,
      artifactsJson: JSON.stringify({ totalMs, segmentCount: result.segments.length }),
    });
  } catch (err) {
    deps.storage.updateMediaJob(jobId, { status: 'failed', artifactsJson: JSON.stringify({ error: String(err) }) });
  }
}

const json = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

export function registerMediaRoutes(routes: Map<string, RouteHandler>, deps: MediaDeps): void {
  const runner = deps.runner ?? ((jobId: string) => { void processMediaJob(deps, jobId); });

  routes.set('POST /media-jobs', (_req, res, body) => {
    const b = JSON.parse(body) as MediaJobRequest;
    const jobId = randomUUID();
    const jobDir = join(deps.dataDir, 'media', jobId);
    mkdirSync(jobDir, { recursive: true });
    const sourcePath = join(jobDir, b.fileName);
    writeFileSync(sourcePath, Buffer.from(b.dataBase64, 'base64'));
    const cfg: MediaJobConfig = {
      isVideo: b.isVideo,
      framesEnabled: b.framesEnabled,
      fps: deps.settings.get().frameExtraction.fps,
      sourceLanguage: b.sourceLanguage ?? null,
      targetLanguage: b.targetLanguage,
      voiceClone: b.voiceClone,
      voice: b.voice,
    };
    deps.storage.insertMediaJob({ id: jobId, sourcePath, frameConfigJson: JSON.stringify(cfg), createdAt: Date.now() });
    runner(jobId);
    json(res, 200, { jobId });
  });

  routes.set('GET /media-job', (req, res) => {
    const id = new URL(req.url ?? '', 'http://gateway.local').searchParams.get('id') ?? '';
    const row = deps.storage.getMediaJob(id);
    if (!row) { json(res, 404, { error: 'job_not_found' }); return; }
    json(res, 200, { job: row, progress: jobProgress.get(id) ?? null });
  });

  // T23 双栏工作台播放原声用
  routes.set('GET /media-file', (req, res) => {
    const id = new URL(req.url ?? '', 'http://gateway.local').searchParams.get('id') ?? '';
    const row = deps.storage.getMediaJob(id);
    if (!row || !existsSync(row.source_path)) { json(res, 404, { error: 'file_not_found' }); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    createReadStream(row.source_path).pipe(res);
  });
}
```

**Step 10: server.ts 注册 media 路由**

- [ ] `packages/gateway/src/server.ts` 文件头部追加 `import { registerMediaRoutes } from './mediaJobs';`，并在 `registerHistoryRoutes(routes, ...)` 调用之后插入：

```ts
  registerMediaRoutes(routes, { storage, settings: opts.settings, dataDir: opts.dataDir, logFiles });
```

**Step 11: 运行确认通过 + Commit（gateway 半程）**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/mediaJobs.test.ts test/storage.test.ts` → 预期全部通过（mediaJobs 4 passed + storage 全量）。
- [ ] `pnpm --filter @livetranslate/gateway exec vitest run` → 预期既有套件无回归。
- [ ] `git add packages/gateway; git commit -m "feat(gateway): media job orchestration with full-speed preprocessing"`

## Task 22: dubTimeline 顺延漂移

spec §5.2 决策 D：配音回放不做变速贴时间轴，第 n 段起点 = max(原段起点, 上一段译文结束)，整体顺延并可视化漂移量。纯函数，真实实测段时长驱动测试（四段 24k 音频 195840/380160/349440/330240 字节 = 4080/7920/7280/6880ms）。

**Files:**
- Create: `packages/core/src/file/dubTimeline.ts` + `packages/core/test/dubTimeline.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试**

- [ ] `packages/core/test/dubTimeline.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { computeDubTimeline, type DubSegmentTiming } from '../src/file/dubTimeline';

// 实测四段译文音频时长（字节数 / 48 = ms @24k16bit mono）：4080 / 7920 / 7280 / 6880ms
const REAL: DubSegmentTiming[] = [
  { seq: 0, srcStartMs: 0, srcEndMs: 4600, dubDurationMs: 4080 },
  { seq: 1, srcStartMs: 4600, srcEndMs: 11800, dubDurationMs: 7920 },
  { seq: 2, srcStartMs: 11800, srcEndMs: 18800, dubDurationMs: 7280 },
  { seq: 3, srcStartMs: 18800, srcEndMs: 25000, dubDurationMs: 6880 },
];

describe('computeDubTimeline (spec 5.2 决策 D)', () => {
  it('starts each dub at max(srcStart, prevDubEnd) and accumulates drift', () => {
    expect(computeDubTimeline(REAL)).toEqual([
      { seq: 0, dubStartMs: 0, dubEndMs: 4080, driftMs: 0 },       // 译文短于原段，无漂移
      { seq: 1, dubStartMs: 4600, dubEndMs: 12520, driftMs: 0 },   // 原段起点晚于上段配音结束
      { seq: 2, dubStartMs: 12520, dubEndMs: 19800, driftMs: 720 }, // 被上段顺延 720ms
      { seq: 3, dubStartMs: 19800, dubEndMs: 26680, driftMs: 1000 },
    ]);
  });

  it('sorts by srcStartMs before placing', () => {
    const shuffled = [REAL[2]!, REAL[0]!, REAL[3]!, REAL[1]!];
    expect(computeDubTimeline(shuffled).map((p) => p.seq)).toEqual([0, 1, 2, 3]);
  });

  it('returns empty for empty input', () => {
    expect(computeDubTimeline([])).toEqual([]);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/dubTimeline.test.ts` → 预期 FAIL：`Cannot find module '../src/file/dubTimeline'`。

**Step 3: 最小实现**

- [ ] `packages/core/src/file/dubTimeline.ts`：

```ts
export interface DubSegmentTiming {
  seq: number;
  srcStartMs: number; // 段在原始媒体中的 VAD 起点
  srcEndMs: number;
  dubDurationMs: number; // 译文音频实际时长（wavDurationSeconds * 1000）
}

export interface DubPlacement {
  seq: number;
  dubStartMs: number;
  dubEndMs: number;
  driftMs: number; // dubStartMs - srcStartMs，DriftBar（T24）直接显示
}

// spec §5.2 决策 D：不变速，第 n 段起点 = max(原段起点, 上一段配音结束)
export function computeDubTimeline(segments: DubSegmentTiming[]): DubPlacement[] {
  const sorted = [...segments].sort((a, b) => a.srcStartMs - b.srcStartMs);
  const placements: DubPlacement[] = [];
  let prevDubEnd = 0;
  for (const s of sorted) {
    const dubStartMs = Math.max(s.srcStartMs, prevDubEnd);
    const dubEndMs = dubStartMs + s.dubDurationMs;
    placements.push({ seq: s.seq, dubStartMs, dubEndMs, driftMs: dubStartMs - s.srcStartMs });
    prevDubEnd = dubEndMs;
  }
  return placements;
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { computeDubTimeline, type DubPlacement, type DubSegmentTiming } from './file/dubTimeline';
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/dubTimeline.test.ts` → 预期 `3 passed`。
- [ ] `git add packages/core; git commit -m "feat(core): dub timeline with sequential drift placement (spec 5.2/D)"`

## Task 23: 双栏工作台 + 原声播放

spec §5.2：选文件 → 预处理作业（T21）进度条 → 完成后双栏展示原文/译文分段，支持原始媒体播放与逐段译文回放。UI 任务：实现 + 手工验证（E2E 在 T36 补齐）。

**Files:**
- Modify: `packages/ui/src/api.ts`（media 作业客户端）
- Rewrite: `packages/ui/src/pages/FileDubPage.tsx`（替换 T10 占位页）
- Modify: `packages/ui/src/styles.css`

**Step 1: api.ts 追加 media 作业客户端**

- [ ] `packages/ui/src/api.ts` 末尾追加（与 T21 网关路由一一对应）：

```ts
export interface MediaJobDto {
  id: string;
  source_path: string;
  frame_config_json: string;
  artifacts_json: string | null;
  status: 'pending' | 'processing' | 'done' | 'failed';
  session_id: string | null;
  created_at: number;
}

export interface MediaJobStatusDto {
  job: MediaJobDto;
  progress: { doneMs: number; totalMs: number } | null;
}

export interface CreateMediaJobBody {
  fileName: string;
  dataBase64: string;
  isVideo: boolean;
  sourceLanguage?: string;
  targetLanguage: string;
  voiceClone: boolean;
  voice: string;
  framesEnabled: boolean;
}

export async function createMediaJob(b: CreateMediaJobBody): Promise<string> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/media-jobs`, { method: 'POST', body: JSON.stringify(b) });
  if (!res.ok) throw new Error(`gateway /media-jobs -> HTTP ${res.status}`);
  return ((await res.json()) as { jobId: string }).jobId;
}

export async function fetchMediaJob(id: string): Promise<MediaJobStatusDto | null> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/media-job?id=${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gateway /media-job -> HTTP ${res.status}`);
  return (await res.json()) as MediaJobStatusDto;
}

export const mediaFileUrl = (id: string): string =>
  `${getPlatform().gatewayHttpBase()}/media-file?id=${encodeURIComponent(id)}`;
```

**Step 2: FileDubPage 实现**

- [ ] `packages/ui/src/pages/FileDubPage.tsx` 整文件重写：

```tsx
import { useEffect, useRef, useState } from 'react';
import { LANGUAGES, bytesToBase64, supportsAudioOutput } from '@livetranslate/core';
import {
  createGatewayApi, createMediaJob, fetchMediaJob, fetchSegmentAudio, fetchSegments, mediaFileUrl,
  type MediaJobStatusDto, type SegmentDto,
} from '../api';
import { createPlayerSink } from '../audio/playerSink';

type Phase = 'pick' | 'uploading' | 'processing' | 'done' | 'failed';

const fmtMs = (ms: number | null): string => {
  if (ms === null) return '--:--';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function FileDubPage(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [voice, setVoice] = useState('Tina');
  const [voiceClone, setVoiceClone] = useState(true); // spec 5.2：once 复刻默认开
  const [framesEnabled, setFramesEnabled] = useState(true); // spec 5.2：抽帧增强默认开（仅视频）
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<MediaJobStatusDto | null>(null);
  const [segments, setSegments] = useState<SegmentDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sink = useRef(createPlayerSink());

  useEffect(() => {
    void createGatewayApi().getSettings().then(({ settings }) => {
      setTargetLanguage(settings.targetLanguage);
      setVoice(settings.defaultVoice);
      setFramesEnabled(settings.frameExtraction.enabled);
    });
  }, []);

  // 轮询作业状态（T21 进度存内存，1s 一次足够）
  useEffect(() => {
    if (!jobId || phase !== 'processing') return;
    const timer = setInterval(() => {
      void fetchMediaJob(jobId).then(async (st) => {
        if (!st) return;
        setStatus(st);
        if (st.job.status === 'done' && st.job.session_id) {
          clearInterval(timer);
          setSegments(await fetchSegments(st.job.session_id));
          setPhase('done');
        } else if (st.job.status === 'failed') {
          clearInterval(timer);
          setError(st.job.artifacts_json ? (JSON.parse(st.job.artifacts_json) as { error: string }).error : '预处理失败');
          setPhase('failed');
        }
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [jobId, phase]);

  async function start(): Promise<void> {
    if (!file) return;
    setPhase('uploading');
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const id = await createMediaJob({
        fileName: file.name,
        dataBase64: bytesToBase64(bytes),
        isVideo,
        targetLanguage,
        voiceClone,
        voice,
        framesEnabled: isVideo && framesEnabled,
      });
      setJobId(id);
      setPhase('processing');
    } catch (err) {
      setError(String(err));
      setPhase('failed');
    }
  }

  async function playSegment(seg: SegmentDto): Promise<void> {
    if (!seg.audio_path || !status?.job.session_id) return;
    const wav = await fetchSegmentAudio(status.job.session_id, seg.seq);
    await sink.current.play(wav);
  }

  const progress = status?.progress ?? null;
  const pct = progress && progress.totalMs > 0 ? Math.round((progress.doneMs / progress.totalMs) * 100) : 0;

  return (
    <div className="filedub-page">
      <h2>翻译机·配音</h2>
      {phase === 'pick' && (
        <div className="config-panel">
          <label>
            音视频文件
            <input
              type="file"
              accept="audio/*,video/*"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                setIsVideo(f?.type.startsWith('video/') ?? false);
              }}
            />
          </label>
          <label>
            目标语言
            <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
              {LANGUAGES.filter((l) => l.audio).map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={voiceClone} onChange={(e) => setVoiceClone(e.target.checked)} />
            音色复刻（once，取文件开头人声）
          </label>
          {!voiceClone && (
            <label>
              预置音色
              <input value={voice} onChange={(e) => setVoice(e.target.value)} />
            </label>
          )}
          {isVideo && (
            <label>
              <input type="checkbox" checked={framesEnabled} onChange={(e) => setFramesEnabled(e.target.checked)} />
              抽帧视觉增强（提升专名/术语翻译，额外消耗 token）
            </label>
          )}
          <button disabled={!file || !supportsAudioOutput(targetLanguage)} onClick={() => void start()}>开始预处理</button>
          {file && !supportsAudioOutput(targetLanguage) && <p className="error-text">该目标语言不支持语音输出，请换音频支持语种</p>}
        </div>
      )}
      {(phase === 'uploading' || phase === 'processing') && (
        <div className="dub-progress">
          <p>{phase === 'uploading' ? '上传中…' : `全速预处理中（P8，不限速）：${fmtMs(progress?.doneMs ?? 0)} / ${fmtMs(progress?.totalMs ?? null)}`}</p>
          <progress max={100} value={pct} />
        </div>
      )}
      {phase === 'failed' && (
        <div className="dub-progress">
          <p className="error-text">{error}</p>
          <button onClick={() => { setPhase('pick'); setJobId(null); setStatus(null); }}>重新选择</button>
        </div>
      )}
      {phase === 'done' && jobId && (
        <div className="dub-workbench">
          <div className="dub-source-media">
            <h3>原始媒体</h3>
            {isVideo
              ? <video controls src={mediaFileUrl(jobId)} className="dub-video" />
              : <audio controls src={mediaFileUrl(jobId)} />}
          </div>
          <div className="dub-columns">
            <div className="dub-col">
              <h3>原文</h3>
              {segments.map((s) => (
                <div key={s.seq} className="dub-cell">
                  <span className="segment-meta">{fmtMs(s.vad_start_ms)}–{fmtMs(s.vad_end_ms)}{s.source_lang ? ` · ${s.source_lang}` : ''}</span>
                  <p className="segment-source">{s.source_text}</p>
                </div>
              ))}
            </div>
            <div className="dub-col">
              <h3>译文</h3>
              {segments.map((s) => (
                <div key={s.seq} className="dub-cell">
                  <span className="segment-meta">#{s.seq}</span>
                  <p className="segment-target">{s.target_text}</p>
                  {s.audio_path && <button onClick={() => void playSegment(s)}>▶ 播放译文</button>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] `packages/ui/src/styles.css` 末尾追加：

```css
.dub-progress { max-width: 480px; }
.dub-progress progress { width: 100%; height: 12px; }
.dub-video { max-width: 640px; width: 100%; }
.dub-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
.dub-col { border: 1px solid #333; border-radius: 8px; padding: 12px; overflow-y: auto; max-height: 60vh; }
.dub-cell { border-bottom: 1px solid #2a2a2a; padding: 8px 0; }
.error-text { color: #e5484d; }
```

**Step 3: 手工验证**

- [ ] 预检：`pnpm --filter @livetranslate/ui typecheck` → 预期无错误。
- [ ] `pnpm --filter @livetranslate/web dev`（真实 Key/Host 已在设置页配好，本机已装 ffmpeg）→ 进入“翻译机·配音”：
  - 选一个短 mp3（建议用 `scratch/` 里的中文样本转的 mp3，或任意 30s 内中文语音），目标语言 English，保持“音色复刻”勾选 → 点“开始预处理”。
  - 进度条推进明显快于实时（全速推流 P8：30s 素材应在数秒内完成）。
  - 完成后双栏出现分段原文/译文，每段时间戳与语种标签正确；点“▶ 播放译文”能听到复刻音色的译文语音；顶部原始媒体可播放。
  - 选一个 mp4 视频 → 出现“抽帧视觉增强”开关且默认勾选；顶部以 `<video>` 展示。
  - 历史页出现一条 `filedub` 会话，可回放段音频、可查看事件日志（T19 能力复用，验证 §6.6 文件模式同样落日志）。

**Step 4: Commit**

- [ ] `git add packages/ui; git commit -m "feat(ui): file dub workbench with job progress and dual-column review"`

## Task 24: 配音播放控制器 + 漂移可视化

spec §5.2：按 T22 时间轴顺延播放译文段，DriftBar 可视化每段漂移量。控制器为纯逻辑（注入 now/schedule/playSegment），TDD；DriftBar 与页面接线走手工验证。

**Files:**
- Create: `packages/ui/src/state/dubPlayback.ts` + `packages/ui/test/dubPlayback.test.ts`
- Create: `packages/ui/src/components/DriftBar.tsx`
- Modify: `packages/ui/src/pages/FileDubPage.tsx`、`packages/ui/src/styles.css`

**Step 1: 写失败测试**

- [ ] `packages/ui/test/dubPlayback.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { DubSegmentTiming } from '@livetranslate/core';
import { DubPlaybackController } from '../src/state/dubPlayback';

// 与 T22 相同的真实实测时长
const TIMINGS: DubSegmentTiming[] = [
  { seq: 0, srcStartMs: 0, srcEndMs: 4600, dubDurationMs: 4080 },
  { seq: 1, srcStartMs: 4600, srcEndMs: 11800, dubDurationMs: 7920 },
  { seq: 2, srcStartMs: 11800, srcEndMs: 18800, dubDurationMs: 7280 },
  { seq: 3, srcStartMs: 18800, srcEndMs: 25000, dubDurationMs: 6880 },
];

function fakeEnv() {
  let t = 0;
  const scheduled: Array<{ at: number; cb: () => void; cancelled: boolean; fired: boolean }> = [];
  const played: number[] = [];
  const controller = new DubPlaybackController({
    now: () => t,
    schedule: (cb, delayMs) => {
      const item = { at: t + delayMs, cb, cancelled: false, fired: false };
      scheduled.push(item);
      return () => { item.cancelled = true; };
    },
    playSegment: (seq) => played.push(seq),
  });
  const advance = (ms: number): void => {
    t += ms;
    for (const s of scheduled) {
      if (!s.cancelled && !s.fired && s.at <= t) { s.fired = true; s.cb(); }
    }
  };
  return { controller, advance, played };
}

describe('DubPlaybackController (spec 5.2 顺延回放)', () => {
  it('fires segments at their drifted start times in order', () => {
    const { controller, advance, played } = fakeEnv();
    controller.load(TIMINGS);
    controller.play();
    advance(0);
    expect(played).toEqual([0]); // dubStartMs=0 立即触发
    advance(4600);
    expect(played).toEqual([0, 1]);
    advance(7920); // t=12520 → seq2（被顺延到 12520）
    expect(played).toEqual([0, 1, 2]);
    expect(controller.currentSeq()).toBe(2);
    advance(7280); // t=19800 → seq3
    expect(played).toEqual([0, 1, 2, 3]);
    advance(6880); // t=26680，全部结束
    expect(controller.currentSeq()).toBeNull();
  });

  it('pause cancels pending segments and resume replays the remainder', () => {
    const { controller, advance, played } = fakeEnv();
    controller.load(TIMINGS);
    controller.play();
    advance(5000); // seq0/seq1 已触发
    controller.pause();
    expect(controller.positionMs()).toBe(5000);
    advance(60000); // 暂停期间时间流逝，不应触发任何段
    expect(played).toEqual([0, 1]);
    controller.play();
    advance(7520); // 5000+7520=12520 → seq2
    expect(played).toEqual([0, 1, 2]);
  });

  it('seek repositions without firing skipped segments', () => {
    const { controller, advance, played } = fakeEnv();
    controller.load(TIMINGS);
    controller.seek(19000);
    expect(controller.currentSeq()).toBe(2); // 19000 落在 seq2 的 12520–19800 区间
    controller.play();
    advance(800); // 19800 → 只有 seq3 到点
    expect(played).toEqual([3]);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/ui exec vitest run test/dubPlayback.test.ts` → 预期 FAIL：`Cannot find module '../src/state/dubPlayback'`。

**Step 3: 最小实现**

- [ ] `packages/ui/src/state/dubPlayback.ts`：

```ts
import { computeDubTimeline, type DubPlacement, type DubSegmentTiming } from '@livetranslate/core';

export interface DubPlaybackDeps {
  now(): number; // 毫秒壁钟；页面用 performance.now()，测试注入假时钟
  schedule(cb: () => void, delayMs: number): () => void; // 返回取消函数
  playSegment(seq: number): void;
}

export class DubPlaybackController {
  private placements: DubPlacement[] = [];
  private basePositionMs = 0;
  private startedAt: number | null = null;
  private cancels: Array<() => void> = [];

  constructor(private deps: DubPlaybackDeps) {}

  load(timings: DubSegmentTiming[]): DubPlacement[] {
    this.pause();
    this.basePositionMs = 0;
    this.placements = computeDubTimeline(timings);
    return this.placements;
  }

  positionMs(): number {
    return this.startedAt === null
      ? this.basePositionMs
      : this.basePositionMs + (this.deps.now() - this.startedAt);
  }

  play(): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.deps.now();
    const pos = this.basePositionMs;
    for (const p of this.placements) {
      if (p.dubStartMs >= pos) {
        this.cancels.push(this.deps.schedule(() => this.deps.playSegment(p.seq), p.dubStartMs - pos));
      }
    }
  }

  pause(): void {
    if (this.startedAt !== null) {
      this.basePositionMs = this.positionMs();
      this.startedAt = null;
    }
    this.cancels.forEach((cancel) => cancel());
    this.cancels = [];
  }

  seek(ms: number): void {
    const wasPlaying = this.startedAt !== null;
    this.pause();
    this.basePositionMs = Math.max(0, ms);
    if (wasPlaying) this.play();
  }

  currentSeq(): number | null {
    const pos = this.positionMs();
    const hit = this.placements.find((p) => p.dubStartMs <= pos && pos < p.dubEndMs);
    return hit ? hit.seq : null;
  }

  getPlacements(): DubPlacement[] {
    return this.placements;
  }
}
```

- [ ] `packages/ui/src/components/DriftBar.tsx`：

```tsx
import type { DubPlacement } from '@livetranslate/core';

export interface DriftBarProps {
  placements: DubPlacement[];
  currentSeq: number | null;
  totalMs: number; // 原始媒体总时长，用于横轴刻度
}

export function DriftBar({ placements, currentSeq, totalMs }: DriftBarProps): JSX.Element {
  const maxMs = Math.max(totalMs, ...placements.map((p) => p.dubEndMs), 1);
  return (
    <div className="drift-bar">
      {placements.map((p) => (
        <div
          key={p.seq}
          className={`drift-chip${p.seq === currentSeq ? ' active' : ''}${p.driftMs > 0 ? ' drifted' : ''}`}
          style={{ left: `${(p.dubStartMs / maxMs) * 100}%`, width: `${((p.dubEndMs - p.dubStartMs) / maxMs) * 100}%` }}
          title={`#${p.seq} 漂移 +${(p.driftMs / 1000).toFixed(1)}s`}
        />
      ))}
    </div>
  );
}
```

**Step 4: FileDubPage 接线**

- [ ] `packages/ui/src/pages/FileDubPage.tsx` 头部 import 追加：

```tsx
import { OUTPUT_SAMPLE_RATE, wavDurationSeconds, type DubPlacement, type DubSegmentTiming } from '@livetranslate/core';
import { DriftBar } from '../components/DriftBar';
import { DubPlaybackController } from '../state/dubPlayback';
```

- [ ] 组件内追加状态与回放初始化（放在 `const sink = useRef(...)` 之后）：

```tsx
  const [placements, setPlacements] = useState<DubPlacement[]>([]);
  const [dubPlaying, setDubPlaying] = useState(false);
  const [currentSeq, setCurrentSeq] = useState<number | null>(null);
  const audioCache = useRef(new Map<number, Uint8Array>());
  const controller = useRef<DubPlaybackController | null>(null);

  async function initDubPlayback(segs: SegmentDto[], sessionId: string): Promise<void> {
    const timings: DubSegmentTiming[] = [];
    for (const s of segs) {
      if (!s.audio_path || s.vad_start_ms === null || s.vad_end_ms === null) continue;
      const wav = await fetchSegmentAudio(sessionId, s.seq);
      audioCache.current.set(s.seq, wav);
      timings.push({
        seq: s.seq,
        srcStartMs: s.vad_start_ms,
        srcEndMs: s.vad_end_ms,
        dubDurationMs: Math.round(wavDurationSeconds(wav.length - 44, OUTPUT_SAMPLE_RATE) * 1000), // 去掉 44 字节 WAV 头
      });
    }
    const c = new DubPlaybackController({
      now: () => performance.now(),
      schedule: (cb, delayMs) => {
        const handle = window.setTimeout(cb, delayMs);
        return () => window.clearTimeout(handle);
      },
      playSegment: (seq) => {
        const wav = audioCache.current.get(seq);
        if (wav) void sink.current.play(wav);
      },
    });
    setPlacements(c.load(timings));
    controller.current = c;
  }

  useEffect(() => {
    if (!dubPlaying) return;
    const handle = setInterval(() => setCurrentSeq(controller.current?.currentSeq() ?? null), 200);
    return () => clearInterval(handle);
  }, [dubPlaying]);
```

- [ ] T23 轮询 effect 中的 done 分支：

```tsx
        if (st.job.status === 'done' && st.job.session_id) {
          clearInterval(timer);
          setSegments(await fetchSegments(st.job.session_id));
          setPhase('done');
        }
```

替换为：

```tsx
        if (st.job.status === 'done' && st.job.session_id) {
          clearInterval(timer);
          const segs = await fetchSegments(st.job.session_id);
          setSegments(segs);
          await initDubPlayback(segs, st.job.session_id);
          setPhase('done');
        }
```

- [ ] done 分支 JSX：在 `<div className="dub-columns">` 之前插入回放区：

```tsx
          <div className="dub-playback">
            <button disabled={dubPlaying} onClick={() => { controller.current?.play(); setDubPlaying(true); }}>▶ 配音回放</button>
            <button disabled={!dubPlaying} onClick={() => { controller.current?.pause(); sink.current.stop(); setDubPlaying(false); }}>⏸ 暂停</button>
            <button onClick={() => { controller.current?.seek(0); sink.current.stop(); setCurrentSeq(null); }}>⏮ 回到开头</button>
            <DriftBar placements={placements} currentSeq={currentSeq} totalMs={progress?.totalMs ?? 0} />
          </div>
```

- [ ] 译文列的 `.dub-cell` 高亮当前段：`<div key={s.seq} className={`dub-cell${currentSeq === s.seq ? ' playing' : ''}`}>`（原文列同样处理）。
- [ ] `packages/ui/src/styles.css` 末尾追加：

```css
.dub-playback { display: flex; align-items: center; gap: 8px; margin: 12px 0; }
.drift-bar { position: relative; flex: 1; height: 18px; background: #1c1c1c; border-radius: 4px; }
.drift-chip { position: absolute; top: 3px; height: 12px; background: #2f6feb; border-radius: 2px; }
.drift-chip.drifted { background: #b58900; }
.drift-chip.active { outline: 2px solid #fff; }
.dub-cell.playing { background: #24303f; }
```

**Step 5: 运行确认通过 + 手工验证 + Commit**

- [ ] `pnpm --filter @livetranslate/ui exec vitest run test/dubPlayback.test.ts` → 预期 `3 passed`。
- [ ] `pnpm --filter @livetranslate/ui typecheck` → 预期无错误。
- [ ] 手工：完成一个配音作业后点“▶ 配音回放”→ 译文段按时间轴顺序自动播放；译文长于原段时后续段被顺延，DriftBar 中顺延段显示为黄色且 tooltip 给出 `+N.Ns`；当前播放段双栏同步高亮；“⏸ 暂停”立即停声，再点“▶”从暂停点续播。
- [ ] `git add packages/ui; git commit -m "feat(ui): dub playback controller with drift visualization"`

## Task 25: 导出：SRT / 双语 TXT / 混音 WAV

spec §5.2：三种导出物。SRT 贴原时间轴（字幕对齐原片）；混音 WAV 按 T22 顺延漂移时间轴把各段 24k 译文 PCM 铺进静音底轨；双语 TXT 逐段原文+译文。core 纯函数 TDD，gateway 路由拼装。

**Files:**
- Create: `packages/core/src/file/srt.ts` + `packages/core/test/srt.test.ts`
- Create: `packages/core/src/file/dubMixdown.ts` + `packages/core/test/dubMixdown.test.ts`
- Create: `packages/gateway/src/exportRoutes.ts` + `packages/gateway/test/exportRoutes.test.ts`
- Modify: `packages/core/src/index.ts`、`packages/gateway/src/server.ts`、`packages/ui/src/api.ts`、`packages/ui/src/pages/FileDubPage.tsx`

**Step 1: core 写失败测试**

- [ ] `packages/core/test/srt.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildBilingualTxt, buildSrt, formatSrtTime } from '../src/file/srt';

describe('formatSrtTime', () => {
  it('formats hh:mm:ss,mmm', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(4600)).toBe('00:00:04,600');
    expect(formatSrtTime(65040)).toBe('00:01:05,040');
    expect(formatSrtTime(3600000 + 61001)).toBe('01:01:01,001');
  });
});

describe('buildSrt (spec 5.2，贴原时间轴)', () => {
  it('renders numbered cues with blank-line separators', () => {
    const srt = buildSrt([
      { startMs: 0, endMs: 4600, text: "The weather is very nice today, let's go for a walk in the park together." },
      { startMs: 4600, endMs: 11800, text: 'Second sentence.' },
    ]);
    expect(srt).toBe([
      '1',
      '00:00:00,000 --> 00:00:04,600',
      "The weather is very nice today, let's go for a walk in the park together.",
      '',
      '2',
      '00:00:04,600 --> 00:00:11,800',
      'Second sentence.',
      '',
    ].join('\n'));
  });
});

describe('buildBilingualTxt', () => {
  it('emits source + target per block', () => {
    expect(buildBilingualTxt([
      { sourceText: '今天天气很好，我们一起去公园散步。', targetText: 'The weather is very nice today.' },
      { sourceText: '第二句。', targetText: 'Second sentence.' },
    ])).toBe('今天天气很好，我们一起去公园散步。\nThe weather is very nice today.\n\n第二句。\nSecond sentence.\n');
  });
});
```

- [ ] `packages/core/test/dubMixdown.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { computeDubTimeline, type DubSegmentTiming } from '../src/file/dubTimeline';
import { BYTES_PER_MS_24K, mixdownDubPcm } from '../src/file/dubMixdown';

// 真实实测四段：195840/380160/349440/330240 字节 = 4080/7920/7280/6880ms @24k
const TIMINGS: DubSegmentTiming[] = [
  { seq: 0, srcStartMs: 0, srcEndMs: 4600, dubDurationMs: 4080 },
  { seq: 1, srcStartMs: 4600, srcEndMs: 11800, dubDurationMs: 7920 },
  { seq: 2, srcStartMs: 11800, srcEndMs: 18800, dubDurationMs: 7280 },
  { seq: 3, srcStartMs: 18800, srcEndMs: 25000, dubDurationMs: 6880 },
];

describe('mixdownDubPcm (spec 5.2 混音 WAV)', () => {
  it('lays real-sized segments on the drift timeline over silence', () => {
    const audioBySeq = new Map<number, Uint8Array>([
      [0, new Uint8Array(195840).fill(1)],
      [1, new Uint8Array(380160).fill(2)],
      [2, new Uint8Array(349440).fill(3)],
      [3, new Uint8Array(330240).fill(4)],
    ]);
    const pcm = mixdownDubPcm({ placements: computeDubTimeline(TIMINGS), audioBySeq, totalMs: 25000 });
    // 末段顺延到 26680ms 结束 → 总长 26680 * 48 字节
    expect(pcm.length).toBe(26680 * BYTES_PER_MS_24K);
    expect(pcm[0]).toBe(1); // seq0 从 0ms 开始
    expect(pcm[4080 * BYTES_PER_MS_24K]).toBe(0); // 4080–4600ms 是静音间隙
    expect(pcm[4600 * BYTES_PER_MS_24K]).toBe(2); // seq1 从 4600ms 开始
    expect(pcm[12520 * BYTES_PER_MS_24K]).toBe(3); // seq2 被顺延到 12520ms
    expect(pcm[19800 * BYTES_PER_MS_24K]).toBe(4); // seq3 顺延到 19800ms
    expect(pcm[pcm.length - 1]).toBe(4); // 恰好在末段结尾处收尾
  });

  it('pads to totalMs when dubs finish earlier', () => {
    const pcm = mixdownDubPcm({
      placements: computeDubTimeline([{ seq: 0, srcStartMs: 0, srcEndMs: 1000, dubDurationMs: 500 }]),
      audioBySeq: new Map([[0, new Uint8Array(500 * BYTES_PER_MS_24K).fill(9)]]),
      totalMs: 1000,
    });
    expect(pcm.length).toBe(1000 * BYTES_PER_MS_24K);
    expect(pcm[500 * BYTES_PER_MS_24K]).toBe(0); // 后半段静音
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/srt.test.ts test/dubMixdown.test.ts` → 预期 FAIL：`Cannot find module '../src/file/srt'` / `'../src/file/dubMixdown'`。

**Step 3: core 最小实现**

- [ ] `packages/core/src/file/srt.ts`：

```ts
export interface SrtCue {
  startMs: number;
  endMs: number;
  text: string;
}

export function formatSrtTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}

export function buildSrt(cues: SrtCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}\n`)
    .join('\n');
}

export function buildBilingualTxt(entries: Array<{ sourceText: string; targetText: string }>): string {
  return entries.map((e) => `${e.sourceText}\n${e.targetText}\n`).join('\n');
}
```

- [ ] `packages/core/src/file/dubMixdown.ts`：

```ts
import type { DubPlacement } from './dubTimeline';

export const BYTES_PER_MS_24K = 48; // 24000 采样/s × 2 字节 = 48 字节/ms（P9）

export interface MixdownInput {
  placements: DubPlacement[];
  audioBySeq: Map<number, Uint8Array>; // 各段 24k PCM（不含 WAV 头）
  totalMs: number; // 原始媒体总时长
}

// 静音底轨 + 按顺延时间轴铺段；顺延保证段间不重叠（T22），无需叠加混音
export function mixdownDubPcm(input: MixdownInput): Uint8Array {
  const endMs = Math.max(input.totalMs, ...input.placements.map((p) => p.dubEndMs), 0);
  const out = new Uint8Array(endMs * BYTES_PER_MS_24K);
  for (const p of input.placements) {
    const pcm = input.audioBySeq.get(p.seq);
    if (!pcm) continue;
    const offset = p.dubStartMs * BYTES_PER_MS_24K;
    out.set(pcm.subarray(0, Math.max(0, out.length - offset)), offset);
  }
  return out;
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { buildBilingualTxt, buildSrt, formatSrtTime, type SrtCue } from './file/srt';
export { BYTES_PER_MS_24K, mixdownDubPcm, type MixdownInput } from './file/dubMixdown';
```

**Step 4: 运行确认通过 + Commit（core 半程）**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/srt.test.ts test/dubMixdown.test.ts` → 预期 `5 passed`。
- [ ] `git add packages/core; git commit -m "feat(core): srt builder and dub mixdown on drift timeline"`

**Step 5: gateway 写失败测试**

- [ ] `packages/gateway/test/exportRoutes.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { BYTES_PER_MS_24K, OUTPUT_SAMPLE_RATE, pcm16ToWav } from '@livetranslate/core';
import { openDb } from '../src/db';
import { Storage } from '../src/storage';
import { registerExportRoutes } from '../src/exportRoutes';
import type { RouteHandler } from '../src/server';

function fakeRes() {
  const chunks: Array<string | Buffer> = [];
  let statusCode = 0;
  let headers: Record<string, string> = {};
  const res = {
    writeHead: (code: number, h?: Record<string, string>) => { statusCode = code; headers = h ?? {}; return res; },
    end: (data?: string | Buffer) => { if (data !== undefined) chunks.push(data); },
  } as unknown as ServerResponse;
  return {
    res,
    text: () => chunks.map((c) => c.toString()).join(''),
    bytes: () => Buffer.concat(chunks.map((c) => Buffer.from(c))),
    status: () => statusCode,
    headers: () => headers,
  };
}

let dataDir: string;
let storage: Storage;
let routes: Map<string, RouteHandler>;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'lt-export-'));
  storage = new Storage(openDb(join(dataDir, 'app.db')), dataDir);
  routes = new Map();
  registerExportRoutes(routes, { storage });

  storage.createSession({ id: 'sess_e1', mode: 'filedub', configJson: '{}', startedAt: 1 });
  // seq0：译文 1000ms；seq1：译文 4000ms（长于原段，验证顺延只影响 WAV、不影响 SRT）
  const wav0 = pcm16ToWav(new Uint8Array(1000 * BYTES_PER_MS_24K).fill(7), OUTPUT_SAMPLE_RATE);
  const wav1 = pcm16ToWav(new Uint8Array(4000 * BYTES_PER_MS_24K).fill(8), OUTPUT_SAMPLE_RATE);
  const p0 = storage.saveSegmentAudio('sess_e1', 0, wav0);
  const p1 = storage.saveSegmentAudio('sess_e1', 1, wav1);
  storage.insertSegment({
    sessionId: 'sess_e1', seq: 0, vadStartMs: 0, vadEndMs: 2000,
    sourceText: '今天天气很好。', targetText: 'Nice weather today.', sourceLang: 'zh', emotion: 'neutral',
    audioPath: p0, usageJson: null,
  });
  storage.insertSegment({
    sessionId: 'sess_e1', seq: 1, vadStartMs: 2000, vadEndMs: 5000,
    sourceText: '第二句。', targetText: 'Second sentence.', sourceLang: 'zh', emotion: 'neutral',
    audioPath: p1, usageJson: null,
  });
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe('registerExportRoutes (spec 5.2 导出)', () => {
  it('GET /export/srt renders cues on the original timeline', () => {
    const r = fakeRes();
    void routes.get('GET /export/srt')!({ url: '/export/srt?sessionId=sess_e1' } as never, r.res, '');
    expect(r.status()).toBe(200);
    expect(r.headers()['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(r.text()).toBe([
      '1', '00:00:00,000 --> 00:00:02,000', 'Nice weather today.', '',
      '2', '00:00:02,000 --> 00:00:05,000', 'Second sentence.', '',
    ].join('\n'));
  });

  it('GET /export/txt renders bilingual blocks', () => {
    const r = fakeRes();
    void routes.get('GET /export/txt')!({ url: '/export/txt?sessionId=sess_e1' } as never, r.res, '');
    expect(r.text()).toBe('今天天气很好。\nNice weather today.\n\n第二句。\nSecond sentence.\n');
  });

  it('GET /export/dub-wav mixes segments on the drift timeline', () => {
    const r = fakeRes();
    void routes.get('GET /export/dub-wav')!({ url: '/export/dub-wav?sessionId=sess_e1' } as never, r.res, '');
    const wav = r.bytes();
    expect(r.headers()['Content-Type']).toBe('audio/wav');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    // seq1 尾部顺延到 2000+4000=6000ms → data 长 6000*48
    expect(wav.length).toBe(44 + 6000 * BYTES_PER_MS_24K);
    expect(wav[44]).toBe(7); // seq0 起点
    expect(wav[44 + 1000 * BYTES_PER_MS_24K]).toBe(0); // 1000–2000ms 静音
    expect(wav[44 + 2000 * BYTES_PER_MS_24K]).toBe(8); // seq1 贴原起点 2000ms
  });

  it('returns 404 for unknown session', () => {
    const r = fakeRes();
    void routes.get('GET /export/srt')!({ url: '/export/srt?sessionId=nope' } as never, r.res, '');
    expect(r.status()).toBe(404);
  });
});
```

**Step 6: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/exportRoutes.test.ts` → 预期 FAIL：`Cannot find module '../src/exportRoutes'`。

**Step 7: gateway 最小实现**

- [ ] `packages/gateway/src/exportRoutes.ts`：

```ts
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import {
  BYTES_PER_MS_24K, OUTPUT_SAMPLE_RATE, buildBilingualTxt, buildSrt, computeDubTimeline,
  mixdownDubPcm, pcm16ToWav, type DubSegmentTiming, type SrtCue,
} from '@livetranslate/core';
import type { RouteHandler } from './server';
import type { Storage } from './storage';

const query = (url: string | undefined, key: string): string =>
  new URL(url ?? '', 'http://gateway.local').searchParams.get(key) ?? '';

const notFound = (res: ServerResponse): void => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'session_not_found' }));
};

const sendText = (res: ServerResponse, filename: string, body: string): void => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.end(body);
};

export function registerExportRoutes(routes: Map<string, RouteHandler>, deps: { storage: Storage }): void {
  routes.set('GET /export/srt', (req, res) => {
    const sessionId = query(req.url, 'sessionId');
    if (!deps.storage.getSession(sessionId)) { notFound(res); return; }
    // spec §5.2：字幕贴原时间轴（VAD 起止），不受配音顺延影响
    const cues: SrtCue[] = deps.storage.listSegments(sessionId)
      .filter((s) => s.vad_start_ms !== null && s.vad_end_ms !== null)
      .map((s) => ({ startMs: s.vad_start_ms!, endMs: s.vad_end_ms!, text: s.target_text }));
    sendText(res, `${sessionId}.srt`, buildSrt(cues));
  });

  routes.set('GET /export/txt', (req, res) => {
    const sessionId = query(req.url, 'sessionId');
    if (!deps.storage.getSession(sessionId)) { notFound(res); return; }
    const entries = deps.storage.listSegments(sessionId)
      .map((s) => ({ sourceText: s.source_text, targetText: s.target_text }));
    sendText(res, `${sessionId}.txt`, buildBilingualTxt(entries));
  });

  routes.set('GET /export/dub-wav', (req, res) => {
    const sessionId = query(req.url, 'sessionId');
    if (!deps.storage.getSession(sessionId)) { notFound(res); return; }
    const timings: DubSegmentTiming[] = [];
    const audioBySeq = new Map<number, Uint8Array>();
    let totalMs = 0;
    for (const s of deps.storage.listSegments(sessionId)) {
      if (!s.audio_path || s.vad_start_ms === null || s.vad_end_ms === null) continue;
      const pcm = new Uint8Array(readFileSync(s.audio_path)).subarray(44); // 去 WAV 头
      audioBySeq.set(s.seq, pcm);
      timings.push({
        seq: s.seq, srcStartMs: s.vad_start_ms, srcEndMs: s.vad_end_ms,
        dubDurationMs: Math.round(pcm.length / BYTES_PER_MS_24K),
      });
      totalMs = Math.max(totalMs, s.vad_end_ms);
    }
    const wav = pcm16ToWav(
      mixdownDubPcm({ placements: computeDubTimeline(timings), audioBySeq, totalMs }),
      OUTPUT_SAMPLE_RATE,
    );
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Disposition': `attachment; filename="${sessionId}-dub.wav"`,
    });
    res.end(Buffer.from(wav));
  });
}
```

- [ ] `packages/gateway/src/server.ts` 头部追加 `import { registerExportRoutes } from './exportRoutes';`，并在 `registerMediaRoutes(...)` 调用后插入：

```ts
  registerExportRoutes(routes, { storage });
```

**Step 8: UI 导出按钮**

- [ ] `packages/ui/src/api.ts` 末尾追加：

```ts
export const exportUrl = (kind: 'srt' | 'txt' | 'dub-wav', sessionId: string): string =>
  `${getPlatform().gatewayHttpBase()}/export/${kind}?sessionId=${encodeURIComponent(sessionId)}`;
```

- [ ] `packages/ui/src/pages/FileDubPage.tsx`：import 追加 `exportUrl`；done 分支的 `.dub-playback` 区块后插入：

```tsx
          {status?.job.session_id && (
            <div className="dub-exports">
              <a href={exportUrl('srt', status.job.session_id)} download>导出 SRT</a>
              <a href={exportUrl('txt', status.job.session_id)} download>导出双语 TXT</a>
              <a href={exportUrl('dub-wav', status.job.session_id)} download>导出混音 WAV</a>
            </div>
          )}
```

- [ ] `packages/ui/src/styles.css` 末尾追加：

```css
.dub-exports { display: flex; gap: 16px; margin-bottom: 12px; }
.dub-exports a { color: #4c9aff; }
```

**Step 9: 运行确认通过 + 手工验证 + Commit**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/exportRoutes.test.ts` → 预期 `4 passed`。
- [ ] `pnpm --filter @livetranslate/ui typecheck` → 预期无错误。
- [ ] 手工：完成配音作业后三个导出链接可下载；SRT 用播放器挂到原视频上时间对齐；混音 WAV 用音频软件打开可听到带静音间隙的逐段译文；TXT 逐段原文+译文。
- [ ] `git add packages/gateway packages/ui; git commit -m "feat(gateway,ui): export routes for srt, bilingual txt and dub wav"`

## Task 26: 抽帧视觉增强规则 + 降级“仅音轨”

spec §5.2/P11：单帧 JPEG base64 前 ≤190KB、≤2fps、≤720p（尺寸已由 T20 ffmpeg scale 保证）；超大帧跳过不阻断作业；抽帧失败降级“仅音轨”并提示；ffmpeg 缺失明确报错（spec §6.5）。

**Files:**
- Create: `packages/core/src/file/imageRules.ts` + `packages/core/test/imageRules.test.ts`
- Modify: `packages/core/src/index.ts`、`packages/gateway/src/mediaJobs.ts`、`packages/gateway/test/mediaJobs.test.ts`、`packages/ui/src/pages/FileDubPage.tsx`

**Step 1: core 写失败测试**

- [ ] `packages/core/test/imageRules.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, MAX_FRAME_FPS, filterOversizedFrames, rawBytesOfBase64 } from '../src/file/imageRules';
import type { PipelineFrame } from '../src/file/filePipeline';

describe('imageRules (P11)', () => {
  it('computes raw byte size from base64 length and padding', () => {
    expect(rawBytesOfBase64('QUJD')).toBe(3); // "ABC"
    expect(rawBytesOfBase64('QUI=')).toBe(2);
    expect(rawBytesOfBase64('QQ==')).toBe(1);
    expect(rawBytesOfBase64('')).toBe(0);
  });

  it('exposes protocol constants', () => {
    expect(MAX_FRAME_BYTES).toBe(190 * 1024); // base64 编码前 ≤190KB
    expect(MAX_FRAME_FPS).toBe(2);
  });

  it('drops frames above 190KB and keeps the rest in order', () => {
    const small: PipelineFrame = { timeMs: 0, jpegBase64: 'QUJD' };
    // 259416 个 base64 字符（无 padding）= 194562 原始字节 > 194560
    const big: PipelineFrame = { timeMs: 500, jpegBase64: 'A'.repeat(259416) };
    const tail: PipelineFrame = { timeMs: 1000, jpegBase64: 'QQ==' };
    const { kept, droppedTimesMs } = filterOversizedFrames([small, big, tail]);
    expect(kept).toEqual([small, tail]);
    expect(droppedTimesMs).toEqual([500]);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/imageRules.test.ts` → 预期 FAIL：`Cannot find module '../src/file/imageRules'`。

**Step 3: core 最小实现**

- [ ] `packages/core/src/file/imageRules.ts`：

```ts
import type { PipelineFrame } from './filePipeline';

export const MAX_FRAME_BYTES = 190 * 1024; // P11：base64 编码前 ≤190KB
export const MAX_FRAME_FPS = 2; // P11：≤2 张/秒（T20 抽帧 fps 参数限定 1|2）

export function rawBytesOfBase64(b64: string): number {
  if (b64.length === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length * 3) / 4 - padding;
}

export function filterOversizedFrames(frames: PipelineFrame[]): { kept: PipelineFrame[]; droppedTimesMs: number[] } {
  const kept: PipelineFrame[] = [];
  const droppedTimesMs: number[] = [];
  for (const f of frames) {
    if (rawBytesOfBase64(f.jpegBase64) > MAX_FRAME_BYTES) droppedTimesMs.push(f.timeMs);
    else kept.push(f);
  }
  return { kept, droppedTimesMs };
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { MAX_FRAME_BYTES, MAX_FRAME_FPS, filterOversizedFrames, rawBytesOfBase64 } from './file/imageRules';
```

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/imageRules.test.ts` → 预期 `3 passed`。

**Step 4: mediaJobs 接入规则与降级**

- [ ] `packages/gateway/test/mediaJobs.test.ts` 先补失败断言：
  - `ScriptedTransport` 追加计数器：`appendedImages = 0;`，并把 `appendImage(): void {}` 改为 `appendImage(): void { this.appendedImages++; }`。
  - 既有用例中两处 `extract: () => Promise.resolve({ pcm16k: new Uint8Array(32000), frames: [] })` 与 `extract: () => Promise.reject(...)` 保持不变，但成功用例的 extract 返回值改为 `{ pcm16k: new Uint8Array(32000), frames: [], framesDegraded: false }`；其 artifacts 断言改为：

```ts
    expect(JSON.parse(job.artifacts_json!)).toEqual({ totalMs: 1000, segmentCount: 1, droppedFrames: 0, framesDegraded: false });
```

  - `describe('processMediaJob', ...)` 末尾新增用例：

```ts
  it('drops oversized frames (P11) but still appends the valid ones', async () => {
    deps.storage.insertMediaJob({
      id: 'job_v', sourcePath: join(dataDir, 'in.mp4'),
      frameConfigJson: JSON.stringify({
        isVideo: true, framesEnabled: true, fps: 1, sourceLanguage: null,
        targetLanguage: 'en', voiceClone: false, voice: 'Tina',
      }),
      createdAt: 1,
    });
    const t = new ScriptedTransport(SCRIPT);
    await processMediaJob(deps, 'job_v', {
      extract: () => Promise.resolve({
        pcm16k: new Uint8Array(32000),
        frames: [
          { timeMs: 150, jpegBase64: 'QUJD' },
          { timeMs: 450, jpegBase64: 'A'.repeat(259416) }, // 194562 字节 > 190KB → 丢弃
        ],
        framesDegraded: false,
      }),
      transportFactory: () => t,
    });
    expect(t.appendedImages).toBe(1);
    const job = deps.storage.getMediaJob('job_v')!;
    expect(JSON.parse(job.artifacts_json!)).toEqual({ totalMs: 1000, segmentCount: 1, droppedFrames: 1, framesDegraded: false });
  });
```

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/mediaJobs.test.ts` → 预期 FAIL（新断言与新字段未实现）。
- [ ] `packages/gateway/src/mediaJobs.ts` 修改：
  - import 追加：`filterOversizedFrames`（并入 `@livetranslate/core` 已有 import 列表）。
  - `ProcessOverrides.extract` 与 `defaultExtract` 的返回类型改为 `Promise<ExtractResult>`，新增类型：

```ts
export interface ExtractResult {
  pcm16k: Uint8Array;
  frames: PipelineFrame[];
  framesDegraded: boolean; // 抽帧失败降级“仅音轨”（spec 5.2）
}
```

  - `defaultExtract` 整体替换为（ffmpeg 缺失明确报错 + 抽帧失败降级）：

```ts
async function defaultExtract(sourcePath: string, cfg: MediaJobConfig): Promise<ExtractResult> {
  let pcm16k: Uint8Array;
  try {
    pcm16k = await extractPcm16k(sourcePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // spec §6.5：ffmpeg 失败明确报错
      throw new Error('未检测到 ffmpeg：请安装并加入 PATH，或设置 LT_FFMPEG_PATH/LT_FFPROBE_PATH');
    }
    throw new Error(`音轨抽取失败（格式可能不受支持，建议先转 mp3/mp4）：${String(err)}`);
  }
  let frames: PipelineFrame[] = [];
  let framesDegraded = false;
  if (cfg.isVideo && cfg.framesEnabled) {
    try {
      const extracted = await extractFrames(sourcePath, { fps: cfg.fps, workDir: join(dirname(sourcePath), 'frames') });
      frames = extracted.map((f) => ({ timeMs: f.timeMs, jpegBase64: f.jpeg.toString('base64') }));
    } catch {
      framesDegraded = true; // 抽帧失败不阻断作业：降级仅音轨
    }
  }
  return { pcm16k, frames, framesDegraded };
}
```

  - `processMediaJob` 中拆包与推流前过滤（替换原 `const { pcm16k, frames } = await (overrides.extract ?? defaultExtract)(job.source_path, cfg);` 一行）：

```ts
    const { pcm16k, frames: rawFrames, framesDegraded } = await (overrides.extract ?? defaultExtract)(job.source_path, cfg);
    const { kept: frames, droppedTimesMs } = filterOversizedFrames(rawFrames); // P11：超大帧跳过
```

  - artifacts 写入处（done 分支）替换为：

```ts
    deps.storage.updateMediaJob(jobId, {
      status: 'done', sessionId: sid,
      artifactsJson: JSON.stringify({
        totalMs, segmentCount: result.segments.length,
        droppedFrames: droppedTimesMs.length, framesDegraded,
      }),
    });
```

**Step 5: UI 降级提示**

- [ ] `packages/ui/src/pages/FileDubPage.tsx`：done 分支 `<h3>原始媒体</h3>` 上方插入（需先在组件内解析 artifacts）：

```tsx
          {(() => {
            const a = status?.job.artifacts_json
              ? (JSON.parse(status.job.artifacts_json) as { droppedFrames?: number; framesDegraded?: boolean })
              : null;
            if (!a) return null;
            return (
              <>
                {a.framesDegraded && <p className="warn-text">抽帧失败，已降级为“仅音轨”翻译（译文不含视觉增强）</p>}
                {(a.droppedFrames ?? 0) > 0 && <p className="warn-text">有 {a.droppedFrames} 帧超过 190KB 限制被跳过（P11）</p>}
              </>
            );
          })()}
```

- [ ] `packages/ui/src/styles.css` 末尾追加：`.warn-text { color: #b58900; }`

**Step 6: 运行确认通过 + Commit（M3 出口）**

- [ ] `pnpm --filter @livetranslate/core exec vitest run` → 预期全部通过。
- [ ] `pnpm --filter @livetranslate/gateway exec vitest run` → 预期全部通过（含新用例）。
- [ ] `pnpm --filter @livetranslate/ui typecheck` → 预期无错误。
- [ ] 手工（M3 出口验收）：mp4 视频开启抽帧完成配音；临时把 PATH 中 ffmpeg 改名后新建作业 → 失败页显示“未检测到 ffmpeg…”指引（验完恢复）。
- [ ] `git add packages/core packages/gateway packages/ui; git commit -m "feat: frame size rules with audio-only degradation and ffmpeg guidance (M3 exit)"`

---

# Milestone 4：实时翻译机

## Task 27: 流式播放队列 StreamPlayer

spec §5.3：译文 24k PCM 边收边播——Web Audio 队列调度，`nextStartTime` 累积无缝拼接，断流后从当前时刻续播。注入 `AudioContextLike`，纯逻辑 TDD。

**Files:**
- Create: `packages/ui/src/audio/streamPlayer.ts` + `packages/ui/test/streamPlayer.test.ts`

**Step 1: 写失败测试**

- [ ] `packages/ui/test/streamPlayer.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { StreamPlayer, type AudioBufferLike, type AudioContextLike, type AudioSourceLike } from '../src/audio/streamPlayer';

class FakeBuffer implements AudioBufferLike {
  data: Float32Array;
  constructor(length: number) { this.data = new Float32Array(length); }
  getChannelData(): Float32Array { return this.data; }
}

class FakeSource implements AudioSourceLike {
  buffer: AudioBufferLike | null = null;
  startedAt: number | null = null;
  stopped = false;
  connected = false;
  connect(): void { this.connected = true; }
  start(when: number): void { this.startedAt = when; }
  stop(): void { this.stopped = true; }
}

class FakeCtx implements AudioContextLike {
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  createBuffer(_ch: number, length: number): AudioBufferLike { return new FakeBuffer(length); }
  createBufferSource(): AudioSourceLike {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

// 2400 采样 = 100ms @24k；小端 int16
const chunk100ms = (): Uint8Array => new Uint8Array(4800);

describe('StreamPlayer (spec 5.3 边收边播)', () => {
  it('schedules chunks back-to-back via nextStartTime accumulation', () => {
    const ctx = new FakeCtx();
    const p = new StreamPlayer(ctx);
    p.enqueuePcm(chunk100ms());
    p.enqueuePcm(chunk100ms());
    expect(ctx.sources[0]!.startedAt).toBe(0);
    expect(ctx.sources[1]!.startedAt).toBeCloseTo(0.1, 5);
    expect(p.bufferedSeconds()).toBeCloseTo(0.2, 5);
    expect(ctx.sources.every((s) => s.connected)).toBe(true);
  });

  it('resumes from currentTime after the queue drained (断流不置负时间)', () => {
    const ctx = new FakeCtx();
    const p = new StreamPlayer(ctx);
    p.enqueuePcm(chunk100ms()); // 队列到 0.1s
    ctx.currentTime = 1.0; // 早已播完
    p.enqueuePcm(chunk100ms());
    expect(ctx.sources[1]!.startedAt).toBe(1.0);
    expect(p.bufferedSeconds()).toBeCloseTo(0.1, 5);
  });

  it('converts little-endian int16 to float32 [-1,1)', () => {
    const ctx = new FakeCtx();
    const p = new StreamPlayer(ctx);
    // 两个采样：16384 (0x4000) → 0.5；-32768 (0x8000) → -1
    p.enqueuePcm(new Uint8Array([0x00, 0x40, 0x00, 0x80]));
    const data = (ctx.sources[0]!.buffer as FakeBuffer).data;
    expect(data[0]).toBeCloseTo(0.5, 5);
    expect(data[1]).toBe(-1);
  });

  it('flush stops all pending sources and resets the queue', () => {
    const ctx = new FakeCtx();
    const p = new StreamPlayer(ctx);
    p.enqueuePcm(chunk100ms());
    p.enqueuePcm(chunk100ms());
    p.flush();
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(p.bufferedSeconds()).toBe(0);
  });

  it('ignores empty chunks', () => {
    const ctx = new FakeCtx();
    const p = new StreamPlayer(ctx);
    p.enqueuePcm(new Uint8Array(0));
    expect(ctx.sources.length).toBe(0);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/ui exec vitest run test/streamPlayer.test.ts` → 预期 FAIL：`Cannot find module '../src/audio/streamPlayer'`。

**Step 3: 最小实现**

- [ ] `packages/ui/src/audio/streamPlayer.ts`：

```ts
import { OUTPUT_SAMPLE_RATE } from '@livetranslate/core';

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioSourceLike {
  buffer: AudioBufferLike | null;
  connect(dest: unknown): void;
  start(when: number): void;
  stop(): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  destination: unknown;
  createBuffer(numChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioSourceLike;
}

// P9：模型输出 24k PCM16；每个 audio-delta 解码后入队，无缝连播
export class StreamPlayer {
  private nextStartTime = 0;
  private sources: AudioSourceLike[] = [];

  constructor(private ctx: AudioContextLike, private sampleRate: number = OUTPUT_SAMPLE_RATE) {}

  enqueuePcm(pcm: Uint8Array): void {
    const samples = Math.floor(pcm.length / 2);
    if (samples === 0) return;
    const buf = this.ctx.createBuffer(1, samples, this.sampleRate);
    const ch = buf.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime);
    src.start(startAt);
    this.nextStartTime = startAt + samples / this.sampleRate;
    this.sources.push(src);
  }

  bufferedSeconds(): number {
    return Math.max(0, this.nextStartTime - this.ctx.currentTime);
  }

  flush(): void {
    for (const s of this.sources) s.stop();
    this.sources = [];
    this.nextStartTime = 0;
  }
}
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/ui exec vitest run test/streamPlayer.test.ts` → 预期 `5 passed`。
- [ ] `git add packages/ui; git commit -m "feat(ui): web audio stream player queue for 24k pcm"`

## Task 28: 三步声道向导（收音/播音/回环自检）

spec §5.3：强制三步向导不可跳过——①选收音设备+实时音量条；②选播音设备+播放测试音；③回环自检：输出疑似扬声器（默认设备或名称含 speaker/扬声器）时红色警告，必须勾选“我已确认使用耳机”才能完成。纯逻辑（RMS、疑似扬声器判定、测试音生成）TDD，组件手工验证。

**Files:**
- Create: `packages/ui/src/audio/rms.ts` + `packages/ui/test/rms.test.ts`
- Create: `packages/ui/src/wizard/wizardRules.ts` + `packages/ui/test/wizardRules.test.ts`
- Create: `packages/ui/src/components/DevicePicker.tsx`、`packages/ui/src/components/VolumeMeter.tsx`、`packages/ui/src/wizard/ChannelWizard.tsx`
- Modify: `packages/ui/src/audio/micCapture.ts`（RMS 改用 rmsLevel）、`packages/ui/src/pages/InterpreterPage.tsx`（挂载向导）、`packages/ui/src/styles.css`

**Step 1: 写失败测试（纯逻辑）**

- [ ] `packages/ui/test/rms.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { rmsLevel } from '../src/audio/rms';

describe('rmsLevel', () => {
  it('returns 0 for empty input', () => {
    expect(rmsLevel(new Float32Array(0))).toBe(0);
  });

  it('returns 0 for silence', () => {
    expect(rmsLevel(new Float32Array(1024))).toBe(0);
  });

  it('returns the constant for a DC signal', () => {
    expect(rmsLevel(new Float32Array(256).fill(0.5))).toBeCloseTo(0.5, 6);
  });

  it('returns ~0.707 for a full-scale sine wave', () => {
    const f32 = new Float32Array(2400); // 100 个完整周期（1kHz @24k，周期 24 采样）
    for (let i = 0; i < f32.length; i++) f32[i] = Math.sin((2 * Math.PI * i) / 24);
    expect(rmsLevel(f32)).toBeCloseTo(Math.SQRT1_2, 3);
  });
});
```

- [ ] `packages/ui/test/wizardRules.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { isSuspectedSpeaker, makeTestTonePcm } from '../src/wizard/wizardRules';

describe('isSuspectedSpeaker (spec 5.3 回环自检)', () => {
  it('flags the system default output device', () => {
    expect(isSuspectedSpeaker({ deviceId: 'default', label: '默认 - 耳机 (WH-1000XM5)' })).toBe(true);
  });

  it('flags labels containing "speaker"', () => {
    expect(isSuspectedSpeaker({ deviceId: 'a1', label: 'Speakers (Realtek High Definition Audio)' })).toBe(true);
  });

  it('flags labels containing 扬声器', () => {
    expect(isSuspectedSpeaker({ deviceId: 'a2', label: '扬声器 (Realtek(R) Audio)' })).toBe(true);
  });

  it('passes explicit headphone devices', () => {
    expect(isSuspectedSpeaker({ deviceId: 'a3', label: '耳机 (WH-1000XM5 Stereo)' })).toBe(false);
  });
});

describe('makeTestTonePcm', () => {
  it('produces int16 mono pcm of the requested duration', () => {
    const pcm = makeTestTonePcm(1000, 100, 24000);
    expect(pcm.length).toBe(2400 * 2); // 100ms @24k，2 字节/采样
  });

  it('starts at zero crossing and peaks at 0.6 amplitude at quarter period', () => {
    const pcm = makeTestTonePcm(1000, 100, 24000); // 周期 = 24 采样，第 6 采样处 sin(π/2)=1
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(6 * 2, true)).toBeCloseTo(Math.round(0.6 * 32767), -1);
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/ui exec vitest run test/rms.test.ts test/wizardRules.test.ts` → 预期两个文件均 `Cannot find module`（`../src/audio/rms` / `../src/wizard/wizardRules` 不存在）。

**Step 3: 最小实现（纯逻辑）**

- [ ] `packages/ui/src/audio/rms.ts`：

```ts
// RMS 音量（0..1），供音量条与声道向导使用（spec §5.3）。
export function rmsLevel(f32: Float32Array): number {
  if (f32.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i]! * f32[i]!;
  return Math.sqrt(sum / f32.length);
}
```

- [ ] `packages/ui/src/wizard/wizardRules.ts`：

```ts
// 声道向导纯逻辑：不碰浏览器 API，可单测（spec §5.3 步骤③回环自检）。

// 判定输出设备疑似“外放扬声器”：系统默认设备（无法确认实体）或名称含 speaker/扬声器。
export function isSuspectedSpeaker(dev: { deviceId: string; label: string }): boolean {
  if (dev.deviceId === 'default') return true;
  return /speaker|扬声器/i.test(dev.label);
}

// 生成正弦测试音（0.6 幅度防爆音），PCM16 小端单声道，配合 pcm16ToWav 播放。
export function makeTestTonePcm(freqHz: number, durationMs: number, sampleRate: number): Uint8Array {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.6;
    view.setInt16(i * 2, Math.round(v * 32767), true);
  }
  return out;
}
```

- [ ] `packages/ui/src/audio/micCapture.ts` 中 node.port.onmessage 的 RMS 内联计算改用 rmsLevel（行为不变，消除重复）：

```ts
import { rmsLevel } from './rms';
// ……其余 import 不变

  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (paused) return;
    const f32 = e.data;
    if (opts.onLevel) opts.onLevel(rmsLevel(f32));
    chunker.push(downsampleTo16kPcm16(f32, ctx.sampleRate));
  };
```

**Step 4: 运行确认通过**

- [ ] `pnpm --filter @livetranslate/ui exec vitest run test/rms.test.ts test/wizardRules.test.ts` → 预期 `10 passed`（4 + 6）。

**Step 5: 向导组件实现**

- [ ] `packages/ui/src/components/DevicePicker.tsx`（enumerateDevices + devicechange 监听）：

```tsx
import { useEffect, useState } from 'react';

export function DevicePicker({ kind, value, onChange }: {
  kind: 'audioinput' | 'audiooutput';
  value: string;
  onChange: (deviceId: string, label: string) => void;
}): JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (alive) setDevices(all.filter((d) => d.kind === kind));
    };
    void refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
    };
  }, [kind]);
  return (
    <select
      className="device-picker"
      value={value}
      onChange={(e) => {
        const dev = devices.find((d) => d.deviceId === e.target.value);
        onChange(e.target.value, dev?.label ?? '');
      }}
    >
      <option value="">请选择设备…</option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>{d.label || `设备 ${d.deviceId.slice(0, 8)}`}</option>
      ))}
    </select>
  );
}
```

- [ ] `packages/ui/src/components/VolumeMeter.tsx`：

```tsx
export function VolumeMeter({ level }: { level: number }): JSX.Element {
  const pct = Math.min(100, Math.round(level * 300)); // RMS 0.33 即满格，正常说话可见摆动
  return (
    <div className="volume-meter">
      <div className="volume-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
```

- [ ] `packages/ui/src/wizard/ChannelWizard.tsx`（三步强制门控：①音量条动过→②测试音播过→③疑似扬声器必须勾选）：

```tsx
import { useEffect, useRef, useState } from 'react';
import { OUTPUT_SAMPLE_RATE, pcm16ToWav } from '@livetranslate/core';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { createPlayerSink } from '../audio/playerSink';
import { DevicePicker } from '../components/DevicePicker';
import { VolumeMeter } from '../components/VolumeMeter';
import { isSuspectedSpeaker, makeTestTonePcm } from './wizardRules';

export interface ChannelChoice {
  inputDeviceId: string;
  outputDeviceId: string;
}

// 三步强制向导：任何一步未达标不得进入运行界面（spec §5.3）。
export function ChannelWizard({ onComplete }: { onComplete: (choice: ChannelChoice) => void }): JSX.Element {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [inputId, setInputId] = useState('');
  const [outputId, setOutputId] = useState('');
  const [outputLabel, setOutputLabel] = useState('');
  const [level, setLevel] = useState(0);
  const [hasSignal, setHasSignal] = useState(false);   // 步骤①：音量条动过才算通过
  const [toneTested, setToneTested] = useState(false); // 步骤②：至少播过一次测试音
  const [headphoneConfirmed, setHeadphoneConfirmed] = useState(false); // 步骤③强制勾选
  const captureRef = useRef<MicCaptureHandle | null>(null);
  const sinkRef = useRef(createPlayerSink());

  // 步骤①：选中设备即启动采集，实时驱动音量条（向导阶段不推流）
  useEffect(() => {
    if (!inputId) return;
    let cancelled = false;
    void startMicCapture({
      deviceId: inputId,
      onChunk: () => {},
      onLevel: (rms) => {
        if (cancelled) return;
        setLevel(rms);
        if (rms > 0.01) setHasSignal(true);
      },
    }).then((h) => {
      if (cancelled) h.stop();
      else captureRef.current = h;
    });
    return () => {
      cancelled = true;
      captureRef.current?.stop();
      captureRef.current = null;
    };
  }, [inputId]);

  const playTestTone = async (): Promise<void> => {
    await sinkRef.current.setSink(outputId);
    await sinkRef.current.play(pcm16ToWav(makeTestTonePcm(440, 600, OUTPUT_SAMPLE_RATE), OUTPUT_SAMPLE_RATE));
    setToneTested(true);
  };

  const suspected = isSuspectedSpeaker({ deviceId: outputId, label: outputLabel });
  const finish = (): void => {
    captureRef.current?.stop();
    captureRef.current = null;
    onComplete({ inputDeviceId: inputId, outputDeviceId: outputId });
  };

  return (
    <div className="wizard">
      {step === 1 && (
        <section className="wizard-step">
          <h2>① 选择收音设备</h2>
          <DevicePicker kind="audioinput" value={inputId} onChange={(id) => { setInputId(id); setHasSignal(false); }} />
          <VolumeMeter level={level} />
          <p className="hint">对着话筒说话，看到音量条摆动即可继续。</p>
          <button disabled={!inputId || !hasSignal} onClick={() => setStep(2)}>下一步</button>
        </section>
      )}
      {step === 2 && (
        <section className="wizard-step">
          <h2>② 选择播音设备</h2>
          <DevicePicker kind="audiooutput" value={outputId} onChange={(id, label) => { setOutputId(id); setOutputLabel(label); setToneTested(false); }} />
          <button disabled={!outputId} onClick={() => { void playTestTone(); }}>播放测试音</button>
          <p className="hint">应从所选设备听到 0.6 秒提示音。</p>
          <button disabled={!outputId || !toneTested} onClick={() => setStep(3)}>下一步</button>
        </section>
      )}
      {step === 3 && (
        <section className="wizard-step">
          <h2>③ 回环自检</h2>
          <p>收音：{inputId}</p>
          <p>播音：{outputLabel || outputId}</p>
          {suspected && (
            <div className="warn-box">
              <p className="error-text">输出设备疑似外放扬声器：翻译语音会被话筒重新拾取，造成回环自翻译。</p>
              <label>
                <input type="checkbox" checked={headphoneConfirmed} onChange={(e) => setHeadphoneConfirmed(e.target.checked)} />
                我已确认使用耳机
              </label>
            </div>
          )}
          <button disabled={suspected && !headphoneConfirmed} onClick={finish}>完成，进入运行界面</button>
        </section>
      )}
    </div>
  );
}
```

- [ ] `packages/ui/src/pages/InterpreterPage.tsx`（向导版：完成后先展示选择结果，Task 29 在此基础上接运行界面）：

```tsx
import { useState } from 'react';
import { ChannelWizard, type ChannelChoice } from '../wizard/ChannelWizard';

export function InterpreterPage(): JSX.Element {
  const [choice, setChoice] = useState<ChannelChoice | null>(null);
  if (!choice) return <ChannelWizard onComplete={setChoice} />;
  return (
    <div>
      <h2>实时翻译机</h2>
      <p>收音设备：{choice.inputDeviceId}</p>
      <p>播音设备：{choice.outputDeviceId}</p>
    </div>
  );
}
```

- [ ] `packages/ui/src/styles.css` 追加：

```css
.wizard { max-width: 560px; margin: 40px auto; }
.wizard-step { display: flex; flex-direction: column; gap: 12px; }
.device-picker { padding: 6px; }
.volume-meter { height: 12px; background: #222; border-radius: 6px; overflow: hidden; }
.volume-fill { height: 100%; background: #4caf50; transition: width 80ms linear; }
.warn-box { border: 1px solid #d33; background: rgba(221, 51, 51, 0.12); padding: 12px; border-radius: 6px; }
.hint { color: #999; font-size: 13px; }
```

**Step 6: 手工验证**

- [ ] `pnpm --filter @livetranslate/web dev`，浏览器开 `http://localhost:5173/#/interpreter`：
  - 步骤①：未选设备时“下一步”置灰；选中麦克风后浏览器弹权限请求，允许后对着话筒说话，音量条绿色摆动，“下一步”变为可点；保持安静则始终置灰。
  - 步骤②：选择输出设备后点“播放测试音”，从该设备听到 440Hz 提示音；未播放前“下一步”置灰。
  - 步骤③：选“默认设备”或名称含“扬声器/Speakers”的设备 → 红色警告框出现，“完成”置灰；勾选“我已确认使用耳机”后可点；选名称含“耳机”的非默认设备 → 无警告直接可完成。
  - 完成后页面显示两个设备 ID；刷新页面重新进入向导（不持久化，每次会话强制重走，spec §5.3）。
- [ ] 回归：`pnpm --filter @livetranslate/ui exec vitest run` → 预期全部通过（含既有 micCapture 相关套件不受重构影响）。

**Step 7: Commit**

- [ ] `git add packages/ui; git commit -m "feat(ui): mandatory three-step channel wizard with loopback warning"`

## Task 29: 实时翻译机运行界面（全屏字幕 + 流式播放，M4 出口）

spec §5.3：向导完成后进入运行界面——全屏大字号双语字幕（原文小灰 + 译文大白，text/stash 覆盖渲染 P4），译文 24k PCM 边收边播（T27 StreamPlayer），顶部暂停/结束/通道指示/首字延迟。音色复刻默认 once（P10：复刻时 voice 必须 "default"）。M4 仅 WS 通道，浏览器侧开 AEC/NS 兑底回声（D6）；Task 34 只换 transportFactory，页面不再改。目标语言不支持音频时预禁用启动（spec §6.5）。

**Files:**
- Modify: `packages/ui/src/pages/InterpreterPage.tsx`（整文件重写，替换 T28 向导版展示页）、`packages/ui/src/styles.css`

**Step 1: 实现**

- [ ] `packages/ui/src/pages/InterpreterPage.tsx` 整文件重写：

```tsx
import { useEffect, useRef, useState } from 'react';
import {
  LANGUAGES, OUTPUT_SAMPLE_RATE, SessionOrchestrator, UsageMeter, WsTransport,
  base64ToBytes, supportsAudioOutput,
  type NormalizedEvent, type OrchestratorState, type SessionConfig, type TranscriptSegment,
} from '@livetranslate/core';
import { getPlatform } from '../platform';
import { browserWsFactory } from '../wsFactory';
import { createGatewayApi, createSessionRecord, finishSessionRecord, postSegmentRecord } from '../api';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { StreamPlayer } from '../audio/streamPlayer';
import { ChannelWizard, type ChannelChoice } from '../wizard/ChannelWizard';

export function InterpreterPage(): JSX.Element {
  const [choice, setChoice] = useState<ChannelChoice | null>(null); // 每次进页强制重走向导（spec §5.3）
  const [state, setState] = useState<OrchestratorState>('idle');
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [useClone, setUseClone] = useState(true); // 默认 once 复刻
  const [defaultVoice, setDefaultVoice] = useState('Tina');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [segments, setSegments] = useState<readonly TranscriptSegment[]>([]);

  const orchRef = useRef<SessionOrchestrator | null>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);
  const playerRef = useRef<StreamPlayer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const speechStartedAtRef = useRef<number | null>(null);
  const meterRef = useRef(new UsageMeter());

  useEffect(() => {
    void createGatewayApi().getSettings().then((r) => {
      setSourceLanguage(r.settings.sourceLanguage || 'auto');
      setTargetLanguage(r.settings.targetLanguage || 'en');
      setDefaultVoice(r.settings.defaultVoice || 'Tina');
    });
  }, []);

  function buildConfig(): SessionConfig {
    return {
      modalities: ['text', 'audio'], // 实时翻译机必须放音
      voice: useClone ? 'default' : defaultVoice, // P10：复刻时 voice 必须 "default"
      ...(useClone ? { enable_voice_clone: true, voice_clone_options: { frequency: 'once' as const } } : {}),
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: {
        model: 'qwen3-asr-flash-realtime',
        ...(sourceLanguage !== 'auto' ? { language: sourceLanguage } : {}),
      },
      translation: { language: targetLanguage },
    };
  }

  function persistDoneSegment(responseId: string): void {
    const sessionId = sessionIdRef.current;
    const seg = orchRef.current?.model.getSegments().find((s) => s.responseId === responseId);
    if (!sessionId || !seg) return;
    void postSegmentRecord({
      sessionId, seq: seg.seq, vadStartMs: seg.vadStartMs, vadEndMs: seg.vadEndMs,
      sourceText: seg.sourceText, targetText: seg.targetText,
      sourceLang: seg.sourceLang, emotion: seg.emotion,
      usageJson: seg.usage ? JSON.stringify(seg.usage) : null,
      // 实时模式不逐段存 WAV：音频已实时播出，历史页仅回看文本（§6.6 事件日志由网关中继自动落盘）
    });
  }

  function handleEvent(ev: NormalizedEvent): void {
    if (ev.kind === 'session-created') {
      sessionIdRef.current = ev.sessionId; // 与 relay 日志文件同键
      void createSessionRecord({ id: ev.sessionId, mode: 'interpreter', configJson: JSON.stringify(buildConfig()), startedAt: Date.now() });
    }
    if (ev.kind === 'speech-started') speechStartedAtRef.current = Date.now();
    if (ev.kind === 'translation-delta' && speechStartedAtRef.current !== null) {
      setLatencyMs(Date.now() - speechStartedAtRef.current); // 顶部延迟指示器：当前段首字延迟
      speechStartedAtRef.current = null;
    }
    if (ev.kind === 'audio-delta') playerRef.current?.enqueuePcm(base64ToBytes(ev.base64)); // T27 边收边播
    if (ev.kind === 'response-done') {
      if (ev.usage) meterRef.current.applyUsage(ev.usage); // P6 差分累计，结束时落盘
      persistDoneSegment(ev.responseId);
    }
  }

  async function start(): Promise<void> {
    if (!choice) return;
    const ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE }); // P9：输出 24kHz
    const sinkable = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (sinkable.setSinkId) await sinkable.setSinkId(choice.outputDeviceId); // 向导选定的播音设备
    ctxRef.current = ctx;
    playerRef.current = new StreamPlayer(ctx);
    const orch = new SessionOrchestrator({
      config: buildConfig(),
      transportFactory: () => new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory }),
      onStateChange: setState,
      onEvent: handleEvent,
    });
    orch.model.onChange(() => setSegments(orch.model.getSegments()));
    orchRef.current = orch;
    meterRef.current = new UsageMeter();
    setLatencyMs(null);
    await orch.start();
    // D6：M4 仅 WS 通道，浏览器侧 AEC/NS 兑底回声
    micRef.current = await startMicCapture({
      deviceId: choice.inputDeviceId,
      echoCancellation: true,
      onChunk: (b) => orch.pushAudio(b),
    });
  }

  function pause(): void {
    micRef.current?.pause();
    orchRef.current?.pause(); // R4：保连接停推流
    playerRef.current?.flush(); // 暂停立即静音，不留残余队列
  }

  function resume(): void {
    micRef.current?.resume();
    orchRef.current?.resume();
  }

  async function stop(): Promise<void> {
    micRef.current?.stop();
    micRef.current = null;
    await orchRef.current?.stop(); // P3：finish → finished → 客户端 close（内部置 state='idle'）
    playerRef.current?.flush();
    playerRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      await finishSessionRecord({ id: sessionId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    }
    sessionIdRef.current = null;
  }

  if (!choice) return <ChannelWizard onComplete={setChoice} />;

  const running = state === 'running' || state === 'paused' || state === 'reconnecting';
  if (!running) {
    const audioOk = supportsAudioOutput(targetLanguage);
    return (
      <div className="page-body">
        <h2>实时翻译机</h2>
        <p className="hint">
          收音：{choice.inputDeviceId.slice(0, 8)}… ｜ 播音：{choice.outputDeviceId.slice(0, 8)}…
          <button onClick={() => setChoice(null)}>重新配置声道</button>
        </p>
        <label>源语言
          <select value={sourceLanguage} onChange={(e) => setSourceLanguage(e.target.value)}>
            <option value="auto">自动检测</option>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <label>目标语言
          <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={useClone} onChange={(e) => setUseClone(e.target.checked)} />
          复刻我的音色（首句采样，once）
        </label>
        {!audioOk && <p className="error-text">该目标语言仅支持文本输出，无法启动实时翻译机，请改选支持语音的语言。</p>}
        {state === 'error' && <p className="error-text">重连失败，请检查网络后重新开始。</p>}
        <button disabled={!audioOk} onClick={() => void start()}>开始翻译</button>
      </div>
    );
  }

  const latest = segments[segments.length - 1];
  return (
    <div className="interpreter-fullscreen">
      <header className="interpreter-topbar">
        <span className="channel-badge">{orchRef.current?.transport?.kind === 'webrtc' ? 'WebRTC' : 'WS'}</span>
        <span>首字延迟：{latencyMs === null ? '—' : `${latencyMs}ms`}</span>
        {state === 'running' && <button onClick={pause}>暂停</button>}
        {state === 'paused' && <button onClick={resume}>恢复</button>}
        <button onClick={() => void stop()}>结束</button>
        {state === 'reconnecting' && <span className="warn-banner">连接中断，正在重连……</span>}
      </header>
      <main className="subtitle-area">
        {latest ? (
          <>
            <p className="subtitle-source">
              {latest.sourceText}
              {latest.sourceStash && <span className="stash">{latest.sourceStash}</span>}
            </p>
            <p className="subtitle-target">
              {latest.targetText}
              {latest.targetStash && <span className="stash">{latest.targetStash}</span>}
            </p>
          </>
        ) : (
          <p className="subtitle-source">请开始说话……</p>
        )}
      </main>
    </div>
  );
}
```

- [ ] `packages/ui/src/styles.css` 追加：

```css
.interpreter-fullscreen { position: fixed; inset: 0; background: #000; display: flex; flex-direction: column; z-index: 10; }
.interpreter-topbar { display: flex; gap: 16px; align-items: center; padding: 12px 16px; color: #aaa; }
.channel-badge { border: 1px solid #555; border-radius: 4px; padding: 2px 8px; font-size: 12px; }
.subtitle-area { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 0 8vw; gap: 24px; }
.subtitle-source { color: #888; font-size: 22px; }
.subtitle-target { color: #fff; font-size: 44px; line-height: 1.4; }
```

（`.stash` 浅灰斜体样式已在 Task 10 全局定义，字幕区直接复用，体现 P4 覆盖渲染：text 正常色、stash 可回撤部分浅色。）

**Step 2: 手工验证（M4 出口标准，spec §8）**

- [ ] 网关已配真实 Key，`pnpm --filter @livetranslate/web dev`，打开 `http://localhost:5173/#/interpreter`：
  - 先完成三步向导（T28）；完成后进入配置页，默认勾选“复刻我的音色”。
  - 目标语言选一个仅文本语种（如波斯语 fa）→ 红色提示出现且“开始翻译”置灰；改回英语后可点。
  - 点“开始翻译”后进入全屏黑幕：对着话筒说中文，原文小灰字逐渐出现（stash 部分斜体且会回撤重写，P4），译文大白字跟随；耳机中听到连续译文语音（复刻音色与本人相似），无明显卡顿拼接痕迹。
  - 顶部通道指示显示 WS；首字延迟每段刷新（实测应在数百 ms 量级）。
  - 点“暂停”：声音立即停、字幕不再变化；“恢复”后继续。
  - 点“结束”：回到配置页；历史页出现 mode=interpreter 的会话，段落文本完整；`{dataDir}/logs/sessions/{sessionId}.jsonl` 存在（§6.6 由 relay 自动落盘）。
  - 断网测试：断开 Wi-Fi 再恢复 → 顶部出现“正在重连”，恢复后继续可用（R3）。
- [ ] 回归：`pnpm --filter @livetranslate/ui exec vitest run` → 预期全部通过。

**Step 3: Commit**

- [ ] `git add packages/ui; git commit -m "feat(ui): interpreter fullscreen subtitles with streaming voice-clone playback (M4 exit)"`

# Milestone 5：会议模式

## Task 30: 热座状态机 MeetingCoordinator

spec §5.4：idle→speaking→translating→playing→idle；VAD 静音 ≥3s 自动结束发言；translating/playing 中按下无效；跳过播放按钮。注入 schedule（假时钟），纯逻辑 TDD。

**Files:**
- Create: `packages/core/src/meeting/meetingCoordinator.ts` + `packages/core/test/meetingCoordinator.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试**

- [ ] `packages/core/test/meetingCoordinator.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { MeetingCoordinator, SILENCE_END_MS } from '../src/meeting/meetingCoordinator';

// 可推进的假调度器：与 DubPlaybackDeps.schedule 同约定（返回取消函数）
class FakeScheduler {
  now = 0;
  private tasks: Array<{ cb: () => void; at: number; cancelled: boolean }> = [];
  schedule = (cb: () => void, delayMs: number): (() => void) => {
    const task = { cb, at: this.now + delayMs, cancelled: false };
    this.tasks.push(task);
    return () => { task.cancelled = true; };
  };
  advance(ms: number): void {
    this.now += ms;
    for (const t of this.tasks) {
      if (!t.cancelled && t.at <= this.now) { t.cancelled = true; t.cb(); }
    }
  }
}

function setup() {
  const clock = new FakeScheduler();
  const transitions: string[] = [];
  const coord = new MeetingCoordinator({
    schedule: clock.schedule,
    onStateChange: (s, speaker) => transitions.push(`${s}:${speaker ?? '-'}`),
  });
  return { clock, coord, transitions };
}

describe('MeetingCoordinator (spec 5.4 热座)', () => {
  it('walks the full hot-seat cycle idle→speaking→translating→playing→idle', () => {
    const { coord, transitions } = setup();
    expect(coord.requestSpeak('Alice')).toBe(true);
    coord.endSpeech();
    coord.notePlaybackStarted();
    coord.notePlaybackFinished();
    expect(transitions).toEqual(['speaking:Alice', 'translating:Alice', 'playing:Alice', 'idle:-']);
    expect(coord.speaker).toBeNull();
  });

  it('rejects requestSpeak while someone is speaking', () => {
    const { coord } = setup();
    coord.requestSpeak('Alice');
    expect(coord.requestSpeak('Bob')).toBe(false);
    expect(coord.speaker).toBe('Alice');
  });

  it('rejects requestSpeak during playing (按下无效)', () => {
    const { coord } = setup();
    coord.requestSpeak('Alice');
    coord.endSpeech();
    coord.notePlaybackStarted();
    expect(coord.requestSpeak('Bob')).toBe(false);
    expect(coord.state).toBe('playing');
  });

  it('auto-ends speech after 3s of VAD silence', () => {
    const { clock, coord } = setup();
    coord.requestSpeak('Alice');
    coord.noteSpeechStopped();
    clock.advance(SILENCE_END_MS - 1);
    expect(coord.state).toBe('speaking');
    clock.advance(1);
    expect(coord.state).toBe('translating');
  });

  it('cancels the silence timer when speech resumes', () => {
    const { clock, coord } = setup();
    coord.requestSpeak('Alice');
    coord.noteSpeechStopped();
    clock.advance(2000);
    coord.noteSpeechStarted(); // 发言人继续说话
    clock.advance(5000);
    expect(coord.state).toBe('speaking');
  });

  it('skipPlayback releases the seat immediately', () => {
    const { coord } = setup();
    coord.requestSpeak('Alice');
    coord.endSpeech();
    coord.notePlaybackStarted();
    coord.skipPlayback();
    expect(coord.state).toBe('idle');
    expect(coord.speaker).toBeNull();
  });

  it('ignores playback events outside their source states', () => {
    const { coord } = setup();
    coord.notePlaybackStarted(); // idle 中无效
    coord.notePlaybackFinished();
    expect(coord.state).toBe('idle');
    coord.requestSpeak('Alice');
    coord.notePlaybackFinished(); // speaking 中无效
    expect(coord.state).toBe('speaking');
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/meetingCoordinator.test.ts` → 预期 FAIL：`Cannot find module '../src/meeting/meetingCoordinator'`。

**Step 3: 最小实现**

- [ ] `packages/core/src/meeting/meetingCoordinator.ts`：

```ts
export type HotSeatState = 'idle' | 'speaking' | 'translating' | 'playing';

export const SILENCE_END_MS = 3000; // spec §5.4：VAD 静音 ≥3s 自动结束发言

export interface CoordinatorDeps {
  schedule(cb: () => void, delayMs: number): () => void; // 返回取消函数；生产用 setTimeout/clearTimeout
  onStateChange?(state: HotSeatState, speaker: string | null): void;
}

export class MeetingCoordinator {
  state: HotSeatState = 'idle';
  speaker: string | null = null;
  private cancelSilence: (() => void) | null = null;

  constructor(private deps: CoordinatorDeps) {}

  private setState(s: HotSeatState): void {
    this.state = s;
    this.deps.onStateChange?.(s, this.speaker);
  }

  private clearSilenceTimer(): void {
    this.cancelSilence?.();
    this.cancelSilence = null;
  }

  // 热座抢占：仅 idle 可上座；translating/playing 中按下无效（spec §5.4）
  requestSpeak(name: string): boolean {
    if (this.state !== 'idle') return false;
    this.speaker = name;
    this.setState('speaking');
    return true;
  }

  noteSpeechStarted(): void {
    if (this.state !== 'speaking') return;
    this.clearSilenceTimer();
  }

  noteSpeechStopped(): void {
    if (this.state !== 'speaking') return;
    this.clearSilenceTimer();
    this.cancelSilence = this.deps.schedule(() => this.endSpeech(), SILENCE_END_MS);
  }

  // 手动结束发言或静音超时
  endSpeech(): void {
    if (this.state !== 'speaking') return;
    this.clearSilenceTimer();
    this.setState('translating');
  }

  notePlaybackStarted(): void {
    if (this.state !== 'translating') return;
    this.setState('playing');
  }

  notePlaybackFinished(): void {
    if (this.state !== 'playing') return;
    this.speaker = null;
    this.setState('idle');
  }

  // spec §5.4：跳过播放按钮，立即释放热座
  skipPlayback(): void {
    if (this.state !== 'playing') return;
    this.speaker = null;
    this.setState('idle');
  }
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { MeetingCoordinator, SILENCE_END_MS, type CoordinatorDeps, type HotSeatState } from './meeting/meetingCoordinator';
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/meetingCoordinator.test.ts` → 预期 `7 passed`。
- [ ] `git add packages/core; git commit -m "feat(core): hot-seat meeting coordinator state machine (spec 5.4)"`

## Task 31: session 轮换判定 rotationPolicy

spec §5.4 + P13：输入 token 累计 >40000、会话异常、暂停超 10 分钟 → 轮换新 session。纯函数 TDD。

**Files:**
- Create: `packages/core/src/session/rotationPolicy.ts` + `packages/core/test/rotationPolicy.test.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: 写失败测试**

- [ ] `packages/core/test/rotationPolicy.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ROTATE_INPUT_TOKENS, ROTATE_PAUSE_MS, shouldRotate } from '../src/session/rotationPolicy';

describe('shouldRotate (spec 5.4 / P13)', () => {
  it('keeps the session at exactly 40000 input tokens', () => {
    expect(shouldRotate({ sessionInputTokens: ROTATE_INPUT_TOKENS, hadError: false, pausedSinceMs: null, now: 0 })).toBeNull();
  });

  it('rotates above 40000 input tokens', () => {
    expect(shouldRotate({ sessionInputTokens: ROTATE_INPUT_TOKENS + 1, hadError: false, pausedSinceMs: null, now: 0 })).toBe('tokens');
  });

  it('error takes precedence over token count', () => {
    expect(shouldRotate({ sessionInputTokens: 50000, hadError: true, pausedSinceMs: null, now: 0 })).toBe('error');
  });

  it('rotates after a pause longer than 10 minutes', () => {
    expect(shouldRotate({ sessionInputTokens: 0, hadError: false, pausedSinceMs: 0, now: ROTATE_PAUSE_MS + 1 })).toBe('paused');
  });

  it('keeps the session for short pauses', () => {
    expect(shouldRotate({ sessionInputTokens: 0, hadError: false, pausedSinceMs: 0, now: ROTATE_PAUSE_MS - 1 })).toBeNull();
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/rotationPolicy.test.ts` → 预期 FAIL：`Cannot find module '../src/session/rotationPolicy'`。

**Step 3: 最小实现**

- [ ] `packages/core/src/session/rotationPolicy.ts`：

```ts
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
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { ROTATE_INPUT_TOKENS, ROTATE_PAUSE_MS, shouldRotate, type RotationInput, type RotationReason } from './session/rotationPolicy';
```

**Step 4: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/rotationPolicy.test.ts` → 预期 `5 passed`。
- [ ] `git add packages/core; git commit -m "feat(core): session rotation policy for token, error and pause limits (P13)"`

## Task 32: 会议落库（meetings/meeting_turns）+ 网关路由

spec §6.2：meetings/meeting_turns 表已在 Task 16 的 db.ts schema 中建好（turn 通过 session_id+seq 关联 segments 取双语文本，不重复存文本）。本任务补 Storage 方法与 REST 路由。

**Files:**
- Modify: `packages/gateway/src/storage.ts`（追加会议方法）、`packages/gateway/test/storage.test.ts`（追加用例）、`packages/gateway/src/server.ts`（注册路由）
- Create: `packages/gateway/src/meetingRoutes.ts` + `packages/gateway/test/meetingRoutes.test.ts`

**Step 1: 写失败测试（storage 追加）**

- [ ] `packages/gateway/test/storage.test.ts` 追加：

```ts
describe('meeting storage (spec 6.2)', () => {
  it('creates meetings and joins turns with segment texts', () => {
    storage.createMeeting({ id: 'm1', rosterJson: JSON.stringify(['Alice', 'Bob']), targetLanguage: 'en', createdAt: 1753668000000 });
    expect(storage.getMeeting('m1')?.target_language).toBe('en');
    expect(storage.listMeetings().map((m) => m.id)).toEqual(['m1']);

    storage.createSession({ id: 'sess_mt_1', mode: 'meeting', configJson: '{}', startedAt: 1753668000000 });
    storage.insertSegment({
      sessionId: 'sess_mt_1', seq: 1, vadStartMs: 0, vadEndMs: 4600,
      sourceText: '今天天气很好，我们一起去公园散步。',
      targetText: "The weather is very nice today, let's go for a walk in the park together.  ",
      sourceLang: 'zh', emotion: 'neutral', audioPath: null, usageJson: null,
    });
    storage.addMeetingTurn({ meetingId: 'm1', speaker: 'Alice', sessionId: 'sess_mt_1', seq: 1 });

    const turns = storage.listMeetingTurnTexts('m1');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.speaker).toBe('Alice');
    expect(turns[0]!.source_text).toBe('今天天气很好，我们一起去公园散步。');
    expect(turns[0]!.source_lang).toBe('zh');
  });

  it('returns null for an unknown meeting', () => {
    expect(storage.getMeeting('nope')).toBeNull();
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/storage.test.ts` → 预期 FAIL：`storage.createMeeting is not a function`。

**Step 3: 最小实现（storage 追加）**

- [ ] `packages/gateway/src/storage.ts` 追加行类型与方法（Storage 类内，getMediaJob 之后）：

```ts
export interface MeetingRow {
  id: string;
  roster_json: string;
  target_language: string;
  created_at: number;
}

export interface MeetingTurnRow {
  id: number;
  meeting_id: string;
  speaker: string;
  session_id: string;
  seq: number;
}

export interface MeetingTurnText {
  speaker: string;
  source_text: string;
  target_text: string;
  source_lang: string | null;
}

  createMeeting(input: { id: string; rosterJson: string; targetLanguage: string; createdAt: number }): void {
    this.db.prepare('INSERT INTO meetings (id, roster_json, target_language, created_at) VALUES (?, ?, ?, ?)')
      .run(input.id, input.rosterJson, input.targetLanguage, input.createdAt);
  }

  getMeeting(id: string): MeetingRow | null {
    return (this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as MeetingRow | undefined) ?? null;
  }

  listMeetings(): MeetingRow[] {
    return this.db.prepare('SELECT * FROM meetings ORDER BY created_at DESC').all() as MeetingRow[];
  }

  addMeetingTurn(input: { meetingId: string; speaker: string; sessionId: string; seq: number }): void {
    this.db.prepare('INSERT INTO meeting_turns (meeting_id, speaker, session_id, seq) VALUES (?, ?, ?, ?)')
      .run(input.meetingId, input.speaker, input.sessionId, input.seq);
  }

  // 发言文本不重复存：JOIN segments 取双语内容（session 轮换后仍能跨 session 拼回全场记录）
  listMeetingTurnTexts(meetingId: string): MeetingTurnText[] {
    return this.db.prepare(`
      SELECT mt.speaker, s.source_text, s.target_text, s.source_lang
      FROM meeting_turns mt
      JOIN segments s ON s.session_id = mt.session_id AND s.seq = mt.seq
      WHERE mt.meeting_id = ?
      ORDER BY mt.id
    `).all(meetingId) as MeetingTurnText[];
  }
```

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/storage.test.ts` → 预期全部通过（含既有用例）。

**Step 4: 路由写失败测试**

- [ ] `packages/gateway/test/meetingRoutes.test.ts`：

```ts
import { mkdtempSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import { registerMeetingRoutes } from '../src/meetingRoutes';
import type { RouteHandler } from '../src/server';
import { Storage } from '../src/storage';

function fakeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  const res = {
    writeHead: (code: number) => { statusCode = code; return res; },
    end: (data?: string) => { if (data !== undefined) chunks.push(data); },
  } as unknown as ServerResponse;
  return { res, json: () => JSON.parse(chunks.join('')) as Record<string, unknown>, status: () => statusCode };
}

const fakeReq = (url: string) => ({ url }) as never;

let storage: Storage;
let routes: Map<string, RouteHandler>;

beforeEach(() => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lt-meeting-'));
  storage = new Storage(openDb(join(dataDir, 'app.db')), dataDir);
  routes = new Map();
  registerMeetingRoutes(routes, { storage });
});

describe('meeting routes', () => {
  it('creates a meeting and lists it', async () => {
    const create = fakeRes();
    await routes.get('POST /meetings')!(fakeReq('/meetings'), create.res,
      JSON.stringify({ id: 'm1', roster: ['Alice', 'Bob'], targetLanguage: 'en', createdAt: 1753668000000 }));
    expect(create.status()).toBe(200);

    const list = fakeRes();
    await routes.get('GET /meetings')!(fakeReq('/meetings'), list.res, '');
    const meetings = list.json().meetings as Array<{ id: string; roster_json: string }>;
    expect(meetings[0]!.id).toBe('m1');
    expect(JSON.parse(meetings[0]!.roster_json)).toEqual(['Alice', 'Bob']);
  });

  it('records turns and returns joined texts', async () => {
    storage.createMeeting({ id: 'm2', rosterJson: '["Alice"]', targetLanguage: 'en', createdAt: 1 });
    storage.createSession({ id: 'sess_mt_2', mode: 'meeting', configJson: '{}', startedAt: 1 });
    storage.insertSegment({
      sessionId: 'sess_mt_2', seq: 3, vadStartMs: 0, vadEndMs: 4600,
      sourceText: '大家好。', targetText: 'Hello everyone.', sourceLang: 'zh', emotion: 'neutral',
      audioPath: null, usageJson: null,
    });

    const post = fakeRes();
    await routes.get('POST /meeting-turns')!(fakeReq('/meeting-turns'), post.res,
      JSON.stringify({ meetingId: 'm2', speaker: 'Alice', sessionId: 'sess_mt_2', seq: 3 }));
    expect(post.status()).toBe(200);

    const get = fakeRes();
    await routes.get('GET /meeting-turns')!(fakeReq('/meeting-turns?meetingId=m2'), get.res, '');
    const turns = get.json().turns as Array<{ speaker: string; target_text: string }>;
    expect(turns).toEqual([{ speaker: 'Alice', source_text: '大家好。', target_text: 'Hello everyone.', source_lang: 'zh' }]);
  });

  it('404s for an unknown meeting', async () => {
    const get = fakeRes();
    await routes.get('GET /meeting')!(fakeReq('/meeting?id=nope'), get.res, '');
    expect(get.status()).toBe(404);
  });
});
```

**Step 5: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/meetingRoutes.test.ts` → 预期 FAIL：`Cannot find module '../src/meetingRoutes'`。

**Step 6: 最小实现（路由）**

- [ ] `packages/gateway/src/meetingRoutes.ts`：

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from './server';
import type { Storage } from './storage';

export interface MeetingDeps {
  storage: Storage;
}

const json = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const query = (req: IncomingMessage): URLSearchParams =>
  new URL(req.url ?? '/', 'http://localhost').searchParams;

export function registerMeetingRoutes(routes: Map<string, RouteHandler>, deps: MeetingDeps): void {
  routes.set('POST /meetings', (_req, res, body) => {
    const b = JSON.parse(body) as { id: string; roster: string[]; targetLanguage: string; createdAt: number };
    deps.storage.createMeeting({
      id: b.id, rosterJson: JSON.stringify(b.roster), targetLanguage: b.targetLanguage, createdAt: b.createdAt,
    });
    json(res, 200, { meeting: deps.storage.getMeeting(b.id) });
  });

  routes.set('GET /meetings', (_req, res) => {
    json(res, 200, { meetings: deps.storage.listMeetings() });
  });

  routes.set('GET /meeting', (req, res) => {
    const meeting = deps.storage.getMeeting(query(req).get('id') ?? '');
    if (!meeting) {
      json(res, 404, { error: 'meeting_not_found' });
      return;
    }
    json(res, 200, { meeting });
  });

  routes.set('POST /meeting-turns', (_req, res, body) => {
    const b = JSON.parse(body) as { meetingId: string; speaker: string; sessionId: string; seq: number };
    deps.storage.addMeetingTurn({ meetingId: b.meetingId, speaker: b.speaker, sessionId: b.sessionId, seq: b.seq });
    json(res, 200, { ok: true });
  });

  routes.set('GET /meeting-turns', (req, res) => {
    json(res, 200, { turns: deps.storage.listMeetingTurnTexts(query(req).get('meetingId') ?? '') });
  });
}
```

- [ ] `packages/gateway/src/server.ts` 在 `registerExportRoutes(routes, { storage });` 后追加：

```ts
registerMeetingRoutes(routes, { storage });
```

（文件头 import：`import { registerMeetingRoutes } from './meetingRoutes';`）

**Step 7: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/meetingRoutes.test.ts test/storage.test.ts` → 预期全部通过（meetingRoutes 3 个新用例）。
- [ ] `git add packages/gateway; git commit -m "feat(gateway): meeting storage joins and REST routes"`

## Task 33: 会议页（热座 UI + always 复刻 + 轮换 + 双语导出，M5 出口）

spec §5.4：参会人名单→热座抓占→发言→翻译播放（always 实时复刻每位发言人音色，P10 voice="default"）→释放热座；全场统一目标语言；固定 WS（D1）；轮换由 T31 判定（token/异常/长时间空闲），轮换不中断会议，发言记录跨 session 拼接（T32 JOIN）；导出双语 Markdown/TXT。先 TDD 导出纯函数，再实现页面。

**Files:**
- Create: `packages/core/src/meeting/meetingExport.ts` + `packages/core/test/meetingExport.test.ts`
- Modify: `packages/core/src/index.ts`、`packages/ui/src/api.ts`（会议接口）、`packages/ui/src/pages/MeetingPage.tsx`（整文件重写）、`packages/ui/src/styles.css`

**Step 1: 写失败测试（导出纯函数）**

- [ ] `packages/core/test/meetingExport.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildMeetingMarkdown, buildMeetingTxt, type MeetingTurnExport } from '../src/meeting/meetingExport';

const turns: MeetingTurnExport[] = [
  {
    speaker: 'Alice',
    sourceText: '今天天气很好，我们一起去公园散步。',
    targetText: "The weather is very nice today, let's go for a walk in the park together.  ", // 真实译文带尾部空格，导出应 trim
    sourceLang: 'zh',
  },
  { speaker: 'Bob', sourceText: 'Good idea.', targetText: '好主意。', sourceLang: 'en' },
];

describe('buildMeetingMarkdown (spec 5.4 双语导出)', () => {
  it('renders header, roster and per-speaker bilingual blocks', () => {
    const md = buildMeetingMarkdown(
      { roster: ['Alice', 'Bob'], targetLanguage: 'en', createdAtIso: '2026-07-28T02:00:00.000Z' },
      turns,
    );
    expect(md).toBe([
      '# 会议记录 2026-07-28T02:00:00.000Z',
      '',
      '- 参会人：Alice、Bob',
      '- 目标语言：en',
      '',
      '## 发言',
      '',
      '### Alice（zh）',
      '',
      '今天天气很好，我们一起去公园散步。',
      '',
      "> The weather is very nice today, let's go for a walk in the park together.",
      '',
      '### Bob（en）',
      '',
      'Good idea.',
      '',
      '> 好主意。',
      '',
    ].join('\n'));
  });

  it('omits the language suffix when sourceLang is null', () => {
    const md = buildMeetingMarkdown(
      { roster: ['Alice'], targetLanguage: 'en', createdAtIso: '2026-07-28T02:00:00.000Z' },
      [{ speaker: 'Alice', sourceText: 'Hi.', targetText: '你好。', sourceLang: null }],
    );
    expect(md).toContain('### Alice\n');
    expect(md).not.toContain('### Alice（');
  });
});

describe('buildMeetingTxt', () => {
  it('renders speaker-prefixed bilingual pairs separated by blank lines', () => {
    expect(buildMeetingTxt(turns)).toBe(
      "[Alice] 今天天气很好，我们一起去公园散步。\nThe weather is very nice today, let's go for a walk in the park together.\n\n[Bob] Good idea.\n好主意。\n",
    );
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/meetingExport.test.ts` → 预期 FAIL：`Cannot find module '../src/meeting/meetingExport'`。

**Step 3: 最小实现**

- [ ] `packages/core/src/meeting/meetingExport.ts`：

```ts
export interface MeetingTurnExport {
  speaker: string;
  sourceText: string;
  targetText: string;
  sourceLang: string | null;
}

export interface MeetingMeta {
  roster: string[];
  targetLanguage: string;
  createdAtIso: string; // new Date(created_at).toISOString()
}

export function buildMeetingMarkdown(meta: MeetingMeta, turns: MeetingTurnExport[]): string {
  const lines: string[] = [
    `# 会议记录 ${meta.createdAtIso}`,
    '',
    `- 参会人：${meta.roster.join('、')}`,
    `- 目标语言：${meta.targetLanguage}`,
    '',
    '## 发言',
    '',
  ];
  for (const t of turns) {
    lines.push(
      `### ${t.speaker}${t.sourceLang ? `（${t.sourceLang}）` : ''}`,
      '',
      t.sourceText.trim(),
      '',
      `> ${t.targetText.trim()}`,
      '',
    );
  }
  return lines.join('\n');
}

export function buildMeetingTxt(turns: MeetingTurnExport[]): string {
  return turns.map((t) => `[${t.speaker}] ${t.sourceText.trim()}\n${t.targetText.trim()}\n`).join('\n');
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { buildMeetingMarkdown, buildMeetingTxt, type MeetingMeta, type MeetingTurnExport } from './meeting/meetingExport';
```

**Step 4: 运行确认通过 + 阶段 Commit**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/meetingExport.test.ts` → 预期 `3 passed`。
- [ ] `git add packages/core; git commit -m "feat(core): bilingual meeting export builders (markdown/txt)"`

**Step 5: 会议页实现**

- [ ] `packages/ui/src/api.ts` 追加：

```ts
export interface MeetingTurnTextDto {
  speaker: string;
  source_text: string;
  target_text: string;
  source_lang: string | null;
}

export const createMeetingRecord = (b: { id: string; roster: string[]; targetLanguage: string; createdAt: number }): Promise<void> =>
  postJson('/meetings', b);

export const postMeetingTurn = (b: { meetingId: string; speaker: string; sessionId: string; seq: number }): Promise<void> =>
  postJson('/meeting-turns', b);

export async function fetchMeetingTurns(meetingId: string): Promise<MeetingTurnTextDto[]> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/meeting-turns?meetingId=${encodeURIComponent(meetingId)}`);
  if (!res.ok) throw new Error(`gateway /meeting-turns -> HTTP ${res.status}`);
  return ((await res.json()) as { turns: MeetingTurnTextDto[] }).turns;
}
```

- [ ] `packages/ui/src/pages/MeetingPage.tsx` 整文件重写：

```tsx
import { useRef, useState } from 'react';
import {
  LANGUAGES, MeetingCoordinator, OUTPUT_SAMPLE_RATE, SessionOrchestrator, UsageMeter, WsTransport,
  base64ToBytes, buildMeetingMarkdown, buildMeetingTxt, shouldRotate, supportsAudioOutput,
  type HotSeatState, type NormalizedEvent, type OrchestratorState, type SessionConfig, type TranscriptSegment,
} from '@livetranslate/core';
import { getPlatform } from '../platform';
import { browserWsFactory } from '../wsFactory';
import {
  createMeetingRecord, createSessionRecord, fetchMeetingTurns, finishSessionRecord, postMeetingTurn, postSegmentRecord,
} from '../api';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { StreamPlayer } from '../audio/streamPlayer';

export function MeetingPage(): JSX.Element {
  const [rosterText, setRosterText] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [running, setRunning] = useState(false);
  const [hotSeat, setHotSeat] = useState<HotSeatState>('idle');
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [rotationNotice, setRotationNotice] = useState<string | null>(null);
  const [connState, setConnState] = useState<OrchestratorState>('idle');
  const [segments, setSegments] = useState<readonly TranscriptSegment[]>([]);
  const [lastMeetingId, setLastMeetingId] = useState<string | null>(null);

  const coordRef = useRef<MeetingCoordinator | null>(null);
  const orchRef = useRef<SessionOrchestrator | null>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);
  const playerRef = useRef<StreamPlayer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const meterRef = useRef(new UsageMeter());
  const sessionIdRef = useRef<string | null>(null);
  const meetingIdRef = useRef<string | null>(null);
  const rosterRef = useRef<string[]>([]);
  const createdAtRef = useRef(0);
  const idleSinceRef = useRef(Date.now());
  const pollRef = useRef<number | null>(null);

  const roster = rosterText.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);

  function buildConfig(): SessionConfig {
    return {
      modalities: ['text', 'audio'],
      voice: 'default', // P10：复刻时 voice 必须 "default"
      enable_voice_clone: true,
      voice_clone_options: { frequency: 'always' as const }, // spec §5.4：每位发言人实时复刻
      sample_rate: 16000,
      input_audio_format: 'pcm',
      input_audio_transcription: { model: 'qwen3-asr-flash-realtime' }, // 多人多语种：语种自动检测（P5）
      translation: { language: targetLanguage }, // 全场统一目标语言
    };
  }

  function waitPlaybackEnd(): void {
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(() => {
      const player = playerRef.current;
      if (!player || player.bufferedSeconds() > 0) return;
      window.clearInterval(pollRef.current!);
      pollRef.current = null;
      coordRef.current?.notePlaybackFinished(); // 播完释放热座
    }, 200);
  }

  function persistTurn(responseId: string): void {
    const sessionId = sessionIdRef.current;
    const mId = meetingIdRef.current;
    const seg = orchRef.current?.model.getSegments().find((s) => s.responseId === responseId);
    const who = coordRef.current?.speaker;
    if (!sessionId || !mId || !seg || !who) return;
    void postSegmentRecord({
      sessionId, seq: seg.seq, vadStartMs: seg.vadStartMs, vadEndMs: seg.vadEndMs,
      sourceText: seg.sourceText, targetText: seg.targetText,
      sourceLang: seg.sourceLang, emotion: seg.emotion,
      usageJson: seg.usage ? JSON.stringify(seg.usage) : null,
    }).then(() => postMeetingTurn({ meetingId: mId, speaker: who, sessionId, seq: seg.seq })); // 先落 segment 再记 turn（JOIN 依赖）
  }

  function handleEvent(ev: NormalizedEvent): void {
    const coord = coordRef.current;
    if (!coord) return;
    if (ev.kind === 'session-created') {
      sessionIdRef.current = ev.sessionId;
      void createSessionRecord({ id: ev.sessionId, mode: 'meeting', configJson: JSON.stringify(buildConfig()), startedAt: Date.now() });
    }
    if (ev.kind === 'speech-started') coord.noteSpeechStarted();
    if (ev.kind === 'speech-stopped') coord.noteSpeechStopped(); // 3s 静音后自动结束发言（T30）
    if (ev.kind === 'audio-delta') {
      coord.notePlaybackStarted(); // translating→playing（其余状态忽略，幂等）
      playerRef.current?.enqueuePcm(base64ToBytes(ev.base64)); // T27 边收边播
      waitPlaybackEnd();
    }
    if (ev.kind === 'server-error') void rotateSession('error'); // spec §5.4：异常即轮换
    if (ev.kind === 'response-done') {
      if (ev.usage) meterRef.current.applyUsage(ev.usage); // P6 差分
      persistTurn(ev.responseId);
      const reason = shouldRotate({
        sessionInputTokens: meterRef.current.snapshot().sessionTotal.input_tokens,
        hadError: false, pausedSinceMs: null, now: Date.now(),
      });
      if (reason) void rotateSession(reason); // P13：token 超限轮换
    }
  }

  async function startOrchestrator(): Promise<void> {
    const orch = new SessionOrchestrator({
      config: buildConfig(),
      transportFactory: () => new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory }), // D1：会议固定 WS
      onStateChange: setConnState,
      onEvent: handleEvent,
    });
    orch.model.onChange(() => setSegments(orch.model.getSegments()));
    orchRef.current = orch;
    await orch.start();
  }

  async function rotateSession(reason: string): Promise<void> {
    const oldId = sessionIdRef.current;
    await orchRef.current?.stop(); // P3：finish→finished→close，旧日志自然封口
    if (oldId) {
      await finishSessionRecord({ id: oldId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    }
    sessionIdRef.current = null;
    meterRef.current.startNewSession(); // session 累积归零，全局累计保留
    await startOrchestrator();
    setRotationNotice(`会话已轮换（${reason}），会议不中断，字幕从新 session 重新计段`);
  }

  async function startMeeting(): Promise<void> {
    const id = `meet_${Date.now()}`;
    const createdAt = Date.now();
    await createMeetingRecord({ id, roster, targetLanguage, createdAt });
    meetingIdRef.current = id;
    rosterRef.current = roster;
    createdAtRef.current = createdAt;
    setLastMeetingId(id);
    coordRef.current = new MeetingCoordinator({
      schedule: (cb, delayMs) => {
        const t = window.setTimeout(cb, delayMs);
        return () => window.clearTimeout(t);
      },
      onStateChange: (s, who) => {
        setHotSeat(s);
        setSpeaker(who);
        if (s === 'idle') idleSinceRef.current = Date.now(); // 空座起计时，供长时间空闲轮换判定
      },
    });
    const ctx = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE }); // P9
    ctxRef.current = ctx;
    playerRef.current = new StreamPlayer(ctx);
    meterRef.current = new UsageMeter();
    setRotationNotice(null);
    await startOrchestrator();
    micRef.current = await startMicCapture({
      echoCancellation: true, // D6
      onChunk: (b) => {
        if (coordRef.current?.state === 'speaking') orchRef.current?.pushAudio(b); // 仅热座持有人推流
      },
    });
    setRunning(true);
  }

  async function grabSeat(name: string): Promise<void> {
    // 抢座前检查：长时间无人发言按“暂停”处理（spec §5.4 暂停超 10 分钟轮换）
    const reason = shouldRotate({
      sessionInputTokens: meterRef.current.snapshot().sessionTotal.input_tokens,
      hadError: false,
      pausedSinceMs: hotSeat === 'idle' ? idleSinceRef.current : null,
      now: Date.now(),
    });
    if (reason) await rotateSession(reason);
    coordRef.current?.requestSpeak(name); // 非 idle 时返回 false，按钮本身也已禁用
  }

  async function endMeeting(): Promise<void> {
    micRef.current?.stop();
    micRef.current = null;
    await orchRef.current?.stop();
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      await finishSessionRecord({ id: sessionId, endedAt: Date.now(), usageJson: JSON.stringify(meterRef.current.snapshot().sessionTotal) });
    }
    sessionIdRef.current = null;
    playerRef.current?.flush();
    playerRef.current = null;
    void ctxRef.current?.close();
    ctxRef.current = null;
    if (pollRef.current !== null) { window.clearInterval(pollRef.current); pollRef.current = null; }
    setRunning(false);
    setHotSeat('idle');
    setSpeaker(null);
  }

  async function exportMeeting(kind: 'md' | 'txt'): Promise<void> {
    const mId = lastMeetingId;
    if (!mId) return;
    const turns = (await fetchMeetingTurns(mId)).map((t) => ({
      speaker: t.speaker, sourceText: t.source_text, targetText: t.target_text, sourceLang: t.source_lang,
    }));
    const content = kind === 'md'
      ? buildMeetingMarkdown({ roster: rosterRef.current, targetLanguage, createdAtIso: new Date(createdAtRef.current).toISOString() }, turns)
      : buildMeetingTxt(turns);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${mId}.${kind === 'md' ? 'md' : 'txt'}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!running) {
    const audioOk = supportsAudioOutput(targetLanguage);
    return (
      <div className="page-body">
        <h2>会议</h2>
        <label>参会人（逗号或换行分隔）
          <textarea value={rosterText} onChange={(e) => setRosterText(e.target.value)} rows={3} placeholder="Alice, Bob" />
        </label>
        <label>全场目标语言
          <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </label>
        {!audioOk && <p className="error-text">该目标语言仅支持文本输出，会议模式需要语音播报，请改选支持语音的语言。</p>}
        <button disabled={roster.length < 2 || !audioOk} onClick={() => void startMeeting()}>开始会议</button>
        {lastMeetingId && (
          <p>
            上一场会议：{lastMeetingId}
            <button onClick={() => void exportMeeting('md')}>导出 Markdown</button>
            <button onClick={() => void exportMeeting('txt')}>导出 TXT</button>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="page-body meeting-page">
      <header className="meeting-topbar">
        <span className="channel-badge">WS</span>
        <span className={`hotseat-banner hotseat-${hotSeat}`}>
          {hotSeat === 'idle' && '空座，可抓占发言'}
          {hotSeat === 'speaking' && `${speaker} 正在发言…`}
          {hotSeat === 'translating' && `翻译 ${speaker} 的发言…`}
          {hotSeat === 'playing' && `播放 ${speaker} 的译文…`}
        </span>
        {connState === 'reconnecting' && <span className="warn-banner">连接中断，正在重连……</span>}
        <button onClick={() => void endMeeting()}>结束会议</button>
      </header>
      {rotationNotice && <p className="hint">{rotationNotice}</p>}
      <section className="meeting-seats">
        {rosterRef.current.map((name) => (
          <button key={name} className="seat-btn" disabled={hotSeat !== 'idle'} onClick={() => void grabSeat(name)}>
            {name} 发言
          </button>
        ))}
        {hotSeat === 'speaking' && <button onClick={() => coordRef.current?.endSpeech()}>结束发言</button>}
        {hotSeat === 'playing' && (
          <button onClick={() => {
            playerRef.current?.flush(); // 丢弃剩余音频
            coordRef.current?.skipPlayback(); // spec §5.4：跳过播放
          }}>跳过播放</button>
        )}
      </section>
      <section className="segments">
        {segments.map((s) => (
          <div key={s.seq} className="segment-card">
            <p>{s.sourceText}{s.sourceStash && <span className="stash">{s.sourceStash}</span>}</p>
            <p>{s.targetText}{s.targetStash && <span className="stash">{s.targetStash}</span>}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
```

- [ ] `packages/ui/src/styles.css` 追加：

```css
.meeting-topbar { display: flex; gap: 16px; align-items: center; }
.hotseat-banner { padding: 4px 12px; border-radius: 4px; background: #333; }
.hotseat-speaking { background: #2d5a2d; }
.hotseat-translating { background: #5a4a2d; }
.hotseat-playing { background: #2d3a5a; }
.meeting-seats { display: flex; gap: 12px; margin: 16px 0; flex-wrap: wrap; }
.seat-btn { font-size: 18px; padding: 12px 24px; }
```

**Step 6: 手工验证（M5 出口标准，spec §8）**

- [ ] 网关已配真实 Key，`pnpm --filter @livetranslate/web dev`，打开 `http://localhost:5173/#/meeting`：
  - 参会人填“Alice, Bob”，目标语言 en，“开始会议”；只填一人时按钮置灰。
  - 点“Alice 发言”→顶部显示“Alice 正在发言”，说一句中文后停 3 秒 → 自动转“翻译…”再转“播放…”，耳机听到以 Alice 音色播报的英文；播完自动回“空座”。
  - 播放中点“Bob 发言”无效（按钮禁用）；点“跳过播放”立即静音并释放热座。
  - Bob 接着发言（可换人或换语调模拟），播报音色随发言人变化（always 复刻）。
  - 结束会议后点“导出 Markdown”/“导出 TXT”：文件包含全部发言的双语内容与发言人名。
  - 轮换验证（不依赖真实 40000 token）：临时把 `ROTATE_PAUSE_MS` 改为 `30 * 1000` 重新构建，空座 30 秒后抓座 → 出现“会话已轮换（paused）”提示且翻译继续可用；验完改回并确认 `pnpm --filter @livetranslate/core exec vitest run test/rotationPolicy.test.ts` 仍通过。
  - 导出文件里能看到轮换前后两个 session 的发言拼接在一起（T32 跨 session JOIN）。
- [ ] 回归：`pnpm -r exec vitest run` → 预期全部通过。

**Step 7: Commit**

- [ ] `git add packages/ui packages/core; git commit -m "feat(ui): meeting hot-seat page with always-clone playback and bilingual export (M5 exit)"`

---

# Milestone 6：收口（WebRTC 通道、打包、E2E、活体冒烟）

## Task 34: WebRtcTransport + SDP 代理 + AutoTransport 自动降级（R5）

spec §2.5/§4：WebRTC 通道——浏览器 RTCPeerConnection 创建 offer，SDP 经网关代理 `POST https://{workspaceHost}/api/v1/webrtc/realtime?model=...`（Content-Type: application/sdp + Bearer，Key 仅网关侧）换取 answer；JSON 事件走 data channel（服务端经 txt 通道推送），麦克风音频走 RTP 音轨上行（Opus 48k，服务端自动重采样），播音走远端 RTP 轨下行；仅 server VAD。WebRTC 为白名单开通制，握手失败（未开白名单/网络受限）时按 R5 自动降级 WsTransport 并在 UI 提示。

接入范围：只接实时翻译机（`protocolPreference === 'auto'` 时优先 WebRTC）。文件配音与会议模式固定 WS（D1）；单人测试也固定 WS——它依赖 `audio-delta` 事件做按段落库与回放（T14 AudioSegmenter），而 WebRTC 音频走 RTP 轨拿不到分段 PCM，两条路径互斥。

分三段提交：网关 SDP 代理 → core WebRtcTransport → AutoTransport 降级与 UI 接线。

**Files:**
- Create: `packages/gateway/src/sdpProxy.ts` + `packages/gateway/test/sdpProxy.test.ts`
- Create: `packages/core/src/protocol/webrtcTransport.ts` + `packages/core/test/webrtcTransport.test.ts`
- Create: `packages/core/src/protocol/transportFactory.ts` + `packages/core/test/transportFactory.test.ts`
- Create: `packages/ui/src/rtcFactory.ts`
- Modify: `packages/gateway/src/server.ts`、`packages/core/src/index.ts`、`packages/ui/src/api.ts`、`packages/ui/src/pages/InterpreterPage.tsx`

**Step 1: 写失败测试（网关 SDP 代理）**

- [ ] `packages/gateway/test/sdpProxy.test.ts`：

```ts
import { mkdtempSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerSdpProxy } from '../src/sdpProxy';
import type { RouteHandler } from '../src/server';
import { SettingsStore, type KeyStore } from '../src/settings';

class MemKeyStore implements KeyStore {
  private key: string | null = null;
  getKey(): string | null { return this.key; }
  setKey(k: string): void { this.key = k; }
  clearKey(): void { this.key = null; }
}

function fakeRes() {
  const chunks: string[] = [];
  let statusCode = 0;
  const res = {
    writeHead: (code: number) => { statusCode = code; return res; },
    end: (data?: string) => { if (data !== undefined) chunks.push(data); },
  } as unknown as ServerResponse;
  return {
    res,
    text: () => chunks.join(''),
    json: () => JSON.parse(chunks.join('')) as Record<string, unknown>,
    status: () => statusCode,
  };
}

const OFFER_SDP = 'v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';

let settings: SettingsStore;
let routes: Map<string, RouteHandler>;
let calls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-sdp-'));
  settings = new SettingsStore(join(dir, 'settings.json'), new MemKeyStore());
  routes = new Map();
  calls = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('v=0\r\no=answer\r\n', { status: 200, headers: { 'Content-Type': 'application/sdp' } });
  }) as typeof fetch;
  registerSdpProxy(routes, { settings, fetchImpl: fakeFetch });
});

describe('sdp proxy', () => {
  it('forwards the offer to the bailian webrtc endpoint with bearer auth', async () => {
    settings.update({ workspaceHost: 'dashscope.aliyuncs.com' });
    settings.setApiKey('sk-test-123');
    const r = fakeRes();
    await routes.get('POST /webrtc/sdp')!({ url: '/webrtc/sdp' } as never, r.res, OFFER_SDP);

    expect(calls[0]!.url).toBe('https://dashscope.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.5-livetranslate-flash-realtime');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/sdp');
    expect(headers.Authorization).toBe('Bearer sk-test-123');
    expect(calls[0]!.init.body).toBe(OFFER_SDP); // offer 原文透传
    expect(r.status()).toBe(200);
    expect(r.text()).toBe('v=0\r\no=answer\r\n'); // answer 原文回传
  });

  it('rejects with 400 when key or host is missing', async () => {
    const r = fakeRes();
    await routes.get('POST /webrtc/sdp')!({ url: '/webrtc/sdp' } as never, r.res, OFFER_SDP);
    expect(r.status()).toBe(400);
    expect(r.json()).toEqual({ error: 'missing_key_or_host' });
    expect(calls).toHaveLength(0); // 未配 Key 绝不外呼
  });
});
```

**Step 2: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/sdpProxy.test.ts` → 预期 FAIL：`Cannot find module '../src/sdpProxy'`。

**Step 3: 最小实现（SDP 代理）**

- [ ] `packages/gateway/src/sdpProxy.ts`：

```ts
import type { ServerResponse } from 'node:http';
import type { RouteHandler } from './server';
import type { SettingsStore } from './settings';

const MODEL = 'qwen3.5-livetranslate-flash-realtime';

export interface SdpProxyDeps {
  settings: SettingsStore;
  fetchImpl?: typeof fetch; // 测试注入；生产用全局 fetch（Node 20+）
}

const json = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

export function registerSdpProxy(routes: Map<string, RouteHandler>, deps: SdpProxyDeps): void {
  const doFetch = deps.fetchImpl ?? fetch;
  routes.set('POST /webrtc/sdp', async (_req, res, body) => {
    const key = deps.settings.getApiKey();
    const host = deps.settings.get().workspaceHost;
    if (!key || !host) {
      json(res, 400, { error: 'missing_key_or_host' });
      return;
    }
    // spec §2.5：SDP 交换端点；Bearer 只出现在网关侧，浏览器拿不到 Key
    const upstream = await doFetch(`https://${host}/api/v1/webrtc/realtime?model=${MODEL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${key}` },
      body,
    });
    const answer = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/sdp' });
    res.end(answer); // 白名单未开通等上游错误原样透传，交给 AutoTransport 触发降级
  });
}
```

- [ ] `packages/gateway/src/server.ts` 在 `registerMeetingRoutes(routes, { storage });` 后追加（文件头 import：`import { registerSdpProxy } from './sdpProxy';`）：

```ts
registerSdpProxy(routes, { settings: opts.settings });
```

**Step 4: 运行确认通过 + Commit（第一段）**

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/sdpProxy.test.ts` → 预期 `2 passed`。
- [ ] `git add packages/gateway; git commit -m "feat(gateway): webrtc sdp exchange proxy"`

**Step 5: 写失败测试（core WebRtcTransport）**

- [ ] `packages/core/test/webrtcTransport.test.ts`（FakePeer/FakeDc 注入，校验握手时序与两条音频路径的分工）：

```ts
import { describe, expect, it } from 'vitest';
import type { SessionConfig } from '../src/protocol/types';
import {
  WebRtcTransport, type DataChannelLike, type PeerLike,
} from '../src/protocol/webrtcTransport';

const cfg: SessionConfig = {
  modalities: ['text', 'audio'],
  voice: 'default',
  enable_voice_clone: true,
  voice_clone_options: { frequency: 'once' },
  sample_rate: 16000,
  input_audio_format: 'pcm',
  input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
  translation: { language: 'en' },
};

class FakeDc implements DataChannelLike {
  sent: string[] = [];
  onmessage: ((data: string) => void) | null = null;
  onopen: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  receive(obj: unknown): void { this.onmessage?.(JSON.stringify(obj)); }
}

class FakePeer implements PeerLike {
  dc = new FakeDc();
  addedTracks: MediaStreamTrack[] = [];
  remoteSdp: string | null = null;
  closed = false;
  ontrack: ((ev: { streams: readonly MediaStream[] }) => void) | null = null;
  createDataChannel(_label: string): DataChannelLike { return this.dc; }
  addTrack(track: MediaStreamTrack, _stream: MediaStream): void { this.addedTracks.push(track); }
  createOffer(): Promise<{ type: string; sdp?: string }> { return Promise.resolve({ type: 'offer', sdp: 'v=0\r\noffer' }); }
  setLocalDescription(_desc: { type: string; sdp?: string }): Promise<void> { return Promise.resolve(); }
  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> { this.remoteSdp = desc.sdp; return Promise.resolve(); }
  close(): void { this.closed = true; }
}

// core 测试跑在 Node，没有 DOM 全局；用结构假对象充当 MediaStream/Track
const fakeTrack = { kind: 'audio' } as unknown as MediaStreamTrack;
const fakeLocalStream = { getAudioTracks: () => [fakeTrack] } as unknown as MediaStream;

async function connected() {
  const peer = new FakePeer();
  const offers: string[] = [];
  const t = new WebRtcTransport({
    peerFactory: () => peer,
    sdpExchange: (offer) => { offers.push(offer); return Promise.resolve('v=0\r\nanswer'); },
    getLocalStream: () => Promise.resolve(fakeLocalStream),
    finishTimeoutMs: 50,
  });
  const done = t.connect(cfg);
  await new Promise((r) => setTimeout(r, 0)); // 等 offer/answer 微任务链跑完
  peer.dc.receive({ type: 'session.created', session: { id: 'sess_rtc_1' } });
  peer.dc.receive({ type: 'session.updated' });
  await done;
  return { peer, t, offers };
}

describe('WebRtcTransport', () => {
  it('performs sdp handshake then session.update handshake over data channel (P2)', async () => {
    const { peer, offers } = await connected();
    expect(offers).toEqual(['v=0\r\noffer']); // offer 交给 sdpExchange
    expect(peer.remoteSdp).toBe('v=0\r\nanswer'); // answer 回填 remote description
    expect(peer.addedTracks).toEqual([fakeTrack]); // 麦克风音轨上 RTP
    const first = JSON.parse(peer.dc.sent[0]!) as { type: string; session: SessionConfig };
    expect(first.type).toBe('session.update'); // created 后立即下发配置
    expect(first.session.voice).toBe('default'); // P10
  });

  it('treats appendAudio as a no-op because audio rides the RTP track', async () => {
    const { peer, t } = await connected();
    t.appendAudio(new ArrayBuffer(3200));
    expect(peer.dc.sent).toHaveLength(1); // 仍只有 session.update，没有 input_audio_buffer.append
  });

  it('sends images over the data channel', async () => {
    const { peer, t } = await connected();
    t.appendImage('/9j/4AAQSkZJRg==');
    const msg = JSON.parse(peer.dc.sent[1]!) as { type: string; image: string };
    expect(msg).toEqual({ type: 'input_image_buffer.append', image: '/9j/4AAQSkZJRg==' });
  });

  it('normalizes data-channel events exactly like the ws path (P4)', async () => {
    const { peer, t } = await connected();
    const texts: string[] = [];
    t.on('asr-delta', (ev) => texts.push(`${ev.text}|${ev.stash}`));
    peer.dc.receive({
      type: 'conversation.item.input_audio_transcription.text',
      item_id: 'item_rtc_1', text: '今天天气', stash: '很好', language: 'zh', emotion: 'neutral',
    });
    expect(texts).toEqual(['今天天气|很好']);
  });

  it('closes the peer after session.finished (P3) and on timeout fallback', async () => {
    const { peer, t } = await connected();
    const finishing = t.finish();
    peer.dc.receive({ type: 'session.finished' });
    await finishing;
    expect(peer.closed).toBe(true);
    const last = JSON.parse(peer.dc.sent[peer.dc.sent.length - 1]!) as { type: string };
    expect(last.type).toBe('session.finish');

    // 超时兑底：服务端不回 finished 也必须在 finishTimeoutMs 后 close
    const peer2 = new FakePeer();
    const t2 = new WebRtcTransport({
      peerFactory: () => peer2,
      sdpExchange: () => Promise.resolve('v=0\r\nanswer'),
      getLocalStream: () => Promise.resolve(fakeLocalStream),
      finishTimeoutMs: 20,
    });
    const done2 = t2.connect(cfg);
    await new Promise((r) => setTimeout(r, 0));
    peer2.dc.receive({ type: 'session.created', session: { id: 'sess_rtc_2' } });
    peer2.dc.receive({ type: 'session.updated' });
    await done2;
    await t2.finish();
    expect(peer2.closed).toBe(true);
  });

  it('exposes the remote RTP stream via getRemoteAudio', async () => {
    const { peer, t } = await connected();
    const remote = { id: 'remote-1' } as unknown as MediaStream;
    peer.ontrack?.({ streams: [remote] });
    expect(t.getRemoteAudio()).toBe(remote);
  });
});
```

**Step 6: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/webrtcTransport.test.ts` → 预期 FAIL：`Cannot find module '../src/protocol/webrtcTransport'`。

**Step 7: 最小实现（WebRtcTransport）**

- [ ] `packages/core/src/protocol/webrtcTransport.ts`（与 WsTransport 同构：同一套 Emitter/normalizeServerEvent/rawTaps/finish 兑底；差异只在运输层）：

```ts
import { Emitter } from './emitter';
import { normalizeServerEvent } from './normalize';
import type {
  ITranslateTransport, NormalizedEvent, NormalizedKind, RawDirection, ServerEvent, SessionConfig,
} from './types';

export interface DataChannelLike {
  send(data: string): void;
  onmessage: ((data: string) => void) | null;
  onopen: (() => void) | null;
}

export interface PeerLike {
  createDataChannel(label: string): DataChannelLike;
  addTrack(track: MediaStreamTrack, stream: MediaStream): void;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(desc: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(desc: { type: string; sdp: string }): Promise<void>;
  close(): void;
  ontrack: ((ev: { streams: readonly MediaStream[] }) => void) | null;
}

export interface WebRtcTransportOptions {
  peerFactory: () => PeerLike;
  sdpExchange: (offerSdp: string) => Promise<string>; // 网关 POST /webrtc/sdp
  getLocalStream: () => Promise<MediaStream>; // 向导选定的麦克风
  finishTimeoutMs?: number;
  connectTimeoutMs?: number;
}

type EventMap = { [K in NormalizedKind]: Extract<NormalizedEvent, { kind: K }> };

export class WebRtcTransport implements ITranslateTransport {
  readonly kind = 'webrtc' as const;
  private peer: PeerLike | null = null;
  private dc: DataChannelLike | null = null;
  private remoteStream: MediaStream | null = null;
  private emitter = new Emitter<EventMap>();
  private rawTaps = new Set<(dir: RawDirection, payload: ServerEvent) => void>();
  private finishTimeoutMs: number;
  private connectTimeoutMs: number;

  constructor(private opts: WebRtcTransportOptions) {
    this.finishTimeoutMs = opts.finishTimeoutMs ?? 10_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  }

  async connect(cfg: SessionConfig): Promise<void> {
    const peer = this.opts.peerFactory();
    this.peer = peer;
    const dc = peer.createDataChannel('events');
    this.dc = dc;
    peer.ontrack = (ev) => { this.remoteStream = ev.streams[0] ?? null; }; // 远端译音 RTP 轨
    const local = await this.opts.getLocalStream();
    for (const track of local.getAudioTracks()) peer.addTrack(track, local); // 麦风上行走 RTP（spec §4.2）
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const answerSdp = await this.opts.sdpExchange(offer.sdp ?? '');
    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.close();
        reject(new Error('WebRtcTransport: session.updated timeout')); // 白名单未开通时典型表现 → 交给 AutoTransport 降级
      }, this.connectTimeoutMs);
      dc.onmessage = (data) => {
        const ev = JSON.parse(data) as ServerEvent;
        this.rawTaps.forEach((tap) => tap('s2c', ev));
        if (ev.type === 'session.created') {
          this.sendJson({ type: 'session.update', session: cfg }); // P2 握手与 WS 完全一致
        }
        if (ev.type === 'session.updated') {
          clearTimeout(timer);
          resolve();
        }
        const norm = normalizeServerEvent(ev);
        if (norm) this.emitter.emit(norm.kind, norm as never);
      };
    });
  }

  updateSession(patch: Partial<SessionConfig>): Promise<void> {
    this.sendJson({ type: 'session.update', session: patch });
    return Promise.resolve();
  }

  appendAudio(_pcm16: ArrayBuffer): void {
    // 麦克风音频经 RTP 轨直达服务端（spec §4.2），data channel 不重复推流
  }

  appendImage(jpegBase64: string): void {
    this.sendJson({ type: 'input_image_buffer.append', image: jpegBase64 });
  }

  finish(): Promise<void> {
    return new Promise((resolve) => {
      const peer = this.peer;
      if (!peer || !this.dc) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        off();
        peer.close(); // P3 兑底：服务端永不断链，超时强制断开
        resolve();
      }, this.finishTimeoutMs);
      const off = this.emitter.on('session-finished', () => {
        clearTimeout(timer);
        off();
        peer.close(); // P3：收到 finished 后客户端主动断开
        resolve();
      });
      this.sendJson({ type: 'session.finish' });
    });
  }

  abort(): void {
    this.peer?.close();
    this.peer = null;
    this.dc = null;
  }

  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void {
    return this.emitter.on(kind, cb);
  }

  onRaw(cb: (dir: RawDirection, payload: ServerEvent) => void): () => void {
    this.rawTaps.add(cb);
    return () => this.rawTaps.delete(cb);
  }

  getRemoteAudio(): MediaStream | null {
    return this.remoteStream;
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (!this.dc) throw new Error('WebRtcTransport: not connected');
    this.rawTaps.forEach((tap) => tap('c2s', obj as ServerEvent));
    this.dc.send(JSON.stringify(obj));
  }
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export {
  WebRtcTransport,
  type DataChannelLike, type PeerLike, type WebRtcTransportOptions,
} from './protocol/webrtcTransport';
```

**Step 8: 运行确认通过 + Commit（第二段）**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/webrtcTransport.test.ts` → 预期 `6 passed`。
- [ ] `git add packages/core; git commit -m "feat(core): webrtc transport over data channel with rtp audio"`

**Step 9: 写失败测试（AutoTransport 降级）**

- [ ] `packages/core/test/transportFactory.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { AutoTransport } from '../src/protocol/transportFactory';
import type {
  ITranslateTransport, NormalizedEvent, NormalizedKind, RawDirection, ServerEvent, SessionConfig,
} from '../src/protocol/types';

const cfg: SessionConfig = {
  modalities: ['text', 'audio'],
  voice: 'default',
  enable_voice_clone: true,
  voice_clone_options: { frequency: 'once' },
  sample_rate: 16000,
  input_audio_format: 'pcm',
  input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
  translation: { language: 'en' },
};

class FakeTransport implements ITranslateTransport {
  connectCalls = 0;
  aborted = false;
  audio: ArrayBuffer[] = [];
  finished = false;
  private listeners = new Map<NormalizedKind, Set<(ev: never) => void>>();
  constructor(readonly kind: 'ws' | 'webrtc', private failConnect = false) {}
  connect(_cfg: SessionConfig): Promise<void> {
    this.connectCalls += 1;
    return this.failConnect ? Promise.reject(new Error('sdp exchange failed: 403')) : Promise.resolve();
  }
  emit(ev: NormalizedEvent): void { this.listeners.get(ev.kind)?.forEach((cb) => cb(ev as never)); }
  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void {
    let set = this.listeners.get(kind);
    if (!set) { set = new Set(); this.listeners.set(kind, set); }
    const s = set;
    s.add(cb as (ev: never) => void);
    return () => s.delete(cb as (ev: never) => void);
  }
  onRaw(_cb: (dir: RawDirection, payload: ServerEvent) => void): () => void { return () => undefined; }
  updateSession(_patch: Partial<SessionConfig>): Promise<void> { return Promise.resolve(); }
  appendAudio(pcm16: ArrayBuffer): void { this.audio.push(pcm16); }
  appendImage(_jpegBase64: string): void { /* 降级测试用不到图像 */ }
  finish(): Promise<void> { this.finished = true; return Promise.resolve(); }
  abort(): void { this.aborted = true; }
  getRemoteAudio(): MediaStream | null { return null; }
}

function makeAuto(rtcFails: boolean) {
  const rtc = new FakeTransport('webrtc', rtcFails);
  const ws = new FakeTransport('ws');
  const chosen: Array<[string, string]> = [];
  const auto = new AutoTransport({
    makeWebRtc: () => rtc,
    makeWs: () => ws,
    onChannelChosen: (kind, reason) => chosen.push([kind, reason]),
  });
  return { auto, rtc, ws, chosen };
}

describe('AutoTransport', () => {
  it('prefers webrtc when its handshake succeeds', async () => {
    const { auto, rtc, ws, chosen } = makeAuto(false);
    await auto.connect(cfg);
    expect(rtc.connectCalls).toBe(1);
    expect(ws.connectCalls).toBe(0);
    expect(auto.kind).toBe('webrtc');
    expect(chosen).toEqual([['webrtc', 'preferred']]);
  });

  it('falls back to ws when webrtc connect rejects (R5)', async () => {
    const { auto, rtc, ws, chosen } = makeAuto(true);
    await auto.connect(cfg);
    expect(rtc.aborted).toBe(true); // 失败的 peer 必须清理
    expect(ws.connectCalls).toBe(1);
    expect(auto.kind).toBe('ws');
    expect(chosen).toEqual([['ws', 'fallback']]);
  });

  it('replays subscriptions made before connect onto the adopted transport', async () => {
    // T17 时序：SessionOrchestrator.start() 先 on(ALL_KINDS) 再 connect()，订阅不能丢
    const { auto, rtc, ws } = makeAuto(true);
    const texts: string[] = [];
    const off = auto.on('asr-delta', (ev) => texts.push(ev.text));
    await auto.connect(cfg);
    ws.emit({ kind: 'asr-delta', itemId: 'item_a1', text: '今天', stash: '天气', language: 'zh', emotion: 'neutral' });
    expect(texts).toEqual(['今天']);
    rtc.emit({ kind: 'asr-delta', itemId: 'item_a1', text: '不应该出现', stash: '', language: 'zh', emotion: 'neutral' });
    expect(texts).toEqual(['今天']); // 被抛弃的 rtc 上的订阅已解除
    off();
    ws.emit({ kind: 'asr-delta', itemId: 'item_a1', text: '退订后不收', stash: '', language: 'zh', emotion: 'neutral' });
    expect(texts).toEqual(['今天']);
  });

  it('delegates audio, finish and kind to the adopted inner transport', async () => {
    const { auto, ws } = makeAuto(true);
    await auto.connect(cfg);
    const buf = new ArrayBuffer(3200);
    auto.appendAudio(buf);
    expect(ws.audio).toEqual([buf]);
    await auto.finish();
    expect(ws.finished).toBe(true);
    expect(auto.getRemoteAudio()).toBeNull();
  });
});
```

**Step 10: 运行确认失败**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/transportFactory.test.ts` → 预期 FAIL：`Cannot find module '../src/protocol/transportFactory'`。

**Step 11: 最小实现（AutoTransport）**

- [ ] `packages/core/src/protocol/transportFactory.ts`：

```ts
import type {
  ITranslateTransport, NormalizedEvent, NormalizedKind, RawDirection, ServerEvent, SessionConfig,
} from './types';

export type ChannelReason = 'preferred' | 'fallback';

export interface AutoTransportOptions {
  makeWebRtc: () => ITranslateTransport;
  makeWs: () => ITranslateTransport;
  onChannelChosen?: (kind: 'ws' | 'webrtc', reason: ChannelReason) => void; // R5：UI 降级提示通道
}

interface EventSub {
  kind: NormalizedKind;
  cb: (ev: NormalizedEvent) => void;
  realOff: (() => void) | null;
  removed: boolean;
}

interface RawSub {
  cb: (dir: RawDirection, payload: ServerEvent) => void;
  realOff: (() => void) | null;
  removed: boolean;
}

export class AutoTransport implements ITranslateTransport {
  private inner: ITranslateTransport | null = null;
  private subs: EventSub[] = [];
  private rawSubs: RawSub[] = [];

  constructor(private opts: AutoTransportOptions) {}

  get kind(): 'ws' | 'webrtc' {
    return this.inner?.kind ?? 'ws';
  }

  async connect(cfg: SessionConfig): Promise<void> {
    // T17 时序：编排器先 on() 再 connect()，故订阅先落缓冲区，adopt 时回放到真正的传输上
    const rtc = this.opts.makeWebRtc();
    this.adopt(rtc);
    try {
      await rtc.connect(cfg);
      this.opts.onChannelChosen?.('webrtc', 'preferred');
      return;
    } catch {
      this.detach();
      rtc.abort(); // R5：WebRTC 不可用（白名单/网络），清理后降级
    }
    const ws = this.opts.makeWs();
    this.adopt(ws);
    await ws.connect(cfg); // WS 也失败则向上抛，交给编排层重连退避（R3）
    this.opts.onChannelChosen?.('ws', 'fallback');
  }

  updateSession(patch: Partial<SessionConfig>): Promise<void> {
    return this.req().updateSession(patch);
  }

  appendAudio(pcm16: ArrayBuffer): void {
    this.req().appendAudio(pcm16);
  }

  appendImage(jpegBase64: string): void {
    this.req().appendImage(jpegBase64);
  }

  finish(): Promise<void> {
    return this.inner ? this.inner.finish() : Promise.resolve();
  }

  abort(): void {
    this.inner?.abort();
    this.detach();
  }

  on<K extends NormalizedKind>(kind: K, cb: (ev: Extract<NormalizedEvent, { kind: K }>) => void): () => void {
    const sub: EventSub = {
      kind,
      cb: cb as (ev: NormalizedEvent) => void,
      realOff: this.inner ? this.inner.on(kind, cb) : null,
      removed: false,
    };
    this.subs.push(sub);
    return () => {
      sub.removed = true;
      sub.realOff?.();
      sub.realOff = null;
    };
  }

  onRaw(cb: (dir: RawDirection, payload: ServerEvent) => void): () => void {
    const sub: RawSub = { cb, realOff: this.inner ? this.inner.onRaw(cb) : null, removed: false };
    this.rawSubs.push(sub);
    return () => {
      sub.removed = true;
      sub.realOff?.();
      sub.realOff = null;
    };
  }

  getRemoteAudio(): MediaStream | null {
    return this.inner?.getRemoteAudio() ?? null;
  }

  private req(): ITranslateTransport {
    if (!this.inner) throw new Error('AutoTransport: not connected');
    return this.inner;
  }

  private adopt(t: ITranslateTransport): void {
    this.inner = t;
    for (const s of this.subs) if (!s.removed) s.realOff = t.on(s.kind, s.cb as never);
    for (const r of this.rawSubs) if (!r.removed) r.realOff = t.onRaw(r.cb);
  }

  private detach(): void {
    for (const s of this.subs) { s.realOff?.(); s.realOff = null; }
    for (const r of this.rawSubs) { r.realOff?.(); r.realOff = null; }
    this.inner = null;
  }
}
```

- [ ] `packages/core/src/index.ts` 追加：

```ts
export { AutoTransport, type AutoTransportOptions, type ChannelReason } from './protocol/transportFactory';
```

**Step 12: 运行确认通过**

- [ ] `pnpm --filter @livetranslate/core exec vitest run test/transportFactory.test.ts` → 预期 `4 passed`。
- [ ] 回归：`pnpm --filter @livetranslate/core exec vitest run` → 预期全部通过。

**Step 13: UI 接线（实时翻译机优先 WebRTC）**

- [ ] `packages/ui/src/rtcFactory.ts`（浏览器 RTCPeerConnection → PeerLike 适配，对称 wsFactory）：

```ts
import type { DataChannelLike, PeerLike } from '@livetranslate/core';

export function browserPeerFactory(): PeerLike {
  const pc = new RTCPeerConnection();
  let eventsIn: ((data: string) => void) | null = null;
  const like: PeerLike = {
    createDataChannel: (label: string): DataChannelLike => {
      const dc = pc.createDataChannel(label);
      const dcLike: DataChannelLike = {
        send: (d) => dc.send(d),
        onmessage: null,
        onopen: null,
      };
      dc.onmessage = (ev) => dcLike.onmessage?.(String(ev.data));
      dc.onopen = () => dcLike.onopen?.();
      eventsIn = (data) => dcLike.onmessage?.(data);
      return dcLike;
    },
    addTrack: (track, stream) => { pc.addTrack(track, stream); },
    createOffer: () => pc.createOffer(),
    setLocalDescription: (desc) => pc.setLocalDescription(desc as RTCSessionDescriptionInit),
    setRemoteDescription: (desc) => pc.setRemoteDescription(desc as RTCSessionDescriptionInit),
    close: () => pc.close(),
    ontrack: null,
  };
  pc.ontrack = (ev) => like.ontrack?.({ streams: ev.streams });
  // spec §2.5：服务端事件经其自建的 txt 通道推送，并入同一个 onmessage，对 core 透明
  pc.ondatachannel = (ev) => {
    ev.channel.onmessage = (m) => eventsIn?.(String(m.data));
  };
  return like;
}
```

- [ ] `packages/ui/src/api.ts` 追加：

```ts
export async function exchangeSdp(offerSdp: string): Promise<string> {
  const res = await fetch(`${getPlatform().gatewayHttpBase()}/webrtc/sdp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offerSdp,
  });
  if (!res.ok) throw new Error(`sdp exchange failed: ${res.status}`); // reject → AutoTransport 降级
  return res.text();
}
```

- [ ] `packages/ui/src/pages/InterpreterPage.tsx` 修改（在 T29 完整版上的四处增量）：

① import 区：core 导入行改为含 AutoTransport/WebRtcTransport/ITranslateTransport，并新增 rtcFactory/exchangeSdp：

```tsx
import {
  AutoTransport, LANGUAGES, OUTPUT_SAMPLE_RATE, SessionOrchestrator, UsageMeter, WebRtcTransport, WsTransport,
  base64ToBytes, supportsAudioOutput,
  type ITranslateTransport, type NormalizedEvent, type OrchestratorState, type SessionConfig, type TranscriptSegment,
} from '@livetranslate/core';
import { createGatewayApi, createSessionRecord, exchangeSdp, finishSessionRecord, postSegmentRecord } from '../api';
import { browserPeerFactory } from '../rtcFactory';
```

② 状态区追加（`defaultVoice` 声明之后），并在 settings 加载回调里同步协议偏好：

```tsx
  const [protocolPreference, setProtocolPreference] = useState<'auto' | 'ws'>('ws');
  const [channelNotice, setChannelNotice] = useState<string | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
```

```tsx
      setProtocolPreference(r.settings.protocolPreference); // 设置页“自动/强制 WS”（T11）
```

③ `start()` 里把 `transportFactory` 一行替换为通道选择逻辑，并在 `await orch.start()` 后接上远端音轨播放：

```tsx
    function makeTransport(): ITranslateTransport {
      const makeWs = () => new WsTransport({ url: getPlatform().gatewayWsUrl(), wsFactory: browserWsFactory });
      if (protocolPreference !== 'auto') return makeWs(); // 设置页强制 WS 时不尝试 WebRTC
      return new AutoTransport({
        makeWs,
        makeWebRtc: () => new WebRtcTransport({
          peerFactory: browserPeerFactory,
          sdpExchange: exchangeSdp,
          getLocalStream: () => navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: choice.inputDeviceId }, echoCancellation: true, noiseSuppression: true },
          }),
        }),
        onChannelChosen: (kind, reason) => {
          setChannelNotice(reason === 'fallback'
            ? 'WebRTC 不可用（未开白名单或网络受限），已自动降级为 WS 通道'
            : null); // R5：降级必须可见
        },
      });
    }
    const orch = new SessionOrchestrator({
      config: buildConfig(),
      transportFactory: makeTransport,
      onStateChange: setState,
      onEvent: handleEvent,
    });
```

```tsx
    await orch.start();
    const remote = orch.transport?.getRemoteAudio();
    if (remote) {
      // WebRTC 通道：译音走远端 RTP 轨，audio-delta 不会出现，StreamPlayer 自然闲置
      const el = new Audio();
      el.srcObject = remote;
      const sinkEl = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (sinkEl.setSinkId) await sinkEl.setSinkId(choice.outputDeviceId);
      await el.play();
      remoteAudioRef.current = el;
    }
```

④ 清理与提示：`pause()` 追加 `if (remoteAudioRef.current) remoteAudioRef.current.muted = true;`，`resume()` 追加 `if (remoteAudioRef.current) remoteAudioRef.current.muted = false;`，`stop()` 在 `playerRef.current?.flush();` 前追加：

```tsx
    remoteAudioRef.current?.pause();
    remoteAudioRef.current = null;
    setChannelNotice(null);
```

全屏顶栏 `channel-badge` 无需改动（已按 `orchRef.current?.transport?.kind` 渲染，AutoTransport.kind 反映内层通道）；在其后追加降级提示：

```tsx
        {channelNotice && <span className="warn-banner">{channelNotice}</span>}
```

（`.warn-banner` 样式已在 T17 重连提示时定义，直接复用。）

**Step 14: 手工验证（两条通道都要跑通）**

- [ ] 降级路径（不依赖白名单，人人可验）：设置页协议选“自动”，`pnpm --filter @livetranslate/web dev` 打开 `http://localhost:5173/#/interpreter`，走完向导后开始翻译：若账号未开 WebRTC 白名单，SDP 交换返回非 200 → 顶栏徽章显示 WS，并出现“已自动降级为 WS 通道”提示；说一句中文，字幕与语音与 T29 表现完全一致（降级后功能零损失，R5）。
- [ ] 强制 WS 路径：设置页改“强制 WS”，重新开始 → 不发起 `POST /webrtc/sdp`（DevTools Network 面板确认），无降级提示。
- [ ] WebRTC 路径（仅白名单已开时可验，否则记录为已验证降级即可）：协议选“自动”且 SDP 交换成功 → 徽章显示 WebRTC，译音来自远端音轨（DevTools `chrome://webrtc-internals` 可见双向 RTP）；暂停 → 声音立即静音；结束 → 回配置页，历史页段落文本完整。
- [ ] 回归：`pnpm -r exec vitest run` → 预期全部通过。

**Step 15: Commit（第三段）**

- [ ] `git add packages/core packages/ui; git commit -m "feat(core,ui): auto transport with ws fallback and channel indicator (R5)"`

## Task 35: 三端打包（electron-builder win/mac + 网页调试端构建）

spec §1.1/§8 M6：三端 = Windows（nsis 安装包）/ macOS（dmg）/ Web（vite 构建 + 本地网关，仅调试形态不分发）。纯构建配置任务，无 TDD：实现步骤 + 手工验证。

**Files:**
- Create: `apps/desktop/electron-builder.yml`、`apps/desktop/resources/icon.png`
- Modify: `packages/ui/vite.config.ts`、`apps/desktop/package.json`、根 `package.json`

**Step 1: 生成应用图标（真实产物）**

- [ ] PowerShell：`New-Item -ItemType Directory -Force apps/desktop/resources; ffmpeg -f lavfi -i "color=c=0x3355ff:s=512x512:d=0.1" -frames:v 1 "apps/desktop/resources/icon.png"`
- [ ] 验证：`ffprobe apps/desktop/resources/icon.png` → 输出含 `512x512`（mac 图标要求 ≥512，win 自动缩到 256）。

**Step 2: UI 构建适配 file:// 加载**

- [ ] `packages/ui/vite.config.ts` 整文件替换（新增 `base: './'`，否则 Electron `loadFile` 下绝对路径资源 404）：

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // Electron 打包后用 file:// 加载，资源必须相对路径
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist' },
});
```

**Step 3: electron-builder 配置**

- [ ] `apps/desktop/electron-builder.yml`：

```yaml
appId: com.livetranslate.tool
productName: LiveTranslate Tool
directories:
  output: release
  buildResources: resources
files:
  - dist/**
  - ui/**
  - package.json
asar: true
asarUnpack:
  - "**/*.node" # better-sqlite3 原生模块必须解包才能被 require
win:
  target: nsis
  icon: resources/icon.png
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
mac:
  target: dmg
  icon: resources/icon.png
  category: public.app-category.productivity
```

- [ ] `apps/desktop/package.json` 修改：
  - 把 `@livetranslate/core`、`@livetranslate/gateway` 从 dependencies 移到 devDependencies（esbuild 已整体打进 `dist/main.cjs`，运行期不需要 workspace 链接，electron-builder 也无法打包符号链接）；`better-sqlite3` 保留在 dependencies（external + 原生模块，由 electron-builder 收集）。
  - devDependencies 追加 `"electron-builder": "^25.1.8"`。
  - scripts 追加（copy:ui 用 Node 内联脚本，免额外依赖、跨平台）：

```json
    "copy:ui": "node -e \"const fs=require('node:fs');fs.rmSync('ui',{recursive:true,force:true});fs.cpSync('../../packages/ui/dist','ui',{recursive:true});\"",
    "dist": "pnpm build && pnpm --filter @livetranslate/ui build && pnpm copy:ui && electron-builder --config electron-builder.yml"
```

（`main.ts` 已按 `join(__dirname, '..', 'ui', 'index.html')` 加载，即 `apps/desktop/ui/`，与 copy:ui 目标一致，T12 预留无需改动。）

- [ ] 根 `package.json` scripts 追加：

```json
    "dist:desktop": "pnpm --filter @livetranslate/desktop dist",
    "build:web": "pnpm --filter @livetranslate/ui build"
```

- [ ] 根 `.gitignore` 追加两行：`apps/desktop/release/` 与 `apps/desktop/ui/`（打包中间产物不入库）。

**Step 4: 手工验证**

- [ ] Windows：`pnpm dist:desktop` → 生成 `apps/desktop/release/LiveTranslate Tool Setup 0.1.0.exe`；安装后启动：设置页填 Key → 连接自检通过 → 单人测试说一句话字幕正常；安装目录 `resources/app.asar.unpacked` 下存在 `better_sqlite3.node`；userData 目录出现 `apikey.enc` 且 `settings.json` 无 Key 明文（D4）。
- [ ] 缺 ffmpeg 环境行为：临时清空 PATH 启动安装版，文件配音页导入视频 → 预期弹出 T20 的提示“未检测到 ffmpeg：请安装并加入 PATH，或设置 LT_FFMPEG_PATH/LT_FFPROBE_PATH”，其余模式不受影响。
- [ ] macOS（在 mac 机器上执行同一命令）：`pnpm dist:desktop` → `apps/desktop/release/LiveTranslate Tool-0.1.0.dmg`，安装后同样跑一轮单人测试（safeStorage 走 Keychain）。
- [ ] Web 端回归：`pnpm build:web` 成功；`pnpm --filter @livetranslate/web dev` 页面资源加载正常（`base: './'` 不影响 dev server）。

**Step 5: Commit**

- [ ] `git add apps/desktop packages/ui package.json .gitignore pnpm-lock.yaml; git commit -m "build: electron-builder packaging for win/mac and web debug build"`

## Task 36: Playwright E2E（单人测试 / 文件配音 / 会议热座）

spec §7 测试策略：三条 E2E 覆盖单人测试、文件配音、会议热座；实时翻译机因依赖真实双声道硬件走手工验收（T29 / T34 Part D 的手工清单）。全套 E2E **不需要真实 API Key**：

- **mock 上游**（`e2e/mock/upstream.ts`）：一个本地 WS 服务，按 §0.1 的真实事件结构回放标准回合（'今天天气很好，我们一起去公园散步。' → 英文译文），usage 按 session 累积（P6 差分的活体测试基准）。
- **网关指向 mock**：`workspaceHost = '127.0.0.1:9601'` + `upstreamScheme: 'ws'`（relay T8 已支持）+ `LT_UPSTREAM_SCHEME=ws`（本任务为 mediaJobs 直连补上同款开关）；Key 用 `DASHSCOPE_API_KEY=sk-e2e-fake` 环境变量（EnvKeyStore，mock 不校验）。
- **假麦克风**：Chromium `--use-fake-device-for-media-capture` + `--use-file-for-fake-audio-capture=zh-sample.wav`（ffmpeg 生成的正弦音，mock 收到任意 append 即回放，不做真实 ASR）。

三个时序要点（决定 mock 与用例写法，实现时不得偏离）：

1. **译文段延迟 3500ms 发送**：会议热座的 translating 态出现在 `endSpeech` 之后、译文到达之前；若 mock 立即回放译文，UI 会直接跳过 translating。3500ms 给用例留出点击「结束发言」的窗口。
2. **`session.finish` 冲刷**：`runFilePipeline`（T21）全速推完音频立刻 `finish()`，此时 3500ms 定时器未到期——mock 收到 `session.finish` 必须先同步冲刷未发送的译文段，再回 `session.finished`，否则文件配音管道拿不到译文就断链。
3. **会议用例点「结束发言」按钮**：假麦克风 wav 会循环播放、永无静音，客户端 VAD 的 3s 静音判定永不触发；用按钮驱动热座状态机是确定性的。

**Files:**
- Create: `packages/gateway/test/cors.test.ts`
- Modify: `packages/gateway/src/server.ts`（补 CORS——网页调试端 5173 → 网关 8788 跨源，E2E 与 T10 网页端共同依赖）
- Modify: `packages/gateway/src/mediaJobs.ts`（上游 scheme 支持 `LT_UPSTREAM_SCHEME` 切换）
- Create: `e2e/package.json`、`e2e/playwright.config.ts`
- Create: `e2e/mock/upstream.ts`、`e2e/mock/boot.ts`
- Create: `e2e/fixtures/zh-sample.wav`、`e2e/fixtures/dub-input.wav`（ffmpeg 生成）
- Create: `e2e/tests/solo.spec.ts`、`e2e/tests/filedub.spec.ts`、`e2e/tests/meeting.spec.ts`

**Step 1: CORS 写失败测试**

- [ ] `packages/gateway/test/cors.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayServer, type GatewayHandle } from '../src/server';
import { SettingsStore, type KeyStore } from '../src/settings';

class MemKeyStore implements KeyStore {
  private key: string | null = null;
  getKey(): string | null { return this.key; }
  setKey(k: string): void { this.key = k; }
  clearKey(): void { this.key = null; }
}

let handle: GatewayHandle;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-cors-'));
  const settings = new SettingsStore(join(dir, 'settings.json'), new MemKeyStore());
  handle = await createGatewayServer({ settings, dataDir: dir, port: 0 });
});

afterEach(async () => { await handle.close(); });

describe('gateway CORS', () => {
  it('answers OPTIONS preflight with 204 and allow headers', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/settings`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type');
  });

  it('adds allow-origin header on normal routes', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/settings`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
```

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/cors.test.ts` → 预期 FAIL：两条用例均因响应头缺 `access-control-allow-origin`（首条还会拿到 404 而非 204）。

**Step 2: CORS 最小实现 + Commit**

- [ ] `packages/gateway/src/server.ts`：`createServer((req, res) => {` 之后、`let body = '';` 之前插入：

```ts
    // 网页调试端（5173）与 Electron file:// 均跨源访问网关 HTTP 接口
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
```

（网关只监听 `127.0.0.1`，`*` 不扩大暴露面；Key 从不经由这些接口明文返回——`GET /settings` 走 T7 的 `getMaskedKey()`。）

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/cors.test.ts` → 预期 `2 passed`。
- [ ] `pnpm --filter @livetranslate/gateway exec vitest run` → 预期既有全部用例仍通过（CORS 头不影响 fakeRes 型路由测试）。
- [ ] `git add packages/gateway; git commit -m "fix(gateway): cors headers for cross-origin web and desktop clients"`

**Step 3: e2e 包脚手架 + fixture 生成**

- [ ] `e2e/package.json`（版本与 T1/T8 各包对齐）：

```json
{
  "name": "@livetranslate/e2e",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "test": "playwright test"
  },
  "devDependencies": {
    "@livetranslate/gateway": "workspace:*",
    "@playwright/test": "^1.48.0",
    "@types/ws": "^8.5.12",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "ws": "^8.18.0"
  }
}
```

- [ ] `e2e/playwright.config.ts`：

```ts
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  workers: 1, // mock 上游 / 网关 / SQLite 为共享单例，必须串行
  use: {
    baseURL: 'http://127.0.0.1:5173',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-device-for-media-capture',
        '--use-fake-ui-for-media-capture',
        `--use-file-for-fake-audio-capture=${resolve(__dirname, 'fixtures', 'zh-sample.wav')}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  webServer: {
    command: 'pnpm --filter @livetranslate/ui build && tsx mock/boot.ts',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
```

- [ ] 生成两个 wav fixture（仓库根执行；内容是正弦音——mock 不做真实 ASR，只要有字节流即可）：

```powershell
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3" -ar 48000 -ac 1 -sample_fmt s16 e2e/fixtures/zh-sample.wav
ffmpeg -y -f lavfi -i "sine=frequency=330:duration=3" -ar 16000 -ac 1 -sample_fmt s16 e2e/fixtures/dub-input.wav
```

- [ ] `pnpm install`（链接新包）；`pnpm --filter @livetranslate/e2e exec playwright install chromium` → 预期下载 Chromium 成功。

**Step 4: mock 上游回放器**

- [ ] `e2e/mock/upstream.ts`（事件名与字段严格对齐 §0.1 与 normalize.ts T3 的原始事件表）：

```ts
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
```

**Step 5: boot 脚本（mock 上游 + 网关 + ui preview 一键拉起）**

- [ ] `e2e/mock/boot.ts`（由 playwright webServer 以 `tsx mock/boot.ts` 启动，cwd 固定为 `e2e/`）：

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { preview } from 'vite';
import { createGatewayServer, EnvKeyStore, SettingsStore } from '@livetranslate/gateway';
import { startMockUpstream } from './upstream';

async function main(): Promise<void> {
  await startMockUpstream(9601);

  // 每次全新临时数据目录：SQLite/事件日志/设置互不污染，用例可重复运行
  const dataDir = mkdtempSync(join(tmpdir(), 'lt-e2e-'));
  process.env.DASHSCOPE_API_KEY = 'sk-e2e-fake'; // EnvKeyStore 读取，mock 不校验
  process.env.LT_UPSTREAM_SCHEME = 'ws'; // mediaJobs 直连也指向明文 mock

  const settings = new SettingsStore(join(dataDir, 'settings.json'), new EnvKeyStore());
  settings.update({ workspaceHost: '127.0.0.1:9601', protocolPreference: 'ws' });

  await createGatewayServer({ settings, dataDir, port: 8788, upstreamScheme: 'ws' });

  const uiRoot = resolve(process.cwd(), '..', 'packages', 'ui');
  await preview({
    root: uiRoot,
    preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  });
  console.log('[e2e] mock upstream :9601, gateway :8788, ui preview :5173');
}

void main();
```

**Step 6: mediaJobs 支持明文上游（与 relay 的 upstreamScheme 对称）**

- [ ] `packages/gateway/src/mediaJobs.ts`：`processMediaJob` 内直连上游的 `new WsTransport({...})` 中，将

```ts
url: `wss://${host}/api-ws/v1/realtime?model=${MODEL}`,
```

改为：

```ts
        // E2E 用 LT_UPSTREAM_SCHEME=ws 指向本地 mock；生产缺省 wss（与 relay 的 upstreamScheme 选项对称）
        url: `${process.env.LT_UPSTREAM_SCHEME === 'ws' ? 'ws' : 'wss'}://${host}/api-ws/v1/realtime?model=${MODEL}`,
```

- [ ] `pnpm --filter @livetranslate/gateway exec vitest run test/mediaJobs.test.ts` → 预期全部通过（既有用例走 `overrides.transportFactory`，不碰真实 URL）。

**Step 7: 单人测试 E2E**

- [ ] `e2e/tests/solo.spec.ts`（选择器对齐 T16 SegmentCard 与 T17 SoloPage 的真实标签）：

```ts
import { expect, test } from '@playwright/test';

test('单人测试：开始 → 覆盖式转写 → 译文与回放按钮 → 结束', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '开始', exact: true }).click();

  const firstCard = page.locator('.segment-card').first();
  // P4 覆盖式渲染：先看到部分文本（text+stash），再被全量刷新
  await expect(firstCard.locator('.segment-source')).toContainText('今天天气', { timeout: 15_000 });
  await expect(firstCard.locator('.segment-source')).toContainText('今天天气很好，我们一起去公园散步。', { timeout: 15_000 });
  // 译文在 mock 延迟 3.5s 后到达
  await expect(firstCard.locator('.segment-target')).toContainText("let's go for a walk in the park together", { timeout: 15_000 });
  // 段落 done 后出现按段回放按钮（24k PCM → WAV，240ms → “▶ 0.2s”）
  await expect(firstCard.locator('.segment-meta button')).toContainText('▶', { timeout: 15_000 });

  await page.getByRole('button', { name: '结束', exact: true }).click();
  // 结束后回到可重新开始的状态
  await expect(page.getByRole('button', { name: '开始', exact: true })).toBeEnabled({ timeout: 10_000 });
});
```

**Step 8: 文件配音 E2E（运行机器需已安装 ffmpeg，T20 抽音轨依赖）**

- [ ] `e2e/tests/filedub.spec.ts`：

```ts
import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test('文件配音：上传 → 全速预处理 → 双栏工作台 → 导出 SRT', async ({ page }) => {
  await page.goto('/#/filedub');
  await page.setInputFiles('input[type="file"]', resolve(__dirname, '..', 'fixtures', 'dub-input.wav'));
  await page.getByRole('button', { name: '开始预处理' }).click();

  // 全速管道（P8 无 sleep）+ mock finish 冲刷：双栏工作台很快就绪
  await expect(page.locator('.dub-cell .segment-source').first()).toContainText('今天天气很好', { timeout: 60_000 });
  await expect(page.locator('.dub-cell .segment-target').first()).toContainText('The weather is very nice today', { timeout: 10_000 });
  // 译文栏有按段播放按钮（mock 回了 240ms 音频）
  await expect(page.getByRole('button', { name: '▶ 播放译文' }).first()).toBeVisible();
  // 导出入口就绪（GET /export/srt，T26）
  await expect(page.getByRole('link', { name: '导出 SRT' })).toBeVisible();
});
```

**Step 9: 会议热座 E2E**

- [ ] `e2e/tests/meeting.spec.ts`（状态机断言对齐 T33 MeetingPage 的 banner 四态文案；用「结束发言」按钮驱动，不依赖 VAD 静音计时）：

```ts
import { expect, test } from '@playwright/test';

test('会议热座：两人各一轮发言 → 状态机完整流转 → 结束与导出入口', async ({ page }) => {
  await page.goto('/#/meeting');
  await page.getByLabel('参会人（逗号或换行分隔）').fill('Alice, Bob');
  await page.getByRole('button', { name: '开始会议' }).click();

  const banner = page.locator('.hotseat-banner');
  await expect(banner).toContainText('空座，可抓占发言', { timeout: 15_000 });

  // —— Alice 一轮 ——
  await page.getByRole('button', { name: 'Alice 发言' }).click();
  await expect(banner).toContainText('Alice 正在发言…', { timeout: 10_000 });
  // 占座后其他席位禁用（热座互斥）
  await expect(page.getByRole('button', { name: 'Bob 发言' })).toBeDisabled();
  // mock 收到音频后立即回 ASR；看到原文后点结束发言（早于 3.5s 译文到达，命中 translating 态）
  await expect(page.locator('.segment-card').first()).toContainText('今天天气', { timeout: 10_000 });
  await page.getByRole('button', { name: '结束发言' }).click();
  await expect(banner).toContainText('翻译 Alice 的发言…', { timeout: 5_000 });
  // 译文到达→播放 240ms→回到空座（playing 态短暂，不单独断言，以回到空座为准）
  await expect(banner).toContainText('空座，可抓占发言', { timeout: 20_000 });
  await expect(page.locator('.segment-card').first()).toContainText("let's go for a walk in the park together");

  // —— Bob 一轮（验证座位释放后可再抓占） ——
  await page.getByRole('button', { name: 'Bob 发言' }).click();
  await expect(banner).toContainText('Bob 正在发言…', { timeout: 10_000 });
  await expect(page.locator('.segment-card')).toHaveCount(2, { timeout: 10_000 });
  await page.getByRole('button', { name: '结束发言' }).click();
  await expect(banner).toContainText('空座，可抓占发言', { timeout: 20_000 });

  // —— 结束与导出 ——
  await page.getByRole('button', { name: '结束会议' }).click();
  await expect(page.getByRole('button', { name: '导出 Markdown' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: '导出 TXT' })).toBeVisible();
});
```

**Step 10: 运行确认通过 + Commit**

- [ ] `pnpm --filter @livetranslate/e2e exec playwright test` → 预期输出 `3 passed`（首次运行含 ui build + boot 拉起，约 1–2 分钟）。
- [ ] 若 meeting 用例在「翻译 Alice 的发言…」断言处超时：说明点击「结束发言」晚于译文到达，把 `e2e/mock/upstream.ts` 的 `RESPONSE_DELAY_MS` 上调到 `5000` 后重跑（其余用例不受影响，只是变慢）。
- [ ] `git add e2e packages/gateway pnpm-workspace.yaml pnpm-lock.yaml; git commit -m "test(e2e): playwright suites for solo, file dubbing and meeting with mock upstream"`

## Task 37: 活体冒烟脚本 + 手动 CI + 发布终检

E2E 全部走 mock，真实上游的协议漂移（事件改名、字段增删）需要一条**活体冒烟**兼顾：`tools/live-smoke.mjs` 是 `scratch/ws-exp.mjs` 的正式化演进版，只读环境变量拿 Key（永不硬编码），可本地手动跑，也可在 GitHub Actions 里手动触发（不进定时任务，避免无人值守烧 token）。

两种运行档位：

- **连通档（缺省）**：任意 16k 单声道 PCM16 wav（正弦音即可）→ 断言 P2/P3 骨干：`session.created` → `session.updated` → `session.finish` 后收到 `session.finished` 并由客户端断链。验证 Key/网络/握手协议存活，CI 用这档（仓库不提交语音素材，ffmpeg 现场生成音频）。
- **全链路档（`--expect-turn`）**：传入真实中文语音 wav（本地录一段即可）→ 额外断言 ≥ 1 次 ASR completed 与 ≥ 1 次 `response.done`（含 usage），验证完整翻译回合。

**Files:**
- Create: `tools/live-smoke.mjs`
- Create: `.github/workflows/live-smoke.yml`
- Modify: 根 `package.json`（devDependencies 加 `ws`，供 tools/ 脚本 import）

**Step 1: 冒烟脚本**

- [ ] 根 `package.json` 的 `devDependencies` 追加 `"ws": "^8.18.0"`，执行 `pnpm install`。
- [ ] `tools/live-smoke.mjs`：

```js
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
```

- [ ] 本地验证（需真实 Key；无 Key 环境跳过，交由 CI 手动触发验证）：
  - 连通档：`ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 -sample_fmt s16 $env:TEMP/smoke.wav; node tools/live-smoke.mjs $env:TEMP/smoke.wav` → 预期末尾 `PASS (connectivity)`，exit 0。
  - 全链路档：用任意真实中文语音 wav（单人测试录一段即可）跑 `node tools/live-smoke.mjs speech.wav --expect-turn` → 预期 `PASS (full turn)`，且打印的 usage 结构与 §0.1 真实样例一致。

**Step 2: 手动触发的 CI workflow**

- [ ] `.github/workflows/live-smoke.yml`：

```yaml
name: live-smoke
on: workflow_dispatch # 仅手动触发：消耗真实 token，不进 push/定时

jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - run: ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 -sample_fmt s16 /tmp/smoke.wav
      - run: node tools/live-smoke.mjs /tmp/smoke.wav
        env:
          DASHSCOPE_API_KEY: ${{ secrets.DASHSCOPE_API_KEY }}
          LT_WORKSPACE_HOST: ${{ secrets.LT_WORKSPACE_HOST }}
```

（仓库 Settings → Secrets 配置 `DASHSCOPE_API_KEY`；`LT_WORKSPACE_HOST` 不配时脚本用缺省域名。）

**Step 3: 发布终检清单（M6 出口标准，spec §8）**

- [ ] 单测全绿：`pnpm --filter @livetranslate/core exec vitest run; pnpm --filter @livetranslate/gateway exec vitest run; pnpm --filter @livetranslate/ui exec vitest run` → 三个包全部 passed。0 failed。
- [ ] E2E 全绿：`pnpm --filter @livetranslate/e2e exec playwright test` → `3 passed`。
- [ ] 类型检查：`pnpm --filter @livetranslate/core exec tsc --noEmit; pnpm --filter @livetranslate/gateway exec tsc --noEmit; pnpm --filter @livetranslate/ui exec tsc --noEmit` → 无错误。
- [ ] 三端产物：Windows `pnpm dist:desktop` 出 nsis 安装包；macOS 同命令出 dmg；`pnpm build:web` 产出可部署静态产物（T35 手工清单全部补勾）。
- [ ] 手工验收对照 spec §8 各里程碑出口标准逐条过一遍：尤其实时翻译机双声道向导（T29）与 WebRTC 降级路径（T34 Part D）这两处 E2E 未覆盖的手工清单。
- [ ] 活体冒烟连通档 PASS（本地或 CI 手动触发任选其一）。

**Step 4: Commit**

- [ ] `git add tools .github package.json pnpm-lock.yaml; git commit -m "chore: live smoke script, manual CI workflow and release checklist"`

---

全计划到此结束：37 个任务覆盖 M1–M6 全部里程碑（M1 骨架 T1–T13、M2 单人测试完整 T14–T19、M3 文件配音 T20–T26、M4 实时翻译机 T27–T29、M5 会议热座 T30–T33、M6 WebRTC/打包/E2E/冒烟 T34–T37）。每个任务独立可验收、独立 commit，按序执行即可从空仓库走到可发布产品。