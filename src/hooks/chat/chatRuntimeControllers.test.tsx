import { act, renderHook } from "@testing-library/react";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES } from "@/lib/constants";
import { useStartNewChatSession } from "@/hooks/chat/useStartNewChatSession";
import { useHomePageController } from "@/hooks/home/useHomePageController";
import { useSidebarFooterController } from "@/hooks/layout/useSidebarFooterController";
import type { ChatMessage } from "@/lib/chat";
import chatReducer from "@/store/slices/chatSlice";
import userReducer from "@/store/slices/userSlice";

// ─── Mock 函数 ───

/** 模拟 React Router 的 navigate 函数 */
const navigateMock = vi.fn();
/** 模拟 authService.logout */
const authLogoutMock = vi.fn();
/** 模拟 React Router 的 useParams 返回值 */
const useParamsMock = vi.fn();
/** 模拟 React Router 的 useLocation 返回值 */
const useLocationMock = vi.fn();

// ─── 模块级 Mock ───

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useParams: () => useParamsMock(),
    useLocation: () => useLocationMock(),
  };
});

vi.mock("@/hooks/useAiModelsQuery", () => ({
  useAiModelsQuery: () => ({
    models: [
      {
        id: 55,
        aiName: "Model 55",
      },
    ],
  }),
}));

vi.mock("@/services/authService", () => ({
  authService: {
    logout: () => authLogoutMock(),
    login: vi.fn(),
    checkLogin: vi.fn(),
  },
}));

// ─── 工具函数 ───

/**
 * 创建测试用 Redux Store，预置一个已登录用户和一条旧聊天消息。
 *
 * chat 初始状态：session-1 会话，含一条 stale chat 消息。
 * 这样每个测试都可以在"有旧聊天数据"的上下文中验证 reset 行为。
 */
const createStore = () =>
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
        messages: [
          {
            id: "chat-1",
            role: "user",
            content: "stale chat",
            timestamp: 1,
            status: "done",
          },
        ] as ChatMessage[],
        isStreaming: false,
        error: null,
        currentSessionId: "session-1",
        currentSessionTitle: "Session 1",
        pendingOutbound: null,
        activeStreamRequestId: null,
        activeStreamSessionId: null,
        activeStreamMessageId: null,
        isStartingNewSession: false,
      },
    },
  });

/**
 * 渲染 Hook 的测试辅助函数，包裹 Redux Provider。
 *
 * @param callback - 待测试的 Hook 调用
 * @returns 渲染结果（含 result、store、rerender、unmount）
 */
const renderWithStore = <T,>(callback: () => T) => {
  const store = createStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  const rendered = renderHook(callback, {
    wrapper,
  });

  return {
    ...rendered,
    store,
  };
};

/**
 * 聊天运行时重置入口点测试套件。
 *
 * 验证三个不同入口点（新建对话、首页发送、登出）都能正确
 * 清空 chat runtime 后再执行各自的后续操作。
 *
 * 被测试的 Hook：
 * - useStartNewChatSession：侧边栏 / 导航栏"新建对话"按钮
 * - useHomePageController：首页发送消息跳转到聊天页
 * - useSidebarFooterController：侧边栏底部登出操作
 */
describe("chat runtime reset entrypoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authLogoutMock.mockResolvedValue(undefined);
    useParamsMock.mockReturnValue({});
    useLocationMock.mockReturnValue({
      key: "default-location",
      state: null,
    });
  });

  /**
   * 验证 useStartNewChatSession：先清空 runtime + 设置过渡标志，再导航到 /chat。
   *
   * 关键验证点：
   * - beginNewChatSession 后：currentSessionId 为 null，messages 为空，
   *   isStartingNewSession 为 true（过渡标志）
   * - 导航到达 /chat 路径（replace 模式）
   *
   * navigate 的 mockImplementationOnce 用于在导航回调中检查 Redux 状态，
   * 确保 beginNewChatSession 的 dispatch 先于 navigate 执行。
   */
  it("clears runtime and sets transition flag before navigating to /chat", () => {
    const { result, store } = renderWithStore(() => useStartNewChatSession());

    navigateMock.mockImplementationOnce(() => {
      const chat = store.getState().chat;
      expect(chat.currentSessionId).toBeNull();
      expect(chat.isStartingNewSession).toBe(true);
    });

    act(() => {
      result.current();
    });

    expect(navigateMock).toHaveBeenCalledWith(ROUTES.chat, {
      replace: true,
    });
    expect(store.getState().chat.currentSessionId).toBeNull();
    expect(store.getState().chat.messages).toHaveLength(0);
    expect(store.getState().chat.isStartingNewSession).toBe(true);
  });

  /**
   * 验证从首页发送消息时，在导航到聊天页之前清空 chat runtime。
   *
   * 流程：
   * 1. 用户在首页输入问题 + 选择模型
   * 2. handleSend 先 dispatch(resetChatRuntime()) 清空旧会话
   * 3. 再 navigate 到 /chat，携带 initialQuery 和 model 作为 location.state
   *
   * 这样可以确保聊天页在接收 initialQuery 时不会与旧 runtime 数据冲突。
   */
  it("resets the chat runtime before navigating from HomePage", async () => {
    const { result, store } = renderWithStore(() => useHomePageController());

    act(() => {
      result.current.setQuery("new topic");
    });

    await act(async () => {
      await result.current.handleSend();
    });

    expect(store.getState().chat.currentSessionId).toBeNull();
    expect(store.getState().chat.messages).toHaveLength(0);
    expect(navigateMock).toHaveBeenCalledWith(ROUTES.chat, {
      state: {
        model: {
          id: 55,
          aiName: "Model 55",
        },
        initialQuery: "new topic",
      },
    });
  });

  /**
   * 验证登出时，先清空 chat runtime 再导航到登录页。
   *
   * 流程：
   * 1. 用户点击登出
   * 2. handleLogout 调用 authService.logout()
   * 3. dispatch(resetChatRuntime()) 清空所有聊天数据
   * 4. navigate 到 /auth 登录页
   *
   * 确保登出后不会残留上一个用户的聊天数据，
   * 且下一位登录的用户不会看到不属于他的会话。
   */
  it("resets the chat runtime after logout before navigating to auth", async () => {
    const { result, store } = renderWithStore(() =>
      useSidebarFooterController(),
    );

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(store.getState().chat.currentSessionId).toBeNull();
    expect(store.getState().chat.messages).toHaveLength(0);
    expect(navigateMock).toHaveBeenCalledWith(ROUTES.auth);
  });
});
