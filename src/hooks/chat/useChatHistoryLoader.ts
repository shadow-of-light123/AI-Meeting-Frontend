import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CHAT_HISTORY_LOADING_TITLE,
  normalizeHistoryMessages,
} from "@/hooks/chat/chatRuntime.shared";
import { aiService } from "@/services/aiService";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { hydrateChatSession, resetChatRuntime } from "@/store/slices/chatSlice";

/**
 * useChatHistoryLoader 的入参类型。
 *
 * 所有外部依赖（路由状态、流式控制、导航）由调用方显式注入，
 * 使 Hook 保持纯逻辑、不直接耦合 React Router。
 */
type UseChatHistoryLoaderOptions = {
  /** URL 路径中的会话 ID（可能为 null，表示无会话路由） */
  routeSessionId: string | null;
  /** 是否存在尚未处理的 initialQuery，存在时跳过历史加载以避免竞态 */
  hasPendingInitialQuery: boolean;
  /** 取消当前活跃的 SSE 流式请求（加载历史前必须中断旧连接） */
  cancelActiveStream: () => void;
  /** 导航回聊天根路径 /chat（会话不存在或加载失败时回退） */
  navigateToChatRoot: (options?: { replace?: boolean }) => void;
};

/**
 * 聊天历史消息加载 Hook —— 按 routeSessionId 从服务端拉取历史消息并水合到 Redux。
 *
 * 核心流程：
 * 1. 通过 shouldLoadHistory 判断是否需要发起加载请求：
 *    - routeSessionId 非空
 *    - 没有待处理的 initialQuery（避免与"新会话首条消息发送"形成竞态）
 *    - 不在新建会话的过渡态中（isStartingNewSession 为 false）
 *    - Redux 中尚未持有该会话的消息（sessionId 不匹配或 messages 为空）
 * 2. 确认需要加载后：
 *    - 取消当前活跃的流式请求（避免旧 SSE 回调污染新会话的消息列表）
 *    - 先写入占位状态（title = CHAT_HISTORY_LOADING_TITLE，messages = []），
 *      让 UI 展示加载态而非残留旧数据
 *    - 通过 React Query 发起 getConversationHistory 请求
 * 3. 请求成功 → 将后端消息转换为 ChatMessage 数组并 hydrateChatSession
 * 4. 请求失败 → resetChatRuntime 清空运行时 + navigateToChatRoot 回退到根路径
 *
 * 返回 isHistoryLoading 供 UI 层展示加载指示器。
 */
export function useChatHistoryLoader({
  routeSessionId,
  hasPendingInitialQuery,
  cancelActiveStream,
  navigateToChatRoot,
}: UseChatHistoryLoaderOptions) {
  const dispatch = useAppDispatch();
  const { currentSessionId, messages, isStartingNewSession } = useAppSelector(
    (state) => state.chat,
  );

  /**
   * 是否需要加载历史记录 —— 综合路由、运行时状态、待发送标记的判断。
   *
   * 四个条件缺一不可：
   * - routeSessionId 存在（否则没有要加载的目标）
   * - 无 pending 的 initialQuery（否则会与新会话发送流程冲突）
   * - 非新建会话过渡态（beginNewChatSession 到 URL 同步之间的窗口期）
   * - 目标会话尚未在 Redux 中（避免重复加载）
   */
  const shouldLoadHistory = useMemo(
    () =>
      Boolean(routeSessionId) &&
      !hasPendingInitialQuery &&
      !isStartingNewSession &&
      (currentSessionId !== routeSessionId || messages.length === 0),
    [
      currentSessionId,
      hasPendingInitialQuery,
      isStartingNewSession,
      messages.length,
      routeSessionId,
    ],
  );

  /**
   * 阶段一：加载开始前 —— 取消当前流 + 写入占位状态。
   *
   * 此 effect 在 shouldLoadHistory 变为 true 时立即执行，
   * 先中断旧连接再填充加载占位，确保 UI 不会短暂残留旧会话的消息。
   */
  useEffect(() => {
    if (!routeSessionId || !shouldLoadHistory) {
      return;
    }

    // 中断当前流式请求（可能是之前会话的 SSE 连接）
    cancelActiveStream();
    // 写入加载占位：标题为 "正在加载会话..."，消息列表为空
    dispatch(
      hydrateChatSession({
        sessionId: routeSessionId,
        title: CHAT_HISTORY_LOADING_TITLE,
        messages: [],
      }),
    );
  }, [cancelActiveStream, dispatch, routeSessionId, shouldLoadHistory]);

  /**
   * 通过 React Query 托管历史消息请求。
   *
   * - enabled 与 shouldLoadHistory 同步，避免不必要的请求
   * - retry: false —— 历史加载失败不重试（直接回退到根路径）
   * - staleTime: 30s —— 短时间内重复进入同一会话不重复请求
   * - refetchOnWindowFocus: false —— 切回窗口不自动刷新
   */
  const historyQuery = useQuery({
    queryKey: ["chat-history", routeSessionId],
    enabled: shouldLoadHistory && Boolean(routeSessionId),
    queryFn: () => aiService.getConversationHistory(routeSessionId as string),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  /**
   * 阶段二：请求成功 → 规范化消息并写入 Redux。
   *
   * normalizeHistoryMessages 将后端 AiMessageHistory[] 转换为前端 ChatMessage[]，
   * 完成消息角色映射、时间戳转换、错误标记等。
   */
  useEffect(() => {
    if (!routeSessionId || !historyQuery.data) {
      return;
    }

    dispatch(
      hydrateChatSession({
        sessionId: routeSessionId,
        title: routeSessionId,
        messages: normalizeHistoryMessages(historyQuery.data),
      }),
    );
  }, [dispatch, historyQuery.data, routeSessionId]);

  /**
   * 阶段三：请求失败 → 重置运行时 + 回退到聊天根路径。
   *
   * 常见场景：用户通过书签访问一个已被删除的会话，
   * 此时后端返回错误，前端应清空残留状态并导航回 /chat。
   */
  useEffect(() => {
    if (!routeSessionId || !historyQuery.error) {
      return;
    }

    console.error("Failed to load history:", historyQuery.error);
    dispatch(resetChatRuntime());
    navigateToChatRoot({
      replace: true,
    });
  }, [dispatch, historyQuery.error, navigateToChatRoot, routeSessionId]);

  /**
   * 对外暴露历史加载状态。
   *
   * isHistoryLoading 同时覆盖 React Query 的 isLoading（首次加载）
   * 和 isFetching（后台重新获取），确保 UI 在所有加载阶段都有反馈。
   */
  return {
    isHistoryLoading:
      shouldLoadHistory && (historyQuery.isLoading || historyQuery.isFetching),
  };
}
