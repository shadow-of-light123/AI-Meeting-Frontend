# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是"码上面试平台"的前端项目 —— 基于大语言模型的简历分析、模拟面试和 AI 对话应用。后端仓库是 [AI-Meeting](https://github.com/lishuangqiang/AI-Meeting)，采用 Spring Boot 3 单体架构。

## 开发命令

```bash
npm run dev          # 启动开发服务器（默认代理到 http://localhost:8002）
npm run build        # 类型检查 + 生产构建
npm run preview      # 预览生产构建
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化
npm test             # Vitest 监听模式
npm run test:run     # Vitest 单次运行
npm run test:ci      # CI 测试（等同于 test:run）
npm run typecheck    # TypeScript 类型检查（不生成文件）
npm run check        # 完整校验：lint + typecheck + test:run
```

## 技术栈

React 19.2 · TypeScript 5.9 (strict) · Vite 7.3 · Tailwind CSS 3.4 · React Router 7.13 · Redux Toolkit 2.11 · TanStack React Query 5.90 · Radix UI (shadcn/ui 组件体系) · Axios 1.13 · Zod 4.3 · React Hook Form 7.71 · Framer Motion 12.35 · `@microsoft/fetch-event-source` (SSE 流式响应) · Vitest 4.0 · jsdom · ESLint 9 flat config · Prettier · Husky · Commitlint

## 目录结构与架构

```
src/
├── app/               # App 入口：RouterProvider + Redux/Query 初始化
│   ├── App.tsx        # 启动时用 Token 检查登录态，未就绪时显示 Loading
│   ├── router.tsx     # React Router 路由定义（懒加载）
│   └── providers.tsx  # Redux Store + TanStack QueryClient 提供者
├── pages/             # 页面级组件（auth, chat, interview, marketing, questionbank）
├── layouts/           # AppLayout：侧边栏 + <Outlet/>，移动端用 Sheet 抽屉
├── components/
│   ├── ui/            # shadcn/ui 基础组件（button, card, dialog, input, sheet, etc.）
│   ├── auth/          # AuthGuard（路由守卫，未登录跳转 /auth）, AuthFormCard, AuthMarketingPanel
│   ├── chat/          # ChatRoom, ChatBubble, ChatList, SmartComposer, ReasoningPanel, ProgressBubble
│   ├── interview/     # 面试专用组件（resume, camera, intro, report, sketchpad）
│   ├── home/          # 首页：Hero, QuickActions, ModelSelector, ComposerPanel
│   ├── layout/        # Sidebar 及子组件（SidebarHeader, SidebarHistory, SidebarNav, etc.）
│   ├── audio/         # MicrophoneControl
│   └── feedback/      # ErrorNotice
├── hooks/             # 按功能域拆分的自定义 Hook
│   ├── audio/         # ASR 录音、TTS 播放、音频缓存
│   ├── auth/          # 登录页面控制器
│   ├── chat/          # 对话发送流程、历史加载、路由状态、运行时共享逻辑
│   ├── interview/     # 面试核心逻辑（session, resume, report, camera, records, shared）
│   ├── home/          # 首页控制器
│   └── layout/        # 侧边栏控制器
├── services/          # API 服务层
│   ├── aiService.ts           # AI 对话 API + SSE 流式聊天
│   ├── agentService.ts        # 智能体（Agent）SSE 对话
│   ├── interviewService.ts    # 面试相关 API（简历解析、答题、评分、雷达图、记录）
│   ├── authService.ts         # 登录/注册/登出
│   ├── audioToTextWs.ts       # WebSocket 语音转写客户端
│   └── xunfeiTtsService.ts    # 讯飞长文本 TTS
├── store/             # Redux Toolkit
│   ├── index.ts       # configureStore: user + chat reducer
│   ├── hooks.ts       # useAppDispatch / useAppSelector 类型封装
│   └── slices/
│       ├── userSlice.ts   # 登录、登出、auth 状态检查（createAsyncThunk）
│       └── chatSlice.ts   # 消息列表、流式状态、pending outbound、active stream 追踪
├── lib/               # 工具函数与共享逻辑
│   ├── request.ts     # Axios 封装（详见下方"HTTP 请求层"）
│   ├── chat.ts        # ChatMessage 类型定义与状态常量
│   ├── authToken.ts   # localStorage Token 读写
│   ├── errors/        # AppError 类 + ErrorCode 枚举（1000-5999 区间划分）
│   ├── constants.ts   # ROUTES, CHAT_ROLES, INTERVIEW_DEFAULTS, MEDIA_TARGETS
│   ├── streamLimiter.ts   # SSE 文本流限速器（逐字输出控制）
│   ├── audioTranscription.ts  # 语音转写消息解析（增量去重）
│   └── utils.ts       # cn() 等通用工具
├── config/
│   └── env.ts         # VITE_API_BASE_URL / VITE_API_TARGET / VITE_WS_BASE_URL 环境变量解析
└── types/
    ├── ai.ts          # AI 对话相关 DTO 类型定义
    └── auth.ts        # 认证相关 DTO
```

## 核心架构决策

### HTTP 请求层 (`src/lib/request.ts`)

- Axios 实例 baseURL 为 `VITE_API_BASE_URL`（默认 `/api`，开发时 Vite proxy 转发到 `VITE_API_TARGET`）
- 后端统一返回 `BaseResponse<T>`（code/message/data/requestId/success），自动解包为 `data`
- **请求去重与防抖**：通过 `requestPolicy` 支持 `join`（合并并发请求）、`cancel-previous`、`reject`、`debounceMs` 四种策略
- 401/403 自动映射为 `AppError(UNAUTHORIZED/FORBIDDEN)`
- `/xunzhi/v1/users/login`、`/register`、`/check-login` 为白名单路径，不注入 Token

### 状态管理分工

- **Redux**：用户认证状态（userSlice）、聊天运行时状态（chatSlice，含流式消息更新）
- **TanStack React Query**：服务端数据缓存（staleTime: 5min, refetchOnWindowFocus: false）
- **组件本地状态**：表单、UI 交互

### SSE 流式响应

AI/Agent 对话使用 `@microsoft/fetch-event-source` 进行 SSE 流式请求。`chatSlice` 通过 `appendAssistantChunk` + `appendAssistantReasoningChunk` 增量更新消息内容，`setActiveStream` 追踪当前流状态。`TextStreamLimiter` 用于控制前端文本逐字渲染速率（默认 40ms 间隔，每次 12 字符）。

### 面试模块

面试流程：上传简历 → AI 解析出题 → 多轮问答（评分 + 追问）→ 神态分析 → 结束面试 → 报告（雷达图 + 回放）

- `useInterviewSessionFlow` 是面试主流程 Hook，管理会话生命周期
- 答题支持文本和语音两种方式，带 `requestPolicy: { dedupe: "reject", debounceMs: 250 }` 防重
- 后端 API 存在新旧路径兼容（`getWithPathFallback`），404时自动降级
- 面试恢复：`restoreInterviewSession` 用于恢复中断的面试会话

### WebSocket 语音转写

`AudioToTextWebSocket` 类封装 WebSocket 连接，支持心跳保活（15s ping）、二进制音频帧发送、连接中排队（最多 24 个 chunk）、基于 timestamp + messageKey 的消息去重。

### 环境变量

- `VITE_API_BASE_URL`：API 基础路径，默认 `/api`
- `VITE_API_TARGET`：开发代理目标，默认 `http://localhost:8002`
- `VITE_WS_BASE_URL`：WebSocket 地址（可选，不设则自动推断 ws/wss 协议）

### `@/` 路径别名

`@/` 映射到 `src/`，在 tsconfig 和 vite 中均已配置。

### 代码分割

Vite 构建时将 `react-pdf`/`pdfjs-dist` 单独拆分为 `pdf-viewer` chunk，`react-router-dom`/react 核心为 `react-core`，状态管理库为 `state-management`，UI 库为 `ui-vendor`。

## 设计规范

项目遵循 Apple 风格设计系统（详见 `DESIGN.md`），核心要点：

- 颜色：纯黑 `#000000` / 浅灰 `#f5f5f7` 交替分区，唯一强调色 Apple Blue `#0071e3` 仅用于交互元素
- Shadow 使用极其克制：唯一阴影 `rgba(0,0,0,0.22) 3px 5px 30px 0px`
- 图标库：Lucide React
- UI 组件基于 shadcn/ui（Radix 原语）+ Tailwind CSS，配置文件在 `components.json`
