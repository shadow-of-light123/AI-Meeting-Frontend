# 语音输入（ASR）完整实现指南

> 本文基于本项目（码上面试平台前端）的实际代码，详细讲解语音输入（自动语音识别 ASR）的完整实现。
> 阅读完本文后，你将能理解从麦克风采集、WebSocket 传输到实时字幕显示的全链路。

---

## 目录

1. [整体架构](#1-整体架构)
2. [数据流总览](#2-数据流总览)
3. [麦克风 PCM 流采集](#3-麦克风-pcm-流采集)
4. [WebSocket 传输层](#4-websocket-传输层)
5. [转写结果状态机](#5-转写结果状态机)
6. [核心控制器](#6-核心控制器)
7. [UI 集成](#7-ui-集成)
8. [语音播放（TTS）](#8-语音播放tts)
9. [完整数据流示例](#9-完整数据流示例)
10. [面试场景中的集成](#10-面试场景中的集成)
11. [文件清单与职责](#11-文件清单与职责)

---

## 1. 整体架构

语音输入系统分为**五层**，每层各司其职：

```
┌─────────────────────────────────────────────────────────────────────┐
│                         UI 层                                        │
│  MicrophoneControl（通用麦克风按钮组件）                              │
│  SmartComposer（聊天输入框 + 语音按钮）                              │
│  InterviewSketchpadSheet（面试草稿板 + 语音按钮）                    │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────────┐
│                     Hook 控制器层                                    │
│  useAudioTranscriptionController（核心控制器，组装所有子模块）       │
│    ├── useReducer：管理 liveText / finalText 状态机                  │
│    ├── useMicrophonePcmStream（麦克风 PCM 流采集 → Float32→PCM16）  │
│    └── useAudioTranscriptionTransport（WebSocket 连接管理）         │
│  useAudioToText（简单的 Redux 封装，从 store 取 userId）             │
│  useAudioToTextComposerBridge（录音文本 → 输入框合并）              │
└──────────────────────┬──────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────────┐
│                    Service 层                                       │
│  AudioToTextWebSocket 类（WebSocket 客户端）                         │
│    ├── sendAudio(data)：发送二进制 PCM16 音频                        │
│    ├── handleMessage()：接收 JSON 转写结果并分发                     │
│    ├── 心跳保活（每 15s ping）                                       │
│    ├── 连接中排队（最多 24 chunk 的滑动窗口）                        │
│    └── 消息去重（timestamp + key 双防线）                            │
└──────────────────────┬──────────────────────────────────────────────┘
                       │  WebSocket
┌──────────────────────▼──────────────────────────────────────────────┐
│                     后端 / 讯飞 ASR                                  │
│  讯飞语音转写服务：实时返回音频转文字结果                            │
│  （中间结果 replace + 最终结果 archive）                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 数据流总览

```
麦克风采集 (getUserMedia)
       │  Float32 PCM
       ▼
ScriptProcessorNode.onaudioprocess
       │  Float32 → PCM16（Int16Array）
       │  每 640 个采样拆一个 chunk
       ▼
AudioToTextWebSocket.sendAudio(chunk)
       │  binary WebSocket frame
       ▼
后端 / 讯飞 ASR 服务
       │  JSON { type, data, timestamp }
       ▼
AudioToTextWebSocket.onmessage
       │  resolveAudioTranscriptionEvent() 解析为结构化事件
       ▼
      handleMessage() 分发
       │
       ├── reset       → 清空 liveText
       ├── replace     → 更新 liveText（实时中间结果，不断修正）
       ├── archive     → 追加到 finalText（一句识别完成，已确认）
       └── error       → 通知 UI 报错
       │
       ▼
useAudioTranscriptionController 中的 useReducer
       │  AudioTranscriptionState { liveText, finalText }
       ▼
getMergedAudioTranscription(state) → `${finalText}\n\n${liveText}`
       │
       ▼
SmartComposerView 显示转录文本
```

---

## 3. 麦克风 PCM 流采集

**文件**：`src/hooks/audio/useMicrophonePcmStream.ts`

### 3.1 作用

打开麦克风 → 采集音频流 → 转换为 PCM16 格式 → 按固定大小拆分 chunk → 回调发送

### 3.2 核心实现

```typescript
export function useMicrophonePcmStream({ sampleRate, onChunk, onError }) {
  const start = useCallback(async () => {
    // 1. 获取麦克风流：16kHz 单声道
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate },
    });

    // 2. 创建 AudioContext
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioContextCtor({ sampleRate });

    // 3. 将麦克风流连接到 ScriptProcessorNode
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1); // buffer:4096, 1ch in, 1ch out

    // 4. 处理音频数据
    processor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0); // Float32Array
      const pcm16Data = new Int16Array(inputData.length);

      // Float32(-1~1) → PCM16(-32768~32767)
      for (let i = 0; i < inputData.length; i++) {
        const sample = Math.max(-1, Math.min(1, inputData[i]));
        pcm16Data[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }

      // 每 640 个采样拆一个 chunk 发送（640 samples = 40ms at 16kHz）
      for (let offset = 0; offset < pcm16Data.length; offset += 640) {
        const end = Math.min(offset + 640, pcm16Data.length);
        const chunk = pcm16Data.subarray(offset, end);
        onChunkRef.current(chunk.buffer); // ArrayBuffer → WebSocket.send()
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
  }, [sampleRate]);

  const stop = useCallback(async () => {
    // 清理：断开节点、停止所有轨道、关闭 AudioContext
    processor?.disconnect();
    source?.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await audioContext.close();
  }, []);
}
```

### 3.3 关键参数

| 参数            | 值              | 说明                                   |
| --------------- | --------------- | -------------------------------------- |
| `sampleRate`    | `16000` (16kHz) | 电话语音质量标准，讯飞 ASR 推荐        |
| `channelCount`  | `1` (单声道)    | 语音识别通常使用单声道                 |
| 每个 chunk 大小 | `640` 采样      | 16kHz × 40ms = 640 个采样/帧           |
| 每次回调        | `4096` 采样     | ScriptProcessorNode 的 buffer 大小     |
| 编码格式        | PCM16 (Int16)   | 16 位有符号整数，Web Audio 原生支持    |
| 数据类型        | `ArrayBuffer`   | 通过 WebSocket.send() 直接发送二进制帧 |

### 3.4 转换说明：Float32 → PCM16

```
麦克风输出: Float32Array [-1, 1]
                       │
                       ▼
         样本值 × 32767（16 位有符号整数范围）
                       │
                       ▼
         正数 → × 0x7FFF（32767）
         负数 → × 0x8000（-32768）
                       │
                       ▼
         Int16Array [-32768, 32767]
                       │
                       ▼
         ArrayBuffer → WebSocket 二进制帧
```

---

## 4. WebSocket 传输层

**文件**：`src/services/audioToTextWs.ts`

### 4.1 作用

管理 WebSocket 连接生命周期：

- 建立连接（URL 中带 Token 认证）
- 发送二进制音频数据
- 接收 JSON 转写结果并分发
- 心跳保活（防止连接被断开）
- 连接中音频排队（不丢数据）
- 消息去重（防止重复渲染）

### 4.2 连接 URL

```typescript
// URL 结构
ws://localhost:8002/api/xunzhi/v1/xunfei/audio-to-text/{userId}?token={authToken}
```

WebSocket 不能设置自定义 HTTP 请求头，所以 Token 通过 URL 查询参数传递。

### 4.3 连接生命周期

```
connect()
    │
    ├── new WebSocket(url)
    │
    ├── onopen（TCP 连接建立）
    │       ├── 发送排队中的音频（flushPendingBinaryQueue）
    │       └── 启动心跳定时器（startPing）
    │
    ├── onmessage（收到服务端消息）
    │       └── JSON.parse → handleMessage() → 分发到对应回调
    │
    ├── onerror（连接出错）
    │       └── 通知调用方
    │
    └── onclose（连接断开）
            ├── 停止心跳
            ├── 判断是否非正常断开
            └── 清理状态
```

### 4.4 音频数据排队

WebSocket 的 `connect()` 是异步的，调用方可能在连接**还在握手**（`CONNECTING`）时就开始发送音频。为了避免数据丢失：

```typescript
sendAudio(data: Blob | ArrayBuffer) {
  if (this.ws?.readyState === WebSocket.OPEN) {
    // 连接已就绪 → 直接发送
    this.ws.send(data);
  } else if (this.ws?.readyState === WebSocket.CONNECTING) {
    // 连接尚未建立 → 入队等待
    // 队列满时移除最旧的 chunk（滑动窗口），优先保留最近的数据
    if (this.pendingBinaryQueue.length >= this.maxPendingBinaryChunks) {
      this.pendingBinaryQueue.shift();
    }
    this.pendingBinaryQueue.push(data);
  }
}
```

| 参数                     | 值       | 说明                                  |
| ------------------------ | -------- | ------------------------------------- |
| `maxPendingBinaryChunks` | `24`     | 最多缓存 24 个 chunk（约 960ms 音频） |
| 满队列策略               | 移除最旧 | 滑动窗口，优先保留最新数据            |

### 4.5 消息去重

后端可能因网络重传等原因发送重复消息。使用**两层防线**去重：

```typescript
shouldApplyEvent(message, event) {
  const text = event.text ?? event.message ?? "";
  const nextKey = `${event.kind}:${message.type}:${text}`;
  const nextTimestamp = message.timestamp;

  // 第一层：timestamp 防线
  if (nextTimestamp !== null) {
    // 乱序：比已处理消息更旧 → 丢弃
    if (nextTimestamp < this.lastMessageTimestamp) return false;
    // 重复：同一 timestamp + 同一内容 → 丢弃
    if (nextTimestamp === this.lastMessageTimestamp && nextKey === this.lastMessageKey) return false;
    this.lastMessageTimestamp = nextTimestamp;
    this.lastMessageKey = nextKey;
    return true;
  }

  // 第二层：key 防线（无 timestamp 时）
  if (nextKey === this.lastMessageKey) return false;
  this.lastMessageKey = nextKey;
  return true;
}
```

### 4.6 心跳保活

```typescript
startPing() {
  this.pingInterval = setInterval(() => {
    this.sendCommand("ping");  // 每 15 秒发送一次
  }, 15000);
}

sendCommand(type) {
  if (this.ws?.readyState === WebSocket.OPEN) {
    this.ws.send(JSON.stringify({ type }));
  }
}
```

支持的命令类型：

| 命令                  | 用途               |
| --------------------- | ------------------ |
| `ping`                | 心跳探测           |
| `start_transcription` | 通知服务端开始转写 |
| `stop_transcription`  | 通知服务端停止转写 |
| `get_status`          | 查询当前转写状态   |

---

## 5. 转写结果状态机

**文件**：`src/lib/audioTranscription.ts`

### 5.1 消息 → 事件解析

```typescript
// 服务端原始消息结构
type AudioToTextIncomingMessage = {
  type?: string; // 消息类型（"transcription", "final", "connected" 等）
  message?: string; // 文本或错误信息
  data?: string; // 转写文本内容
  isSnapshot?: boolean; // 是否为快照
  updateAction?: string; // 更新动作（"replace", "archive"）
  timestamp?: number; // 消息时间戳（用于去重）
};

// 解析为结构化事件
type AudioTranscriptionEvent =
  | { kind: "reset" } // 新一轮转写开始
  | { kind: "replace"; text: string } // 中间结果（实时，会修正）
  | { kind: "archive"; text: string } // 最终结果（已确认）
  | { kind: "connected" } // 业务层握手完成
  | { kind: "control" } // 控制确认消息
  | { kind: "heartbeat" } // 心跳响应
  | { kind: "error"; message: string } // 错误
  | { kind: "unknown"; type?: string }; // 未识别
```

解析映射（`resolveAudioTranscriptionEvent`）：

```typescript
// 根据原始消息的 type 和 updateAction 判断事件类型
message.updateAction === "replace" || message.type === "transcription" → { kind: "replace", text }
message.updateAction === "archive" || message.type === "final"       → { kind: "archive", text }
message.type === "connected"                                          → { kind: "connected" }
message.type === "transcription_started"                              → { kind: "reset" }
message.type === "transcription_stopped" || "status"                  → { kind: "control" }
message.type === "heartbeat" || "pong"                                → { kind: "heartbeat" }
message.type === "error"                                              → { kind: "error", message }
其他                                                                  → { kind: "unknown" }
```

### 5.2 状态机

```typescript
type AudioTranscriptionState = {
  liveText: string; // 当前正在说的实时文本（不断被 replace 覆盖更新）
  finalText: string; // 已归档的最终结果（一句一句累积）
};

const initialState = { liveText: "", finalText: "" };
```

状态变迁逻辑（`reduceAudioTranscriptionState`）：

```
reset 事件:
  state → { liveText: "", finalText: "" }
  说明：新一轮转写开始，清空所有

replace 事件（收到新的中间结果）:
  state.liveText = event.text (替换为最新识别结果)
  state.finalText 不变
  说明：说话过程中不断更新的实时字幕，上一条中间结果被完全替换

archive 事件（一句话识别完成）:
  将 archivedText merge 到 finalText 尾部
  state.liveText = "" (清空当前实时文本)
  说明：一句话说完，确认结果追加到历史，等待下一句
```

### 5.3 文本合并

```typescript
// finalText 和 liveText 的合并逻辑
export const getMergedAudioTranscription = (state) =>
  mergeDistinctTranscription(state.finalText, state.liveText);

// 去重合并——避免在最终结果和实时结果重叠时出现重复文本
mergeDistinctTranscription(base, next) {
  if (base.includes(next)) return base;     // 实时结果是最终结果的子集
  if (next.includes(base)) return next;     // 最终结果是实时结果的子集
  return `${base}\n\n${next}`;              // 两句不同，拼接
}
```

---

## 6. 核心控制器

**文件**：`src/hooks/audio/useAudioTranscriptionController.ts`

### 6.1 作用

将麦克风采集、WebSocket 传输、状态机三者组装在一起，对外暴露简单的 `startRecording` / `stopRecording` + 转录文本。

### 6.2 结构

```typescript
export function useAudioTranscriptionController(currentUser) {
  // 1. 转写结果状态（useReducer）
  const [transcriptionState, dispatchTranscription] = useReducer(
    reduceAudioTranscriptionState,
    createInitialAudioTranscriptionState,
  );

  // 2. 传输层（WebSocket 连接管理）
  const { connect, disconnect, sendAudioChunk } =
    useAudioTranscriptionTransport({
      userId: resolveAudioUserId(currentUser),
      onReplace: (text) => dispatchTranscription({ kind: "replace", text }),
      onArchive: (text) => dispatchTranscription({ kind: "archive", text }),
      onError: (message) => {
        setError(message);
        cleanup();
      },
    });

  // 3. 麦克风流（PCM 采集 + 发送）
  const stream = useMicrophonePcmStream({
    sampleRate: 16000,
    onChunk: sendAudioChunk, // ← 每个音频 chunk 直接发 WebSocket
  });

  // 4. 开始录音
  const startRecording = useCallback(async () => {
    connectTransport(); // 建立 WebSocket
    await startStream(); // 打开麦克风
    setIsRecording(true);
  }, []);

  // 5. 停止录音
  const stopRecording = () => cleanup();

  // 6. 对外暴露
  return {
    isRecording,
    currentSentence: transcriptionState.liveText, // 当前实时字幕
    historySentences: transcriptionState.finalText.split("\n\n"), // 已确认的句子列表
    transcription: getMergedAudioTranscription(transcriptionState), // 全部文本
    error,
    startRecording,
    stopRecording,
  };
}
```

### 6.3 竞态处理

使用 `Symbol("audio-transcription-start")` 作为 token，防止快速点击开始/停止导致的状态混乱：

```typescript
const startRecording = async () => {
  const startToken = Symbol("audio-transcription-start");
  activeStartTokenRef.current = startToken;

  connectTransport();
  await startStream();

  // 如果在等待过程中被取消了（用户又点了一次停止），则不设置 isRecording
  if (activeStartTokenRef.current !== startToken) {
    return;
  }
  setIsRecording(true);
};
```

---

## 7. UI 集成

### 7.1 通用的麦克风按钮组件

**文件**：`src/components/audio/MicrophoneControl.tsx`

```typescript
export default function MicrophoneControl({
  disabled, onStart, onStop, onError,
}: MicrophoneControlProps) {
  const { isRecording, level, toggle } = useMicrophoneRecording({
    onStart, onStop, onError,
  });

  return (
    <Button onClick={toggle} disabled={disabled}>
      {/* 录音中：显示脉冲动画 + 音量波纹 */}
      {isRecording && (
        <>
          <span className="animate-ping border-red-500" />
          <span style={{ transform: `scale(${1 + level * 0.8})` }} />
        </>
      )}
      <Mic className="h-5 w-5" />
    </Button>
  );
}
```

### 7.2 聊天输入框集成

**文件**：`src/components/chat/SmartComposer.tsx`

```typescript
function SmartComposer({ value, onChange, onSend }) {
  const { isRecording, transcription, error, startRecording, stopRecording }
    = useAudioToText();  // ← 从 Redux 取 userId，调用 useAudioTranscriptionController

  // 自动将语音转写结果合并到输入框
  useAudioToTextComposerBridge({
    enabled: showVoiceButton,
    isRecording,
    transcription,  // ← 实时字幕
    value,          // ← 输入框已有文本
    onChange,       // ← 更新输入框
  });

  const handleMicClick = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  return <SmartComposerView onMicClick={handleMicClick} />;
}
```

### 7.3 语音文本合并逻辑

**文件**：`src/hooks/useAudioToText.ts`

```typescript
export function useAudioToTextComposerBridge({
  enabled,
  isRecording,
  transcription,
  value,
  onChange,
}) {
  const baseInputRef = useRef("");

  // 1. 开始录音时：缓存输入框已有内容
  useEffect(() => {
    if (isRecording && !prevRecordingRef.current) {
      baseInputRef.current = value; // 把输入框里已有文字存起来
    }
  }, [isRecording, value]);

  // 2. 收到转写文本时：合并到输入框
  useEffect(() => {
    if (!isRecording || !transcription) return;

    const base = baseInputRef.current;
    const separator = base && !base.endsWith("\n") ? "\n" : "";
    const merged = `${base}${separator}${transcription}`;

    if (merged !== value) {
      onChange(merged); // 实时更新输入框
    }
  }, [isRecording, transcription]);
}
```

**效果**：你开始在输入框打字"请问"，然后点麦克风说"今天的天气怎么样"——输入框实时显示"请问\n今天的天气怎么样"。

### 7.4 音量可视化

`useMicrophoneRecording` 使用 **AnalyserNode** 计算 RMS 音量：

```typescript
const analyser = audioContext.createAnalyser();
analyser.fftSize = 256;
analyser.smoothingTimeConstant = 0.85;

const data = new Uint8Array(analyser.fftSize);
const update = (time) => {
  analyser.getByteTimeDomainData(data);
  // 计算 RMS（均方根）
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const value = (data[i] - 128) / 128;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / data.length);
  setLevel(rms); // ← 用于控制波纹动画的缩放比例
  rafRef.current = requestAnimationFrame(update);
};
```

---

## 8. 语音播放（TTS）

### 8.1 讯飞 TTS 服务

**文件**：`src/services/xunfeiTtsService.ts`

```typescript
const service = {
  // 创建合成任务
  async createTask(params) {
    return service.post("/xunzhi/v1/xunfei/tts/tasks", params);
  },

  // 查询任务状态
  async queryTask(taskId) {
    return service.get(`/xunzhi/v1/xunfei/tts/tasks/${taskId}`);
  },

  // 同步合成（创建任务 + 等待完成 + 返回音频）
  async synthesize(params) {
    const task = await service.post("/xunzhi/v1/xunfei/tts/synthesize", params);
    // 返回：{ audioBase64, audioUrl, completed, success }
  },
};
```

### 8.2 播放流程

**文件**：`src/hooks/audio/useChatTtsPlayback.ts`

```
ChatList 组件读取 messages
        │
        ▼
useChatTtsPlayback(messages) — 检测新的 AI 消息
        │
        ▼
useChatTtsAudioCache — 缓存已有音频，检测新消息
        │
        ▼
xunfeiTtsService.synthesize({ text: ai回复内容 })
        │
        ▼
返回 audioBase64 → 解码为 Blob
        │
        ▼
useChatTtsAudioElement — 创建 HTMLAudioElement 播放
```

---

## 9. 完整数据流示例

### 9.1 用户说"今天天气怎么样"的完整链路

```
用户说"今天天气怎么样"
    │
    ▼
麦克风采集 PCM16 音频 → 每 40ms 发送一个 chunk
    │  WS send(binary)
    ▼
服务端返回（连续多次）：
    │
    ├── { type: "transcription_started" }          → reset → 清空 liveText
    ├── { type: "transcription", data: "今" }      → replace → liveText = "今"
    ├── { type: "transcription", data: "今天" }    → replace → liveText = "今天"
    ├── { type: "transcription", data: "今天天" }  → replace → liveText = "今天天"
    ├── { type: "transcription", data: "今天天气" } → replace → liveText = "今天天气"
    ├── { type: "transcription", data: "今天天气怎么" } → replace → liveText = "今天天气怎么"
    ├── { type: "transcription", data: "今天天气怎么样" } → replace → liveText = "今天天气怎么样"
    │
    ├── { type: "final", data: "今天天气怎么样" }   → archive → finalText追加, liveText清空
    │                                                     → mergedText = "今天天气怎么样"
    │
    ▼
SmartComposer — onChange("今天天气怎么样") → 输入框实时显示
```

### 9.2 时序图

```
用户         麦克风      AudioToTextWebSocket       后端/讯飞      SmartComposer
 │             │                  │                   │               │
 │  按下麦克风按钮                │                   │               │
 │────────────▶ startRecording() │                   │               │
 │             │                  │                   │               │
 │             │ connect()       │                   │               │
 │             │────────────────▶│  WS connect       │               │
 │             │                  │──────────────────▶│               │
 │             │                  │  connected        │               │
 │             │                  │◀──────────────────│               │
 │             │  startStream()   │  start_transcription              │
 │             │────────────────▶ │──────────────────▶│               │
 │             │                  │                   │               │
 │  说"今天天气怎么样"           │                   │               │
 │             │                  │                   │               │
 │             │ onaudioprocess   │                   │               │
 │             │ PCM16 chunk     │                   │               │
 │             │────────────────▶│  WS send(binary)  │               │
 │             │                  │──────────────────▶│               │
 │             │                  │                   │               │
 │             │                  │  JSON replace "今"               │
 │             │                  │◀──────────────────│               │
 │             │                  │  dispatch replace │               │
 │             │                  │───────────────────│─ → liveText="今"
 │             │                  │                   │               │
 │             │                  │  JSON replace "今天"              │
 │             │                  │◀──────────────────│               │
 │             │                  │  dispatch replace │               │
 │             │                  │───────────────────│─ → liveText="今天"
 │             │                  │                   │               │
 │  ...更多 replace ...          │                   │               │
 │             │                  │                   │               │
 │             │                  │  JSON final "今天天气怎么样"       │
 │             │                  │◀──────────────────│               │
 │             │                  │  dispatch archive │               │
 │             │                  │───────────────────│─ → finalText  │
 │             │                  │                   │               │
 │  输入框实时显示"今天天气怎么样"                                    │
 │◀────────────────────────────────────────────────────────────────────│
 │                                                                     │
 │  按下发送按钮                                                       │
 │─────────────▶ handleSend("今天天气怎么样")                         │
```

---

## 10. 面试场景中的集成

除了聊天场景，语音输入也集成在**面试答题草稿板**中：

**文件**：`src/components/interview/sketchpad/useInterviewSketchpadTranscription.ts`

```typescript
export function useInterviewSketchpadTranscription() {
  const { isRecording, transcription, error, startRecording, stopRecording } =
    useAudioToText();

  return {
    isRecording,
    transcription,
    error,
    isTranscribing: isRecording && Boolean(transcription),
    toggleRecording: () => {
      if (isRecording) stopRecording();
      else startRecording();
    },
  };
}
```

面试场景中，用户可以在答题时用语音输入代替打字，语音转写结果直接填入回答框。

---

## 11. 文件清单与职责

### 核心文件

| 文件                                             | 职责                                            | 代码量  |
| ------------------------------------------------ | ----------------------------------------------- | ------- |
| `services/audioToTextWs.ts`                      | WebSocket 客户端（连接、心跳、发送、去重）      | ~560 行 |
| `lib/audioTranscription.ts`                      | 消息解析、状态机、去重合并                      | ~160 行 |
| `hooks/audio/useMicrophonePcmStream.ts`          | 麦克风 PCM 采集、Float32→PCM16 转换、chunk 拆分 | ~130 行 |
| `hooks/audio/useAudioTranscriptionTransport.ts`  | WebSocket 连接管理 Hook                         | ~90 行  |
| `hooks/audio/useAudioTranscriptionController.ts` | 核心控制器（组装各模块）                        | ~160 行 |
| `hooks/audio/useMicrophoneRecording.ts`          | 精简版麦克风控制 + 音量可视化（AnalyserNode）   | ~130 行 |

### 辅助与集成文件

| 文件                                                                   | 职责                                        |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| `hooks/useAudioToText.ts`                                              | Redux 封装（取 userId）+ 输入框文本合并桥接 |
| `components/audio/MicrophoneControl.tsx`                               | 通用的麦克风按钮 UI 组件                    |
| `components/chat/SmartComposer.tsx`                                    | 聊天输入框集成麦克风按钮 + 实时字幕         |
| `components/interview/sketchpad/useInterviewSketchpadTranscription.ts` | 面试草稿板集成                              |

### TTS（语音合成）文件

| 文件                                    | 职责                                       |
| --------------------------------------- | ------------------------------------------ |
| `services/xunfeiTtsService.ts`          | 讯飞 TTS 服务（创建任务、查询、同步合成）  |
| `hooks/audio/chatTtsPlayback.shared.ts` | TTS 播放共享逻辑（音频缓存、状态定义）     |
| `hooks/audio/useChatTtsAudioCache.ts`   | TTS 音频缓存管理                           |
| `hooks/audio/useChatTtsAudioElement.ts` | HTMLAudioElement 播放控制                  |
| `hooks/audio/useChatTtsPlayback.ts`     | TTS 播放主 Hook（监听消息变化 → 自动播放） |

---

## 附录：快速参考卡片

### 音频参数

| 参数       | 值              |
| ---------- | --------------- |
| 采样率     | `16000` Hz      |
| 声道       | 单声道 (1ch)    |
| 编码       | PCM16 (Int16)   |
| Chunk 大小 | 640 采样 = 40ms |
| 心跳间隔   | 15 秒           |

### 消息事件类型

| kind        | 来源                                     | 含义           | 对 liveText 的影响                 |
| ----------- | ---------------------------------------- | -------------- | ---------------------------------- |
| `reset`     | `transcription_started`                  | 新一轮转写开始 | `liveText = ""`                    |
| `replace`   | `transcription` / `updateAction=replace` | 中间结果       | `liveText = 新文本`                |
| `archive`   | `final` / `updateAction=archive`         | 最终确认       | `finalText += 文本, liveText = ""` |
| `connected` | `connected`                              | 业务层握手完成 | 无                                 |
| `error`     | `error`                                  | 服务端报错     | 无                                 |

### 一个录音会话的完整生命周期

```
createController(user)
        │
    startRecording()
        │
        ├── connectTransport()       → 创建 WebSocket
        ├── startStream()             → getUserMedia + AudioContext
        │
        ├── 收到 connected            → sendCommand("start_transcription")
        │
        ├── [循环] onaudioprocess     → Float32→PCM16 → sendAudio(chunk)
        │         │
        │         └── WS 收到 replace → reduce(liveText) → UI 更新实时字幕
        │         └── WS 收到 archive → reduce(finalText) → UI 追加确认文字
        │
        └── stopRecording()
                │
                ├── sendCommand("stop_transcription")
                ├── disconnectTransport()
                └── stopStream()       → 关闭麦克风 + AudioContext
```
