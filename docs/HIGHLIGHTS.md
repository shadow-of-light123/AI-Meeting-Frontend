# 码上面试平台 · 前端项目难点与亮点分析

> 基于 React 19 + TypeScript 5.9 + Vite 7 的 AI 模拟面试与智能对话平台

---

## 一、难点 (Technical Challenges)

### 1.1 请求去重与防抖引擎 (`src/lib/request.ts`)

这是项目中最复杂的纯工程模块，约 650 行代码，实现了一套完整的 HTTP 请求治理体系。面对的核心问题是：在一个 AI 对话应用中，同一时刻可能有多个组件或 Hook 发起参数相同的请求，或在用户快速操作时产生重复提交——需要一个统一的管道来管理并发、去重和防抖。

#### 1.1.1 四种策略在一个管道中编排

```typescript
// 策略枚举（非字面量，而是内联在 RequestPolicy 中）
type RequestPolicy = {
  dedupe: "join" | "cancel-previous" | "reject" | "off";
  debounceMs?: number;
  key?: string; // 自定义请求 Key，覆盖自动序列化
};
```

| 策略                | 行为                                                         | 默认适用场景          | 典型调用方                        |
| ------------------- | ------------------------------------------------------------ | --------------------- | --------------------------------- |
| `"join"`            | 并发相同请求合并为一次网络调用，所有调用者共享同一个 Promise | GET 请求              | 会话列表、模型列表、历史消息      |
| `"cancel-previous"` | 新的同 Key 请求发起时，自动 abort 前一个进行中的请求         | 需要最新数据的查询    | 搜索结果、实时过滤                |
| `"reject"`          | 检测到重复请求时直接拒绝，返回错误                           | 幂等性敏感操作        | 面试答题提交（`debounceMs: 250`） |
| `"off"`             | 不作任何干预，每次调用都发起独立请求                         | POST/PUT/PATCH/DELETE | 登录、登出、创建会话              |

调度管道（五个环节依次执行）：

```
组件 → service → executeWithPolicy → withDebounce → withInflightDedup → axios.request
                      │                   │                 │
                      │  解析 requestPolicy  │  防抖窗口期内     │  根据 dedupe 策略
                      │  确定策略和 debounce │  收集调用者       │  决定如何处理重复
                      │                     │  定时器触发后批量决议  │
```

#### 1.1.2 稳定的请求 Key 序列化 (`stableSerialize`)

去重的前提是能判断两个请求是否"相同"。`stableSerialize()` 函数负责将任意 JavaScript 值序列化为稳定的字符串 Key，处理了以下边界情况：

- **循环引用**：通过 `WeakSet` 追踪已访问对象，检测到循环时返回 `"[Circular]"`
- **Date 对象**：转为 ISO 字符串（`"2025-01-01T00:00:00.000Z"`），保证同一时刻的 Date 对象 Key 相同
- **URLSearchParams**：转为 `"?key=value&..."` 格式（而非 `"[object URLSearchParams]"`）
- **FormData**：按 key 排序后拼接所有键值对
- **对象**：`Object.keys().sort()` 后逐键序列化，确保 `{a:1,b:2}` 和 `{b:2,a:1}` 生成相同的 Key
- **数组**：递归序列化每个元素用逗号拼接
- **基本类型**：直接 `String()` 转换
- **null/undefined**：分别返回 `"null"` / `"undefined"`

```typescript
// 请求 Key 的组成 = method + url + 序列化后 params + 序列化后 data + 自定义 key
const requestKey = `${method}:${url}:${serializedParams}:${serializedData}`;
if (customKey) requestKey = `${requestKey}:${customKey}`;
```

#### 1.1.3 防抖的批量消费者模式 (`withDebounce`)

不同于 `lodash.debounce` 的"最后一次获胜"模式，`withDebounce` 实现了**批量决议**：

1. 防抖窗口期内的第一个调用者创建 `DebounceRequestEntry`，其中包含 `resolvers[]` 数组
2. 后续调用者被追加到 `resolvers[]` 数组中，等待统一决议
3. 定时器触发后，单次 `run()` 调用遍历所有 `resolvers`，逐个 resolve 或 reject
4. 每个调用者仍然能获得属于自己的结果（共享的 Promise 被分发）

```typescript
// 简化后的核心逻辑
const withDebounce = <T>(requestKey, debounceMs, run) => {
  const existing = debounceRequestMap.get(requestKey);
  if (existing) {
    // 已有等待中的防抖请求，加入队列
    return new Promise<T>((resolve, reject) =>
      existing.resolvers.push({ resolve, reject }),
    );
  }

  // 第一个调用者：创建 entry，启动定时器
  const entry = { resolvers: [], timer: null };
  entry.timer = setTimeout(() => {
    const active = debounceRequestMap.get(requestKey);
    debounceRequestMap.delete(requestKey);
    run().then(
      (result) => active.resolvers.forEach((r) => r.resolve(result)),
      (error) => active.resolvers.forEach((r) => r.reject(error)),
    );
  }, debounceMs);

  debounceRequestMap.set(requestKey, entry);
  return new Promise<T>((resolve, reject) =>
    entry.resolvers.push({ resolve, reject }),
  );
};
```

#### 1.1.4 AbortSignal 跨层传播 (`bindAbortSignal`)

在去重管道中，调用者传入的 `AbortSignal`、去重层内部的 `AbortController` 和 Axios 的 cancel token 三者需要联动：

- 调用者 abort → 去重层内部 `AbortController` 同时 abort → Axios 请求取消
- 去重策略 `cancel-previous` 触发 → 旧的 `AbortController` abort → 旧 Axios 请求取消
- `bindAbortSignal` 通过 `signal.addEventListener("abort", ...)` 建立双向绑定

#### 1.1.5 三层 Map 状态一致性

去重引擎同时维护三张全局 Map：

```typescript
const inflightRequestMap = new Map<string, InflightRequestEntry>(); // 进行中请求
const debounceRequestMap = new Map<string, DebounceRequestEntry>(); // 防抖等待队列
const abortControllerMap = new Map<string, AbortController>(); // 取消控制器
```

三个 Map 必须保持一致性：请求完成或失败后需从对应 Map 中删除，防止内存泄漏。`inflightRequestMap` 的 entry 中包含 `cleanup` 回调，在请求完成时自动清理。

---

### 1.2 会话创建与消息发送的竞态互锁 (`useChatSendFlow.ts`)

这是项目中并发控制最复杂的 Hook，约 550 行代码。核心难点在于：**新建会话是一个异步过程，而消息发送依赖会话 ID，两者之间存在一个"路由尚未同步"的时间窗口**。

#### 1.2.1 问题场景

用户在聊天页面 `/chat`（无 sessionId）输入消息并点击发送：

```
时刻 T0：用户点击"发送"
时刻 T1：dispatch(appendUserMessage) → 乐观更新 UI（消息已显示在列表中）
时刻 T2：dispatch(appendAssistantPlaceholder) → 空的 AI 气泡就位
时刻 T3：调用 createConversation() → 后端创建会话
         └─ 网络延迟可能在 200ms ~ 2s
时刻 T4：createConversation 返回 { sessionId: "abc" }
时刻 T5：navigate(`/chat/abc`) → URL 从 /chat 变为 /chat/abc
时刻 T6：React Router 完成内部状态更新 → routeSessionId 从 null 变为 "abc"
时刻 T7：pendingOutbound useEffect 检测到条件就绪 → 发起 SSE 流式请求
```

如果在 T3-T7 之间用户又点击了发送，必须阻止重复创建会话。

#### 1.2.2 Pending Outbound 延迟发送模式

```typescript
// sendMessage 中 —— 无可用 sessionId 时的分支
if (!activeSessionId) {
  const response = await aiService.createConversation({...});

  // 写入 Redux：会话信息
  dispatch(setChatRuntimeSession({ sessionId, title }));

  // 替换 URL
  navigateToSession(activeSessionId, { replace: true });

  // 刷新侧边栏会话列表
  await queryClient.invalidateQueries({ queryKey: ["conversations"] });

  // ★ 关键：不在此处直接调用 streamMessage，而是暂存为 pendingOutbound
  dispatch(setPendingOutbound({ requestId, sessionId, assistantMessageId, content, aiId }));
  return;  // ← 函数返回，由 useEffect 接管后续
}
```

```typescript
// useEffect —— 消费 pendingOutbound，三个条件全部满足才触发
useEffect(() => {
  if (!pendingOutbound || isStreaming) return;
  if (routeSessionId !== pendingOutbound.sessionId) return; // URL 还没同步
  if (currentSessionId !== pendingOutbound.sessionId) return; // Redux 还没同步

  dispatch(setPendingOutbound(null)); // 清除 pending
  void streamMessage(pendingOutbound); // 发起 SSE
}, [currentSessionId, isStreaming, pendingOutbound, routeSessionId]);
```

#### 1.2.3 三层取消协议

每一层独立且互备，任意一层失效都不会导致数据污染：

| 层级   | 机制                      | 作用范围                | 失效后果（若无此层）                |
| ------ | ------------------------- | ----------------------- | ----------------------------------- |
| 第一层 | `AbortController.abort()` | 中断底层 HTTP SSE 连接  | 旧连接的 chunk 继续到达             |
| 第二层 | `activeRequestIdRef` 门禁 | 每个 SSE 回调执行前校验 | 旧 chunk 写入新会话消息列表         |
| 第三层 | `cancelActiveStreamRef`   | useEffect cleanup 兜底  | 组件卸载后残留的定时器继续 dispatch |

```typescript
// 第二层的核心实现 —— isActiveRequest 闭包
const isActiveRequest = () =>
  activeRequestIdRef.current === outbound.requestId &&
  abortControllerRef.current === abortController;

// SSE 每个回调中都先过这个门禁
onMessage: (chunk) => {
  if (!isActiveRequest()) return;  // ← 旧请求的 chunk 在这里被丢弃
  contentLimiter?.push(chunk);
},
```

#### 1.2.4 过期的 pendingOutbound 清理

用户快速从新会话页跳转到已有会话时，pending 的消息应被废弃：

```typescript
useEffect(() => {
  if (!pendingOutbound || !routeSessionId) return;
  if (routeSessionId === pendingOutbound.sessionId) return; // 正常情况

  // routeSessionId 与 pendingOutbound.sessionId 不匹配 → 用户已跳走
  dispatch(finishAssistantMessage({ id: pendingOutbound.assistantMessageId }));
  dispatch(setPendingOutbound(null));
}, [dispatch, pendingOutbound, routeSessionId]);
```

---

### 1.3 WebSocket 音频流的连接态缓冲与消息去重 (`audioToTextWs.ts`)

语音转写是一个对实时性和完整性要求极高的场景：用户说话 → 录音 → PCM16 编码 → WebSocket 发送 → 服务端转写 → 返回文本。`AudioToTextWebSocket` 类封装了整个流程。

#### 1.3.1 连接态缓冲队列

WebSocket 连接建立（TCP 握手 + HTTP Upgrade）需要时间，但用户在按下录音按钮的瞬间就开始说话了。如果在 `onopen` 之前发送音频数据，`send()` 会失败或数据丢失。

```
用户说话 ──────────────────────────────────────────────────
录音采集 ─■─■─■─■─■─■─■─■─■─■─■─■─■─■─■─■─
WebSocket ─ ─ ─ ─[连接中]──[onopen]─────────────────────
缓冲队列 ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ──flush──▶ 按序发送
```

```typescript
sendAudio(data: Blob | ArrayBuffer) {
  if (this.ws?.readyState === WebSocket.OPEN) {
    this.ws.send(data);                        // 已连接：直接发送
  } else if (this.ws?.readyState === WebSocket.CONNECTING) {
    // 连接中：入队等待，上限 24 块
    if (this.pendingBinaryQueue.length >= this.maxPendingBinaryChunks) {
      this.pendingBinaryQueue.shift();          // FIFO，溢出时丢弃最旧的
    }
    this.pendingBinaryQueue.push(data);
  }
}

// onopen 回调中立即清空队列
this.ws.onopen = () => {
  this.flushPendingBinaryQueue();  // 按入队顺序逐个 send
  this.startPing();
};
```

上限设为 24 块的原因：假设每块 640 个样本（约 40ms 音频），24 块覆盖约 960ms——足以覆盖大部分网络条件下的 WebSocket 建连时间。超出时丢弃最旧的块是权衡：丢开头几个音节比阻塞队列导致后续数据堆积更合理。

#### 1.3.2 双重去重策略

WebSocket 重连或服务端重传可能导致重复的转录事件。`shouldApplyEvent` 采用双重去重：

- **时间戳光标**：每个事件携带 `timestamp`，如果比上次处理的时间戳更旧则丢弃（`<` 比较，非 `<=`——允许同一毫秒内不同内容的事件通过时间戳层）
- **内容指纹 Key**：`event.kind + message.type + text` 组成唯一 Key，连续相同 Key 的事件只保留第一条

```typescript
private shouldApplyEvent(message, event) {
  const text = "text" in event ? event.text : "";
  const nextKey = `${event.kind}:${message.type ?? ""}:${text}`;
  const nextTimestamp = typeof message.timestamp === "number" ? message.timestamp : null;

  if (nextTimestamp !== null) {
    if (nextTimestamp < this.lastMessageTimestamp) return false;  // 更旧 → 丢弃
    if (nextTimestamp === this.lastMessageTimestamp && nextKey === this.lastMessageKey) {
      return false;  // 同一毫秒 + 相同内容 → 重复 → 丢弃
    }
    this.lastMessageTimestamp = nextTimestamp;
    this.lastMessageKey = nextKey;
    return true;
  }

  // 无时间戳时仅依赖内容指纹
  if (nextKey === this.lastMessageKey) return false;
  this.lastMessageKey = nextKey;
  return true;
}
```

#### 1.3.3 15 秒心跳保活

```typescript
private startPing() {
  this.pingInterval = setInterval(() => {
    this.sendCommand("ping");
  }, 15000);  // 15s 间隔，低于大部分代理/网关的 60s 空闲超时
}
```

心跳发送的是 JSON 命令 `{"type":"ping"}`（非 WebSocket 原生 ping 帧）——这样做是为了兼容服务端期望的协议格式。服务端响应 `{"type":"pong"}`，由 `resolveAudioTranscriptionEvent` 解析为 `{ kind: "heartbeat" }` 事件，不影响转录状态。

---

### 1.4 双轨流式渲染——真实 SSE + 客户端模拟流式

项目维护了两套独立的流式渲染基础设施，服务于不同的业务场景：

#### 1.4.1 真实 SSE 流（`aiService.ts`）

基于 `@microsoft/fetch-event-source` 实现，后端通过 SSE 协议持续推送生成内容。

**SSE chunk 格式兼容**：`parseAiStreamChunk` 需要兼容多种 AI 提供商的流格式，优先级从高到低：

```typescript
const parseAiStreamChunk = (raw: string): StreamParseResult => {
  // 1. 纯文本 "[DONE]" → 流结束信号（OpenAI 兼容）
  if (raw.trim().toLowerCase() === "[done]") return { done: true };

  try {
    const obj = JSON.parse(raw);
    let data = obj;

    // 2a. 嵌套 data 字段（某些后端将数据包在 { data: {...} } 中）
    if (obj.data && typeof obj.data === "object") data = obj.data;

    // 2b. type 命中 reasoning 集合 → content 视为推理内容
    if (STREAM_REASONING_MARKERS.has(data.type)) {
      return {
        reasoning: data.content || data.reasoning_content,
        done: isDoneStreamMarker(data.type),
      };
    }

    // 2c. 直接字段 .content / .reasoning_content / .reasoning
    // 2d. OpenAI 兼容：choices[0].delta.content / choices[0].message.content
    // ...
  } catch {
    // 3. JSON 解析失败 → 纯文本流，原始文本作为 content
    return { content: raw };
  }
};
```

**10+ 种流结束信号**：通过 `STREAM_DONE_MARKERS` Set 存储 `["done", "end", "message_end", "message_stop", "completed", "complete", "stop"]`，外加 `"[done]"` 的特殊处理。归一化为小写后统一比对，消除大小写和空格差异。

**onclose 的二次处理**：`fetchEventSource` 在 SSE 连接关闭时可能抛出 `"Connection closed"` 错误（非 HTTP 错误，而是 `onclose` 回调中的 `FatalError`）。`streamChat` 在 `onError` 回调中特殊处理此消息，避免将其误报为用户可见错误。

#### 1.4.2 客户端模拟流式（`useInterviewMessageStream.ts`）

面试报告场景中，后端一次性返回完整的问答应答文本，但 UI 需要逐段展示（打字机效果）。这是纯前端模拟，使用 `setInterval` 逐字符输出。

| 维度     | 真实 SSE 流                              | 客户端模拟流                      |
| -------- | ---------------------------------------- | --------------------------------- |
| 数据来源 | `@microsoft/fetch-event-source` 持续推送 | 后端一次性完整返回                |
| 流控方式 | `TextStreamLimiter`（40ms/12 字符）      | `setInterval`（18-26ms/2 字符）   |
| 可取消   | AbortController + requestId 门禁         | `{ cancelled: boolean }` ref 对象 |
| 思考过程 | 独立 reasoning 通道，同步渲染            | 三阶段轮播指示器（1.2s/阶段）     |
| 失败处理 | failAssistantMessage + 错误文本          | 直接展示完整错误信息              |

---

### 1.5 后端 API Schema 漂移容忍 (`interviewService.ts`)

后端 API 经历多个版本迭代后，相同含义的字段在不同接口中使用了不同的命名。面试服务通过两种机制平滑应对：

#### 1.5.1 字段名标准化

```typescript
// pickFirst 工具函数：按优先级尝试多个候选键名，返回第一个非 undefined 的值
function pickFirst<T>(
  source: Record<string, unknown>,
  candidates: string[],
): T | undefined {
  for (const key of candidates) {
    if (key in source && source[key] !== undefined && source[key] !== null) {
      return source[key] as T;
    }
  }
  return undefined;
}

// 实际应用
pickFirst(response, ["sessionId", "session_id", "session_id_old"]);
pickFirst(response, ["resumeFileUrl", "resume_file_url", "resumeUrl"]);
pickFirst(response, ["questionList", "question_list", "questions"]);
pickFirst(response, ["interviewReport", "interview_report", "report"]);
```

这种方式的优势是：不需要后端一次性迁移所有旧接口，前端可以逐步收敛，同时兼容新旧格式。当后端完成迁移后，只需删除候选数组中的旧键名即可。

#### 1.5.2 API 路径降级

```typescript
async function getWithPathFallback<T>(
  newPath: string,
  oldPath: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  try {
    return await get<T>(newPath, config);
  } catch (error) {
    // 仅 404 或 "operation-failed" 错误触发降级，其他错误正常抛出
    if (
      error instanceof AppError &&
      (error.code === ErrorCode.RESOURCE_NOT_FOUND ||
        error.message?.includes("operation-failed"))
    ) {
      return await get<T>(oldPath, config);
    }
    throw error;
  }
}
```

降级是静默的：用户感知不到路径切换，日志中不做额外记录（404 是预期行为而非异常）。当旧路径最终废弃时，只需删除 `getWithPathFallback` 调用改为直接 `get(newPath)`。

---

### 1.6 录音启动/停止的异步竞态 (`useAudioTranscriptionController.ts`)

用户快速点击"开始录音 → 停止 → 开始录音"时，可能出现时序问题：

```
T1: 用户点"开始"
T2: startStream() 被调用，WebSocket 连接中（Promise 尚未 resolve）
T3: 用户点"停止"
T4: stopRecording() 被调用
T5: startStream() 在 T1 调用的 Promise resolve  ← 此时用户已经想停止了！
```

#### 1.6.1 Symbol 令牌机制

```typescript
const startToken = Symbol();
activeStartTokenRef.current = startToken;

await startStream(); // 可能耗时较长（WebSocket 连接建立）

// startStream 完成后，检查令牌是否仍然是当前活跃的
if (activeStartTokenRef.current !== startToken) {
  // 在等待期间，用户已经调用了 stopRecording → 清理并返回
  return;
}
// 令牌匹配 → 继续正常流程
```

Symbol 是唯一值，每次调用 `Symbol()` 生成一个全新的、与前一个不等的值。它比数字计数器更安全——不存在"计数器溢出后重复"的可能性。

#### 1.6.2 与 WebSocket 缓冲的协作

当 `stopRecording` 被调用时：

1. 设置 `activeStartTokenRef.current = Symbol()`（新的令牌，使旧的 startStream 失效）
2. 调用 `ws.sendCommand("stop_transcription")` 通知服务端
3. `ws.disconnect()` 关闭 WebSocket → 清空 `pendingBinaryQueue` → 重置消息光标
4. cleanup 函数中用 `cancelled` 标志防止组件卸载后的状态更新

---

### 1.7 PDF 二进制验证 (`interviewService.ts`)

简历预览场景中，后端可能因为权限问题或服务异常返回非 PDF 内容（如 JSON 错误响应），浏览器 PDF 渲染器会报错或静默失败。

#### 1.7.1 文件头魔数验证

```typescript
async function fetchInterviewResumePreviewBlob(
  interviewId: string,
): Promise<Blob> {
  const blob = await get<Blob>(`/interview/${interviewId}/resume/preview`, {
    responseType: "blob",
  });

  // 读取前 5 字节验证 PDF 魔数
  const header = await blob.slice(0, 5).text();
  if (header === "%PDF-") {
    // 0x25 0x50 0x44 0x46 0x2D
    return blob; // 合法的 PDF
  }

  // 非 PDF：尝试解码前 2048 字节读取服务端错误信息
  const snippet = await blob.slice(0, 2048).text();
  let errorMessage = "Resume preview is not a valid PDF file";

  try {
    const errorJson = JSON.parse(snippet);
    if (errorJson?.message) errorMessage = errorJson.message;
    if (errorJson?.code) errorMessage += ` (code: ${errorJson.code})`;
  } catch {
    // 不是 JSON 也无妨，使用默认错误消息
  }

  throw new AppError(ErrorCode.AI_RESPONSE_ERROR, errorMessage);
}
```

2048 字节的选择：足够覆盖大部分 JSON 错误响应（通常 < 1KB），又不至于在二进制垃圾数据上浪费太多内存。

---

### 1.8 实时摄像头神态分析 (`useInterviewDemeanorPolling.ts`)

面试过程中，系统每 5 秒抓取一帧摄像头画面，上传至后端 AI 分析面试者的神态（专注度、紧张程度、眼神交流等），结果实时展示在面试界面中。

#### 1.8.1 互斥锁防上传堆积

如果某次上传因为网络慢耗时超过 5 秒，下一次轮询触发时不应创建第二个并发的上传请求：

```typescript
const isUploadingRef = useRef(false);

useEffect(() => {
  const interval = setInterval(async () => {
    if (isUploadingRef.current) return; // 上次还在上传中 → 跳过本次
    isUploadingRef.current = true;

    try {
      const frame = await captureFrame(); // 通过回调从摄像头组件获取当前帧
      if (cancelledRef.current) return; // 组件已卸载
      const result = await uploadAndAnalyze(frame);
      if (!cancelledRef.current) {
        setDemeanor(result);
      }
    } catch (error) {
      if (!cancelledRef.current) {
        console.error("Demeanor polling error:", error);
      }
    } finally {
      isUploadingRef.current = false;
    }
  }, 5000);

  return () => {
    cancelledRef.current = true; // 组件卸载标记
    clearInterval(interval);
  };
}, [captureFrame]);
```

#### 1.8.2 `captureFrame` 回调模式

轮询逻辑不直接依赖摄像头 DOM，而是接受一个 `captureFrame: () => Promise<Blob>` 回调。这让摄像头组件和轮询逻辑完全解耦：

- 摄像头组件负责：`<video>` 元素、`getUserMedia` 权限、canvas 截图
- 轮询 Hook 负责：定时器、互斥锁、上传、状态更新

---

## 二、亮点 (Technical Highlights)

### 2.1 分层清晰的状态管理架构

项目采用 **Redux Toolkit + TanStack React Query + 组件本地 useState** 的三层架构，每一层有明确的职责边界：

```typescript
// ─── Redux Toolkit —— 客户端运行时状态 ───
// userSlice：认证相关的实时状态，含 authEpoch 失效信号
// chatSlice：消息列表、SSE 流式状态、pending outbound、active stream 追踪

// ─── TanStack React Query —— 服务端数据缓存 ───
// staleTime: 5min（5 分钟内不重新请求）
// refetchOnWindowFocus: false（切回窗口不自动刷新）
// 典型使用者：会话列表、模型列表、面试报告、历史记录

// ─── 组件本地 useState —— 纯 UI 交互状态 ───
// 输入框内容、展开/折叠、动画状态、tooltip 显隐
```

#### 2.1.1 为什么消息列表用 Redux 而不是 React Query？

消息列表有以下特征，恰好与 Redux 的设计初衷匹配：

- **高频更新**：SSE 流式渲染每 40ms dispatch 一次（React Query 的缓存抽象对此是负担）
- **本地性**：消息列表是"当前会话的投影"，不是"服务端数据的缓存"
- **细粒度更新**：`appendAssistantChunk` 只修改单条消息的 content 字段，Redux + Immer 能做到最小重渲染

#### 2.1.2 `authEpoch` 全局失效信号

这是本项目状态管理中设计最精妙的机制之一。

```typescript
// userSlice 中 —— 身份变更时自增
state.authEpoch += 1; // 登录、登出、身份切换时触发

// 下游 Hook 中 —— 将 authEpoch 加入 queryKey
useQuery({
  queryKey: ["conversations", getUserKey(currentUser), authEpoch],
  queryFn: () => fetchConversations(),
});
```

效果：当用户 A 登出、用户 B 登录后，`authEpoch` 从 1 变为 2，所有依赖 `authEpoch` 的 queryKey 自动变化，React Query 将其视为"新查询"并自动重新请求——无需手动 `invalidateQueries` 所有缓存。

对比没有 `authEpoch` 的方案：

```typescript
// ❌ 需要在登出时手动清理所有缓存
dispatch(logoutUser());
queryClient.invalidateQueries({ queryKey: ["conversations"] });
queryClient.invalidateQueries({ queryKey: ["models"] });
queryClient.invalidateQueries({ queryKey: ["interview-records"] });
// ... 每新增一个缓存都要加一行，容易遗漏

// ✅ 有 authEpoch：只需 authEpoch += 1，所有下游缓存自动失效
```

---

### 2.2 `TextStreamLimiter` —— 通用的逐字输出控制器

一个仅 166 行的独立模块（类型 + 实现），实现了"积攒 → 定时吐出 → 刷新"的优雅流控。

#### 2.2.1 工作模型

```
后端 SSE 推送速度（不可控，可能瞬间几十 KB）
       │
       ▼
  push(chunk) → pending 缓冲区（字符队列）
       │
       ▼
  定时器 tick（每 40ms）
       │
       ├── 从 pending 头部截取 12 个字符
       ├── 追加到 value（累积文本）
       └── onUpdate(value) → dispatch(appendChunk) → UI 更新
```

#### 2.2.2 惰性启停

```typescript
const tick = () => {
  if (!pending) {
    stopTimer(); // 缓冲区空了 → 停止定时器，零 CPU 开销
    return;
  }
  const nextChunk = pending.slice(0, charsPerTick);
  pending = pending.slice(nextChunk.length);
  value += nextChunk;
  options.onUpdate(value);
  if (!pending) stopTimer(); // 取完后恰好空了 → 停止
};
```

定时器不是一直运行的：SSE 推送快时，定时器持续工作；SSE 暂停时（模型思考中），定时器自动停止，不消耗 CPU。

#### 2.2.3 首帧立即输出

```typescript
push(chunk: string) {
  if (!chunk) return;
  pending += chunk;

  if (!timer) {
    // 首次 push：立即输出首帧，不等待一个 intervalMs
    tick();
    ensureTimer();  // 然后启动定时器接管后续
  }
}
```

这让用户感知到"即时响应"——按下发送后，第一个词几乎立即出现（而非延迟 40ms）。

#### 2.2.4 双实例并行

聊天场景同时运行两个 Limiter 实例：

```typescript
// 正文限速器
const contentLimiter = createTextStreamLimiter({
  intervalMs: 40,
  charsPerTick: 12,
  onUpdate: (chunk) => dispatch(appendAssistantChunk({ id, content: chunk })),
});

// 推理限速器
const reasoningLimiter = createTextStreamLimiter({
  intervalMs: 40,
  charsPerTick: 12,
  onUpdate: (chunk) =>
    dispatch(appendAssistantReasoningChunk({ id, reasoning: chunk })),
});

// 两个实例独立工作，各自的 pending 缓冲区、定时器、value 互不干扰
```

参数选择（40ms / 12 字符）的依据：

- 40ms ≈ 25fps，人眼感知流畅
- 12 字符/40ms ≈ 300 字符/秒，接近普通中文阅读速度
- 如果用户阅读速度快于 300 字符/秒，可以调整参数而不用修改 Limiter 内部逻辑

---

### 2.3 系统化的错误处理体系 (`src/lib/errors/`)

#### 2.3.1 五级错误码命名空间

```typescript
export const ErrorCode = {
  // Generic (1000-1999) —— 与业务无关的基础设施错误
  UNKNOWN_ERROR: 1000,
  NETWORK_ERROR: 1001,
  REQUEST_TIMEOUT: 1002,
  ABORTED: 1003,

  // Auth (2000-2999) —— 认证与授权
  UNAUTHORIZED: 2001,
  FORBIDDEN: 2002,
  TOKEN_EXPIRED: 2003,

  // Business (3000-3999) —— 业务逻辑错误
  INVALID_PARAMS: 3001,
  RESOURCE_NOT_FOUND: 3002,
  OPERATION_FAILED: 3003,

  // AI (4000-4999) —— AI 服务相关
  AI_SERVICE_UNAVAILABLE: 4001,
  AI_QUOTA_EXCEEDED: 4002,
  AI_RESPONSE_ERROR: 4003,
  AI_STREAM_PARSING_ERROR: 4004,

  // Client (5000-5999) —— 客户端侧错误
  CLIENT_VALIDATION_ERROR: 5001,
  FILE_UPLOAD_ERROR: 5002,
  CAMERA_PERMISSION_DENIED: 5003,
  MICROPHONE_PERMISSION_DENIED: 5004,
} as const;
```

命名空间的设计意图：

- 通过错误码区间的第一位就能判断错误类别（1=通用 2=认证 3=业务 4=AI 5=客户端）
- 每个区间预留 999 个编号，足够扩展
- 错误码映射到用户可读的 `ErrorMessages` 字典，但允许调用方覆盖 message

#### 2.3.2 `AppError.from()` 智能转换器

```typescript
static from(error: unknown, defaultCode = ErrorCode.UNKNOWN_ERROR): AppError {
  if (error instanceof AppError) return error;               // 已是 AppError → 直接返回
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return new AppError(ErrorCode.ABORTED, "Request was cancelled.", error);
    }
    return new AppError(defaultCode, error.message, error);  // 保留原始错误链
  }
  if (typeof error === "string") return new AppError(defaultCode, error);  // 包装字符串
  return new AppError(defaultCode, undefined, error);        // 兜底
}
```

转换规则：

1. **已有 AppError** → 直接返回，不包装（保留原始 errorCode）
2. **AbortError** → 自动映射为 `ABORTED`（用户取消操作不是错误，不应上报）
3. **普通 Error** → 使用传入的 `defaultCode`（如 `checkAuthStatus` 中传入 `UNAUTHORIZED`）
4. **字符串** → 包装为 AppError
5. **其他** → 兜底为 `UNKNOWN_ERROR`

**request.ts 中的自动映射**：Axios 响应拦截器根据 HTTP 状态码自动转换为 AppError：

- 401 → `AppError(UNAUTHORIZED)` → `shouldClearAuth: true`
- 403 → `AppError(FORBIDDEN)` → `shouldClearAuth: true`
- 网络错误 → `AppError(NETWORK_ERROR)`

---

### 2.4 音频转录的状态机设计 (`src/lib/audioTranscription.ts`)

采用纯函数 reducer 模式（`(state, event) => state`），是典型的 Elm/Redux 架构在单一模块中的应用。

#### 2.4.1 双轨状态模型

```typescript
type AudioTranscriptionState = {
  liveText: string; // 当前实时识别文本（随 "replace" 事件替换）
  finalText: string; // 已归档的稳定文本（随 "archive" 事件追加）
};
```

为什么是双轨而非单轨？

- **liveText**：用户在说话过程中，识别结果持续变化（"你好" → "你好吗" → "你好吗今天"）。这些中间结果需要实时显示但不能直接提交。
- **finalText**：当一段话说完，服务端发送 `archive` 事件，表示这段文本已稳定。归档后 `liveText` 清空，等待下一段实时识别。

#### 2.4.2 8 种事件类型

| 事件        | 触发条件                                             | 行为                                        |
| ----------- | ---------------------------------------------------- | ------------------------------------------- |
| `reset`     | `transcription_started`                              | 清空 liveText 和 finalText                  |
| `replace`   | `updateAction: "replace"` 或 `type: "transcription"` | 替换 liveText（实时识别更新）               |
| `archive`   | `updateAction: "archive"` 或 `type: "final"`         | 将 liveText 合并到 finalText，清空 liveText |
| `connected` | WebSocket 连接建立                                   | 通知外部层                                  |
| `control`   | `transcription_stopped` / `status`                   | 不改变状态（仅信号）                        |
| `heartbeat` | `heartbeat` / `pong`                                 | 不改变状态（仅保活）                        |
| `error`     | `type: "error"`                                      | 携带错误消息                                |
| `unknown`   | 无法识别的 type                                      | 记录日志                                    |

#### 2.4.3 智能文本合并 (`mergeDistinctTranscription`)

```typescript
const mergeDistinctTranscription = (base: string, next: string) => {
  if (!base) return next;
  if (!next) return base;
  if (base === next) return base; // 完全相同 → 去重
  if (base.includes(next)) return base; // next 是 base 的子串 → 保留更长的
  if (next.includes(base)) return next; // base 是 next 的子串 → 用更长的替换
  return `${base}\n\n${next}`; // 都不包含 → 拼接（双换行分隔）
};
```

五种情况的处理覆盖了语音转写中常见的文本关系：

- 完全相同：网络重传导致的重复
- 包含关系：增量识别结果（"你好" → "你好世界"）
- 不相关：新的一段话

---

### 2.5 Apple 风格设计系统 (`DESIGN.md`)

348 行的设计规范文档不仅定义了"用什么颜色/字体"，更重要的是定义了一套**可由 AI 理解和应用的规则体系**。

#### 2.5.1 核心设计约束

| 维度 | 规则                                              | 理由                                                                            |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| 色彩 | 唯一的彩色是 Apple Blue `#0071e3`，仅用于交互元素 | 减少视觉噪音，让用户直觉聚焦可操作元素                                          |
| 背景 | `#000000`（黑）和 `#f5f5f7`（浅灰）交替分区       | 交替节奏营造"电影级沉浸感"，无需边框/分隔线                                     |
| 阴影 | 唯一阴影 `rgba(0,0,0,0.22) 3px 5px 30px 0px`      | 极度克制：只有浮层（dialog、sheet）有阴影                                       |
| 字体 | SF Pro Display（≥20px）和 SF Pro Text（<20px）    | 光学尺寸自动匹配：大字用 Display 变体（更细更优雅），小字用 Text 变体（更清晰） |
| 圆角 | 13px（组件）、9999px（pill）、8px（卡片内部）     | 三种圆角半径覆盖全部场景                                                        |
| 动效 | 200-300ms，`cubic-bezier(0.25, 0.1, 0.25, 1)`     | Apple 风格 easing，快速启动 + 缓慢收尾                                          |

#### 2.5.2 即用型 AI Prompt 模板

文档包含可直接粘贴到 Claude/ChatGPT 中的提示词模板：

```markdown
## AI 代码生成提示词

请生成一个符合以下设计系统的 React 组件：

- 背景色：interactive 区域的背景使用 #ffffff
- 强调色：仅对可点击元素使用 #0071e3
- 阴影：仅在浮层元素上使用唯一的阴影值
- 字体：标题使用 SF Pro Display，正文使用 SF Pro Text
- 动效：所有过渡使用 cubic-bezier(0.25, 0.1, 0.25, 1) 200ms
```

这使得设计系统本身成为 AI 辅助开发的输入——即使用 AI 生成新组件，也能自动遵循设计规范。

---

### 2.6 多媒体能力矩阵

项目整合了三条独立的音频流水线和摄像头分析能力：

| 能力             | 技术方案                           | 关键实现细节                                                                               |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| 语音转文字 (ASR) | WebSocket + PCM16 音频流           | 连接态缓冲队列（24 块上限）、时间戳+内容指纹双重去重、15s 心跳保活                         |
| 文字转语音 (TTS) | 讯飞长文本 TTS REST API            | 异步任务两阶段协议（创建任务 → 轮询结果）、ObjectURL 缓存、自动播放                        |
| 麦克风采集       | ScriptProcessorNode + AnalyserNode | Float32 → PCM16 转换（`int16Sample = floatSample * 0x7FFF`）、640 样本/块、WebKit 前缀回退 |
| 摄像头神态分析   | 5s 定时轮询 + Canvas 截图          | 互斥锁防上传堆积、`cancelled` 标志防卸载后更新、动态帧捕获回调                             |

#### 2.6.1 Float32 → PCM16 转换

```typescript
// AudioProcessingEvent 的 inputBuffer 提供 Float32 样本（-1.0 ~ 1.0）
// PCM16 需要 Int16 样本（-32768 ~ 32767）
const floatSamples = event.inputBuffer.getChannelData(0);
const pcm16 = new Int16Array(floatSamples.length);
for (let i = 0; i < floatSamples.length; i++) {
  pcm16[i] = Math.max(-0x8000, Math.min(0x7fff, floatSamples[i] * 0x7fff));
}
```

640 样本/块：在 16kHz 采样率下，640 个样本 = 40ms 音频。这个大小平衡了实时性（40ms 延迟几乎不可感知）和传输效率（避免过小的块导致过多的 WebSocket 帧开销）。

#### 2.6.2 TTS 异步任务两阶段协议

讯飞长文本 TTS 不支持一次性返回完整音频，而是采用：创建合成任务 → 返回 `taskId` → 轮询任务状态 → 下载音频文件。

```typescript
// 阶段一：提交合成任务
const { taskId } = await createTtsTask({ text, voice: "xiaoyan" });

// 阶段二：轮询直到完成
const audioUrl = await pollUntilReady(taskId, {
  interval: 1000, // 每秒查询一次
  maxAttempts: 30, // 最多等 30 秒
});

// 阶段三：ObjectURL 缓存 + 自动播放
if (!ttsCache.has(taskId)) {
  const blob = await fetch(audioUrl).then((r) => r.blob());
  ttsCache.set(taskId, URL.createObjectURL(blob)); // 避免重复下载
}
audioElement.src = ttsCache.get(taskId);
audioElement.play();
```

---

### 2.7 精细化构建产物分割

Vite 的 `manualChunks` 按业务域拆分为独立 bundle：

```typescript
manualChunks: {
  "pdf-viewer":      ["react-pdf", "pdfjs-dist"],
  "react-core":      ["react", "react-dom", "react-router-dom"],
  "state-management": ["@reduxjs/toolkit", "react-redux", "@tanstack/react-query"],
  "ui-vendor":       ["framer-motion", "lucide-react", /radix-ui/],
}
```

**分割策略的考量：**

| Chunk              | 包含内容                                | 分割理由                                                   |
| ------------------ | --------------------------------------- | ---------------------------------------------------------- |
| `pdf-viewer`       | react-pdf + pdfjs-dist                  | 仅面试页使用（~2MB），按需加载，其他页面不受影响           |
| `react-core`       | React + ReactDOM + Router               | 应用基石，每个页面都需要，单独缓存后应用更新不影响此 chunk |
| `state-management` | Redux + React Query                     | 稳定的状态管理层，更新频率低                               |
| `ui-vendor`        | framer-motion + lucide-react + Radix UI | UI 层独立缓存，组件变更不影响                              |

效果：当开发者修改了一个聊天组件时，只有应用代码的 chunk 需要重新下载，`react-core`、`state-management`、`ui-vendor` 都命中浏览器缓存。这对用户体验和 CI/CD 部署效率都有直接提升。

---

### 2.8 面试追问链的数据分组与可视化 (`InterviewQaReplayCard`)

面试报告回放中，AI 可能对某个回答进行追问。追问与主问题通过题号关联：`Q1`（主问题）→ `Q1-F1`（第一次追问）→ `Q1-F2`（第二次追问）。

#### 2.8.1 追问识别正则

```typescript
const FOLLOW_UP_PATTERN = /^(.*?)-F\d+$/iu;

// 将平铺的 QA 列表分组
function groupQaItems(items: InterviewQaItem[]): QaGroup[] {
  const groups: Map<string, QaGroup> = new Map();

  for (const item of items) {
    const match = item.questionNumber.match(FOLLOW_UP_PATTERN);
    if (match) {
      // Q1-F1 → 找到父组 Q1，追加到 followUps
      const parentNumber = match[1];
      groups.get(parentNumber)?.followUps.push(item);
    } else {
      // Q1 → 创建新组
      groups.set(item.questionNumber, { main: item, followUps: [] });
    }
  }

  return Array.from(groups.values());
}
```

#### 2.8.2 级联入场动画

```typescript
// 父组用 0.06s 间隔，追问用 0.05s 递增
{groups.map((group, gi) => (
  <motion.div
    key={group.main.questionNumber}
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay: gi * 0.06 }}  // Q1: 0s, Q2: 0.06s, Q3: 0.12s
  >
    <QaItem item={group.main} />
    {group.followUps.map((followUp, fi) => (
      <motion.div
        key={followUp.questionNumber}
        initial={{ opacity: 0, x: -10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: gi * 0.06 + (fi + 1) * 0.05 }}
        // Q1-F1: 0.05s, Q1-F2: 0.10s, Q2-F1: 0.11s, Q2-F2: 0.16s ...
      >
        <QaItem item={followUp} isFollowUp />
      </motion.div>
    ))}
  </motion.div>
))}
```

---

### 2.9 纯 SVG 雷达图 (`InterviewRadarChart.tsx`)

不依赖任何第三方图表库（如 Chart.js、ECharts），完全用 SVG 原语手绘的面试能力雷达图。这对 `node_modules` 体积零影响。

#### 2.9.1 绘制层级

```
1. 背景参考环（4 层同心多边形：25%/50%/75%/100%）
     └─ <polygon> + stroke-dasharray 虚线
2. 轴线（从中心辐射到各顶点）
     └─ <line> x1,y1 → x2,y2
3. 数据多边形（填充 + 描边）
     └─ <polygon> + fill-opacity + stroke
4. 数据点圆点
     └─ <circle> cx,cy,r
5. hover Tooltip
     └─ <g> + onMouseMove 定位
```

#### 2.9.2 多边形顶点坐标计算

```typescript
// 将数据值映射到多边形顶点坐标
const getPolygonPoints = (
  data: number[],
  maxValue: number,
  cx: number,
  cy: number,
  r: number,
) => {
  return data.map((value, i) => {
    const angle = (Math.PI * 2 * i) / data.length - Math.PI / 2; // -90° 从顶部开始
    const radius = (value / maxValue) * r;
    return {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });
};

// 生成 SVG polygon 的 points 属性
const pointsStr = vertices.map((v) => `${v.x},${v.y}`).join(" ");
```

#### 2.9.3 鼠标跟随 Tooltip

```typescript
const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; value: number } | null>(null);

<circle
  cx={vertex.x}
  cy={vertex.y}
  r={6}
  onMouseMove={(e) => setTooltip({
    x: e.nativeEvent.offsetX,
    y: e.nativeEvent.offsetY,
    label: dimensions[i],
    value: data[i],
  })}
  onMouseLeave={() => setTooltip(null)}
/>

{/* Tooltip 用 framer-motion AnimatePresence 实现进出动画 */}
<AnimatePresence>
  {tooltip && (
    <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <rect x={tooltip.x + 10} y={tooltip.y - 20} ... />
      <text x={tooltip.x + 18} y={tooltip.y - 4}>{tooltip.label}: {tooltip.value}</text>
    </motion.g>
  )}
</AnimatePresence>
```

---

### 2.10 完善的测试覆盖

12 个测试模块覆盖了核心工具库和服务层，重点测试的是**非 UI 的纯逻辑模块**——这类模块最适合单元测试且 ROI 最高：

| 测试文件                          | 测试对象           | 关键用例                                   |
| --------------------------------- | ------------------ | ------------------------------------------ |
| `request.test.ts`                 | HTTP 请求去重引擎  | 策略解析、stableSerialize 边界、错误码映射 |
| `audioTranscription.test.ts`      | 音频转录状态机     | 每个事件类型的 state 转换                  |
| `audioToTextWs.test.ts`           | WebSocket 消息处理 | 消息去重、缓冲队列、心跳                   |
| `interviewService.test.ts`        | 面试 API 服务      | 字段名标准化、路径降级                     |
| `xunfeiTtsService.test.ts`        | TTS 服务           | 任务状态解析、轮询逻辑                     |
| `useChatPageController.test.tsx`  | 聊天页面控制器     | 14 个用例覆盖发送/历史/竞态/重定向         |
| `chatRuntimeControllers.test.tsx` | 聊天运行时重置入口 | 3 个入口点的级联清理验证                   |

**聊天页面控制器的 14 个测试用例完整覆盖了：**

- 初始查询跳转不重定向到旧会话
- 历史消息加载 + 不重复请求
- 切换会话时的旧消息清理
- 已有会话中直接发送
- 新建会话 + 等路由同步 + 自动流式
- 纯推理内容的流式响应
- pending 消息在路由切换时被取消
- 切换会话时旧 SSE chunk 被丢弃
- 新建对话过渡标志阻止重定向
- 历史加载失败回退到根路径

---

## 三、架构层面的总体评价

| 维度             | 评价                       | 具体表现                                                                                                                                                               |
| ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **并发安全**     | 系统性地处理了竞态条件     | Symbol 令牌、requestId 门禁、cancelled 标志、互斥锁、三层取消协议——遍及 HTTP 层、WebSocket 层、Hook 层                                                                 |
| **协议容忍**     | 对后端演化的高度适应性     | SSE 多格式兼容（OpenAI 兼容 + 自定义 JSON + 纯文本）、API 字段名标准化（`pickFirst`）、路径降级（`getWithPathFallback`）                                               |
| **用户体验打磨** | 不是功能堆砌，而是体验精雕 | 逐字流式渲染（40ms/12字符）、思考过程可视化、追问级联动画、TTS 自动播放、首帧立即输出、零数据加载态                                                                    |
| **工程化程度**   | 专业的前端工程实践         | 清晰的三层状态管理分工、系统化五级错误码体系、精细化 bundle 分割、规范化测试覆盖、完整 TypeScript strict 类型                                                          |
| **代码组织**     | 按功能域垂直分割           | chat / interview / audio / auth / home / layout 六个域，每个域包含 hooks + components + services 的完整闭环，域间通过 Redux extraReducers 和 React Query queryKey 通信 |

---

> 本文档基于对项目 50+ 源文件的深度分析生成，覆盖了 HTTP 层、状态管理、流式渲染、音频系统、面试模块、设计系统等核心子系统。每个分析点都对应到具体的源文件和代码行。
