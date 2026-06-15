import { act, renderHook, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configureStore } from "@reduxjs/toolkit";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES } from "@/lib/constants";
import { useChatPageController } from "@/hooks/chat/useChatPageController";
import chatReducer, {
  initialState as initialChatState,
  beginNewChatSession,
  finishStartingNewChatSession,
} from "@/store/slices/chatSlice";
import userReducer from "@/store/slices/userSlice";
import type { ChatMessage } from "@/lib/chat";

// ─── Mock 函数 ───

/** 模拟 React Router 的 navigate 函数 */
const navigateMock = vi.fn();
/** 模拟 React Router 的 useLocation 返回值 */
const useLocationMock = vi.fn();
/** 模拟 React Router 的 useParams 返回值 */
const useParamsMock = vi.fn();
/** 模拟 aiService.getConversationHistory */
const getConversationHistoryMock = vi.fn();
/** 模拟 aiService.createConversation */
const createConversationMock = vi.fn();
/** 模拟 aiService.streamChat */
const streamChatMock = vi.fn();

// ─── 模块级 Mock ───

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useLocation: () => useLocationMock(),
    useParams: () => useParamsMock(),
  };
});

vi.mock("@/hooks/useAiModelsQuery", () => ({
  useAiModelsQuery: () => ({
    models: [
      {
        id: 101,
        aiName: "GPT Test",
      },
    ],
  }),
}));

vi.mock("@/services/aiService", () => ({
  aiService: {
    getConversationHistory: (...args: unknown[]) =>
      getConversationHistoryMock(...args),
    createConversation: (...args: unknown[]) => createConversationMock(...args),
    streamChat: (...args: unknown[]) => streamChatMock(...args),
  },
}));

// ─── 工具函数 ───

/**
 * 创建一个可控的 Promise（Deferred 模式）。
 * 用于在测试中手动控制异步操作的完成时机，
 * 典型场景：验证"历史请求进行中"的中间状态后，再 resolve 让其完成。
 */
const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * 创建测试用的 Redux Store。
 * 默认预置一个已登录用户（username: "tester"），
 * chat 状态可通过参数覆盖。
 */
const createStore = (chatState: Partial<typeof initialChatState> = {}) =>
  configureStore({
    reducer: {
      user: userReducer,
      chat: chatReducer,
    },
    preloadedState: {
      user: {
        currentUser: {
          id: 1,
          username: "tester",
        },
        isAuthenticated: true,
        loading: false,
        error: null,
        authEpoch: 1,
      },
      chat: {
        ...initialChatState,
        ...chatState,
      },
    },
  });

/**
 * 渲染 useChatPageController Hook，自动包裹 Redux Provider 和 React Query Provider。
 *
 * 此函数封装了测试所需的完整 Provider 层级：
 * - Redux Store（含 user + chat reducer）
 * - TanStack QueryClient（retry: false，避免测试中意外重试）
 *
 * @param chatState - 可选的 chat slice 状态覆盖
 * @returns 渲染结果（含 result、store、queryClient、rerender、unmount）
 */
const renderChatController = (
  chatState: Partial<typeof initialChatState> = {},
) => {
  const store = createStore(chatState);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </Provider>
  );

  const rendered = renderHook(() => useChatPageController(), {
    wrapper,
  });

  return {
    ...rendered,
    store,
    queryClient,
  };
};

describe("useChatPageController", () => {
  /**
   * 每个测试用例前重置所有 mock 状态，并设置默认的 mock 行为：
   * - 静默 console.error（测试中预期的错误输出不干扰报告）
   * - 默认为无路由参数、无 location state 的 /chat 根路径
   * - getConversationHistory 返回空数组
   * - createConversation 返回 session-created 会话
   * - streamChat 回调 "assistant reply" + onDone，模拟一次完整的正常流式响应
   */
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    useParamsMock.mockReturnValue({});
    useLocationMock.mockReturnValue({
      key: "default-location",
      state: null,
    });
    getConversationHistoryMock.mockResolvedValue([]);
    createConversationMock.mockResolvedValue({
      sessionId: "session-created",
      conversationTitle: "Created Session",
    });
    streamChatMock.mockImplementation(
      async (
        _params: unknown,
        _signal: AbortSignal,
        callbacks: {
          onMessage: (chunk: string) => void;
          onReasoning?: (chunk: string) => void;
          onDone?: () => void;
        },
      ) => {
        callbacks.onMessage("assistant reply");
        callbacks.onDone?.();
      },
    );
  });

  /**
   * 验证：URL 携带 initialQuery 时，不会重定向到旧运行时会话，
   * 而是强制创建新会话（forceNewSession）并发送首条消息。
   *
   * 场景：用户从首页选择模型后输入问题，跳转到聊天页。
   * 即使 Redux 中还保留着上次会话的 sessionId，也不应跳回旧会话。
   */
  it("does not redirect to the old runtime session when initialQuery is present", async () => {
    useLocationMock.mockReturnValue({
      key: "initial-query-location",
      state: {
        initialQuery: "hello from home",
        model: {
          id: 202,
          aiName: "Chosen Model",
        },
      },
    });

    const { store } = renderChatController({
      currentSessionId: "old-session",
      currentSessionTitle: "Old Session",
      messages: [
        {
          id: "old-message",
          role: "user",
          content: "stale",
          timestamp: 1,
          status: "done",
        },
      ] as ChatMessage[],
    });

    await waitFor(() => {
      expect(createConversationMock).toHaveBeenCalledTimes(1);
      expect(navigateMock).toHaveBeenCalledWith(
        `${ROUTES.chat}/session-created`,
        {
          replace: true,
        },
      );
    });

    // 不应跳转回旧会话
    expect(navigateMock).not.toHaveBeenCalledWith(
      `${ROUTES.chat}/old-session`,
      expect.anything(),
    );
    expect(store.getState().chat.currentSessionId).toBe("session-created");
    expect(
      store
        .getState()
        .chat.messages.some((message) => message.content === "hello from home"),
    ).toBe(true);
  });

  /**
   * 验证：URL 包含 sessionId 时，加载历史消息并水合到 Redux。
   *
   * 后端返回的消息按时间戳升序排列（user first → assistant second），
   * 且 getConversationHistory 只调用一次（rerender 不触发重复请求）。
   */
  it("loads history once and hydrates the runtime for a route session", async () => {
    useParamsMock.mockReturnValue({
      sessionId: "history-session",
    });
    getConversationHistoryMock.mockResolvedValue([
      {
        id: "history-2",
        sessionId: "history-session",
        messageType: 2,
        messageContent: "assistant second",
        messageSeq: 2,
        createTime: "2025-01-01T00:00:02.000Z",
      },
      {
        id: "history-1",
        sessionId: "history-session",
        messageType: 1,
        messageContent: "user first",
        messageSeq: 1,
        createTime: "2025-01-01T00:00:01.000Z",
      },
    ]);

    const { result, rerender, store } = renderChatController();

    await waitFor(() => {
      expect(result.current.history.messages).toHaveLength(2);
    });

    expect(getConversationHistoryMock).toHaveBeenCalledTimes(1);
    expect(result.current.history.messages[0]?.content).toBe("user first");
    expect(store.getState().chat.currentSessionId).toBe("history-session");

    // 重渲染不触发额外请求（React Query 缓存 + shouldLoadHistory 守卫）
    rerender();

    expect(getConversationHistoryMock).toHaveBeenCalledTimes(1);
  });

  /**
   * 验证：切换到新会话时，先清空旧消息再展示加载态，
   * 历史请求返回后再水合新消息。
   *
   * 使用 Deferred 模式手动控制异步时序：
   * 1. 确认清空旧消息 + 显示 loading
   * 2. resolve 历史请求
   * 3. 确认新消息已加载
   */
  it("clears stale runtime messages before the new session history resolves", async () => {
    useParamsMock.mockReturnValue({
      sessionId: "new-session",
    });
    const historyDeferred = createDeferred<
      Array<{
        id: string;
        sessionId: string;
        messageType: number;
        messageContent: string;
        messageSeq: number;
        createTime: string;
      }>
    >();
    getConversationHistoryMock.mockReturnValue(historyDeferred.promise);

    const { result } = renderChatController({
      currentSessionId: "old-session",
      currentSessionTitle: "Old Session",
      messages: [
        {
          id: "old-message",
          role: "assistant",
          content: "old content",
          timestamp: 1,
          status: "done",
        },
      ] as ChatMessage[],
    });

    // 阶段一：旧消息已清除，显示加载态
    await waitFor(() => {
      expect(result.current.history.messages).toHaveLength(0);
      expect(result.current.history.isLoading).toBe(true);
    });

    // 阶段二：resolve 历史请求
    act(() => {
      historyDeferred.resolve([
        {
          id: "new-message",
          sessionId: "new-session",
          messageType: 2,
          messageContent: "new content",
          messageSeq: 1,
          createTime: "2025-01-01T00:00:01.000Z",
        },
      ]);
    });

    // 阶段三：新消息已水合
    await waitFor(() => {
      expect(result.current.history.messages[0]?.content).toBe("new content");
    });
  });

  /**
   * 验证：在已有会话页面发送消息时，不创建新会话，
   * 直接通过 streamChat 发送到当前会话。
   *
   * 这是"继续对话"的正常路径 —— sessionId 已存在，无需 createConversation。
   */
  it("sends into an existing route session without creating a conversation", async () => {
    useParamsMock.mockReturnValue({
      sessionId: "existing-session",
    });

    const { result } = renderChatController({
      currentSessionId: "existing-session",
      currentSessionTitle: "Existing",
      messages: [
        {
          id: "history-1",
          role: "assistant",
          content: "ready",
          timestamp: 1,
          status: "done",
        },
      ] as ChatMessage[],
    });

    act(() => {
      result.current.composer.setInput("continue chat");
    });

    await act(async () => {
      result.current.composer.handleSend();
    });

    expect(createConversationMock).not.toHaveBeenCalled();
    expect(streamChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "existing-session",
        inputMessage: "continue chat",
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
  });

  /**
   * 验证：无 sessionId 时的完整发送流程 —— 先创建会话，等路由同步后再发起流式。
   *
   * 流程分两阶段：
   * 1. 用户输入 → createConversation → setPendingOutbound（此时 streamChat 未调用）
   * 2. URL 同步为 /chat/session-created → pendingOutbound 被消费 → streamChat 被调用
   *
   * 这验证了 sendMessage → pendingOutbound → useEffect 的异步编排链。
   */
  it("creates a conversation first and starts stream after route session is ready", async () => {
    const { result, store, rerender } = renderChatController();

    act(() => {
      result.current.composer.setInput("start from scratch");
    });

    await act(async () => {
      result.current.composer.handleSend();
    });

    // 阶段一：会话已创建，但 streamChat 尚未调用（等待路由同步）
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(createConversationMock.mock.calls[0]?.[0]).toMatchObject({
      firstMessage: "start from scratch",
    });
    expect(streamChatMock).toHaveBeenCalledTimes(0);
    expect(store.getState().chat.pendingOutbound).not.toBeNull();

    // 阶段二：模拟路由同步到新 sessionId
    useParamsMock.mockReturnValue({
      sessionId: "session-created",
    });
    rerender();

    await waitFor(() => {
      expect(streamChatMock).toHaveBeenCalledTimes(1);
    });

    expect(streamChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-created",
        inputMessage: "start from scratch",
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    expect(store.getState().chat.currentSessionId).toBe("session-created");
    expect(store.getState().chat.pendingOutbound).toBeNull();
  });

  /**
   * 验证：仅包含推理内容（reasoning）的流式响应能正常处理，
   * 即使内容块（content）为空，消息也能正确标记为 done。
   *
   * 场景：某些 AI 模型在思考阶段只产生推理文本，回答正文可能在后续请求中到达。
   */
  it("renders reasoning-only first response without requiring content chunks", async () => {
    useParamsMock.mockReturnValue({
      sessionId: "reasoning-session",
    });
    streamChatMock.mockImplementation(
      async (
        _params: unknown,
        _signal: AbortSignal,
        callbacks: {
          onMessage: (chunk: string) => void;
          onReasoning?: (chunk: string) => void;
          onDone?: () => void;
        },
      ) => {
        callbacks.onReasoning?.("嗯，用户");
        callbacks.onReasoning?.("继续补充");
        callbacks.onDone?.();
      },
    );

    const { result } = renderChatController({
      currentSessionId: "reasoning-session",
      currentSessionTitle: "Reasoning Session",
      messages: [
        {
          id: "seed-reasoning",
          role: "assistant",
          content: "seed",
          timestamp: 1,
          status: "done",
        },
      ] as ChatMessage[],
    });

    act(() => {
      result.current.composer.setInput("你好");
    });

    await act(async () => {
      result.current.composer.handleSend();
    });

    await waitFor(() => {
      const assistant = [...result.current.history.messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" && message.id !== "seed-reasoning",
        );
      expect(assistant?.reasoning).toContain("嗯，用户");
      expect(assistant?.content).toBe("");
      expect(assistant?.status).toBe("done");
    });
  });

  /**
   * 验证：新会话创建后、流式尚未开始前，用户切换到另一个会话，
   * pending 的 assistant 消息被正确清理，不会触发流式请求。
   *
   * 流程：
   * 1. 无路由参数 → 发送消息 → createConversation → setPendingOutbound
   * 2. 切换到 /chat/session-b → 历史加载覆盖了 pending 消息
   * 3. streamChat 从未被调用，pendingOutbound 被清除
   */
  it("cancels pending first-message stream when user switches to another session", async () => {
    const { result, store, rerender } = renderChatController();

    act(() => {
      result.current.composer.setInput("first pending");
    });

    await act(async () => {
      result.current.composer.handleSend();
    });

    // 新会话已创建，pending 状态就绪
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(streamChatMock).toHaveBeenCalledTimes(0);
    expect(store.getState().chat.pendingOutbound?.sessionId).toBe(
      "session-created",
    );

    // 用户切换到其他会话
    useParamsMock.mockReturnValue({
      sessionId: "session-b",
    });
    getConversationHistoryMock.mockResolvedValueOnce([
      {
        id: "history-b",
        sessionId: "session-b",
        messageType: 2,
        messageContent: "loaded b",
        messageSeq: 1,
        createTime: "2025-01-01T00:00:02.000Z",
      },
    ]);
    rerender();

    await waitFor(() => {
      expect(result.current.history.messages[0]?.content).toBe("loaded b");
    });

    // pending 消息不应触发流式
    expect(streamChatMock).toHaveBeenCalledTimes(0);
    expect(store.getState().chat.pendingOutbound).toBeNull();
  });

  /**
   * 验证：会话 A 的流式响应进行中时切换到会话 B，
   * 会话 A 的 SSE 连接被 abort，且后续到达的 stale chunk 不会被写入 Redux。
   *
   * 这是防止竞态的关键测试：
   * - abort 信号确保底层 HTTP 连接被中断
   * - isActiveRequest() 守卫确保回调中丢弃过期数据
   * - 历史加载覆盖确保 UI 展示的是会话 B 的正确内容
   */
  it("drops stale stream chunks after switching to another session", async () => {
    useParamsMock.mockReturnValue({
      sessionId: "session-a",
    });

    const streamDeferred = createDeferred<void>();
    let streamCallbacks:
      | {
          onMessage: (chunk: string) => void;
          onDone?: () => void;
        }
      | undefined;
    let streamSignal: AbortSignal | undefined;

    streamChatMock.mockImplementation(
      async (
        _params: unknown,
        signal: AbortSignal,
        callbacks: {
          onMessage: (chunk: string) => void;
          onDone?: () => void;
        },
      ) => {
        streamSignal = signal;
        streamCallbacks = callbacks;
        return streamDeferred.promise;
      },
    );
    getConversationHistoryMock.mockResolvedValue([
      {
        id: "history-a",
        sessionId: "session-a",
        messageType: 2,
        messageContent: "loaded a",
        messageSeq: 1,
        createTime: "2025-01-01T00:00:01.000Z",
      },
    ]);

    const { result, rerender } = renderChatController({
      currentSessionId: "session-a",
      currentSessionTitle: "Session A",
      messages: [
        {
          id: "seed-a",
          role: "assistant",
          content: "loaded a",
          timestamp: 1,
          status: "done",
        },
      ] as ChatMessage[],
    });

    // 在会话 A 中发送消息
    act(() => {
      result.current.composer.setInput("message a");
    });

    await act(async () => {
      result.current.composer.handleSend();
    });

    expect(streamCallbacks).toBeDefined();

    // 切换到会话 B
    useParamsMock.mockReturnValue({
      sessionId: "session-b",
    });
    getConversationHistoryMock.mockResolvedValueOnce([
      {
        id: "history-b",
        sessionId: "session-b",
        messageType: 2,
        messageContent: "loaded b",
        messageSeq: 1,
        createTime: "2025-01-01T00:00:02.000Z",
      },
    ]);

    rerender();

    // SSE 连接应被 abort
    await waitFor(() => {
      expect(streamSignal?.aborted).toBe(true);
    });

    // 模拟旧连接仍收到数据（竞态场景）
    act(() => {
      streamCallbacks?.onMessage("stale chunk");
      streamDeferred.resolve();
    });

    // 应展示会话 B 的内容，不含 stale chunk
    await waitFor(() => {
      expect(result.current.history.messages[0]?.content).toBe("loaded b");
    });

    expect(
      result.current.history.messages.some(
        (message) => message.content === "stale chunk",
      ),
    ).toBe(false);
  });

  /**
   * 验证：在已有会话页面点击"新建对话"后，不会重定向回旧会话。
   *
   * 流程：
   * 1. 当前在 /chat/old-session，Redux 持有 old-session 的消息
   * 2. dispatch beginNewChatSession → isStartingNewSession 变为 true
   * 3. URL 变为 /chat（无 sessionId）
   * 4. shouldRedirectToRuntimeSession 因 isStartingNewSession 标志而不触发
   * 5. dispatch finishStartingNewChatSession 清除过渡标志
   */
  it("does not redirect back when switching to a new chat from an existing session", async () => {
    useParamsMock.mockReturnValue({
      sessionId: "old-session",
    });

    const { rerender, store } = renderChatController({
      currentSessionId: "old-session",
      currentSessionTitle: "Old Session",
      messages: [
        {
          id: "old-message",
          role: "assistant",
          content: "old content",
          timestamp: 1,
          status: "done",
        },
      ] as ChatMessage[],
    });

    // 触发新建对话
    act(() => {
      store.dispatch(beginNewChatSession());
    });

    // 模拟 URL 变为 /chat
    useParamsMock.mockReturnValue({});
    navigateMock.mockClear();

    rerender();

    // 不应重定向回 old-session
    await waitFor(() => {
      expect(navigateMock).not.toHaveBeenCalledWith(
        `${ROUTES.chat}/old-session`,
        expect.anything(),
      );
    });

    expect(store.getState().chat.currentSessionId).toBeNull();
    expect(store.getState().chat.messages).toHaveLength(0);

    // 过渡完成后清除标志
    act(() => {
      store.dispatch(finishStartingNewChatSession());
    });

    expect(store.getState().chat.isStartingNewSession).toBe(false);
  });

  /**
   * 验证：isStartingNewSession 为 true 时，即使 Redux 中还有旧 sessionId，
   * 也不触发重定向。这保护了"新建对话"过渡期间的 URL 稳定性。
   */
  it("does not redirect while isStartingNewSession even if runtime session id is stale", async () => {
    useParamsMock.mockReturnValue({});

    navigateMock.mockClear();

    renderChatController({
      currentSessionId: "old-session",
      currentSessionTitle: "Old Session",
      isStartingNewSession: true,
      messages: [] as ChatMessage[],
    });

    await waitFor(() => {
      expect(navigateMock).not.toHaveBeenCalledWith(
        `${ROUTES.chat}/old-session`,
        expect.anything(),
      );
    });
  });

  /**
   * 验证：历史加载失败时，重置运行时并回退到 /chat 根路径。
   *
   * 场景：用户通过书签访问已被删除的会话，后端返回错误。
   * 此时应清空 Redux 残留状态并导航到安全页面，而不是停留在错误页。
   */
  it("resets the runtime and navigates back to /chat when history loading fails", async () => {
    useParamsMock.mockReturnValue({
      sessionId: "broken-session",
    });
    getConversationHistoryMock.mockRejectedValue(new Error("history failed"));

    const { store } = renderChatController({
      currentSessionId: "old-session",
      currentSessionTitle: "Old Session",
      messages: [
        {
          id: "old-message",
          role: "assistant",
          content: "old content",
          timestamp: 1,
          status: "done",
        },
      ] as ChatMessage[],
    });

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(ROUTES.chat, {
        replace: true,
      });
    });

    expect(store.getState().chat.currentSessionId).toBeNull();
    expect(store.getState().chat.messages).toHaveLength(0);
  });
});
