# TanStack React Query 完整使用指南

> 本文基于本项目（码上面试平台前端）的实际代码，从零讲解 TanStack React Query 的用法。
> 阅读完本文后，你将能理解项目中所有 React Query 相关代码，并能独立使用 React Query 开发新功能。

---

## 目录

1. [为什么需要 React Query](#1-为什么需要-react-query)
2. [核心概念速览](#2-核心概念速览)
3. [项目结构总览](#3-项目结构总览)
4. [QueryClient：全局配置](#4-queryclient全局配置)
5. [Query Key：缓存标识符](#5-query-key缓存标识符)
6. [useQuery：数据查询](#6-usequery数据查询)
7. [useInfiniteQuery：无限滚动分页](#7-useinfinitequery无限滚动分页)
8. [useQueryClient + invalidateQueries：缓存失效](#8-usequeryclient--invalidatequeries缓存失效)
9. [authEpoch 模式：用户切换后自动刷新](#9-authepoch-模式用户切换后自动刷新)
10. [与 Redux 的分工协作](#10-与-redux-的分工协作)
11. [完整数据流示例](#11-完整数据流示例)
12. [最佳实践总结](#12-最佳实践总结)

---

## 1. 为什么需要 React Query

### 1.1 问题场景

假设有一个列表页面，需要从服务端加载数据并在 UI 中展示：

- **数据重复请求**：用户切到其他标签页再切回来，是否需要重新请求？切换页面再返回，是否要重新加载？
- **手动管理 loading/error**：每个请求都要写 `useState` + `useEffect`，代码重复
- **手动处理缓存**：删除一条记录后，需要手动找到对应的 state 并更新
- **分页逻辑繁琐**：需要自己维护 `page`、`hasMore`、`loadingMore` 等状态
- **竞态处理**：连续快速切换页面，旧请求返回后覆盖新数据

如果只用 `useState` + `useEffect`，每个数据请求的代码模板化程度很高，且容易出错。

### 1.2 React Query 解决了什么

| 痛点                   | React Query 的解决方案                                         |
| ---------------------- | -------------------------------------------------------------- |
| 组件卸载再回来重新请求 | **缓存 + staleTime**：在缓存有效期内直接返回旧数据，不重复请求 |
| 手动管理 loading/error | **自动派生状态**：`isPending`、`isError`、`data` 全自动        |
| 分页/无限滚动复杂      | **useInfiniteQuery**：开箱即用，只需提供 `getNextPageParam`    |
| 缓存一致性             | **invalidateQueries**：操作完成后"标记"缓存过期，自动重新请求  |
| 请求竞态               | **自动处理**：queryKey 变化时自动取消旧请求                    |
| 手动写请求逻辑         | **queryFn**：只需关注数据获取函数的实现                        |

### 1.3 本项目为什么同时使用 Redux + React Query

| 对比维度     | Redux Toolkit                              | TanStack React Query                                   |
| ------------ | ------------------------------------------ | ------------------------------------------------------ |
| **管理什么** | 客户端状态（登录态、实时流式消息）         | 服务端缓存（列表、详情、配置）                         |
| **数据源**   | 由用户操作或 SSE 流式推送产生              | 由服务端 API 返回                                      |
| **缓存策略** | 手动管理（无自动过期）                     | 自动（staleTime 控制，数据在多个组件间共享时自动响应） |
| **典型数据** | `messages[]`、`isStreaming`、`currentUser` | 会话列表、AI 模型列表、面试记录、面试报告              |

**核心原则**：React Query 管理服务端状态，Redux 管理客户端实时状态（流式消息、认证态）。

---

## 2. 核心概念速览

TanStack React Query 围绕三个核心 API 构建：

```
┌─────────────────────────────────────────────────────────────────┐
│                  TanStack React Query 核心三件套                   │
├─────────────────┬───────────────────────────────────────────────┤
│ QueryClient     │ 全局管理缓存、请求队列、默认配置                │
│ useQuery        │ 获取数据 → 自动缓存、自动 loading、自动重试    │
│ useInfiniteQuery│ 分页/无限滚动 → getNextPageParam 控制翻页    │
│ queryClient     │ 手动操作：invalidateQueries 让缓存失效        │
└─────────────────┴───────────────────────────────────────────────┘
```

### 2.1 数据流方向

```
组件挂载
    │
    ▼
useQuery({ queryKey, queryFn, enabled })
    │
    ├── [缓存命中 & 未过期]
    │       └── 返回缓存数据（不发起请求）
    │
    └── [缓存未命中 / 已过期]
            └── 发起 queryFn（HTTP 请求）
                    │
                    ├── 成功 → 写入缓存 → 组件渲染 data
                    │         └── queryClient.invalidateQueries() → 重新请求
                    │
                    └── 失败 → component 通过 status/isError 渲染错误态
```

### 2.2 关键规则

1. **单一 queryKey 决定缓存身份**：相同的 queryKey 共用同一份缓存
2. **staleTime 决定缓存何时过期**：过期后**再次挂载的组件**会触发后台刷新（不阻塞 UI）
3. **queryFn 必须是纯数据获取函数**：应该没有副作用（需要刷新其他数据用 `invalidateQueries`）
4. **enabled 控制请求是否发起**：依赖路由参数或用户登录态时通过 enabled 条件化请求
5. **缓存存在于内存中**：刷新页面后丢失，但 staleTime 内的切换不重复请求

---

## 3. 项目结构总览

React Query 的代码分散在两个位置：

```
src/
├── app/
│   └── providers.tsx         # QueryClientProvider 注入 + 全局默认配置
└── hooks/
    ├── useConversations.ts             # 会话列表（useInfiniteQuery）
    ├── useAiModelsQuery.ts             # AI 模型列表（useQuery）
    ├── chat/
    │   ├── useChatHistoryLoader.ts     # 历史消息加载（useQuery）
    │   └── useChatSendFlow.ts          # 发送消息后刷新缓存（queryClient.invalidateQueries）
    └── interview/
        ├── records/
        │   └── useInterviewRecords.ts  # 面试记录列表（useInfiniteQuery）
        ├── report/
        │   └── useInterviewReportData.ts # 面试报告详情（useQuery）
        ├── session/
        │   └── useInterviewSessionFlow.ts # 面试流程中刷新记录缓存
        └── sketchpad/
            └── useInterviewSketchpadQuestionState.ts # 当前面试题（useQuery）
```

### 3.1 各 Hook 的职责

| Hook                                          | 使用的 API          | 管理的数据               |
| --------------------------------------------- | ------------------- | ------------------------ |
| `useConversations`                            | `useInfiniteQuery`  | 侧边栏会话列表（分页）   |
| `useAiModelsQuery`                            | `useQuery`          | AI 模型下拉列表          |
| `useChatHistoryLoader`                        | `useQuery`          | 点击某个会话后的历史消息 |
| `useInterviewRecords`                         | `useInfiniteQuery`  | 面试记录列表（分页）     |
| `useInterviewReportData`                      | `useQuery`          | 单条面试报告的详情       |
| `useInterviewSketchpadQuestionState`          | `useQuery`          | 面试草稿板中的当前题目   |
| `useChatSendFlow` / `useInterviewSessionFlow` | `invalidateQueries` | 操作完成后的缓存刷新     |

---

## 4. QueryClient：全局配置

### 4.1 创建 QueryClient（`src/app/providers.tsx`）

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5, // 5 分钟内缓存有效
        refetchOnWindowFocus: false, // 不自动刷新
      },
    },
  });

const queryClient = createQueryClient();

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </Provider>
  );
}
```

**逐行解释：**

- `new QueryClient({ defaultOptions })`：创建全局唯一的 QueryClient 实例，设置所有查询的默认值
- `staleTime: 5 * 60 * 1000`：缓存有效期 5 分钟
  - **在这 5 分钟内**，相同的 queryKey 直接返回缓存数据，不发起 HTTP 请求（除非手动 invalidate）
  - **5 分钟后**，如果组件挂载，会在后台发起一次刷新（stale-while-revalidate 模式）
- `refetchOnWindowFocus: false`：用户切换到其他标签页再切回来时不自动请求
  - 项目中不需要此行为，因为对话和面试的状态由 Redux 管理，列表数据有明确的刷新时机（增删操作后手动 invalidate）

### 4.2 全局 State 的形状（不是 Redux 那种全局状态）

React Query 不产生全局状态树——数据按 queryKey 分布在缓存中：

```
QueryClient Cache（内存中）
├── ["conversations", "id:1", 0]  → { pages: [...], pageParams: [...] }
├── ["ai-models", "id:1", 0]      → [{ id: 1, name: "GPT-4" }, ...]
├── ["chat-history", "session-123"] → [AiMessageHistory, ...]
├── ["interview-records", "id:1", 0] → { pages: [...], pageParams: [...] }
├── ["interview-record", "report-456"] → { ...reportData }
├── ["interview-current-question", "session-789"] → { questionNumber: "1", ... }
└── ...
```

每个查询的缓存**独立存在**，没有 Redux 那种单颗状态树的概念。

---

## 5. Query Key：缓存标识符

### 5.1 Query Key 的作用

Query Key 是每条缓存数据的**唯一标识**。两个 key 相同的 `useQuery` 共享同一份缓存：

```typescript
// 组件 A 和组件 B 使用相同的 queryKey → 共用缓存，只发起一次请求
// 组件 A
useQuery({ queryKey: ["ai-models", "id:1", 0], queryFn: ... });
// 组件 B
useQuery({ queryKey: ["ai-models", "id:1", 0], queryFn: ... });
```

### 5.2 本项目中所有 Query Key

```
查询内容                     Query Key
─────────────────────────────────────────────────────────
会话列表            ["conversations", userKey, authEpoch]
AI 模型列表         ["ai-models", userKey, authEpoch]
聊天历史消息        ["chat-history", routeSessionId]
面试记录列表        ["interview-records", userKey, authEpoch]
面试报告详情        ["interview-record", reportSessionId]
当前面试题目        ["interview-current-question", sessionId]
```

### 5.3 Key 设计原则

**原则一：Key = 数据类型 + 用户标识 + 版本号**

```typescript
// 用于"用户相关列表"的 key 模式
["conversations", userKey, authEpoch];
//              ↑ 数据领域    ↑ 谁的数据  ↑ 认证版本
```

- **数据领域**（字符串）：用 kebab-case 描述数据内容
- **用户标识**：区分不同用户的数据（"id:1"、"id:2"、"anonymous"）
- **版本号**：`authEpoch` 来自 Redux userSlice，用户登录/登出时自增，导致 key 变化 → 自动重新请求

**原则二：具体查询要把参数放入 key**

```typescript
// 按路由参数区分不同会话的历史消息
["chat-history", routeSessionId][
  // 按会话 ID 区分不同面试的房间状态
  ("interview-current-question", sessionId)
];
```

**原则三：导出 key 工厂函数，保持一致性**

```typescript
// useConversations.ts —— 导出工厂函数
export const getConversationsQueryKey = (userKey: string, authEpoch: number) =>
  ["conversations", userKey, authEpoch] as const;

// useChatSendFlow.ts —— 其他地方引用同一工厂
import { getConversationsQueryKey } from "@/hooks/useConversations";

await queryClient.invalidateQueries({
  queryKey: getConversationsQueryKey(userKey, authEpoch),
});
```

> **为什么用 `as const`？** 让 TypeScript 推断元组类型而非 `string[]`，在 `invalidateQueries` 时获得精确匹配。

---

## 6. useQuery：数据查询

### 6.1 基本模式

以 `useAiModelsQuery` 为例（`src/hooks/useAiModelsQuery.ts`）：

```typescript
// 一个标准的 useQuery Hook 模板

// 1. 用户标识工具函数
const getAiModelsUserKey = (user: ModelUserIdentity) => {
  if (!user) return "anonymous";
  if (typeof user.id === "number" && Number.isFinite(user.id) && user.id > 0) {
    return `id:${user.id}`;
  }
  if (user.username) return `username:${user.username}`;
  return "anonymous";
};

// 2. key 工厂函数（导出，供 invalidateQueries 复用）
export const getAiModelsQueryKey = (userKey: string, authEpoch: number) =>
  ["ai-models", userKey, authEpoch] as const;

// 3. Hook
export function useAiModelsQuery(options: UseAiModelsQueryOptions = {}) {
  // ① 从 Redux 读取用户认证信息
  const { isAuthenticated, currentUser, authEpoch } = useAppSelector(
    (state) => state.user,
  );

  // ② 计算用户标识
  const userKey = getAiModelsUserKey(currentUser);

  // ③ 登录后才启用查询
  const enabled = (options.enabled ?? true) && isAuthenticated;

  // ④ useQuery 核心调用
  const query = useQuery({
    queryKey: getAiModelsQueryKey(userKey, authEpoch),
    queryFn: async () => {
      const response = await aiService.getAiProperties({ isEnabled: 1 });
      return response?.records ?? [];
    },
    enabled,
  });

  // ⑤ 返回：保留 query 的所有字段 + 派生数据
  return {
    ...query,
    models: (query.data ?? []) as AiProperty[],
  };
}
```

### 6.2 useQuery 返回值说明

```typescript
const query = useQuery({
  queryKey: ["conversations", userKey, authEpoch],
  queryFn: () => fetch("/api/conversations"),
  enabled: true,
});

// query 包含以下常用字段：
query.data; // queryFn 的返回值（或 undefined，请求完成前）
query.isPending; // 首次加载中（无缓存数据 + 请求进行中）
query.isLoading; // 同 isPending（V5 中推荐使用 isPending）
query.isFetching; // 任何请求进行中（包括后台刷新）
query.isError; // 请求是否出错
query.error; // 错误对象
query.isSuccess; // 请求是否成功
query.status; // "pending" | "error" | "success"
query.refetch; // 手动触发重新请求
```

### 6.3 条件查询：enabled 控制

当数据依赖某个变量（如路由参数）时，使用 `enabled` 条件化请求：

```typescript
// useChatHistoryLoader.ts
const historyQuery = useQuery({
  queryKey: ["chat-history", routeSessionId],
  enabled: shouldLoadHistory && Boolean(routeSessionId),
  //            ↑ 只有条件满足时才发起请求
  queryFn: () => aiService.getConversationHistory(routeSessionId as string),
  retry: false, // 不重试
  refetchOnWindowFocus: false,
  staleTime: 30_000, // 30 秒内复用缓存
});
```

**enabled 的典型应用场景：**

| 场景               | 实现                          |
| ------------------ | ----------------------------- |
| 需要登录           | `enabled: isAuthenticated`    |
| 需要路由参数       | `enabled: Boolean(sessionId)` |
| 需要用户选择后加载 | `enabled: isSelected`         |
| 多个条件同时满足   | `enabled: condA && condB`     |

### 6.4 自定义 staleTime

不同数据有不同的实时性要求，每个查询可以覆盖全局默认值：

```typescript
// 聊天历史：30s 内切换会话不重复请求（避免高频切换时的冗余请求）
staleTime: 30_000,

// 面试报告：1 分钟内再看不刷新（报告内容不频繁变化）
staleTime: 60_000,

// 当前面试题：只请求一次，成功后不刷新（由用户操作驱动下一题）
staleTime: 10_000,

// 全局默认（会话列表、模型列表）：5 分钟
// QueryClient defaultOptions 中设定
```

### 6.5 错误处理

```typescript
// useInterviewReportData.ts —— 错误处理模式
const query = useQuery({ ... });

const recordError = useMemo(() => {
  if (!query.error) return null;
  return query.error instanceof Error
    ? query.error.message
    : "加载面试报告时发生错误，请稍后重试。";
}, [query.error]);

// 导出统一格式，供 UI 层直接使用
return {
  isRecordLoading: query.isLoading || query.isFetching,
  recordError,
  // ...其他数据
};
```

### 6.6 派生数据（useMemo 缓存计算结果）

```typescript
// useInterviewSketchpadQuestionState.ts —— 将服务端数据与客户端状态合并
const questionQuery = useQuery<AnswerInterviewQuestionResult | null>({
  queryKey: ["interview-current-question", sessionId],
  enabled: Boolean(open && sessionId),
  queryFn: () => interviewService.getCurrentQuestion(sessionId as string),
  retry: false,
  refetchOnWindowFocus: false,
  staleTime: 10_000,
});

return useMemo(() => {
  const serverQuestion = questionQuery.data ?? null;
  const serverQuestionNumber =
    serverQuestion?.nextQuestionNumber ||
    serverQuestion?.questionNumber ||
    null;

  return {
    // 优先用服务端数据，后端数据未到/报错时降级到客户端本地状态
    questionNumber: serverQuestionNumber ?? currentQuestionNumber ?? null,
    questionContent: isFinished
      ? null
      : serverQuestionContent || currentQuestionContent?.trim() || null,
    isSyncing: questionQuery.isFetching,
  };
}, [
  questionQuery.data,
  questionQuery.isFetching,
  currentQuestionNumber,
  currentQuestionContent,
  isCollapsed,
]);
```

---

## 7. useInfiniteQuery：无限滚动分页

### 7.1 基本模式

以 `useConversations` 为例（`src/hooks/useConversations.ts`）：

```typescript
import { useInfiniteQuery } from "@tanstack/react-query";

export function useConversations(options: UseConversationsOptions = {}) {
  const { isAuthenticated, currentUser, authEpoch } = useAppSelector(
    (state) => state.user,
  );
  const userKey = getConversationUserKey(currentUser);
  const enabled = (options.enabled ?? true) && isAuthenticated;

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status,
    refetch,
  } = useInfiniteQuery({
    queryKey: getConversationsQueryKey(userKey, authEpoch),
    queryFn: async ({ pageParam = 1 }) => {
      return aiService.getConversations({
        current: pageParam,
        size: 20,
      });
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage || !lastPage.records) return undefined;
      if (lastPage.records.length < 20) return undefined;
      return lastPage.current + 1;
    },
    initialPageParam: 1,
    enabled,
  });

  // 将所有页的数据展平为一维数组
  return {
    conversations: data?.pages.flatMap((page) => page.records) || [],
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status,
    refetch,
  };
}
```

### 7.2 核心参数详解

```typescript
useInfiniteQuery({
  // ─── 与 useQuery 相同的参数 ───
  queryKey: [...],
  queryFn: async ({ pageParam }) => { ... },
  enabled: true,

  // ─── 分页专用参数 ───
  initialPageParam: 1,          // 第一页的参数值

  getNextPageParam: (lastPage, allPages) => {
    // 接收「最后一页的返回值」和「所有已加载页」，返回「下一页的参数」
    // 返回 undefined → hasNextPage = false（没有更多页了）
    if (lastPage.records.length < 20) return undefined;
    return lastPage.current + 1;
  },
});
```

### 7.3 返回值的使用

```typescript
// data 的结构：
data = {
  pages: [
    { records: [...], current: 1, pages: 5 },   // 第 1 页
    { records: [...], current: 2, pages: 5 },   // 第 2 页
    ... // 后续页面
  ],
  pageParams: [1, 2, 3, ...],  // 每页对应的 pageParam
}

// 展平为数组：
const items = data.pages.flatMap((page) => page.records);

// 触发翻页：
fetchNextPage();

// 还有更多页吗？
hasNextPage;  // boolean

// 正在加载下一页？
isFetchingNextPage;  // boolean
```

### 7.4 与 UI 组件的结合

```typescript
// 在组件中（示意）：
function ConversationList() {
  const {
    conversations,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status,
  } = useConversations();

  if (status === "pending") return <Loading />;
  if (status === "error") return <Error />;

  return (
    <div>
      {conversations.map((conv) => (
        <ConversationItem key={conv.id} conversation={conv} />
      ))}

      {hasNextPage && (
        <button
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? "加载中..." : "加载更多"}
        </button>
      )}
    </div>
  );
}
```

---

## 8. useQueryClient + invalidateQueries：缓存失效

### 8.1 为什么需要手动失效

React Query 的自动过期（staleTime）适合**组件驱动的刷新**。但以下场景需要**事件驱动的即时刷新**：

- **新增**：创建了一个新的会话 → 会话列表需要更新
- **删除**：删除了某个会话 → 会话列表需要更新
- **编辑**：修改了某条记录的标题 → 相关列表需要更新

这些场景使用 `invalidateQueries` 手动标记缓存为过期，触发自动重新请求。

### 8.2 基本用法

```typescript
import { useQueryClient } from "@tanstack/react-query";

function SomeComponent() {
  const queryClient = useQueryClient();

  const handleDelete = async (id: string) => {
    await api.delete(id);
    // 标记对应缓存过期 → 下次 useQuery 挂载时自动重新请求
    await queryClient.invalidateQueries({
      queryKey: ["conversations"],
    });
  };
}
```

### 8.3 本项目的实际例子

**例 1：删除会话后刷新列表（`useConversations.ts`）**

```typescript
export function useDeleteConversation() {
  const queryClient = useQueryClient();
  const { currentUser, authEpoch } = useAppSelector((state) => state.user);

  const deleteConversation = useCallback(
    async (sessionId: string) => {
      await aiService.deleteConversation(sessionId);

      const userKey = getConversationUserKey(currentUser);
      await queryClient.invalidateQueries({
        queryKey: getConversationsQueryKey(userKey, authEpoch),
        //         ↑ 精确匹配当前用户的会话列表缓存
      });

      // 额外处理：如果删除的是当前活跃会话，还要清理 Redux 并导航
      if (isActiveSession) {
        dispatch(resetChatRuntime());
        navigate(ROUTES.chat);
      }
    },
    [queryClient, currentUser, authEpoch],
  );

  return { deleteConversation, deletingSessionId };
}
```

**例 2：发送首条消息创建会话后刷新列表（`useChatSendFlow.ts`）**

```typescript
// 在 sendMessage 中，当创建了新会话后：
const userKey = getConversationUserKey(currentUser);
await queryClient.invalidateQueries({
  queryKey: getConversationsQueryKey(userKey, authEpoch),
});
```

**例 3：面试结束时刷新面试记录列表（`useInterviewSessionFlow.ts`）**

```typescript
const invalidateInterviewRecords = useCallback(
  () =>
    queryClient.invalidateQueries({
      queryKey: ["interview-records"],
      //         ↑ 只传前缀，匹配所有 ["interview-records", ...]
    }),
  [queryClient],
);
```

### 8.4 Query Key 匹配规则

```typescript
// 精确匹配 —— 只匹配完全相等的 key
invalidateQueries({ queryKey: ["conversations", "id:1", 0] });

// 前缀匹配 —— 匹配所有以此开头的 key（不传 exact 选项时默认前缀匹配）
invalidateQueries({ queryKey: ["conversations"] });
// 匹配：["conversations", "id:1", 0]
// 匹配：["conversations", "id:2", 0]
// 不匹配：["conversations-history", ...]
// 不匹配：["ai-models", ...]
```

> **本项目统一做法**：使用精确匹配（传入完整的 queryKey），减少不必要的缓存刷新。

---

## 9. authEpoch 模式：用户切换后自动刷新

### 9.1 问题

用户 A 登录后会话列表是 A 的数据。用户 A 登出、用户 B 登录后，如果 queryKey 不变，React Query 会**返回旧的缓存数据**（直到 staleTime 过期）。

### 9.2 解决方案

使用 `authEpoch` —— 用户认证版本号，放在 queryKey 中：

```typescript
// userSlice.ts 中的 authEpoch
authEpoch: 0,

// 每次登录/登出时自动 +1
loginUser.fulfilled: (state) => { state.authEpoch += 1; },
logoutUser.fulfilled: (state) => { state.authEpoch += 1; },
checkAuthStatus.rejected: (state) => { state.authEpoch += 1; },
```

```typescript
// 所有用户相关的 queryKey 都包含 authEpoch
export const getConversationsQueryKey = (userKey: string, authEpoch: number) =>
  ["conversations", userKey, authEpoch] as const;

// 在 Hook 中使用：
const { authEpoch } = useAppSelector((state) => state.user);
const query = useQuery({
  queryKey: getConversationsQueryKey(userKey, authEpoch),
  //                                   ↑ authEpoch 变化 → key 变化 → 立即重新请求
});
```

### 9.3 效果

```
用户身份变化链条：
                         authEpoch    queryKey                     缓存行为
用户 A 登录（初始状态）      0        ["conversations", "id:1", 0]  创建新缓存
用户 A 登出                 1        ["conversations", "id:1", 1]  旧缓存失效，重新请求空数据
用户 B 登录                 2        ["conversations", "id:2", 2]  用户不同，创建新缓存
用户 A 再次登录             3        ["conversations", "id:1", 3]  旧缓存不匹配，重新请求
```

**无需手动清空任何 cache —— queryKey 自动变化 → 旧缓存不再命中 → 自动发起新请求。**

---

## 10. 与 Redux 的分工协作

### 10.1 职责边界

```
                 ┌─────────────────────────────────────┐
                 │            React 组件层               │
                 │  （不直接接触 API，通过 Hook 获取数据） │
                 └────────────┬────────────────┬─────────┘
                              │                │
                 ┌────────────▼──┐    ┌────────▼─────────┐
                 │  React Query   │    │     Redux         │
                 │  管理服务端缓存 │    │  管理客户端实时状态 │
                 │                │    │                   │
                 │  会话列表       │    │  messages[]       │
                 │  AI 模型列表    │    │  isStreaming      │
                 │  面试记录       │    │  currentSessionId  │
                 │  历史消息       │    │  currentUser      │
                 │  面试报告       │    │  authEpoch        │
                 │  面试当前题目    │    │                   │
                 └────────────────┘    └───────────────────┘
```

### 10.2 协作模式

**模式一：Hook 同时使用两者**

许多自定义 Hook 内部**同时**使用了 Redux 和 React Query：

```typescript
// useAiModelsQuery.ts —— 从 Redux 读取认证信息作为 queryKey 一部分
export function useAiModelsQuery() {
  const { isAuthenticated, currentUser, authEpoch } = useAppSelector(
    (state) => state.user, // ← 从 Redux 拿用户身份
  );

  return useQuery({
    queryKey: ["ai-models", userKey, authEpoch],
    //                       ↑ 用户信息来自 Redux
    enabled: isAuthenticated, // ← isAuthenticated 来自 Redux
  });
}
```

**模式二：Mutation 后同时更新 Redux + React Query**

```typescript
// useDeleteConversation.ts —— 删除后清 Redux + 刷新 React Query
const deleteConversation = async (sessionId: string) => {
  await aiService.deleteConversation(sessionId);

  // 刷新 React Query 缓存（列表重新请求）
  await queryClient.invalidateQueries({
    queryKey: getConversationsQueryKey(userKey, authEpoch),
  });

  // 清理 Redux 运行时状态（当前聊天消息）
  if (isActiveSession) {
    dispatch(resetChatRuntime());
    navigate(ROUTES.chat);
  }
};
```

**模式三：React Query 加载数据 → 写入 Redux**

```typescript
// useChatHistoryLoader.ts —— React Query 负责请求，Redux 负责存储运行时数据
const historyQuery = useQuery({
  queryKey: ["chat-history", routeSessionId],
  enabled: shouldLoadHistory && Boolean(routeSessionId),
  queryFn: () => aiService.getConversationHistory(routeSessionId as string),
});

// 请求成功后 → 写入 Redux（因为消息需要在 SSE 流式渲染中被增量更新）
useEffect(() => {
  if (!routeSessionId || !historyQuery.data) return;
  dispatch(
    hydrateChatSession({
      sessionId: routeSessionId,
      messages: normalizeHistoryMessages(historyQuery.data),
    }),
  );
}, [dispatch, historyQuery.data, routeSessionId]);

// 请求失败 → 清空 Redux 并跳转
useEffect(() => {
  if (!routeSessionId || !historyQuery.error) return;
  dispatch(resetChatRuntime());
  navigateToChatRoot({ replace: true });
}, [dispatch, historyQuery.error, routeSessionId]);
```

### 10.3 决策树：用 Redux 还是 React Query

```
这个数据是服务端返回的 API 数据吗？
    ├── 是 → 需要缓存/过期/重取策略吗？
    │        ├── 是 → ✅ React Query
    │        │        （会话列表、模型列表、面试记录、历史消息、报告）
    │        └── 否 → 数据是"流式逐字到达"的吗？
    │                 ├── 是 → ✅ Redux（需实时增量更新）
    │                 └── 否 → 两种都可以，优先 React Query
    │
    └── 否（纯客户端状态）
         ├── 登录态、认证信息 → ✅ Redux
         ├── UI 状态（折叠、选中）→ ✅ useState 局部状态
         └── 跨组件共享的 UI 状态 → ✅ Redux

数据需要被 SSE 流式逐字更新吗？
    ├── 是 → ✅ Redux（实时追加 AI 回复内容）
    └── 否 → ✅ React Query（纯请求-响应模式）
```

---

## 11. 完整数据流示例

### 11.1 场景：用户登录后看到会话列表

```
页面加载
    │
    ▼
App.tsx dispatch(checkAuthStatus()).unwrap()  ← Redux Thunk
    │
    ├── 成功 → Redux userSlice:
    │   ├── currentUser = { id: 1, username: "test" }
    │   ├── isAuthenticated = true
    │   └── authEpoch = 0
    │
    ▼
Sidebar 挂载 → useConversations()
    │
    ├── useInfiniteQuery({
    │     queryKey: ["conversations", "id:1", 0],
    │     enabled: isAuthenticated,  // ← true（authEpoch 从 Redux 读）
    │     queryFn: () => aiService.getConversations({ current: 1, size: 20 }),
    │   })
    │
    ├── 首次加载（缓存未命中）
    │       │
    │       ├── isLoading = true → 渲染骨架屏
    │       └── queryFn 执行 → HTTP GET /api/conversations
    │               │
    │               ├── 成功 → data = { pages: [...], ... }
    │               │           └── conversations = flatMap data.pages
    │               │           └── 列表渲染
    │               │
    │               └── 失败 → isError = true → 渲染错误提示
    │
    └── 5 分钟内再次挂载（staleTime 内）
            └── 直接返回缓存数据（不发起请求）

用户切换到其他标签页 20 分钟后再回来
    │
    ├── staleTime="5min" 已过期
    ├── refetchOnWindowFocus=false 不自动刷新
    └── 组件没有重新挂载 → 使用旧缓存（stale-while-revalidate）
```

### 11.2 场景：删除一个会话

```
用户点击删除按钮
    │
    ▼
useDeleteConversation().deleteConversation("session-123")
    │
    ├── 1. 调用 API 删除
    │   await aiService.deleteConversation(sessionId)
    │
    ├── 2. 刷新 React Query 缓存
    │   await queryClient.invalidateQueries({
    │     queryKey: ["conversations", "id:1", 0],
    │   })
    │       │
    │       ├── 标记该 key 的缓存为 stale（过期）
    │       └── 如果 Sidebar 组件正在挂载中 → 自动重新请求
    │            └── 列表重新渲染，删除的条目消失
    │
    └── 3. 如果是当前活跃会话
        dispatch(resetChatRuntime())  ← 清空 Redux 聊天状态
        navigate(ROUTES.chat)         ← 导航到聊天根路径
```

### 11.3 时序图

```
用户          Sidebar           useConversations        aiService        React Query
 │               │                    │                    │                │
 │  挂载        │                    │                    │                │
 │─────────────▶│                    │                    │                │
 │              │   useInfiniteQuery │                    │                │
 │              │───────────────────▶│                    │                │
 │              │                    │ 缓存未命中，发起请求                │
 │              │                    │───────────────────▶│                │
 │              │                    │    GET /api/conversations          │
 │              │                    │◀───────────────────│                │
 │              │                    │                    │                │
 │              │◀───────────────────│                    │                │
 │              │   data.pages[0]    │                    │                │
 │◀─────────────│                    │                    │                │
 │  渲染列表    │                    │                    │                │
 │              │                    │                    │                │
 │  (5 分钟内)  │                    │                    │                │
 │  用户删除了一个会话               │                    │                │
 │              │                    │                    │                │
 │              │  invalidateQueries │                    │                │
 │              │───────────────────▶│                    │                │
 │              │                    │ 标记缓存 stale     │                │
 │              │                    │ 自动重新请求        │                │
 │              │                    │───────────────────▶│                │
 │              │                    │    GET /api/conversations          │
 │              │                    │◀───────────────────│                │
 │              │◀───────────────────│                    │                │
 │◀─────────────│                    │                    │                │
 │  列表更新    │                    │                    │                │
```

---

## 12. 最佳实践总结

### 12.1 本项目遵循的实践

1. **所有查询封装在自定义 Hook 中**：`useConversations`、`useAiModelsQuery`、`useInterviewRecords` 等，组件不直接使用 useQuery

2. **Query Key 工厂函数导出**：key 的创建逻辑集中在一处，`invalidateQueries` 时复用同一工厂

   ```typescript
   // ✅ 正确：导出工厂函数，其他地方引用
   export const getConversationsQueryKey = (
     userKey: string,
     authEpoch: number,
   ) => ["conversations", userKey, authEpoch] as const;

   // ❌ 错误：调用方自己拼 key，容易不一致
   queryClient.invalidateQueries({ queryKey: ["conversations", "id:1", 0] });
   ```

3. **authEpoch 放在 queryKey 中**：用户切换自动重新请求，无需手动清理

4. **enabled 做条件控制**：依赖登录态或路由参数时，用 enabled 阻止请求提前发出

5. **使用 `as const` 声明 queryKey**：获得精确的 TypeScript 元组类型推导

6. **API 服务层保持纯净**：queryFn 调用 `src/services/` 下的函数，不使用 React Query API

7. **staleTime 按数据特性定制**：实时性要求高的用较短的 staleTime，不常变化的数据用较长 staleTime

8. **invalidateQueries 使用精确 key**：尽量传完整的 queryKey 而非前缀，避免引起不必要的刷新

9. **派生数据用 useMemo**：从 `query.data` 映射为 UI 所需格式时使用 useMemo 缓存

### 12.2 常见反模式（不要这样做）

| 反模式                              | 为什么不对                              | 正确做法                                   |
| ----------------------------------- | --------------------------------------- | ------------------------------------------ |
| 在组件中直接用 `useQuery` 调用 API  | 查询逻辑分散，无法复用                  | 封装为自定义 Hook                          |
| 把 queryKey 写成内联字符串          | 其他地方 `invalidateQueries` 时写错 key | 导出工厂函数                               |
| 一个 Hook 内部同时管理多个 useQuery | 职责不清晰，难以维护                    | 每个 Hook 只封装一个数据领域               |
| 在 queryFn 中修改组件状态           | queryFn 应保持纯的数据获取              | 在 `useEffect` 或 `onSuccess` 中处理副作用 |
| 把所有数据都放到 React Query        | 流式消息需要逐字更新，不适合缓存        | 实时流式数据用 Redux                       |
| 每次操作后都 `refetch()`            | 冗余请求，不利用缓存                    | 用 `invalidateQueries` 让自动机制处理      |
| 在 mutation 后手动 setQueryData     | 增加复杂度，容易与后续请求冲突          | 用 `invalidateQueries` 触发重新请求        |

### 12.3 新增一个查询的步骤

假设要为"通知列表"功能新增一个查询：

```
1. 创建 src/hooks/useNotifications.ts
   ├── 定义 getUserKey 工具函数
   ├── 导出 getNotificationsQueryKey 工厂函数
   └── 导出 useNotifications Hook
       ├── 从 Redux 读取 isAuthenticated / currentUser / authEpoch
       ├── useQuery({ queryKey: [...], queryFn: ..., enabled })
       └── 返回 { notifications: ..., status, ... }

2. 在组件中使用
   const { notifications, status } = useNotifications();
   // status === "pending" → 加载态
   // status === "error"   → 错误态
   // status === "success" → 渲染数据

3. 在操作后刷新缓存（如标记已读后）
   import { getNotificationsQueryKey } from "@/hooks/useNotifications";
   queryClient.invalidateQueries({
     queryKey: getNotificationsQueryKey(userKey, authEpoch),
   });
```

### 12.4 本项目的查询模式速查表

| 模式              | 适用场景             | 使用的 API                        | 示例                                                                  |
| ----------------- | -------------------- | --------------------------------- | --------------------------------------------------------------------- |
| 基础查询          | 单选列表、详情数据   | `useQuery`                        | `useAiModelsQuery`、`useInterviewReportData`                          |
| 条件查询          | 依赖路由参数         | `useQuery` + `enabled`            | `useChatHistoryLoader`、`useInterviewSketchpadQuestionState`          |
| 分页查询          | 列表 + 加载更多      | `useInfiniteQuery`                | `useConversations`、`useInterviewRecords`                             |
| 查询 + 写入 Redux | 需要进一步的逐字更新 | `useQuery` + `useEffect dispatch` | `useChatHistoryLoader`                                                |
| 操作后缓存刷新    | 增删改后             | `invalidateQueries`               | `useDeleteConversation`、`useChatSendFlow`、`useInterviewSessionFlow` |

---

## 附录：快速参考卡片

### 常用 API 速查

```typescript
// —— QueryClient 配置 ——
new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false },
  },
});

// —— useQuery ——
useQuery({
  queryKey: ["key", ...deps],
  queryFn: () => fetchData(),
  enabled: Boolean(someDependency),
  staleTime: 30_000,
  retry: false,
  refetchOnWindowFocus: false,
});
// 返回：{ data, isPending, isLoading, isFetching, isError, error, status, refetch }

// —— useInfiniteQuery ——
useInfiniteQuery({
  queryKey: [...],
  queryFn: ({ pageParam }) => fetchPage(pageParam),
  initialPageParam: 1,
  getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.page + 1 : undefined,
  enabled: true,
});
// 返回：{ data, fetchNextPage, hasNextPage, isFetchingNextPage, status, refetch }

// —— invalidateQueries ——
const queryClient = useQueryClient();
await queryClient.invalidateQueries({ queryKey: ["key"] });   // 前缀匹配
await queryClient.invalidateQueries({ queryKey: ["key", "a"] }); // 精确匹配
```

### 一个查询的生命周期

```
组件挂载
    │
    ├── [缓存命中 & 未过期]
    │       └── 返回缓存 data
    │
    ├── [缓存命中 & 已过期]
    │       ├── 返回缓存 data（立即展示旧数据）
    │       └── 后台重新请求（isFetching = true）
    │               ├── 成功 → 更新缓存（UI 更新）
    │               └── 失败 → 保留旧数据，不清除
    │
    └── [缓存未命中]
            ├── isPending = true → UI 展示加载态
            └── 发起请求
                    ├── 成功 → data = response, isPending = false
                    │           缓存写入，其他组件共享
                    └── 失败 → isError = true, error = 错误对象
```

### 新增一个分页查询的模板

```typescript
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAppSelector } from "@/store/hooks";

// 1. 用户标识
const getUserKey = (user: any) => {
  if (!user) return "anonymous";
  if (typeof user.id === "number" && Number.isFinite(user.id) && user.id > 0) {
    return `id:${user.id}`;
  }
  return user.username ? `username:${user.username}` : "anonymous";
};

// 2. Key 工厂
export const getQueryKey = (userKey: string, epoch: number) =>
  ["items", userKey, epoch] as const;

// 3. Hook
export function useItems() {
  const { isAuthenticated, currentUser, authEpoch } = useAppSelector(
    (state) => state.user,
  );
  const userKey = getUserKey(currentUser);

  return useInfiniteQuery({
    queryKey: getQueryKey(userKey, authEpoch),
    queryFn: ({ pageParam = 1 }) => api.getItems({ page: pageParam, size: 20 }),
    getNextPageParam: (lastPage) =>
      lastPage.records.length < 20 ? undefined : lastPage.current + 1,
    initialPageParam: 1,
    enabled: isAuthenticated,
  });
}
```
