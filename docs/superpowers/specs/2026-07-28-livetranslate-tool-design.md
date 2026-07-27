# LiveTranslate Tool — 同声传译体验工具设计文档

- 日期：2026-07-28
- 状态：待用户评审
- 模型：阿里云百炼 `qwen3.5-livetranslate-flash-realtime`
- 定位：生产级品质的同声传译体验软件（Windows exe / macOS app / 网页调试端），核心使命是让用户把模型能力"用起来、用爽"，**不设任何成本护栏**（token 消耗对甲方是正向指标）。

---

## 0. 摘要

基于 qwen3.5-livetranslate-flash-realtime 构建三端一致的同声传译体验工具，包含三大模式：**单人测试**（麦克风→流式译文+按段音频回放）、**翻译机/配音**（文件全速预处理配音 + 实时翻译机模拟）、**会议翻译**（热座串行多语言圆桌，always 音色复刻）。架构为本地优先：React+TS 共享前端 + 可插拔协议接入层（WebSocket 全场景保底 / WebRTC 麦克风增强），Electron 主进程内嵌网关，数据全本地，API Key 用户自填。所有关键协议行为已用真实凭证实测验证（见 §2）。

---

## 1. 目标与非目标

### 1.1 目标
1. 三端（Windows / macOS / Web）体验一致，一套代码，electron-builder 分发桌面安装包。
2. 三大模式完整落地，覆盖模型的全部特色能力：流式同传、音色复刻、视觉增强翻译、热词。
3. 生产级体验品质：设备向导、错误恢复、会话生命周期管理、双语记录导出。
4. 展示性仪表盘：实时 token 用量、延迟指标（首字延迟、音频首包延迟）——作为模型能力展示，非成本控制。

### 1.2 非目标
- 无云端服务、无账号体系、无跨设备数据同步（数据全本地）。
- 不内置分发 API Key（用户在设置中自填）。
- 不做移动端（AOQ 场景不在范围内）。
- 不做多人远程会议（会议模式是单机热座式圆桌）。

---

## 2. 实测协议依据（真实凭证冒烟测试结论）

以下全部为对真实端点两轮实测的结论，是本设计的事实基础：

### 2.1 连接与生命周期
- URL：`wss://{workspaceHost}/api-ws/v1/realtime?model=qwen3.5-livetranslate-flash-realtime`，鉴权 `Authorization: Bearer <API_KEY>` header。
- 连接即收 `session.created`，默认配置：`modalities:["text","audio"]`、`voice:"Tina"`、`sample_rate:16000`、`input/output_audio_format:"pcm"`、`turn_detection:{type:"server_vad", threshold:0.2, silence_duration_ms:1000, create_response:true, interrupt_response:true}`。
- `session.update` 全参数被接受并回显；服务端 VAD 自动断句，无需客户端断句。
- **`session.finish` → 服务端回 `session.finished` 但不主动断链，客户端必须自行 close**。

### 2.2 事件与渲染模型
- 译文增量：纯文本模态走 `response.text.text`，音频模态走 `response.audio_transcript.text`。**均为 `text`(已确认) + `stash`(暂存预测) 双字段全量刷新，stash 会回撤重写**——渲染必须覆盖式，禁止追加拼接。
- ASR 原文：`conversation.item.input_audio_transcription.text/.completed`（含 `language`、`emotion` 字段，需开启 `input_audio_transcription.model:"qwen3-asr-flash-realtime"`）。
- 段落 = 一次 response 生命周期（`response.created`→`response.done`）；`response.done.usage` 含 token 统计。
- 事件量参考：4.7s 音频约 49 条服务端事件。

### 2.3 推流与音频
- 输入：PCM16 / 16kHz / mono，base64 后经 `input_audio_buffer.append` 分块推送（推荐 3200 字节 = 100ms/块）。
- **全速推流完全可行**：25.8s 音频 5ms 灌完、2s 内译完，≥12x 实时吞吐，零限流；VAD 分段边界与 1x 逐毫秒一致。快推的唯一副作用是增量修正轮次减少、措辞略简洁。
- 输出音频：**24kHz / 16bit / mono PCM**（基频分析证实），base64 经 `response.audio.delta` 增量返回。
- 译文音频/原文段时长比实测 **0.89–1.16x（均值≈1.0）**，配音对齐压力小。
- 延迟：纯文本首字 ~929ms；音频模式首包 ~2.5–2.8s；音频在原句未说完时即开始回流（真同传式）。

### 2.4 音色复刻与计费
- `enable_voice_clone:true` + `voice:"default"` + `voice_clone_options.frequency: "once"|"always"` 均实测可用；**always 逐段跟随不同说话人音色**（F0 客观测量证实）。
- 复刻使输出音频 token +20~40%；once 与 always 成本几乎持平。
- **token 按 session 累积计费**：每个 response 的 usage 包含此前全部上下文（输入音频 ~7.2–7.6 token/s 累加）。上下文上限 53,248（输入 49,152 / 输出 4,096）→ 单 session 音频输入上限估算约 100 分钟，需 session 轮换机制（§6.4）。

### 2.5 其他模型事实（文档来源）
- 60 语种互译；29 种支持音频+文本输出，31 种仅文本（UI 需按目标语言动态禁用音频开关）。
- 图像输入（视觉增强翻译）：JPG/JPEG，≤2 张/秒，建议 480p–720p（≤1080p），base64 前 ≤190KB，须在首次 `input_audio_buffer.append` 之后发送，走 `input_image_buffer.append`。
- 热词：`session.translation.corpus.phrases`（映射表）。
- WebRTC：官方支持本模型（白名单开通制）；JSON 事件走 data channel（服务端经 `txt` 通道推送），音频走 RTP 轨（Opus 48k，服务端自动重采样）；仅支持 server VAD；SDP 交换 `POST https://{endpoint}/api/v1/webrtc/realtime?model=...`（`Content-Type: application/sdp`、Bearer 鉴权）。
- AOQ 仅支持 Android/iOS/HarmonyOS，**桌面与浏览器不可用**——因此桌面/网页端以 WebRTC 承接其抗噪/回声定位，WebSocket 全场景保底。

---

## 3. 总体架构

```
┌───────────────────────────────────────────────────────┐
│ ① UI 层（React 18 + TypeScript + Vite）                │
│   模式路由：单人测试 / 翻译机·配音 / 会议 / 设置 / 历史   │
│   共享组件：译文流渲染器(text+stash) · 音频播放器 ·      │
│             设备选择器 · token/延迟仪表盘                │
├───────────────────────────────────────────────────────┤
│ ② 核心逻辑层（纯 TS，平台无关，可单测）                  │
│   SessionOrchestrator（会话编排/轮换/暂停恢复）          │
│   TranscriptModel（段落状态机：text/stash/done）        │
│   AudioSegmenter（response→完整音频段落 blob）          │
│   FilePipeline（解码/重采样/全速推流/抽帧）              │
│   MeetingCoordinator（热座状态机）                      │
│   UsageMeter（usage 聚合展示）· StorageAdapter          │
├───────────────────────────────────────────────────────┤
│ ③ 协议接入层 ITranslateTransport（可插拔）              │
│   WsTransport：全场景保底 + 文件模式主力                 │
│   WebRtcTransport：麦克风模式增强（白名单开通后启用）     │
├───────────────────────────────────────────────────────┤
│ ④ 宿主运行时                                            │
│   桌面：Electron 主进程内嵌网关（safeStorage 存 Key、     │
│         SDP 代理、ffmpeg、SQLite、文件存储）              │
│   网页(调试)：本地 Node 网关（同一网关代码独立进程运行，   │
│         代理 WS/SDP 鉴权，Key 不进浏览器）                │
└───────────────────────────────────────────────────────┘
```

### 3.1 关键决策与理由
| 决策 | 内容 | 理由 |
|---|---|---|
| D1 | 协议双轨：WS 保底一切场景；WebRTC 用于双工麦克风模式（单人测试、实时翻译机，可用时）；文件配音与会议模式固定 WS | AOQ 不支持桌面/浏览器；WebRTC 提供传输层 AEC/抗弱网，仅在双工回声场景有增益；WS 实测全功能可用且文件推流/精确音频分段必须用 WS |
| D2 | `ITranslateTransport` 抽象接口 | 两协议承载同一套 JSON 事件，业务层零感知切换；WebRTC 白名单未开通时自动降级 WS |
| D3 | 本地优先 | 体验工具无账号/云同步需求；SQLite + 本地文件 |
| D4 | Key 用户自填，桌面 `safeStorage` 加密存储；网页端 Key 存于本地网关进程（.env.local），不进浏览器 | 安全 + 分发合规 |
| D5 | 技术栈 React18 + TS + Vite + Electron + electron-builder + better-sqlite3 + ffmpeg（桌面原生二进制 / 网页 ffmpeg.wasm） | 生态成熟、三端一致 |
| D6 | 回声/噪音兜底：`getUserMedia({echoCancellation:true, noiseSuppression:true, autoGainControl:true})` + 耳机引导 | Chromium 内置 AEC/NS；实时翻译机模式强制声道向导（§5.3） |

### 3.2 网关职责（桌面主进程 / 本地 Node 同一份代码）
1. 持有 API Key，向百炼建立 WSS（透传事件到渲染端，经 IPC/本地 WS）。
2. WebRTC SDP 交换代理（`POST /api/v1/webrtc/realtime`，Bearer 注入）。
3. ffmpeg 子进程管理：音轨抽取、重采样到 16k PCM16 mono、按 1–2fps 抽帧 JPEG。
4. SQLite 读写与音频文件落盘。

---

## 4. 协议接入层规范

### 4.1 ITranslateTransport 接口
```ts
interface ITranslateTransport {
  connect(cfg: SessionConfig): Promise<void>;   // 建连+session.update+等待 session.updated
  updateSession(patch: Partial<SessionConfig>): Promise<void>;
  appendAudio(pcm16: ArrayBuffer): void;         // WS: base64 append；WebRTC: 写入音轨
  appendImage(jpegBase64: string): void;         // 统一走事件通道
  finish(): Promise<void>;                       // session.finish → 等 session.finished → close
  abort(): void;                                 // 立即断开（重置用）
  on(event: ServerEventType, cb): void;          // 统一服务端事件总线
  readonly kind: 'ws' | 'webrtc';
  // 译文音频输出路径因协议而异：
  //   ws     → response.audio.delta 事件（可精确按 response 分段拼 blob）
  //   webrtc → RTP 远端音频轨（流式播放；需分段留档时用 MediaRecorder
  //            按 response.created/done 窗口录制远端轨，精度略低）
  getRemoteAudio(): MediaStream | null;          // webrtc 专用，ws 返回 null
}
```

### 4.2 SessionConfig（映射 session.update）
`modalities`、`voice`、`enable_voice_clone`、`voice_clone_options.frequency(never|once|always)`、`sample_rate(16000)`、`input_audio_format('pcm')`、`input_audio_transcription{model:'qwen3-asr-flash-realtime', language|auto}`、`translation{language, corpus.phrases}`。

### 4.3 生命周期规则（实测约束固化）
- R1：收到 `session.finished` 后由客户端主动 close；`finish()` 内置 10s 超时兜底强制断开。
- R2：`response.done` 到达即结算该段（落库、生成音频 blob、刷新 usage）。
- R3：断线重连：指数退避（0.5s/1s/2s/4s，上限 5 次）新建 session；已确认段落不受影响；进行中段落标记"中断"。
- R4：所有模式的"暂停" = 停止 appendAudio（连接与 session 保留）；"重置" = abort + 新 session + 清屏（历史已落库不删除）。
- R5：WebRTC 不可用（白名单/建连失败）→ 自动降级 WsTransport 并在 UI 提示当前通道。

### 4.4 译文渲染协议（TranscriptModel）
- 段落状态机：`translating(text+stash 覆盖刷新) → done(固化)`。
- UI 呈现：已确认 text 正常色；stash 浅灰斜体；stash 回撤直接整段重绘。
- 音频模式下译文文本源为 `response.audio_transcript.*`；文本模式为 `response.text.*`；两者归一化为同一内部事件。

---

## 5. 三大模式详细设计

### 5.1 单人测试模式
**目的**：最低门槛体验流式同传文本。

- 配置面板：源语言（自动检测开关/手动）、目标语言（60 语种）、"同时生成语音"开关（默认关；目标语言不支持音频时禁用并提示）、热词表编辑。
- 主流程：开始 → 麦克风采集（AudioWorklet 降采样到 16k PCM16）→ 持续推流 → 段落流渲染（§4.4）。
- 音频段回放：开启语音后 `modalities:["text","audio"]`；AudioSegmenter 把每个 response 的 `audio.delta` 拼为完整 24k PCM，封装 WAV blob，段落卡片右侧显示 ▶ 播放键与时长。**不自动播放**。
- 控制：暂停/恢复（R4）、重置（R4）、结束（finish → 本次会话归档为一条历史记录）。
- 仪表盘：实时累计 token（input audio/text、output）、当前段首字延迟、会话时长。
- 附加展示：ASR 原文小字（含检测语言、emotion 标签）与译文对照。

### 5.2 翻译机 / 配音模式（文件）
**目的**：上传音视频 → 全速预处理 → 双栏对照播放 / 配音播放。

- 导入：拖入音频（wav/mp3/m4a/flac/ogg）或视频（mp4/mov/mkv/webm）。网关 ffmpeg 抽音轨 → 16k PCM16。
- **预处理（决策：导入即全速推流）**：无 sleep 全速 append（实测 ≥12x 吞吐、2s 级完成）+ `session.finish` 收尾；进度条按已收 `response.done` 的音频时间戳推进。产物：分段记录（VAD 起止时间、原文、译文、24k 音频段、usage）。
- **视觉增强（决策：方案二，做成开关，默认开，"有能力就做"）**：视频文件开启时按 1fps（上限 2fps）抽帧 JPEG（≤720p、≤190KB），与音频时间轴同步在对应 append 进度后发 `input_image_buffer.append`。注意：图像必须在首次音频 append 之后发送。网页端若 ffmpeg.wasm 性能不可接受则降级"仅音轨"并提示。
- 双栏工作台：左=原始播放器（视频画面/音频波形+原文字幕），右=译文（分段卡片：译文字幕+音频段波形），段落间连线对应。
- 播放形态：
  - 原声播放：左栏出声，右栏字幕同步高亮。
  - **配音播放（决策：顺延漂移 D）**：双栏同步滚动、只出右侧译文音频。第 n 段译文音频起点 = max(原段起点, 上一段译文结束)；允许整体漂移，字幕跟随译文音频进度；左栏画面按原时间轴播放（静音），漂移量在进度条上可视化。实测时长比 0.89–1.16x，漂移可控（且模型自带输出语速策略）。
- 音色：默认 `enable_voice_clone: once`（保留原片音色）；可切预设音色。
- 导出：SRT（原文/译文）、配音混音 WAV（按漂移时间轴渲染）、双语 TXT。

### 5.3 翻译机模式（实时模拟）
**目的**：模拟翻译耳机——外部声源对着电脑麦克风说源语言，用户从耳机听目标语言。

- **强制三步声道向导（不可跳过）**：
  1. 选收音设备：`enumerateDevices` 麦克风下拉 + 实时音量条自检（提示"请让外部声源对此麦克风说话"）。
  2. 选播音设备：输出设备下拉（`HTMLAudioElement.setSinkId`）+ "播放测试音"确认只从耳机出声。
  3. 回环自检：若输出设备疑似扬声器（默认设备/名称含 speaker）→ 红色警告"翻译声音会被麦克风收回造成循环，请改用耳机"，需勾选"我已确认使用耳机"才能开始。向导附图文说明。
- 运行界面：全屏大字号双语字幕（原文小灰 + 译文大白，text/stash 渲染），译文音频**自动流式播放**到所选输出设备（24k PCM 经 Web Audio 播放队列，边收边播）；顶部：暂停/结束/通道指示（WS/WebRTC）/延迟指示器。
- 音频通道：优先 WebRTC（AEC）；降级 WS 时开启 Chromium AEC/NS（D6）。
- 音色复刻默认 once。

### 5.4 会议翻译模式（热座串行圆桌）
**目的**：多人不同语言轮流发言，译成统一会议语言并以发言人音色播放。

- 会前设置：会议目标语言（**决策：全场统一单一目标语言**）、参会人名册（姓名+源语言，源语言可"自动检测"）、输出音色策略（固定 `enable_voice_clone: always`）。
- **Session 策略（决策）**：整场会议一条持久 session（`always` 复刻 + 跨句上下文保证术语一致）；触发以下任一条件自动无感轮换新 session：累计输入 token > 40,000（留安全余量）、连接异常、会议暂停超 10 分钟。轮换对 UI 无感，时间线连续。
- **热座状态机**：
  ```
  idle ──任意参会人点击"按下发言"──► speaking(热座锁定给该人)
  speaking ──"结束发言" 或 VAD 静音≥3s 自动──► translating/playing
  playing(译文音频以发言人音色自动播放，热座继续锁定) ──播放完──► idle
  ```
  - speaking 期间：屏幕实时显示该发言人 ASR 原文 + 流式译文。
  - 发言人切换不断链（同 session，always 逐句跟随音色，实测已证实）。
  - 打断保护：playing 中"按下发言"无效，但提供"跳过播放"按钮（主持人用）。
- 时间线：每次发言生成一张卡片（发言人头像/名字、原文、译文、▶ 重播、usage）；会议结束导出全程双语记录（Markdown/TXT，含时间戳与发言人）。
- 设备：单机模式，共用一只麦克风 + 扬声器外放（圆桌物理模型）；设备选择复用 §5.3 组件（不强制耳机，因串行模式播放时无人说话，回声风险低；仍开 AEC）。
- **传输通道：会议模式默认走 WS**（理由：卡片重播需要按 response 精确分段的音频 blob，WS 的 `audio.delta` 天然支持；串行热座场景无双工回声压力，WebRTC 的 AEC 增益有限）。WebRTC 在本模式仅作实验性开关。

---

## 6. 共享子系统

### 6.1 音频管道
- 采集：`getUserMedia`（AEC/NS/AGC 按模式配置）→ AudioWorklet 降采样 48k→16k PCM16 → 3200 字节/100ms 分块。
- 播放：流式（实时翻译机/会议）——WS 通道用 Web Audio 播放队列（`AudioBufferSourceNode` 顺序调度，24k）；WebRTC 通道直接把远端轨绑到 `<audio>`（setSinkId 指定输出设备）。段落回放统一用 WAV blob + `<audio>`（支持 setSinkId）。

### 6.2 存储（本地）
- SQLite（桌面 better-sqlite3 / 网页端经本地网关同库）：
  - `sessions`(id, mode, 配置 JSON, 开始/结束时间, 累计 usage)
  - `segments`(id, session_id, seq, vad_start_ms, vad_end_ms, source_text, target_text, source_lang, emotion, audio_path, usage JSON)
  - `meetings`(id, 名册 JSON, 目标语言) / `meeting_turns`(speaker, segment 引用)
  - `media_jobs`(文件模式：源文件路径、抽帧配置、产物路径)
- 音频段落文件：`{userData}/audio/{sessionId}/{seq}.wav`。
- 历史页：按模式浏览/搜索/重播/导出/删除。

### 6.3 设置模块
- API Key（必填，safeStorage 加密；显示脱敏）、Workspace Host（默认北京地域格式 `{ws-id}.cn-beijing.maas.aliyuncs.com`）、协议偏好（自动/强制 WS）、默认语言对、默认音色、热词表管理（多套命名词表，session 级注入）、抽帧开关与帧率。
- "连接自检"按钮：建一个瞬时 session 验证 Key/网络，显示 `session.created` 往返延迟。

### 6.4 UsageMeter
- 从每个 `response.done.usage` 取增量（注意 usage 为 session 累积值，需差分）；仪表盘展示会话累计与全局累计（本地统计），标注"输入音频 ~7.4 token/s、输出音频 ~12.5 token/s"参考系数。

### 6.5 错误处理
| 错误 | 处理 |
|---|---|
| 401/鉴权失败 | 引导至设置页，附百炼开通指引链接 |
| 断线 | R3 重连；UI 顶栏黄条提示；进行中段落标记中断 |
| `error` 事件 | 按 code 分类展示；未知错误附原始报文可复制 |
| 麦克风权限拒绝 | 各平台图文引导（macOS 系统偏好/Windows 隐私设置） |
| ffmpeg 失败/不支持格式 | 明确报错文件格式与建议转换方式 |
| 目标语言不支持音频 | 预先禁用音频开关（29/31 语种清单内置） |

---

## 7. 测试策略

1. **核心逻辑单测**（vitest）：TranscriptModel 的 text/stash 覆盖刷新与回撤、AudioSegmenter 拼接、UsageMeter 差分、热座状态机、配音漂移时间轴计算。
2. **协议契约测试**：录制的真实事件流（scratch 冒烟日志转 fixture）回放驱动 WsTransport，断言归一化事件序列；活体冒烟脚本保留（`scratch/ws-smoke.mjs` 演进为 `tools/live-smoke.mjs`），CI 手动触发。
3. **E2E**（Playwright + Electron）：三模式关键路径——单人测试开始/暂停/重置/导出；文件导入→预处理→配音播放（用本仓 TTS 素材）；会议两人热座轮转。音频输入用虚拟设备/文件注入。
4. **手工验收清单**：真实麦克风+耳机的实时翻译机全流程、双设备声道向导、macOS/Windows 打包安装。

---

## 8. 里程碑（实施顺序建议，供 writing-plans 细化）

1. M1 骨架：Monorepo（app/gateway/core）、设置页、连接自检、WsTransport + TranscriptModel（单人测试文本流跑通）。
2. M2 单人测试完整：音频段回放、暂停/重置、仪表盘、历史落库。
3. M3 文件配音：ffmpeg 管道、全速预处理、双栏工作台、漂移配音播放、导出、抽帧视觉增强。
4. M4 实时翻译机：声道向导、流式播放队列、全屏字幕。
5. M5 会议模式：热座状态机、always 复刻、session 轮换、双语导出。
6. M6 WebRtcTransport 接入与自动降级、三端打包（electron-builder + 网页调试端）、E2E 完善。

---

## 9. 假设与开放问题

| # | 项 | 状态 |
|---|---|---|
| 1 | WebRTC 白名单/endpoint 由用户提供（"我给你就完了"）；未提供期间麦克风模式走 WS + Chromium AEC，不阻塞任何里程碑 | 用户承诺 |
| 2 | 中途换目标语言：设计为"换语言=新 session"（文档未确认 session 中途改 translation.language 的行为） | 保守设计 |
| 3 | WS 连接时长上限（文档提及 120 分钟）：由 §6.4 session 轮换覆盖 | 已缓解 |
| 4 | 图像输入对翻译质量的实际增益未实测（仅协议验证过事件可发送）：M3 落地时用带口型视频实测 | 待验证 |
| 5 | opus 输入格式暂不使用（PCM16 已满足；弱网优化留作后续） | 范围外 |
| 6 | 网页端 ffmpeg.wasm 抽帧性能：若不可接受则网页端降级仅音轨（桌面端不受影响） | 降级预案 |

---

## 10. 决策日志（本次讨论定案）

1. AOQ 不可用于桌面/浏览器 → 麦克风模式采用 WebRTC（用户拍板"不能 AOQ 就 WebRTC"），WS 全场景保底、接入层可插拔。
2. 文件配音模式走 WebSocket（精确控速、无损推流、支持全速预处理）。
3. "多端同步"= 三端体验一致，本地数据，无云端。
4. API Key 用户自填（设置模块 + safeStorage）。
5. 技术栈：React + TS + Vite + Electron（authorized "你决定"）。
6. 不设成本护栏；token 仪表盘仅展示。
7. 暂停=保 session 停推流可恢复；重置=清屏+重建 session。
8. 文件模式：导入即预处理（A）；配音溢出顺延漂移（D）；视频抽帧视觉增强做成开关（方案二）。
9. 会议模式：全场统一目标语言（A）；always 每句实时复刻；持久 session + 自动轮换；热座串行状态机。
