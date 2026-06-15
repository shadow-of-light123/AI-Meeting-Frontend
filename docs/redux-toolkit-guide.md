# Redux Toolkit 完整使用指南

> 本文基于本项目（码上面试平台前端）的实际代码，从零讲解 Redux Toolkit 的用法。
> 阅读完本文后，你将能理解项目中所有 Redux 相关代码，并能独立使用 Redux Toolkit 开发新功能。

---

## 目录

1. [为什么需要 Redux Toolkit](#1-为什么需要-redux-toolkit)
2. [核心概念速览](#2-核心概念速览)
3. [项目结构总览](#3-项目结构总览)
4. [Store：全局状态容器](#4-store全局状态容器)
5. [Slice：状态切片](#5-slice状态切片)
6. [createAsyncThunk：异步操作](#6-createasyncthunk异步操作)
7. [在组件中使用](#7-在组件中使用)
8. [跨 Slice 通信](#8-跨-slice-通信)
9. [与 React Query 的分工](#9-与-react-query-的分工)
10. [完整数据流示例](#10-完整数据流示例)
11. [最佳实践总结](#11-最佳实践总结)

---

## 1. 为什么需要 Redux Toolkit

### 1.1 问题场景

假设有一个聊天应用，以下状态需要在多个组件之间共享：

- **用户信息**：登录/登出后，顶栏头像、侧边栏用户名、聊天发送者名称都需要更新
- **聊天消息**：输入框发送消息后，消息列表要立即显示新消息，同时侧边栏的会话列表需要刷新
- **流式状态**：AI 回复逐字到达时，消息气泡要实时更新内容，发送按钮要锁定

如果只用 React 的 `useState`，这些状态需要通过 props 层层传递，很快就会失控。

### 1.2 Redux Toolkit 解决了什么

| 痛点                             | Redux Toolkit 的解决方案                                     |
| -------------------------------- | ------------------------------------------------------------ |
| 状态分散在组件中，无法共享       | **Store**：单一全局状态树，任何组件都能访问                  |
| 修改状态的逻辑散落各处           | **Slice**：将状态 + 修改逻辑封装在一起                       |
| 手写 action type 字符串易出错    | **自动生成** action creator 和 type                          |
| 异步请求（登录、加载消息）难管理 | **createAsyncThunk**：自动管理 loading/success/error 三态    |
| TypeScript 类型推导繁琐          | **一站式类型支持**：从 store 到 hook 全链路类型安全          |
| 不可变更新代码冗长               | **Immer** 内置集成：直接"修改" state，框架自动转为不可变更新 |

---

## 2. 核心概念速览

Redux Toolkit 围绕四个核心 API 构建：

```
┌─────────────────────────────────────────────────────────────────┐
│                     Redux Toolkit 核心四件套                      │
├─────────────────┬───────────────────────────────────────────────┤
│ configureStore  │ 创建 Store，自动组合 reducer、开启 DevTools     │
│ createSlice     │ 定义状态 + 同步修改逻辑，自动生成 actions        │
│ createAsyncThunk│ 定义异步操作，自动 dispatch pending/fulfilled/rejected│
│ createSelector  │ 派生数据缓存（本项目暂未深度使用）               │
└─────────────────┴───────────────────────────────────────────────┘
```

### 2.1 数据流方向（单向）

```
组件 dispatch(action)
       │
       ▼
   ┌───────┐    ┌──────────┐
   │ Slice │───▶│  Store   │   Store 是唯一数据源，数据只向一个方向流动
   │Reducer│    │ (state)  │
   └───────┘    └────┬─────┘
                     │
                     ▼
              组件通过 useSelector 读取最新 state → 自动重渲染
```

### 2.2 关键规则

1. **单一数据源**：整个应用只有一个 Store
2. **State 只读**：唯一改变 state 的方式是 dispatch 一个 action
3. **Reducer 是纯函数**：接收旧 state + action，返回新 state（Immer 让你能直接"修改"）
4. **异步逻辑在 thunk 中**：Reducer 内部不能有副作用（API 调用、随机数等）

---

## 3. 项目结构总览

```
src/store/
├── index.ts              # configureStore + 导出 RootState / AppDispatch 类型
├── hooks.ts              # 类型安全的 useAppDispatch / useAppSelector
└── slices/
    ├── userSlice.ts      # 用户认证状态（登录、登出、Token 校验）
    └── chatSlice.ts      # 聊天运行时状态（消息列表、流式状态、pending 消息）
```

### 3.1 文件职责

| 文件                  | 职责                                       | 类比               |
| --------------------- | ------------------------------------------ | ------------------ |
| `store/index.ts`      | 创建全局 Store，组合所有 slice 的 reducer  | 数据库实例         |
| `store/hooks.ts`      | 封装带类型的 `useDispatch` / `useSelector` | JDBC 驱动          |
| `slices/userSlice.ts` | 用户认证相关的 state + reducer + thunk     | user 表 + 存储过程 |
| `slices/chatSlice.ts` | 聊天消息相关的 state + reducer             | chat 表 + 存储过程 |

---

## 4. Store：全局状态容器

### 4.1 创建 Store（`src/store/index.ts`）

```typescript
import { configureStore } from "@reduxjs/toolkit";
import userReducer from "./slices/userSlice";
import chatReducer from "./slices/chatSlice";

export const store = configureStore({
  reducer: {
    user: userReducer, // state.user 由 userSlice 管理
    chat: chatReducer, // state.chat 由 chatSlice 管理
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware(),
  devTools: process.env.NODE_ENV !== "production",
});

// 从 store 自身推导出 TypeScript 类型
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

**逐行解释：**

- `configureStore`：Redux Toolkit 提供的创建 Store 的函数，内部自动做了很多事：
  - 自动组合多个 reducer
  - 自动添加 `redux-thunk` 中间件（让 dispatch 可以接收函数）
  - 开发环境下自动启用 Redux DevTools 浏览器插件
- `reducer` 对象：key 是 state 的第一级字段名，value 是管理该字段的 reducer
  - 这里定义了 `state.user` 和 `state.chat` 两个顶级切片
- `RootState`：整个 Store 的状态树类型，通过 `ReturnType<typeof store.getState>` 自动推导
- `AppDispatch`：dispatch 函数的类型，包含 thunk 中间件的类型信息

### 4.2 全局 state 的形状

```typescript
// RootState 的实际结构（由两个 slice 拼合）
{
  user: {
    currentUser: { id: 1, username: "tester" } | null,
    isAuthenticated: boolean,
    loading: boolean,
    error: string | null,
    authEpoch: number,
  },
  chat: {
    messages: ChatMessage[],
    isStreaming: boolean,
    error: string | null,
    currentSessionId: string | null,
    currentSessionTitle: string | null,
    pendingOutbound: PendingOutbound | null,
    activeStreamRequestId: string | null,
    activeStreamSessionId: string | null,
    activeStreamMessageId: string | null,
    isStartingNewSession: boolean,
  }
}
```

### 4.3 注入到 React 应用（`src/app/providers.tsx`）

```typescript
import { Provider } from "react-redux";
import { store } from "../store";

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <Provider store={store}>   {/* Provider 让整个组件树都能访问 store */}
      {children}
    </Provider>
  );
}
```

`<Provider store={store}>` 是 React Redux 提供的组件，它利用 React Context 将 store 注入到整个组件树。任何一个子孙组件都可以通过 `useSelector` 读取状态、通过 `useDispatch` 派发 action。

---

## 5. Slice：状态切片

`createSlice` 是 Redux Toolkit 的核心 API，一个 API 同时定义：

- **State**：初始状态
- **Reducers**：同步的状态修改逻辑
- **Actions**：自动生成的 action creator 函数

### 5.1 基本结构

以 `chatSlice.ts` 为例，一个 Slice 包含三部分：

```typescript
import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

// 第一步：定义 State 的 TypeScript 类型
interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  // ...
}

// 第二步：定义初始值（应用启动时的默认状态）
const initialState: ChatState = {
  messages: [],
  isStreaming: false,
  error: null,
  // ...
};

// 第三步：创建 Slice
export const chatSlice = createSlice({
  name: "chat", // slice 名称，action type 的前缀
  initialState, // 初始状态
  reducers: {
    // 同步 reducer（生成同步 action）
    // 在这里定义修改 state 的函数
  },
  extraReducers: (builder) => {
    // 额外 reducer（响应其他 slice 的 action 或 thunk）
    // 在这里响应 createAsyncThunk 或其他 slice 的 action
  },
});

// 导出自动生成的 action creator
export const { resetChatRuntime, appendUserMessage /* ... */ } =
  chatSlice.actions;
// 导出 reducer（给 store 的 configureStore 使用）
export default chatSlice.reducer;
```

### 5.2 Reducers 详解（同步操作）

Redux Toolkit 内置了 **Immer** 库，让你可以直接"修改" state，框架在内部自动将修改转为不可变更新。

#### 例子 1：简单赋值

```typescript
reducers: {
  // 不需要 action 参数 —— 直接重置所有字段
  resetChatRuntime: (state) => {
    state.messages = [];
    state.isStreaming = false;
    state.error = null;
    state.currentSessionId = null;
    // ...
  },
}
```

#### 例子 2：带 payload 的 action

```typescript
reducers: {
  // PayloadAction<{ 参数类型 }> 声明了 action.payload 的类型
  setChatRuntimeSession: (
    state,
    action: PayloadAction<{ sessionId: string; title: string }>,
  ) => {
    state.currentSessionId = action.payload.sessionId;
    state.currentSessionTitle = action.payload.title;
    state.error = null;
  },
}
```

**dispatch 方式**：

```typescript
dispatch(setChatRuntimeSession({ sessionId: "abc123", title: "我的会话" }));
```

#### 例子 3：数组操作（Immer 让你直接 push）

```typescript
reducers: {
  appendUserMessage: (state, action: PayloadAction<ChatMessage>) => {
    state.messages.push(action.payload);   // 传统 Redux 需要 [...state.messages, payload]
    state.error = null;
  },
}
```

#### 例子 4：查找并修改数组中的某项

```typescript
reducers: {
  appendAssistantChunk: (
    state,
    action: PayloadAction<{ id: string; content: string }>,
  ) => {
    const message = state.messages.find(
      (item) => item.id === action.payload.id,
    );
    if (!message) return;  // 找不到就跳过（防止运行时错误）
    message.content = action.payload.content;
    message.status = "streaming";
  },
}
```

### 5.3 reducer 与 action 的对应关系

`createSlice` 会自动为 `reducers` 对象中的**每个 key** 生成对应的 action creator：

| reducers 中定义的函数   | 自动生成的 action creator                 | 自动生成的 action type         |
| ----------------------- | ----------------------------------------- | ------------------------------ |
| `resetChatRuntime`      | `chatSlice.actions.resetChatRuntime`      | `"chat/resetChatRuntime"`      |
| `appendUserMessage`     | `chatSlice.actions.appendUserMessage`     | `"chat/appendUserMessage"`     |
| `setChatRuntimeSession` | `chatSlice.actions.setChatRuntimeSession` | `"chat/setChatRuntimeSession"` |

**命名规则**：`{slice的name}/{reducer的key}`

### 5.4 完整示例：chatSlice 的 12 个 reducer

chatSlice 定义了 12 个 reducer，覆盖了聊天运行时的所有操作：

```
resetChatRuntime          → 完全重置聊天状态（清空消息、流式、会话信息）
beginNewChatSession       → 重置 + 设置"新建会话过渡"标志
finishStartingNewChatSession → 清除过渡标志
setChatRuntimeSession     → 设置当前会话 ID 和标题
hydrateChatSession        → 加载历史会话（替换消息列表 + 设置会话信息）
setPendingOutbound        → 设置待发送的消息（创建会话后等待路由同步）
appendUserMessage         → 向消息列表追加用户消息
appendAssistantPlaceholder → 向消息列表追加 AI 占位消息
appendAssistantChunk      → 增量更新 AI 消息的正文内容（逐字流式渲染）
appendAssistantReasoningChunk → 增量更新 AI 消息的推理内容
finishAssistantMessage    → 将 AI 消息标记为"已完成"
failAssistantMessage      → 将 AI 消息标记为"失败"，填入错误信息
setActiveStream           → 设置当前活跃的 SSE 流追踪信息
```

---

## 6. createAsyncThunk：异步操作

`createAsyncThunk` 用于处理**有副作用的异步操作**（API 调用、文件读写等）。

### 6.1 为什么需要 createAsyncThunk

Reducer 必须是**纯函数**——不能在 reducer 内部调用 API。异步操作需要放在 thunk 中。

`createAsyncThunk` 自动为异步操作生成三种 action：

```
yourThunk.pending    → 请求开始（常用：设置 loading = true）
yourThunk.fulfilled  → 请求成功（常用：保存返回数据）
yourThunk.rejected   → 请求失败（常用：记录错误信息）
```

### 6.2 完整示例：登录（userSlice.ts）

#### 定义 Thunk

```typescript
import { createAsyncThunk } from "@reduxjs/toolkit";

// 泛型参数：<成功返回值类型, 调用时传入的参数类型, { rejectValue 类型 }>
export const loginUser = createAsyncThunk<
  UserRespDTO, // fulfilled 时 action.payload 的类型
  UserLoginReqDTO, // 调用 loginUser(data) 时 data 的类型
  { rejectValue: string } // rejected 时 action.payload 的类型
>(
  "user/login", // action type 前缀
  async (data, { rejectWithValue }) => {
    try {
      return await authService.login(data);
      // ↑ return 的值自动成为 fulfilled action 的 payload
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Login failed";
      return rejectWithValue(errorMessage);
      // ↑ rejectWithValue() 让错误走 rejected 分支而非抛出异常
    }
  },
);
```

#### 在 extraReducers 中响应三种状态

```typescript
const userSlice = createSlice({
  name: "user",
  initialState,
  reducers: {
    // 同步 reducer（如果需要）
  },
  extraReducers: (builder) => {
    builder
      // 请求开始
      .addCase(loginUser.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      // 请求成功
      .addCase(loginUser.fulfilled, (state, action) => {
        state.loading = false;
        state.error = null;
        state.isAuthenticated = true;
        state.currentUser = action.payload; // 后端返回的 UserRespDTO
        state.authEpoch += 1; // 身份变更版本号
      })
      // 请求失败
      .addCase(loginUser.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? "Login failed";
        // payload 就是 rejectWithValue 传入的值
      });
  },
});
```

### 6.3 本项目的三个 Thunk

| Thunk             | 作用                                     | 所属 Slice |
| ----------------- | ---------------------------------------- | ---------- |
| `loginUser`       | 发送登录请求，成功后将用户信息写入 Redux | userSlice  |
| `checkAuthStatus` | 应用启动时验证 Token 是否有效            | userSlice  |
| `logoutUser`      | 发送登出请求，清除认证状态               | userSlice  |

### 6.4 在组件中调用 Thunk

```typescript
// App.tsx 中的实际代码
import { checkAuthStatus } from "@/store/slices/userSlice";

const dispatch = useAppDispatch();

// .unwrap() 将 thunk 的 result action 解包：
//   fulfilled → 返回 payload（进入 .then）
//   rejected  → 抛出异常（进入 .catch）
const result = await dispatch(checkAuthStatus()).unwrap();
```

`.unwrap()` 的作用：

```typescript
// 不用 .unwrap()
const action = await dispatch(checkAuthStatus());
if (checkAuthStatus.fulfilled.match(action)) {
  console.log(action.payload); // 类型安全
}

// 用 .unwrap()
try {
  const user = await dispatch(checkAuthStatus()).unwrap();
  console.log(user); // 直接拿到 payload，更简洁
} catch (error) {
  console.log(error); // rejected 的 payload
}
```

---

## 7. 在组件中使用

### 7.1 类型安全的 Hooks（`src/store/hooks.ts`）

```typescript
import { useDispatch, useSelector } from "react-redux";
import type { RootState, AppDispatch } from "./index";

// 不要直接用 useDispatch / useSelector！
// 使用这两个封装好的版本，获得完整的 TypeScript 类型推导
export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
```

### 7.2 读取状态（useAppSelector）

```typescript
// useChatSendFlow.ts 中的实际代码
const { messages, isStreaming, currentSessionId, pendingOutbound } =
  useAppSelector((state) => state.chat);

const { currentUser, authEpoch } = useAppSelector((state) => state.user);
```

**工作原理**：

1. `useAppSelector` 传入一个选择器函数 `(state: RootState) => state.chat`
2. `state` 参数自动具有 `RootState` 类型，所以 `state.chat` 的类型是 `ChatState`
3. 解构出的 `messages`、`isStreaming` 等都有准确的类型
4. 当 `state.chat` 发生变化时，组件自动重渲染

### 7.3 修改状态（useAppDispatch）

```typescript
// useChatSendFlow.ts 中的实际代码
const dispatch = useAppDispatch();

// 同步 action：直接调用自动生成的 action creator
dispatch(appendUserMessage(userMessage));
dispatch(finishAssistantMessage({ id: messageId }));

// 异步 thunk：调用 thunk 函数
dispatch(loginUser({ username: "admin", password: "123456" }));
```

### 7.4 完整的使用示例

```typescript
// 一个简化的聊天组件
function ChatComponent() {
  const dispatch = useAppDispatch();

  // 读取 Redux 状态
  const messages = useAppSelector((state) => state.chat.messages);
  const isStreaming = useAppSelector((state) => state.chat.isStreaming);
  const currentUser = useAppSelector((state) => state.user.currentUser);

  const handleSend = (content: string) => {
    // dispatch 一个带 payload 的同步 action
    dispatch(appendUserMessage({
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: Date.now(),
      status: "done",
    }));
  };

  const handleLogout = () => {
    // dispatch 一个异步 thunk
    dispatch(logoutUser());
  };

  return (
    <div>
      <p>当前用户：{currentUser?.username}</p>
      {messages.map(msg => (
        <div key={msg.id}>{msg.content}</div>
      ))}
      <button disabled={isStreaming} onClick={() => handleSend("你好")}>
        发送
      </button>
    </div>
  );
}
```

---

## 8. 跨 Slice 通信

一个 Slice 可以响应另一个 Slice 的 action。这通过 `extraReducers` 实现。

### 8.1 场景：登出时清空聊天记录

当用户登出时，userSlice 会 dispatch `logoutUser.fulfilled`，chatSlice 需要响应这个 action 来清空聊天数据。

```typescript
// userSlice.ts —— 定义 logoutUser thunk
export const logoutUser = createAsyncThunk(/*...*/);

// chatSlice.ts —— 在 extraReducers 中"监听"userSlice 的 action
import { checkAuthStatus, logoutUser } from "@/store/slices/userSlice";

const chatSlice = createSlice({
  name: "chat",
  initialState,
  reducers: {
    /* 自己的 reducer */
  },
  extraReducers: (builder) => {
    builder
      // 监听 checkAuthStatus 失败（Token 过期）→ 清空聊天
      .addCase(checkAuthStatus.rejected, (state, action) => {
        if (!action.payload?.shouldClearAuth) return;
        state.messages = [];
        state.currentSessionId = null;
        // ... 完整重置
      })
      // 监听 logoutUser 成功 → 清空聊天
      .addCase(logoutUser.fulfilled, (state) => {
        state.messages = [];
        state.currentSessionId = null;
        // ... 完整重置
      });
  },
});
```

### 8.2 extraReducers vs reducers

|                   | reducers                              | extraReducers                                |
| ----------------- | ------------------------------------- | -------------------------------------------- |
| **响应的 action** | 仅本 slice 自动生成的 action          | 任何 action（其他 slice、thunk）             |
| **action type**   | 自动生成（`"sliceName/reducerName"`） | 手动指定（通过 `.addCase()`）                |
| **典型用途**      | 本领域的增删改查                      | 跨领域协调（登出 → 清聊天、登录 → 重置表单） |

### 8.3 跨 Slice 通信的设计原则

```
userSlice（认证领域）               chatSlice（聊天领域）
     │                                    │
     │  dispatch(logoutUser())             │
     │         │                           │
     │         ▼                           │
     │   logoutUser.fulfilled ───监听────▶ │ 清空消息列表
     │                                    │
     │  dispatch(checkAuthStatus())        │
     │         │                           │
     │         ▼                           │
     │  checkAuthStatus.rejected ──监听──▶ │ 清空消息列表（Token 过期）
```

> **关键原则**：chatSlice 只响应 userSlice 的 action，不修改 userSlice 的状态。
> 每个 Slice 只管理自己的 state，不存在"跨 Slice 直接修改对方 state"的情况。

---

## 9. 与 React Query 的分工

本项目同时使用了 Redux Toolkit 和 TanStack React Query，它们的职责划分清晰：

|              | Redux Toolkit                            | React Query                             |
| ------------ | ---------------------------------------- | --------------------------------------- |
| **管理什么** | 用户认证状态、聊天运行时状态（流式消息） | 服务端数据的缓存和同步                  |
| **数据特征** | 应用级、长期存在、多个组件共享           | 服务端返回的列表/详情，有时效性         |
| **典型用途** | 登录态、消息列表、流式状态               | 会话列表、模型列表、面试记录            |
| **缓存策略** | 无（手动管理）                           | 自动（staleTime、refetchOnWindowFocus） |

### 9.1 实际项目中的使用

```typescript
// Redux 管理：消息列表的实时追加（SSE 流式渲染每 40ms 一次）
dispatch(appendAssistantChunk({ id: msgId, content: nextChunk }));

// React Query 管理：会话列表的缓存刷新
queryClient.invalidateQueries({ queryKey: ["conversations"] });
```

### 9.2 判断"该用 Redux 还是 React Query"

```
这个数据是服务端返回的吗？
    ├── 是 → 有缓存/过期/重取需求吗？
    │        ├── 是 → React Query
    │        └── 否（如实时流式消息）→ Redux
    └── 否（纯客户端状态，如登录态、UI 状态）→ Redux
```

---

## 10. 完整数据流示例

以"用户在聊天页面发送一条消息"为例，展示 Redux 的完整数据流：

### 10.1 时序图

```
用户点击发送
     │
     ▼
handleSend("你好")
     │
     ├── dispatch(appendUserMessage(userMsg))      ← 同步 action
     │       └── chatSlice reducer 执行
     │            └── state.messages.push(userMsg)
     │                 └── 组件重渲染，消息列表出现"你好"
     │
     ├── dispatch(appendAssistantPlaceholder(aiMsg)) ← 同步 action
     │       └── chatSlice reducer 执行
     │            └── state.messages.push(aiMsg)  // content: ""
     │                 └── 组件重渲染，出现空的 AI 气泡
     │
     └── 调用 aiService.streamChat()                 ← SSE 流式请求
              │
              ├── onMessage("大家") → dispatch(appendAssistantChunk({id, content: "大家"}))
              │       └── state.messages 中对应消息的 content += "大家"
              │
              ├── onMessage("好，我") → dispatch(appendAssistantChunk({id, content: "大家好，我"}))
              │       └── state.messages 中对应消息的 content += "好，我"
              │
              └── onDone() → dispatch(finishAssistantMessage({id}))
                      └── message.status = "done"
```

### 10.2 对应的代码路径

| 步骤                  | 文件                           | 代码                                        |
| --------------------- | ------------------------------ | ------------------------------------------- |
| 用户输入 → handleSend | `useChatPageController.ts:153` | `handleSend`                                |
| 乐观插入用户消息      | `useChatSendFlow.ts:341`       | `dispatch(appendUserMessage(...))`          |
| 插入 AI 占位消息      | `useChatSendFlow.ts:342`       | `dispatch(appendAssistantPlaceholder(...))` |
| 发起 SSE 流式请求     | `useChatSendFlow.ts:193`       | `aiService.streamChat(...)`                 |
| 流式内容追加          | `useChatSendFlow.ts:166`       | `dispatch(appendAssistantChunk(...))`       |
| 流式完成              | `useChatSendFlow.ts:223`       | `dispatch(finishAssistantMessage(...))`     |

---

## 11. 最佳实践总结

### 11.1 本项目遵循的实践

1. **按领域拆分 Slice**：`userSlice`（认证）、`chatSlice`（聊天），各管各的
2. **类型安全全链路**：从 `configureStore` → `RootState` → `useAppSelector`，每一步都有类型推导
3. **不用裸 `useDispatch`/`useSelector`**：封装为 `useAppDispatch`/`useAppSelector`，获得完整类型
4. **Thunk 只做异步编排**：thunk 内部调用 service 层，不直接操作 state
5. **跨 Slice 通信用 extraReducers**：chatSlice 监听 userSlice 的 thunk 来做级联清理
6. **复杂逻辑放 Hook 而非 Slice**：`useChatSendFlow` 管理发送流程中的竞态控制和编排，chatSlice 只管状态
7. **Redux 与 React Query 分工明确**：实时状态（流式消息）用 Redux，服务端缓存用 React Query

### 11.2 常见反模式（不要这样做）

| 反模式                        | 为什么不对           | 正确做法                                 |
| ----------------------------- | -------------------- | ---------------------------------------- |
| 在 reducer 中调用 API         | reducer 必须是纯函数 | 用 createAsyncThunk                      |
| 在 reducer 中 `new Date()`    | reducer 输出不可预测 | 在 action payload 中传入时间戳           |
| 在 reducer 中 `Math.random()` | 同上                 | 在组件或 thunk 中生成，通过 payload 传入 |
| 直接 `state = newState`       | Immer 只追踪属性修改 | 逐个属性赋值，或用 `return newState`     |
| 在组件中直接修改 `state.xxx`  | state 是只读的       | 只能通过 dispatch action                 |
| 把所有状态都放 Redux          | 增加不必要的样板代码 | 组件本地状态用 useState                  |

### 11.3 新增一个 Slice 的步骤

假设要为"通知"功能新增一个 Slice：

```
1. 创建 src/store/slices/notificationSlice.ts
   ├── 定义 NotificationState 接口
   ├── 定义 initialState
   ├── createSlice({ name: "notification", ... })
   │   ├── reducers: { addNotification, dismissNotification, clearAll }
   │   └── extraReducers: 响应 logoutUser.fulfilled 清空通知
   └── export actions + reducer

2. 在 src/store/index.ts 中注册
   import notificationReducer from "./slices/notificationSlice";
   reducer: {
     user: userReducer,
     chat: chatReducer,
     notification: notificationReducer,  // 新增
   }

3. 在组件中使用
   const notifications = useAppSelector((s) => s.notification.items);
   dispatch(addNotification({ type: "info", message: "操作成功" }));
```

---

## 附录：快速参考卡片

### 常用 API 速查

```typescript
// —— Store ——
configureStore({ reducer: { key: reducer } });

// —— Slice ——
createSlice({
  name: "sliceName",
  initialState,
  reducers: {
    actionName: (state, action: PayloadAction<PayloadType>) => {
      /* 修改 state */
    },
  },
  extraReducers: (builder) => {
    builder.addCase(someThunk.fulfilled, (state, action) => {
      /* */
    });
  },
});

// —— Thunk ——
createAsyncThunk<ReturnType, ArgType, { rejectValue: RejectType }>(
  "slice/thunkName",
  async (arg, { rejectWithValue }) => {
    /* */
  },
);

// —— Hooks ——
const dispatch = useAppDispatch();
const value = useAppSelector((state: RootState) => state.slice.field);

// —— 调用 Thunk ——
dispatch(someThunk(args)); // 普通 dispatch（返回 action）
await dispatch(someThunk(args)).unwrap(); // 解包，fulfilled 返回 payload，rejected 抛异常
```

### 一个动作的生命周期

```
dispatch(actionCreator(payload))
       │
       ├── action = { type: "slice/actionName", payload }
       │
       ├── 遍历所有 reducer（包括 extraReducers）
       │    └── 匹配 action.type 的 reducer 执行
       │         └── 修改对应的 state 片段
       │
       ├── Store 通知所有订阅者
       │    └── 所有 useAppSelector 重新执行选择器函数
       │         └── 返回值变化的组件重渲染
       │
       └── Redux DevTools 记录此次 action（开发环境）
```
