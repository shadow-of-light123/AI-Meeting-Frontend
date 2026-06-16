# 码上面试平台 · 前端面试题集

> 基于项目源码和文档深度分析，覆盖架构、并发、流式渲染、实时通信、状态管理等高频面试考点。
> 每个问题附详细参考答案，可直接用于面试准备。

---

## 目录

1. [项目概述与架构](#1-项目概述与架构)
2. [请求去重与防抖引擎](#2-请求去重与防抖引擎)
3. [并发竞态治理](#3-并发竞态治理)
4. [SSE 流式渲染系统](#4-sse-流式渲染系统)
5. [WebSocket 实时音频管线](#5-websocket-实时音频管线)
6. [状态管理架构](#6-状态管理架构)
7. [错误处理体系](#7-错误处理体系)
8. [面试模块](#8-面试模块)
9. [工程化与性能优化](#9-工程化与性能优化)
10. [设计系统](#10-设计系统)
11. [项目反思与开放问题](#11-项目反思与开放问题)

---

## 1. 项目概述与架构

### Q1.1：请简单介绍这个项目，你在其中负责什么？

**回答要点：**

- 项目定位：基于大语言模型的 AI 模拟面试与智能对话 SaaS 平台
- 我的角色：独立前端架构设计与全量开发（代码量 15000+ 行）
- 核心功能：简历解析出题 → 多轮问答与追问 → 摄像头神态分析 → 雷达图报告；AI 对话模块支持多模型切换、SSE 流式输出；语音转写与 TTS 合成
- 技术栈：React 19 + TypeScript 5.9 + Vite 7 + Redux Toolkit + TanStack React Query + Tailwind CSS + shadcn/ui

**延伸：** 后端是 Spring Boot 3 单体架构，对接了多种 AI 模型（DeepSeek、讯飞星辰等），通信协议覆盖 HTTP、SSE、WebSocket。

---

### Q1.2：项目的目录结构是怎样的？你是如何组织代码的？

**回答要点：**

采用 **按功能域垂直分割** 的组织方式，每个域包含 `hooks/` + `components/` + `services/` 的完整闭环：

```
src/
├── app/          # App 入口：RouterProvider + Redux/Query 初始化
├── pages/        # 页面级组件（auth, chat, interview, home）
├── layouts/      # AppLayout：侧边栏 + <Outlet/>
├── components/   # 按域拆分：ui/, auth/, chat/, interview/, home/, layout/, audio/
├── hooks/        # 按域拆分：audio/, auth/, chat/, interview/, home/, layout/
├── services/     # API 服务层：ai, agent, interview, auth, audioToText, tts
├── store/        # Redux Toolkit（index + hooks + slices/）
├── lib/          # 工具函数：request.ts, errors/, streamLimiter, chat, constants
├── config/       # 环境变量解析
└── types/        # DTO 类型定义
```

**为什么这样组织？**

- 按功能域而非按技术类型（如把所有 hooks 放一起），让同一业务的相关代码内聚
- 域间通过 Redux `extraReducers` 和 React Query `queryKey` 通信，保持松耦合
- 核心基础设施（`request.ts`, `errors/`, `streamLimiter.ts`）放在 `lib/`，多个域共享

---

### Q1.3：为什么同时使用 Redux Toolkit 和 TanStack React Query？它们的分工是什么？

**参考答案：**

这是项目中最重要的架构决策之一。它们管理的数据具有本质不同的特征：

| 维度         | Redux Toolkit                                            | TanStack React Query                           |
| ------------ | -------------------------------------------------------- | ---------------------------------------------- |
| **管理什么** | 客户端运行时状态                                         | 服务端数据的缓存和同步                         |
| **数据特征** | 应用级、长期存在、高频变更                               | 服务端返回的列表/详情，有时效性                |
| **典型数据** | 登录态、消息列表（流式追加）、当前会话、pending outbound | 会话列表、模型列表、面试记录、历史消息         |
| **更新方式** | dispatch action → reducer（40ms/次 SSE 追加）            | 自动（staleTime 5min）/ 手动 invalidateQueries |
| **缓存策略** | 无（手动管理）                                           | 自动过期、窗口聚焦不刷新                       |

**为什么消息列表用 Redux 而不是 React Query？**

1. **高频更新**：SSE 流式渲染每 40ms dispatch 一次 `appendAssistantChunk`，React Query 的缓存抽象对这种高频更新是负担
2. **本地性**：消息列表是"当前会话的投影"，不是"服务端数据的缓存"
3. **细粒度更新**：通过 Immer + `appendAssistantChunk` 只修改单条消息的 content 字段，做到最小重渲染

**为什么会话列表用 React Query 而不是 Redux？**

会话列表是典型的"服务端数据缓存"：有 stale 概念（5 分钟不重复请求）、需要在特定时机刷新（新建/删除会话后 invalidateQueries）。

---

### Q1.4：`authEpoch` 是什么？它解决了什么问题？

**参考答案：**

`authEpoch` 是 `userSlice` 中的一个自增数字字段，用于**全局缓存失效信号**。

```typescript
// userSlice 中 —— 身份变更时自增
state.authEpoch += 1; // 登录、登出时触发

// 下游 Hook 中 —— 加入 queryKey
useQuery({
  queryKey: ["conversations", getUserKey(currentUser), authEpoch],
  queryFn: () => fetchConversations(),
});
```

**解决的问题：** 当用户 A 登出、用户 B 登录后，所有 React Query 缓存需要自动失效。传统做法需要在登出时手动 `invalidateQueries` 所有缓存：

```typescript
// ❌ 传统做法：每新增一个缓存都要加一行
queryClient.invalidateQueries({ queryKey: ["conversations"] });
queryClient.invalidateQueries({ queryKey: ["models"] });
queryClient.invalidateQueries({ queryKey: ["interview-records"] });
// ... 容易遗漏

// ✅ authEpoch 方案：只需 authEpoch += 1
// 所有下游缓存的 queryKey 自动变化 → React Query 视为新查询 → 自动重取
```

---

## 2. 请求去重与防抖引擎

### Q2.1：介绍你自研的请求去重引擎，它解决了什么问题？

**参考答案：**

`src/lib/request.ts`（约 650 行）是整个项目所有 HTTP 请求的统一入口。它实现了一个**通用请求治理层**，通过四种策略在一个管道中编排：

```typescript
requestPolicy: {
  dedupe: "join" | "cancel-previous" | "reject" | "off",
  debounceMs?: number
}
```

| 策略              | 行为                                       | 默认适用        | 典型场景                        |
| ----------------- | ------------------------------------------ | --------------- | ------------------------------- |
| `join`            | 并发相同请求合并为一个，共享同一个 Promise | GET             | 会话列表、模型列表              |
| `cancel-previous` | 新请求发起时自动 abort 前一个              | 需最新数据      | 搜索输入                        |
| `reject`          | 检测到重复直接拒绝                         | 防重复提交      | 面试答题（+ `debounceMs: 250`） |
| `off`             | 不做干预                                   | POST/PUT/DELETE | 登录、创建会话                  |

**调度管道（五个环节依次执行）：**

```
组件 → service → executeWithPolicy → withDebounce → withInflightDedup → axios.request
```

---

### Q2.2：请求去重的 key 是怎么生成的？为什么不用 `JSON.stringify`？

**参考答案：**

需要实现一个 `stableSerialize` 函数来处理以下 `JSON.stringify` 无法保证的情况：

1. **属性顺序**：`JSON.stringify({a:1,b:2})` 和 `JSON.stringify({b:2,a:1})` 结果不同 → 使用 `Object.keys().sort()` 后序列化
2. **循环引用**：`JSON.stringify` 直接抛异常 → 通过 `WeakSet` 追踪已遍历对象，遇到循环返回 `"[Circular]"`
3. **特殊类型**：
   - `Date` → `.toISOString()`（保证同一时刻的 Date 生成相同 key）
   - `URLSearchParams` → `.toString()`（而非 `"[object URLSearchParams]"`）
   - `FormData` → `"[form-data]"`（不可枚举，统一占位符）
4. **null/undefined**：分别返回 `"null"` / `"undefined"` 而非空字符串

```typescript
const stableSerialize = (value, seen = new WeakSet()) => {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URLSearchParams) return value.toString();
  if (typeof FormData !== "undefined" && value instanceof FormData)
    return "[form-data]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${k}:${stableSerialize(value[k], seen)}`).join(",")}}`;
  }
  // ...
};

// 最终 key = method + url + params + data + customKey
const requestKey = `${method}::${path}::params=${serializedParams}::data=${serializedData}`;
```

---

### Q2.3：防抖的"批量消费者模式"和 `lodash.debounce` 有什么区别？

**参考答案：**

`lodash.debounce` 的模式是"最后一次获胜"——只执行最后一次调用，中间的调用者被丢弃。

本项目的 `withDebounce` 实现了**批量决议**——所有在防抖窗口期内的调用者都收到结果：

```typescript
// 核心逻辑（简化）
const withDebounce = (requestKey, debounceMs, run) => {
  const existing = debounceRequestMap.get(requestKey);
  if (existing) {
    // 已有等待中的防抖 → 加入队列，更新 run 为最新
    existing.run = run; // 始终使用最新的请求函数
    return new Promise((resolve, reject) => {
      existing.resolvers.push({ resolve, reject });
    });
  }

  // 第一个调用者：创建 entry，启动定时器
  const entry = { resolvers: [], run };
  entry.timer = setTimeout(async () => {
    debounceRequestMap.delete(requestKey);
    try {
      const result = await entry.run(); // 只执行一次
      entry.resolvers.forEach((r) => r.resolve(result)); // 批量通知所有人
    } catch (error) {
      entry.resolvers.forEach((r) => r.reject(error));
    }
  }, debounceMs);

  return new Promise((resolve, reject) => {
    entry.resolvers.push({ resolve, reject });
  });
};
```

**关键区别：**

| 维度       | lodash.debounce       | 批量消费者模式                        |
| ---------- | --------------------- | ------------------------------------- |
| 中间调用者 | 被丢弃                | 被收集到 `resolvers[]`                |
| 执行次数   | 1 次（最后）          | 1 次（最后），但 N 个调用者都拿到结果 |
| 适用场景   | 窗口 resize、搜索输入 | 多个组件同时触发相同 API 请求         |

**实际场景：** 面试页面加载时，三个组件几乎同时请求同一份面试数据——使用 debounce + join 组合策略，三个请求被合并为一次网络调用，三个组件都拿到相同结果。

---

### Q2.4：AbortSignal 是如何在去重管道中跨层传播的？

**参考答案：**

去重管道中有三层 Abort 信号需要联动：

1. **调用者传入的 AbortSignal**（组件/Hook 层面）
2. **去重层内部的 AbortController**（`withInflightDedup` 创建）
3. **Axios 的 cancel token**（底层 HTTP）

通过 `bindAbortSignal` 建立双向桥接：

```typescript
const bindAbortSignal = (controller, signal) => {
  if (!signal) return;
  if (signal.aborted) {
    controller.abort(); // 已终止 → 立即同步
    return;
  }
  signal.addEventListener("abort", () => controller.abort(), { once: true });
};
```

**传播路径：**

- 调用者 abort → 去重层 AbortController abort → Axios 请求取消（`cancel-previous` 策略同样走这条路）
- 三层 Map（`inflightRequestMap` / `debounceRequestMap` / `abortControllerMap`）同步管理，请求完成后自动清理，防止内存泄漏

---

### Q2.5：GET 请求为什么默认 `join`，而 POST 默认 `off`？

**参考答案：**

遵循 HTTP 语义：

- **GET 是幂等的**：多次相同的 GET 请求应该返回相同的结果，合并（join）不会产生副作用
- **POST 不是幂等的**：多次相同的 POST 可能创建多条记录，默认不做干预（off），由调用方根据具体场景显式指定策略

这体现了"默认安全"的 API 设计原则——不安全的操作需要开发者显式声明。

---

## 3. 并发竞态治理

### Q3.1：项目中处理了哪些竞态场景？每种场景用了什么方案？

**参考答案：**

这是整个项目最有含金量的部分——系统性地处理了多种异步竞态场景：

| 场景                 | 方案                                        | 核心机制                                  |
| -------------------- | ------------------------------------------- | ----------------------------------------- |
| 快速双击发送消息     | `requestPolicy: { dedupe: "reject" }`       | 请求去重引擎                              |
| 会话创建中再次发送   | Pending Outbound 延迟执行                   | `setPendingOutbound` → useEffect 条件触发 |
| SSE 回调中用户取消   | `activeRequestIdRef` 门禁 + AbortController | 三层取消协议                              |
| 快速启停录音         | Symbol 令牌                                 | 每次 start 生成唯一 Symbol                |
| 摄像头轮询上传堆积   | `isUploadingRef` 互斥锁                     | 跳过本次轮询                              |
| 组件卸载后异步回调   | `cancelled` 标志                            | useEffect cleanup                         |
| 客户端模拟流式被中断 | `{ cancelled: boolean }` ref                | 取消标记对象                              |
| 防抖期间多个调用者   | 批量消费者模式                              | `resolvers[]` 统一决议                    |

---

### Q3.2：Symbol 令牌防竞态和 boolean flag 有什么区别？为什么不直接用 boolean？

**参考答案：**

这是面试中最容易被追问的问题之一。

**boolean flag 的问题：**

```typescript
// ❌ 用 boolean
let isStarting = false;

async function start() {
  isStarting = true; // T1: 第一次调用
  await heavyAsyncWork(); // T2-T5: 异步等待
  // T6: 回来时 isStarting 还是 true 吗？
  if (isStarting) {
    /* ... */
  } // 可能是第二次调用设的！
}

// T3: 用户快速停止再开始
start(); // T3: isStarting = true（覆盖第一次的 true！值没变）
stop(); // T4: isStarting = false
start(); // T5: isStarting = true（和 T1 的值一样，无法区分）
```

**Symbol 方案：**

```typescript
// ✅ 用 Symbol
const activeStartTokenRef = useRef(Symbol());

async function start() {
  const token = Symbol(); // 每次创建唯一值
  activeStartTokenRef.current = token;
  await heavyAsyncWork();
  if (activeStartTokenRef.current !== token) {
    return; // 在等待期间被新的 start 或 stop 覆盖了
  }
  // 继续正常流程
}
```

**关键区别：** `Symbol()` 每次调用生成的值都和之前不同——即使"快速启停后再启动"，第二次的 Symbol 也不会和第一次相同。不存在"计数器溢出后重复"的可能性。这是一个基于"唯一性"的竞态防护模式。

---

### Q3.3：Pending Outbound 延迟执行模式是什么？为什么需要它？

**参考答案：**

这是 `useChatSendFlow.ts` 中最复杂的并发控制模式。核心问题：**新建会话是异步的，但消息发送依赖会话 ID——两者之间存在"路由尚未同步"的时间窗口**。

**时序问题：**

```
T0: 用户点击发送（在 /chat 页面，无 sessionId）
T1: 乐观更新 UI（用户消息 + AI 占位气泡）
T2: 调用 createConversation() → 后端创建会话
     └─ 网络延迟 200ms ~ 2s
T4: 返回 { sessionId: "abc" }
T5: navigate(/chat/abc) → URL 变更
T6: React Router 状态更新 → routeSessionId = "abc"
T7: useEffect 检测到条件就绪 → 发起 SSE 流式请求
```

如果直接串行等待会让用户等很久。如果在 T4 直接发起 SSE，`routeSessionId` 还是 null，其他依赖 `routeSessionId` 的逻辑会出问题。

**解决方案 —— Pending Outbound：**

```typescript
// sendMessage 中：无可用 sessionId 时
if (!activeSessionId) {
  const response = await aiService.createConversation({...});
  dispatch(setChatRuntimeSession({ sessionId, title }));
  navigateToSession(activeSessionId, { replace: true });
  // ★ 不直接发送，而是暂存为 pendingOutbound
  dispatch(setPendingOutbound({ requestId, sessionId, assistantMessageId, content }));
  return;
}

// useEffect 中：消费 pendingOutbound，三条件全部满足才触发
useEffect(() => {
  if (!pendingOutbound || isStreaming) return;
  if (routeSessionId !== pendingOutbound.sessionId) return;  // URL 未同步
  if (currentSessionId !== pendingOutbound.sessionId) return; // Redux 未同步

  dispatch(setPendingOutbound(null));
  void streamMessage(pendingOutbound); // 三条件满足 → 发起 SSE
}, [currentSessionId, isStreaming, pendingOutbound, routeSessionId]);
```

**三种触发条件**确保路由、Redux 和应用状态全部就绪后才发送，避免竞态。

---

### Q3.4：SSE 流式回调的三层取消协议是怎么设计的？

**参考答案：**

每一层独立且互备——任意一层失效都不会导致数据污染：

| 层级   | 机制                      | 作用                   | 失效后果（若无此层）                |
| ------ | ------------------------- | ---------------------- | ----------------------------------- |
| 第一层 | `AbortController.abort()` | 中断底层 HTTP SSE 连接 | 旧连接的 chunk 继续到达             |
| 第二层 | `activeRequestIdRef` 门禁 | 每个回调执行前校验     | 旧 chunk 写入新会话消息列表         |
| 第三层 | `cancelActiveStreamRef`   | useEffect cleanup 兜底 | 组件卸载后残留的定时器继续 dispatch |

```typescript
// 第一层：中断 HTTP 连接
abortController.abort();

// 第二层：回调门禁
const isActiveRequest = () =>
  activeRequestIdRef.current === outbound.requestId &&
  abortControllerRef.current === abortController;

onMessage: ((chunk) => {
  if (!isActiveRequest()) return; // 旧请求的 chunk 被丢弃
  contentLimiter?.push(chunk);
},
  // 第三层：组件卸载兜底
  useEffect(() => {
    return () => {
      if (!window.location.pathname.startsWith("/chat")) {
        cancelActiveStreamRef.current(); // 离开聊天页 → 取消
      }
    };
  }, []));
```

**设计原则：** 防御性编程——每一层都不能信任"上一层一定成功"，必须在自己的范围内做独立判断。

---

### Q3.5：过期的 pendingOutbound 如何处理？

**参考答案：**

当用户快速从新会话页跳转到已有会话时，之前 pending 的消息应被废弃：

```typescript
useEffect(() => {
  if (!pendingOutbound || !routeSessionId) return;
  if (routeSessionId === pendingOutbound.sessionId) return; // 正常，等待同步

  // routeSessionId 与 pending 不一致 → 用户已跳走
  dispatch(finishAssistantMessage({ id: pendingOutbound.assistantMessageId }));
  dispatch(setPendingOutbound(null));
}, [pendingOutbound, routeSessionId]);
```

这样确保 AI 占位气泡被正确关闭（不会永远显示 loading），pending 状态被清理。

---

## 4. SSE 流式渲染系统

### Q4.1：为什么需要客户端 TextStreamLimiter？后端不是已经逐字推送了吗？

**参考答案：**

后端 SSE 推送速度是**不可控**的——它可能因为网络缓冲、模型输出速度变化等因素，在某一时刻瞬间推送几十 KB 数据。如果直接渲染：

1. 文字会瞬间闪现，失去"打字机"效果
2. React 渲染频率过高会导致 UI 卡顿

`TextStreamLimiter`（86 行，零依赖）的工作模型：

```
后端 SSE 推送（不可控速度）
       │
       ▼
  push(chunk) → pending 缓冲区（字符队列）
       │
       ▼
  定时器 tick（每 40ms）
       │
       ├── 从 pending 截取 12 字符
       ├── 追加到 value（累积文本）
       └── onUpdate(value) → dispatch → UI 渲染
```

**设计精妙之处：**

1. **惰性启停**：`pending` 为空时自动停止定时器，零 CPU 开销
2. **首帧立即输出**：第一次 `push` 时直接执行 `tick()`，不等 `intervalMs`
3. **按需刷新**：`flush()` 绕过限速，保证最后片段不丢失
4. **双实例并行**：聊天场景同时运行 content + reasoning 两个 Limiter

---

### Q4.2：`parseAiStreamChunk` 是如何兼容多种 AI 流格式的？

**参考答案：**

不同 AI 提供商（OpenAI 兼容、DeepSeek、讯飞星辰、自定义后端）的 SSE 格式不同，`parseAiStreamChunk` 通过多层降级兼容：

```typescript
const parseAiStreamChunk = (raw: string): StreamParseResult => {
  // 1. 纯文本 "[DONE]" → 流结束（OpenAI 兼容）
  if (raw.trim().toLowerCase() === "[done]") return { done: true };

  try {
    const obj = JSON.parse(raw);

    // 2a. 嵌套 data 字段（某些后端 { data: {...} } 格式）
    let data = obj.data && typeof obj.data === "object" ? obj.data : obj;

    // 2b. reasoning 类型检测 → 通过 STREAM_REASONING_MARKERS Set
    if (STREAM_REASONING_MARKERS.has(data.type)) {
      return { reasoning: data.content, done: isDoneStreamMarker(data.type) };
    }

    // 2c. 直接字段：.content / .reasoning_content / .reasoning
    // 2d. OpenAI 兼容：choices[0].delta.content / choices[0].message.content
    // ...
  } catch {
    // 3. JSON 解析失败 → 纯文本流，原始文本作为 content
    return { content: raw };
  }
};
```

**10+ 种流结束信号**通过 `STREAM_DONE_MARKERS` Set 归一化为小写后统一比对：`["done", "end", "message_end", "message_stop", "completed", "complete", "stop"]`，外加 `"[done]"` 特殊处理。

---

### Q4.3：真实 SSE 流和客户端模拟流有什么区别？为什么不统一？

**参考答案：**

| 维度     | 真实 SSE 流                        | 客户端模拟流                      |
| -------- | ---------------------------------- | --------------------------------- |
| 数据来源 | SSE 持续推送，增量到达             | 后端一次性返回完整文本            |
| 流控方式 | `TextStreamLimiter`（40ms/12字符） | `setInterval`（18-26ms/2字符）    |
| 可取消性 | AbortController + requestId 门禁   | `{ cancelled: boolean }` ref 对象 |
| 思考过程 | 独立 reasoning 通道同步渲染        | 三阶段轮播指示器（1.2s/阶段）     |
| 使用场景 | AI 对话                            | 面试报告回放                      |

**为什么不统一？**

**SSE 流是增量到达的**——每个 chunk 携带一部分新内容，`TextStreamLimiter` 只需要限速即可，不需要拆分文本。

**模拟流是一次性拿到完整文本**——前端需要先将大段文本按字符拆分，然后用定时器逐帧输出。它本质上是在"模拟"流式效果。

场景不同，没法统一：SSE 流有天然的"chunk 边界"，模拟流没有。

---

### Q4.4：`onclose` 的 "Connection closed" 错误是怎么处理的？

**参考答案：**

`@microsoft/fetch-event-source` 在 SSE 连接正常关闭时，会在 `onclose` 回调中抛出 `FatalError("Connection closed")`——这不是真正的错误，而是库的行为。

项目做了特殊处理：

```typescript
// aiService.ts 中
onError: (error) => {
  if (error.message === "Connection closed") return; // 忽略
  // 其他错误才上报
};

// useChatSendFlow.ts catch 块中
if (error.message === "Connection closed") {
  // 正常关闭 → 标记消息完成（而非失败）
  dispatch(finishAssistantMessage({ id: outbound.assistantMessageId }));
  return;
}
```

让"正常关闭"和"异常断开"走不同的处理路径。

---

## 5. WebSocket 实时音频管线

### Q5.1：为什么需要连接态缓冲队列？它解决了什么问题？

**参考答案：**

核心问题：**WebSocket 连接建立需要时间（TCP 握手 + HTTP Upgrade），但用户在按下录音按钮的瞬间就开始说话了。**

```
用户说话 ──────────────────────────────────
录音采集 ─■─■─■─■─■─■─■─■─■─■─■─■─■─■─
WebSocket ─ ─ ─[连接中]──[onopen]─────────
缓冲队列 ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ─flush→
```

**如果没有缓冲队列**：WebSocket 还在 CONNECTING 状态时，`send()` 会失败或数据丢失，用户开头的话就丢了。

**解决方案：**

```typescript
sendAudio(data: Blob | ArrayBuffer) {
  if (this.ws?.readyState === WebSocket.OPEN) {
    this.ws.send(data);                       // 已连接 → 直接发送
  } else if (this.ws?.readyState === WebSocket.CONNECTING) {
    if (this.pendingBinaryQueue.length >= 24) {
      this.pendingBinaryQueue.shift();         // FIFO，溢出时丢弃最旧的
    }
    this.pendingBinaryQueue.push(data);        // 入队等待
  }
}

// onopen 中批量发送
this.ws.onopen = () => {
  this.flushPendingBinaryQueue(); // 按入队顺序逐个 send
  this.startPing();
};
```

**上限 24 块**：640 样本 × 24 = 约 960ms 音频，足以覆盖大部分 WebSocket 建连时间。溢出时丢弃最旧的——丢开头几个音节比阻塞队列更合理。

---

### Q5.2：WebSocket 消息去重用的是什么策略？

**参考答案：**

采用**双重去重策略**——时间戳防线 + 内容指纹防线：

**第一层：基于 timestamp（时间戳防线）**

```typescript
if (nextTimestamp < this.lastMessageTimestamp) return false; // 更旧 → 丢弃
if (
  nextTimestamp === this.lastMessageTimestamp &&
  nextKey === this.lastMessageKey
) {
  return false; // 同一毫秒 + 相同内容 → 重复 → 丢弃
}
```

**第二层：基于 key（内容指纹防线）**

```typescript
const nextKey = `${event.kind}:${message.type}:${text}`;
if (nextKey === this.lastMessageKey) return false; // 相同内容 → 丢弃
```

**为什么需要两层？**

- **时间戳层**：处理乱序到达（WebSocket 不保证消息顺序，尤其在重连后）
- **内容指纹层**：处理无时间戳的消息，以及时间戳相同但内容不同的事件（允许同一毫秒内不同内容通过时间戳层）
- 使用 `!==` 而非 `<=`：允许同一毫秒内不同内容的事件通过时间戳层，在内容指纹层做最终判断

---

### Q5.3：Float32 怎么转 PCM16？640 样本/块是怎么选的？

**参考答案：**

Web Audio API 的 `AnalyserNode` / `ScriptProcessorNode` 输出的是 Float32 样本（-1.0 ~ 1.0），而语音转写服务端需要 PCM16（-32768 ~ 32767）：

```typescript
const floatSamples = event.inputBuffer.getChannelData(0); // Float32
const pcm16 = new Int16Array(floatSamples.length);
for (let i = 0; i < floatSamples.length; i++) {
  pcm16[i] = Math.max(-0x8000, Math.min(0x7fff, floatSamples[i] * 0x7fff));
}
```

**640 样本/块的选择依据：**

在 16kHz 采样率下：640 samples / 16000 = **40ms**

- 40ms 延迟几乎不可感知（满足实时性）
- 避免过小的块导致过多 WebSocket 帧开销（IPv4 最小 TCP 头 20 字节 + WebSocket 最小帧头 2 字节）
- 信息密度足够：中文约 4-5 字/秒，40ms 内约 0.16-0.2 字，足够判断音节

---

### Q5.4：心跳保活是怎么实现的？为什么用 JSON ping 而不是 WebSocket 原生 ping？

**参考答案：**

```typescript
private startPing() {
  this.pingInterval = setInterval(() => {
    this.sendCommand("ping"); // 发送 {"type":"ping"}
  }, 15000); // 15s 间隔，低于大多数代理/网关的 60s 空闲超时
}
```

**为什么用 JSON ping 而不是 WebSocket 原生 ping frame？**

WebSocket 原生 ping/pong 帧由浏览器自动处理，JavaScript 代码**无法控制其发送时机**，也无法在业务层感知。本项目的服务端期望通过 JSON 消息格式区分 ping（保活）和业务命令（start_transcription、stop_transcription），使用 JSON ping 能保持协议一致性。

---

## 6. 状态管理架构

### Q6.1：Redux Toolkit 中 `createAsyncThunk` 的三种状态怎么用？

**参考答案：**

`createAsyncThunk` 自动为每个异步操作生成三种 action：`pending`、`fulfilled`、`rejected`：

```typescript
// 定义 thunk
export const loginUser = createAsyncThunk<
  UserRespDTO, // fulfilled 的 payload 类型
  UserLoginReqDTO, // 调用时传入的参数类型
  { rejectValue: string } // rejected 的 payload 类型
>("user/login", async (data, { rejectWithValue }) => {
  try {
    return await authService.login(data); // → fulfilled
  } catch (error) {
    return rejectWithValue("Login failed"); // → rejected（非抛异常）
  }
});

// 在 extraReducers 中响应
builder
  .addCase(loginUser.pending, (state) => {
    state.loading = true; // 显示 loading
    state.error = null; // 清除旧错误
  })
  .addCase(loginUser.fulfilled, (state, action) => {
    state.loading = false;
    state.currentUser = action.payload; // 保存用户信息
    state.isAuthenticated = true;
    state.authEpoch += 1; // 触发缓存失效
  })
  .addCase(loginUser.rejected, (state, action) => {
    state.loading = false;
    state.error = action.payload ?? "Login failed";
  });
```

**最佳实践：** 在组件中使用 `.unwrap()` 解包：

```typescript
try {
  const user = await dispatch(loginUser(data)).unwrap();
  // fulfilled → 拿到 payload
} catch (error) {
  // rejected → 拿到 rejectWithValue 的值
}
```

---

### Q6.2：跨 Slice 通信是怎么实现的？

**参考答案：**

通过 `extraReducers` 实现——一个 Slice 可以"监听"另一个 Slice 的 action：

```typescript
// chatSlice.ts 中监听 userSlice 的 action
import { checkAuthStatus, logoutUser } from "@/store/slices/userSlice";

extraReducers: (builder) => {
  builder
    .addCase(checkAuthStatus.rejected, (state, action) => {
      if (action.payload?.shouldClearAuth) {
        resetRuntimeState(state); // Token 过期 → 清空聊天
      }
    })
    .addCase(logoutUser.fulfilled, (state) => {
      resetRuntimeState(state); // 登出 → 清空聊天
    });
};
```

**关键原则：** 每个 Slice 只管理自己的 state。不存在"跨 Slice 直接修改对方 state"——chatSlice 只是响应 userSlice 的 action，修改的是 chatSlice 自己的 state。

---

### Q6.3：为什么消息列表的更新用 Redux 而不是 React Query？

**参考答案：**

消息列表有三个特征，恰好与 Redux 的设计初衷匹配：

1. **高频更新**：SSE 流式渲染每 40ms dispatch 一次 `appendAssistantChunk`，React Query 的缓存抽象对此是负担（额外的序列化/比较开销）
2. **本地性**：消息列表是"当前会话的运行时投影"，不是"服务端数据的缓存"——它的数据源是 SSE 流，不是 REST API
3. **细粒度更新**：`appendAssistantChunk` 通过 Immer 只修改单条消息的 content 字段，Redux 能做到只有那一个消息气泡重渲染

---

## 7. 错误处理体系

### Q7.1：错误码的五级命名空间是怎么设计的？

**参考答案：**

采用区间编码方案，通过错误码的第一位数字就能判断错误类别：

```
1000-1999  通用（UNKNOWN, NETWORK, TIMEOUT, ABORTED）
2000-2999  认证（UNAUTHORIZED, FORBIDDEN, TOKEN_EXPIRED）
3000-3999  业务（INVALID_PARAMS, RESOURCE_NOT_FOUND, OPERATION_FAILED）
4000-4999  AI（AI_SERVICE_UNAVAILABLE, AI_QUOTA_EXCEEDED, AI_RESPONSE_ERROR）
5000-5999  客户端（CLIENT_VALIDATION_ERROR, MICROPHONE_DENIED, CAMERA_DENIED）
```

**设计意图：**

- 通过错误码区间的第一位就能判断错误类别（1=通用 2=认证 3=业务 4=AI 5=客户端）
- 每个区间预留 999 个编号，足够扩展
- 错误码映射到用户可读的 `ErrorMessages` 字典，但允许调用方覆盖 message

---

### Q7.2：`AppError.from()` 的智能转换逻辑是什么？

**参考答案：**

消除全项目 try-catch 中的样板代码，自动识别错误类型并映射：

```typescript
static from(error: unknown, defaultCode = ErrorCode.UNKNOWN_ERROR): AppError {
  if (error instanceof AppError) return error;          // 已是 → 直接返回
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return new AppError(ErrorCode.ABORTED, "Request was cancelled.", error);
    }
    return new AppError(defaultCode, error.message, error);
  }
  if (typeof error === "string") return new AppError(defaultCode, error);
  return new AppError(defaultCode, undefined, error);   // 兜底
}
```

**转换规则：**

1. **已有 AppError** → 直接返回，不二次包装
2. **AbortError** → 自动映射为 ABORTED（用户取消不是错误，不应上报监控）
3. **普通 Error** → 使用传入的 `defaultCode`
4. **字符串** → 包装为 AppError
5. **其他** → 兜底为 UNKNOWN_ERROR

**request.ts 中的自动映射：** Axios 响应拦截器根据 HTTP 状态码自动转换：

- 401 → `AppError(UNAUTHORIZED)` → `shouldClearAuth: true`
- 403 → `AppError(FORBIDDEN)`
- 网络错误 → `AppError(NETWORK_ERROR)`
- 超时 → `AppError(REQUEST_TIMEOUT)`

---

## 8. 面试模块

### Q8.1：后端 API Schema 漂移是怎么处理的？

**参考答案：**

后端 API 经历多个版本迭代后，相同含义的字段在不同接口中使用了不同的命名（如 `sessionId` vs `session_id` vs `session_id_old`）。前端通过两种机制平滑应对：

**1. 字段名标准化（`pickFirst`）：**

```typescript
function pickFirst<T>(source, candidates: string[]): T | undefined {
  for (const key of candidates) {
    if (key in source && source[key] !== undefined && source[key] !== null) {
      return source[key] as T;
    }
  }
  return undefined;
}

pickFirst(response, ["sessionId", "session_id", "session_id_old"]);
pickFirst(response, ["questionList", "question_list", "questions"]);
```

不需要后端一次性迁移——前端逐步收敛，旧键名在迁移完成后删除即可。

**2. API 路径降级（`getWithPathFallback`）：**

```typescript
async function getWithPathFallback(newPath, oldPath, config) {
  try {
    return await get(newPath, config);
  } catch (error) {
    if (
      error.code === ErrorCode.RESOURCE_NOT_FOUND ||
      error.message?.includes("operation-failed")
    ) {
      return await get(oldPath, config); // 静默降级
    }
    throw error;
  }
}
```

用户感知不到路径切换——404 是预期行为，不算错误。

---

### Q8.2：摄像头神态分析的互斥锁是怎么设计的？

**参考答案：**

面试中每 5 秒抓取一帧摄像头画面上传 AI 分析。如果某次上传因为网络慢耗时超过 5 秒，下一次轮询不应创建第二个并发上传。

```typescript
const isUploadingRef = useRef(false);

useEffect(() => {
  const interval = setInterval(async () => {
    if (isUploadingRef.current) return; // 上次还在上传 → 跳过本次
    isUploadingRef.current = true;

    try {
      const frame = await captureFrame();
      if (cancelledRef.current) return;
      const result = await uploadAndAnalyze(frame);
      if (!cancelledRef.current) setDemeanor(result);
    } catch (error) {
      if (!cancelledRef.current) console.error(error);
    } finally {
      isUploadingRef.current = false; // 释放锁
    }
  }, 5000);

  return () => {
    cancelledRef.current = true;
    clearInterval(interval);
  };
}, [captureFrame]);
```

**为什么用 `useRef` 而不是 `useState`？**

- `useRef` 的更新不触发重渲染（这是纯逻辑状态，不需要 UI 响应）
- `useRef` 的值在整个组件生命周期中保持稳定引用

**`captureFrame` 回调模式**：轮询逻辑不直接依赖 DOM，接受回调函数——摄像头组件和轮询逻辑完全解耦。

---

### Q8.3：纯 SVG 雷达图是怎么实现的？为什么不直接用图表库？

**参考答案：**

不依赖 ECharts / Recharts，完全用 SVG 原语手绘，对 `node_modules` 体积零影响。

**绘制层级：**

```
1. 背景参考环（4 层同心多边形：25%/50%/75%/100%）
     └─ <polygon> + stroke-dasharray 虚线
2. 轴线（从中心辐射到各顶点）
     └─ <line> x1,y1 → x2,y2
3. 数据多边形（填充 + 描边）
     └─ <polygon> + fill-opacity + stroke
4. 数据点圆点
     └─ <circle> cx,cy,r
5. hover Tooltip（framer-motion 动画进出）
```

**核心算法 —— 多边形顶点坐标计算：**

```typescript
const getPolygonPoints = (data, maxValue, cx, cy, r) => {
  return data.map((value, i) => {
    const angle = (Math.PI * 2 * i) / data.length - Math.PI / 2; // -90° 从顶部开始
    const radius = (value / maxValue) * r;
    return {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });
};
```

**为什么不直接用图表库？**

1. 雷达图这个需求相对简单，不需要库的复杂性
2. 额外依赖增加 bundle 体积（ECharts ~1MB）
3. 自定义 SVG 可以完全控制动画（framer-motion）和交互（mouse-follow tooltip）

---

## 9. 工程化与性能优化

### Q9.1：Vite 构建产物的分包策略是怎么设计的？为什么这样分？

**参考答案：**

```typescript
manualChunks: {
  "pdf-viewer":      ["react-pdf", "pdfjs-dist"],
  "react-core":      ["react", "react-dom", "react-router-dom"],
  "state-management": ["@reduxjs/toolkit", "react-redux", "@tanstack/react-query"],
  "ui-vendor":       ["framer-motion", "lucide-react", /radix-ui/],
}
```

**策略考量：**

| Chunk              | 更新频率 | 策略理由                                         |
| ------------------ | -------- | ------------------------------------------------ |
| `pdf-viewer`       | 极低     | 仅面试页使用（~2MB），按需加载，其他页面不受影响 |
| `react-core`       | 极低     | 应用基石，稳定库单独缓存                         |
| `state-management` | 低       | 状态管理库更新频率低                             |
| `ui-vendor`        | 低       | UI 层独立缓存                                    |
| 业务代码           | 高       | 开发者修改组件时，只需重新下载业务 chunk         |

**效果：** 修改一个聊天组件 → 只有业务代码 chunk 需要重新下载，其他 4 个 chunk 全部命中浏览器缓存。

**核心原则：** 按**变更频率**而非文件大小拆分——稳定的库单独缓存，频繁变更的业务代码不影响 vendor 命中率。

---

### Q9.2：项目的测试策略是怎样的？测试了什么，没测什么？

**参考答案：**

**12 个 Vitest 测试模块**，重点测试非 UI 的纯逻辑模块（单元测试 ROI 最高的部分）：

| 测试文件                         | 测试对象           | 关键用例                                   |
| -------------------------------- | ------------------ | ------------------------------------------ |
| `request.test.ts`                | HTTP 请求去重引擎  | 策略解析、stableSerialize 边界、错误码映射 |
| `audioTranscription.test.ts`     | 音频转录状态机     | 每个事件类型的 state 转换                  |
| `audioToTextWs.test.ts`          | WebSocket 消息处理 | 消息去重、缓冲队列                         |
| `interviewService.test.ts`       | 面试 API           | 字段名标准化、路径降级                     |
| `useChatPageController.test.tsx` | 聊天页面控制器     | 14 个用例覆盖发送/历史/竞态/重定向         |

**诚实说没测的部分：**

- **没有 E2E 测试**（Playwright/Cypress）——实时音频、SSE 流、面试流程这些场景最需要端到端覆盖
- Hook 的测试覆盖不完整——只有 `useChatPageController` 有测试，其他 Hook 靠单元测试间接覆盖

---

### Q9.3：项目的 lint、format、commit 规范是怎么配置的？

**参考答案：**

完整的本地代码质量控制链：

- **ESLint 9**（flat config）：TypeScript + React 规则
- **Prettier**：代码格式化
- **Husky**：Git hooks（pre-commit 执行 lint-staged）
- **Commitlint**：commit message 规范（conventional commits）
- 统一校验入口：`npm run check`（lint + typecheck + test:run）

**没有的部分**（已在项目文档中诚实地指出）：没有 CI/CD（GitHub Actions）自动化流水线。

---

## 10. 设计系统

### Q10.1：项目的设计系统有什么特点？为什么遵循 Apple 风格？

**参考答案：**

348 行的 `DESIGN.md` 定义了一套严格的、可被 AI 理解的设计规范：

**核心约束：**

| 维度 | 规则                                            | 理由                                 |
| ---- | ----------------------------------------------- | ------------------------------------ |
| 色彩 | 唯一彩色是 Apple Blue `#0071e3`，仅用于交互元素 | 减少视觉噪音，用户直觉聚焦可操作元素 |
| 背景 | 黑 `#000000` 和浅灰 `#f5f5f7` 交替分区          | 交替节奏营造沉浸感，无需分隔线       |
| 阴影 | 唯一阴影 `rgba(0,0,0,0.22) 3px 5px 30px 0px`    | 极度克制：只有浮层有阴影             |
| 字体 | SF Pro Display（≥20px）和 SF Pro Text（<20px）  | 光学尺寸自动匹配                     |
| 圆角 | 13px（组件）、9999px（pill）、8px（卡片内部）   | 三种半径覆盖全部场景                 |
| 动效 | 200-300ms，`cubic-bezier(0.25, 0.1, 0.25, 1)`   | Apple 风格 easing                    |

**设计系统本身作为 AI 辅助开发的输入**——文档包含可直接粘贴到 Claude 中的 Prompt 模板，即使用 AI 生成新组件也能自动遵循设计规范。

---

## 11. 项目反思与开放问题

### Q11.1：如果让你重新做这个项目，你会改什么？

**参考答案（从项目文档中提取的诚实反思）：**

1. **流解析逻辑复用**：`aiService.streamChat` 和 `agentService.streamChat` 的流解析基本一致但没有抽象为共享的 stream parser。如果接入第三个 AI 服务，又需要复制一份

2. **ScriptProcessorNode 迁移**：麦克风采集用的 `ScriptProcessorNode` 已被 W3C 标记废弃，应迁移到 `AudioWorklet`（在独立线程处理，避免主线程阻塞）

3. **补充 E2E 测试**：实时音频、SSE 流、面试流程这些场景最需要端到端覆盖

4. **减少状态管理库**：Redux Toolkit + TanStack Query 双库共存增加了心智负担。部分 Redux 状态（如 `chatSlice` 的运行时状态）用 React Context + useReducer 可能更轻量

5. **添加 CI/CD**：虽然本地有完整的 lint/test 链条，但没有自动化的构建、测试、部署流水线

---

### Q11.2：如果用户量增大，SSE 连接数过多怎么办？

**参考答案（体现架构思维）：**

1. **连接池管理**：考虑使用共享 SSE 通道，多个组件/页面复用同一个连接
2. **降级为轮询**：对于非实时场景（如会话列表），降级为短轮询或长轮询
3. **自动重连策略**：指数退避（如 1s → 2s → 4s → 8s → 最大 30s），避免在服务端压力大时集中重连（thundering herd）
4. **评估 WebSocket**：如果 SSE 的单向流不够用（如需要双向实时通信），评估迁移到 WebSocket
5. **消息队列缓冲**：在服务端引入消息队列，SSE 推送到前端的速率由队列消费控制

---

### Q11.3：这个项目的最大价值在哪里？面试时应该重点讲什么？

**参考答案：**

项目的最大价值不在于"用了 React 19 + TypeScript + Tailwind"这些关键词，而在于它证明了**能在真实异步复杂度下做出正确的工程决策**。

**面试时重点讲这三个模块：**

| 优先级      | 模块                   | 准备要点                                                                                                                     |
| ----------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 🥇 第一梯队 | **请求去重引擎**       | 画架构图，讲四种策略的设计理由，讲 stableSerialize 的循环引用和属性排序处理，讲批量消费者 debounce 和 lodash.debounce 的区别 |
| 🥈 第二梯队 | **WebSocket 音频系统** | 讲连接态缓冲队列的必要性，画消息去重的流程图（双重去重），讲 PCM16 转换原理                                                  |
| 🥉 第三梯队 | **并发竞态治理**       | 准备 3-4 个具体场景（快速双击、录音启停、SSE 取消、组件卸载），每个给出方案                                                  |

**回答"你是怎么处理竞态条件的"这个问题时，准备以下面试官大概率追问：**

1. "`stableSerialize` 遇到循环引用怎么办？" → WeakSet 记录已遍历对象
2. "为什么 GET 默认 join，POST 默认 off？" → HTTP 幂等性语义
3. "Symbol 令牌和 boolean flag 的区别？" → Symbol 每次创建唯一，避免误判
4. "流式渲染为什么做客户端限速？" → 后端推送速度不可控，限速保护 UI 流畅度

---

## 附录：面试快速自检清单

用这些问题自测你对项目的掌握程度：

- [ ] 能画出 `request.ts` 的调度管道流程图
- [ ] 能讲清楚 Pending Outbound 的时序和三个触发条件
- [ ] 能解释 Symbol 令牌为什么优于 boolean flag
- [ ] 能说出 SSE 三层取消协议每一层的作用
- [ ] 能讲清楚 WebSocket 双重去重的两条防线
- [ ] 能解释 Redux vs React Query 的分工边界
- [ ] 能说出 `authEpoch` 的设计意图
- [ ] 能讲清楚 `stableSerialize` 比 `JSON.stringify` 多处理了什么
- [ ] 能诚实地说出项目的不足之处
- [ ] 能针对"高并发 SSE 连接"给出架构建议

---

> **最后建议：** 面试时不要只背答案——面试官大概率会顺着你的回答追问。最好的准备方式是：打开对应源文件，对着代码讲一遍。能讲清楚代码为什么这样写，比背十个答案都有说服力。
