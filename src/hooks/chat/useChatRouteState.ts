import { useCallback, useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ROUTES } from "@/lib/constants";
import {
  buildChatSessionPath,
  normalizeInitialQuery,
  type ChatPageLocationState,
} from "@/hooks/chat/chatRuntime.shared";
import { useAppSelector } from "@/store/hooks";

/**
 * 聊天页面路由状态 Hook —— 从 React Router 中解析并规范化所有路由相关状态。
 *
 * 职责：
 * 1. 从 URL params 中提取 routeSessionId（可能为 null，表示 /chat 根路径）
 * 2. 从 location.state 中提取 initialQuery 和 initialModel（跨页面跳转携带的参数）
 * 3. 通过 normalizeInitialQuery 对 initialQuery 做运行时类型守卫 + trim
 * 4. 提供 navigateToSession / navigateToChatRoot 两个导航函数的稳定引用
 * 5. 判断是否需要将无路由参数的 /chat 页面自动重定向到 Redux 中的 currentSessionId
 *
 * 该 Hook 是 ChatPage 与 React Router 之间的唯一耦合点，
 * 所有路由状态的解析和导航操作通过此 Hook 统一对外暴露。
 */
export function useChatRouteState() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ sessionId?: string }>();
  const { currentSessionId, isStartingNewSession } = useAppSelector(
    (state) => state.chat,
  );

  /**
   * 从 location.state 中读取 ChatPageLocationState。
   *
   * 使用 useMemo 缓存类型断言结果，确保在 location.state 未变化时返回同一引用。
   * 若 state 为空或非法则返回 null，由下游 normalizeInitialQuery 进一步处理。
   */
  const locationState = useMemo(
    () => (location.state as ChatPageLocationState | null) ?? null,
    [location.state],
  );

  /** URL 路径参数中的会话 ID，去除首尾空格后若为空串则统一为 null */
  const routeSessionId = params.sessionId?.trim() || null;

  /**
   * 规范化后的初始查询文本。
   * normalizeInitialQuery 内部做类型守卫（非 string → null）+ trim，
   * 确保运行时传入的任意值被安全处理。
   */
  const initialQuery = normalizeInitialQuery(locationState?.initialQuery);

  /** 从路由状态中提取的初始模型选择，未传递时为 null */
  const initialModel = locationState?.model ?? null;

  /** 是否存在尚未发送的初始查询，用于历史加载的竞态控制 */
  const hasPendingInitialQuery = Boolean(initialQuery);

  /**
   * 跳转到指定会话页的导航函数。
   *
   * 通过 buildChatSessionPath 构建 `/chat/{sessionId}` 路径，
   * sessionId 会经过 encodeURIComponent 编码以防特殊字符。
   * 使用 useCallback 保证引用稳定，避免下游 useEffect 不必要的重复触发。
   */
  const navigateToSession = useCallback(
    (sessionId: string, options?: { replace?: boolean }) => {
      navigate(buildChatSessionPath(sessionId), {
        replace: options?.replace,
      });
    },
    [navigate],
  );

  /**
   * 跳转到聊天根路径 /chat 的导航函数。
   *
   * 用于会话不存在、加载失败等需要回退到根路径的场景。
   */
  const navigateToChatRoot = useCallback(
    (options?: { replace?: boolean }) => {
      navigate(ROUTES.chat, {
        replace: options?.replace,
      });
    },
    [navigate],
  );

  /**
   * 是否需要将当前无路由参数的 /chat 页面自动重定向到运行时持有的会话。
   *
   * 四个条件同时满足才触发：
   * 1. routeSessionId 为空 —— 当前在 /chat 根路径
   * 2. 无 pending 的 initialQuery —— 不是刚从其他页面跳转过来准备发消息
   * 3. 不在新建会话过渡态 —— beginNewChatSession 后的中间窗口
   * 4. Redux 中持有有效的 currentSessionId —— 有可重定向到的目标会话
   *
   * 典型场景：用户在 /chat/sessionA 时点击侧边栏"新建对话"，
   * 此时需要先跳到 /chat，再由该标志触发重定向回 sessionA（因为 runtime 尚未切换）。
   */
  const shouldRedirectToRuntimeSession =
    !routeSessionId &&
    !hasPendingInitialQuery &&
    !isStartingNewSession &&
    Boolean(currentSessionId);

  return {
    /** URL 路径中的会话 ID */
    routeSessionId,
    /** Redux 中当前运行时的会话 ID（可能与 URL 不一致） */
    currentRuntimeSessionId: currentSessionId,
    /** 规范化后的初始查询文本 */
    initialQuery,
    /** 从路由状态中携带的初始模型 */
    initialModel,
    /** 是否存在待处理的初始查询 */
    hasPendingInitialQuery,
    /** 是否需要重定向到当前运行时会话 */
    shouldRedirectToRuntimeSession,
    /** 当前路由的 location.key，用于判断是否为同一次导航 */
    locationKey: location.key,
    /** 跳转到指定会话页 */
    navigateToSession,
    /** 跳转到聊天根路径 */
    navigateToChatRoot,
  };
}
