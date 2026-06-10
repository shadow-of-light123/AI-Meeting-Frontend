# 码上面试平台 · 新人代码阅读指南

> 面向首次接触本项目的开发者，按层次递进的方式快速建立全局认知。

---

## 一、阅读策略

本项目代码量 15000+ 行，不建议按文件字母序或逐行通读。推荐**分层递进**策略：

```
第一层（骨架）→ 第二层（基础设施）→ 第三层（状态管理）→ 第四层（业务）→ 第五层（UI）
     ↓                  ↓                    ↓                  ↓              ↓
  3 个文件            3 个文件             3 个文件          按需选读        按路由对照
```

每层读完即可对项目建立对应深度的理解，不必一次性读完所有文件。

---

## 二、第一层：理解项目骨架（必读，约 15 分钟）

这一层回答三个问题：**应用怎么启动？有哪些页面？全局状态怎么注入？**

| 顺序 | 文件                    | 核心关注点                                                                                                              |
| ---- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | `src/app/App.tsx`       | 启动时用 Token 检查登录态（`useAppSelector` + `useAppDispatch`），未就绪显示 Loading，认证完成后挂载 `<RouterProvider>` |
| 2    | `src/app/router.tsx`    | React Router 路由树结构，哪些页面是懒加载的（`lazy()`），`AuthGuard` 包裹了哪些路由                                     |
| 3    | `src/app/providers.tsx` | `<Provider store={store}>` + `<QueryClientProvider>` 的嵌套结构，理解 Redux 和 TanStack Query 的注入时机                |

**读完这一层你应该能回答：**

- 用户打开页面后，从"加载中"到"看到首页"经历了几步
- 哪些页面需要登录，哪些不需要
- Redux Store 和 QueryClient 在整个组件树的哪个位置注入

---

## 三、第二层：基础设施（必读，约 20 分钟）

这一层回答：**API 怎么调？环境变量怎么管？全局常量有哪些？**

| 顺序 | 文件                   | 核心关注点                                                                                                                                                                                                                        |
| ---- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4    | `src/config/env.ts`    | `VITE_API_BASE_URL` / `VITE_API_TARGET` / `VITE_WS_BASE_URL` 的默认值和解析逻辑，Vite proxy 转发机制                                                                                                                              |
| 5    | `src/lib/request.ts`   | **重点文件（650 行）** —— Axios 实例创建、`BaseResponse<T>` 自动解包、四种去重策略（join/cancel-previous/reject/off）的编排、`stableSerialize` 序列化器、`withDebounce` 批量消费者模式、401/403 自动映射为 `AppError`、白名单路径 |
| 6    | `src/lib/constants.ts` | `ROUTES` 路由常量、`CHAT_ROLES` 角色枚举、`INTERVIEW_DEFAULTS` 面试默认值、`MEDIA_TARGETS` 媒体约束                                                                                                                               |

**读完这一层你应该能回答：**

- 前后端怎么通信的（开发环境 proxy，生产环境同源或独立部署）
- 调用 `request.get('/api/xxx')` 时，请求经过了哪些中间层
- 什么时候用 `requestPolicy: { dedupe: "reject" }`，什么时候用 `"join"`

---

## 四、第三层：状态管理（必读，约 20 分钟）

这一层回答：**全局状态怎么分的？认证流程怎么流转的？流式消息怎么更新的？**

| 顺序 | 文件                            | 核心关注点                                                                                                                                                                   |
| ---- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7    | `src/store/index.ts`            | `configureStore` 组合了 user reducer + chat reducer，导出 `RootState` / `AppDispatch` 类型                                                                                   |
| 8    | `src/store/slices/userSlice.ts` | 三个 `createAsyncThunk`：`loginUser`、`logoutUser`、`checkAuthStatus`。`authEpoch` 字段在身份变更时自增，驱动 TanStack Query 缓存失效                                        |
| 9    | `src/store/slices/chatSlice.ts` | 消息列表（`Message[]`）、流式状态三标识符（`isStreaming` / `activeStreamId` / `pendingOutbound`）、`appendAssistantChunk` / `appendAssistantReasoningChunk` 增量更新 reducer |

**读完这一层你应该能回答：**

- Redux 管什么、TanStack Query 管什么（分工边界）
- 用户刷新页面后，认证状态怎么恢复的
- SSE 流式返回的文本片段是怎么变成界面上逐字出现的消息的

---

## 五、第四层：核心业务模块（按需选读）

完成前三层后，你对项目的骨架和血管有了完整认知。接下来根据你的关注点，选择对应的业务模块深入：

### 5.1 AI 对话链路

| 文件                                | 关注点                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/services/aiService.ts`         | SSE 流式聊天 API 封装，`@microsoft/fetch-event-source` 用法，流结束信号检测                                            |
| `src/services/agentService.ts`      | Agent 模式 SSE 对话（与 aiService 结构相似）                                                                           |
| `src/hooks/chat/useChatSendFlow.ts` | **核心 Hook** —— Pending Outbound 延迟执行模式、会话创建与消息发送的竞态互锁、`activeRequestIdRef` 门禁 + 三层取消协议 |
| `src/lib/streamLimiter.ts`          | `TextStreamLimiter` 逐字输出控制器（86 行），惰性启停、按需刷新                                                        |
| `src/lib/chat.ts`                   | `ChatMessage` 类型定义、消息状态常量                                                                                   |

**关键阅读路径：**

```
用户点击发送
  → useChatSendFlow.sendMessage()
    → 如果无 sessionId → chatSlice.setPendingOutbound() → aiService.createConversation()
    → useEffect 检测到 pendingOutbound + sessionId → 发起 SSE
    → chatSlice 增量更新消息内容
    → TextStreamLimiter 控制逐字渲染速率
```

### 5.2 面试链路

| 文件                                                 | 关注点                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/hooks/interview/useInterviewSessionFlow.ts`     | 面试主流程 Hook：上传简历 → AI 出题 → 多轮问答 → 神态分析 → 结束 → 报告 |
| `src/services/interviewService.ts`                   | 面试 API 封装，`pickFirst` 字段名标准化，`getWithPathFallback` API 降级 |
| `src/hooks/interview/useInterviewDemeanorPolling.ts` | 5s 定时轮询摄像头神态分析，`isUploadingRef` 互斥锁防堆积                |
| `src/hooks/interview/useInterviewMessageStream.ts`   | 客户端模拟流式（同步响应 → 分帧渲染）                                   |
| `src/components/interview/InterviewRadarChart.tsx`   | 纯 SVG 雷达图（不依赖图表库）                                           |

### 5.3 音频链路

| 文件                                                 | 关注点                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/services/audioToTextWs.ts`                      | WebSocket 语音转写客户端：连接态缓冲队列（`pendingBinaryQueue`）、时间戳+内容指纹双重去重、15s 心跳、PCM16 编码 |
| `src/hooks/audio/useAudioTranscriptionController.ts` | 录音启停控制，Symbol 令牌防竞态                                                                                 |
| `src/services/xunfeiTtsService.ts`                   | 讯飞长文本 TTS：异步任务两阶段协议（创建→轮询）、ObjectURL 缓存                                                 |
| `src/lib/audioTranscription.ts`                      | 转录状态机：纯函数 reducer，8 种事件类型，`liveText` / `finalText` 双轨模型                                     |

### 5.4 错误处理体系

| 文件              | 关注点                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `src/lib/errors/` | `AppError` 类 + `ErrorCode` 枚举（五级命名空间 1000-5999），`AppError.from()` 自动识别 Error 类型并映射 |

---

## 六、第五层：UI 层（按路由对照着看）

| 目录 / 文件                 | 对应路由 / 功能                                                              |
| --------------------------- | ---------------------------------------------------------------------------- |
| `src/layouts/`              | `AppLayout`：侧边栏 + `<Outlet/>`，移动端用 Sheet 抽屉                       |
| `src/pages/auth/`           | `/auth` 登录/注册页                                                          |
| `src/pages/chat/`           | `/chat` AI 对话                                                              |
| `src/pages/interview/`      | `/interview` 面试模块                                                        |
| `src/pages/home/`           | `/` 首页                                                                     |
| `src/pages/questionbank/`   | `/questionbank` 题库                                                         |
| `src/pages/marketing/`      | `/marketing` 营销页                                                          |
| `src/components/ui/`        | shadcn/ui 基础组件（button, card, dialog, input, sheet...）                  |
| `src/components/layout/`    | 侧边栏子组件（SidebarHeader, SidebarHistory, SidebarNav...）                 |
| `src/components/chat/`      | 对话组件（ChatRoom, ChatBubble, ChatList, SmartComposer, ReasoningPanel...） |
| `src/components/interview/` | 面试组件（resume, camera, intro, report, sketchpad...）                      |

---

## 七、按角色推荐的阅读路径

### 如果你是：新加入的前端开发（需要快速上手改代码）

```
必读：第一层（全部）→ 第二层（全部）→ 第三层（全部）
选读：第四层中你负责的模块
用时：约 1 小时建立全局认知，再加 2-3 小时深入业务模块
```

### 如果你是：后端开发（需要了解前端怎么对接你的接口）

```
必读：src/config/env.ts → src/lib/request.ts → src/services/（找到你负责的 service）
用时：约 30 分钟
重点关注：BaseResponse 格式约定、requestPolicy 去重机制、SSE 流结束信号
```

### 如果你是：面试官 / 代码评审者（需要评估项目质量）

```
推荐的深度阅读顺序：
1. src/lib/request.ts —— 请求去重引擎（最体现架构能力的模块）
2. src/hooks/chat/useChatSendFlow.ts —— 并发竞态治理
3. src/services/audioToTextWs.ts —— 实时通信系统的工程化
4. src/lib/streamLimiter.ts —— 小而美的通用模块
5. src/lib/errors/ —— 错误处理体系

辅助文档：
- HIGHLIGHTS.md —— 难点与亮点完整分析
- EVALUATION.md —— 项目含金量评估与评分卡
```

### 如果你是：产品 / 设计（需要了解页面结构）

```
直接看 router.tsx + 对应页面文件，不需要深入 hooks 和 services
重点关注：src/layouts/ → src/pages/ → src/components/ui/
设计规范参考：DESIGN.md
```

---

## 八、文件大小参考（按行数排序，了解哪些是核心大文件）

| 文件                                | 行数（约） | 说明                            |
| ----------------------------------- | ---------- | ------------------------------- |
| `src/lib/request.ts`                | 650        | 请求去重引擎，项目最大单文件    |
| `src/services/interviewService.ts`  | 400+       | 面试 API 封装 + Schema 漂移兼容 |
| `src/hooks/chat/useChatSendFlow.ts` | 350+       | 对话发送流程，最复杂的 Hook     |
| `src/services/audioToTextWs.ts`     | 350+       | WebSocket 音频客户端            |
| `src/store/slices/chatSlice.ts`     | 300+       | 聊天状态管理                    |
| `src/pages/interview/`              | 多文件     | 面试页面组件群                  |
| `src/lib/streamLimiter.ts`          | 86         | 小而美的流式控制器              |

---

## 九、技术名词速查表

| 缩写 / 名词 | 全称 / 含义                  | 在项目中的角色        |
| ----------- | ---------------------------- | --------------------- |
| SSE         | Server-Sent Events           | AI 流式对话的传输协议 |
| ASR         | Automatic Speech Recognition | 语音转文字            |
| TTS         | Text-to-Speech               | 文字转语音（讯飞）    |
| PCM         | Pulse Code Modulation        | 音频原始编码格式      |
| RTK         | Redux Toolkit                | 客户端状态管理        |
| TQ          | TanStack Query               | 服务端缓存管理        |
| shadcn/ui   | shadcn/ui                    | 基于 Radix 的组件体系 |
| DTO         | Data Transfer Object         | API 数据传输类型定义  |

---

> **建议：** 打开项目后，从 `src/app/App.tsx` 开始，按照本文档的第一到第三层顺序阅读。每一层读完再进入下一层，不要跳跃。
