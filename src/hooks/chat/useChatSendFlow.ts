import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CHAT_STREAM_ERROR_TEXT,
  createRuntimeMessageId,
} from "@/hooks/chat/chatRuntime.shared";
import {
  getConversationUserKey,
  getConversationsQueryKey,
} from "@/hooks/useConversations";
import { CHAT_ROLES, ROUTES } from "@/lib/constants";
import { CHAT_MESSAGE_STATUS, type ChatMessage } from "@/lib/chat";
import {
  createTextStreamLimiter,
  type TextStreamLimiter,
} from "@/lib/streamLimiter";
import { aiService } from "@/services/aiService";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import {
  appendAssistantChunk,
  appendAssistantPlaceholder,
  appendAssistantReasoningChunk,
  appendUserMessage,
  failAssistantMessage,
  finishAssistantMessage,
  setActiveStream,
  setPendingOutbound,
  setChatRuntimeSession,
  type PendingOutbound,
} from "@/store/slices/chatSlice";

// ─── 类型定义 ───

/** sendMessage 可选参数 */
type SendMessageOptions = {
  /** 强制创建新会话（忽略 URL 和 Redux 中已有的 sessionId） */
  forceNewSession?: boolean;
};

/** Hook 入参 —— 需要外部提供路由会话 ID 和导航函数 */
type UseChatSendFlowOptions = {
  /** URL 路径中的会话 ID（可能为 null） */
  routeSessionId: string | null;
  /** 跳转到指定会话页（新建会话后替换 URL） */
  navigateToSession: (
    sessionId: string,
    options?: { replace?: boolean },
  ) => void;
};

/**
 * 对话发送流程 Hook —— 管理从用户输入到 SSE 流式响应的完整生命周期。
 *
 * 核心流程：
 * 1. sendMessage 被调用 → 立即向 Redux 插入 user 消息 + assistant 占位
 * 2. 若无可用 sessionId → 调用 createConversation 新建会话 → 设置 pendingOutbound
 *    （延迟发送，等路由同步后再触发流式请求）
 * 3. 若已有 sessionId → 直接调用 streamMessage 发起 SSE 流式请求
 * 4. SSE 回调中通过 TextStreamLimiter 控制逐字渲染速率，增量更新 Redux
 *
 * 并发控制：
 * - 通过 AbortController 取消上一次流式请求
 * - 通过 activeRequestIdRef 判断回调是否仍属于当前活跃请求（防止竞态）
 * - isStreaming / pendingOutbound 双重锁定发送按钮
 */
export function useChatSendFlow({
  routeSessionId,
  navigateToSession,
}: UseChatSendFlowOptions) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();

  // ─── Redux 状态 ───
  const { messages, isStreaming, currentSessionId, pendingOutbound } =
    useAppSelector((state) => state.chat);
  const { currentUser, authEpoch } = useAppSelector((state) => state.user);

  // ─── Refs：跟踪当前活跃的流式请求 ───
  /** 当前 SSE 请求的 AbortController，用于主动取消 */
  const abortControllerRef = useRef<AbortController | null>(null);
  /** 当前活跃请求的唯一标识，用于回调中判断是否仍是最新请求 */
  const activeRequestIdRef = useRef<string | null>(null);
  /**
   * 稳定引用的 cancel 函数，供组件卸载时的清理 useEffect 调用。
   * 使用 ref 而非直接引用 cancelActiveStream，避免 useEffect deps 变化导致重复注册。
   */
  const cancelActiveStreamRef = useRef<() => void>(() => undefined);

  /**
   * 取消当前活跃的流式请求，并清理相关 Redux 状态。
   * - 调用 AbortController.abort() 中断底层 HTTP 请求
   * - 若有 pendingOutbound，将其 assistant 消息标记为完成
   * - 清除 activeStream 追踪
   */
  const cancelActiveStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    activeRequestIdRef.current = null;
    if (pendingOutbound) {
      dispatch(
        finishAssistantMessage({
          id: pendingOutbound.assistantMessageId,
        }),
      );
      dispatch(setPendingOutbound(null));
    }
    dispatch(setActiveStream(null));
  }, [dispatch, pendingOutbound]);

  // 同步 cancelActiveStream 到 ref，供卸载 cleanup 使用
  useEffect(() => {
    cancelActiveStreamRef.current = cancelActiveStream;
  }, [cancelActiveStream]);

  /**
   * 发起 SSE 流式对话请求。
   *
   * 为正文和推理内容各创建一个 TextStreamLimiter（40ms 间隔，每次 12 字符），
   * 实现前端逐字渲染速率控制。请求结束时 flush 剩余缓冲区 + finishAssistantMessage。
   *
   * 通过 isActiveRequest() 闭包在每个回调中判断请求是否仍活跃 ——
   * 若已被新的请求替代或被取消，则丢弃回调数据（防止竞态）。
   *
   * @param outbound - 待发送的消息元信息（requestId / sessionId / assistantMessageId / content / aiId）
   */
  const streamMessage = useCallback(
    async (outbound: PendingOutbound) => {
      // 为本次请求创建新的 AbortController
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      activeRequestIdRef.current = outbound.requestId;

      let contentLimiter: TextStreamLimiter | null = null;
      let reasoningLimiter: TextStreamLimiter | null = null;
      /** 是否已完成消息（onDone 被调用），防止 finally 重复 flush */
      let hasFinalizedMessage = false;

      /**
       * 判断当前回调是否仍属于活跃请求。
       * 同时检查 requestId 和 abortController 引用 —— 两者都匹配才允许继续。
       * 防止组件卸载后 / 新请求发起后旧请求的回调仍写入 Redux。
       */
      const isActiveRequest = () =>
        activeRequestIdRef.current === outbound.requestId &&
        abortControllerRef.current === abortController;

      // 记录当前活跃的流式请求，供 chatSlice 追踪
      dispatch(
        setActiveStream({
          requestId: outbound.requestId,
          sessionId: outbound.sessionId,
          messageId: outbound.assistantMessageId,
        }),
      );

      // ── 正文逐字渲染限速器 ──
      contentLimiter = createTextStreamLimiter({
        intervalMs: 40, // 每 40ms 推送一次
        charsPerTick: 12, // 每次推送 12 个字符
        onUpdate: (nextChunk) => {
          if (!isActiveRequest()) {
            return;
          }
          dispatch(
            appendAssistantChunk({
              id: outbound.assistantMessageId,
              content: nextChunk,
            }),
          );
        },
      });

      // ── 推理内容逐字渲染限速器 ──
      reasoningLimiter = createTextStreamLimiter({
        intervalMs: 40,
        charsPerTick: 12,
        onUpdate: (nextChunk) => {
          if (!isActiveRequest()) {
            return;
          }
          dispatch(
            appendAssistantReasoningChunk({
              id: outbound.assistantMessageId,
              reasoning: nextChunk,
            }),
          );
        },
      });

      try {
        await aiService.streamChat(
          {
            sessionId: outbound.sessionId,
            inputMessage: outbound.content,
            userName: currentUser?.username || "Guest",
            aiId: outbound.aiId,
          },
          abortController.signal,
          {
            /** 正文增量 → 送入限速器排队输出 */
            onMessage: (chunk) => {
              if (!isActiveRequest()) {
                return;
              }
              contentLimiter?.push(chunk);
            },
            /** 推理增量 → 送入推理限速器排队输出 */
            onReasoning: (chunk) => {
              if (!isActiveRequest()) {
                return;
              }
              reasoningLimiter?.push(chunk);
            },
            /** 流正常结束 → flush 剩余缓冲 + 标记消息完成 */
            onDone: () => {
              if (!isActiveRequest()) {
                return;
              }
              contentLimiter?.flush();
              reasoningLimiter?.flush();
              dispatch(
                finishAssistantMessage({
                  id: outbound.assistantMessageId,
                }),
              );
              hasFinalizedMessage = true;
              dispatch(setActiveStream(null));
              activeRequestIdRef.current = null;
              abortControllerRef.current = null;
            },
            /**
             * 流错误回调。
             * "Connection closed" 由 onclose 抛出（已在上方 onclose 内补发 onDone），
             * 此处忽略以避免重复处理。其余错误由 catch 块统一处理。
             */
            onError: (error) => {
              if (error.message === "Connection closed") {
                return;
              }
              console.error("Stream error callback:", error);
            },
          },
        );
      } catch (error: unknown) {
        // AbortError：用户主动取消 → 标记消息完成（非异常）
        // Connection closed：SSE 连接关闭 → 标记消息完成
        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.message === "Connection closed")
        ) {
          if (!hasFinalizedMessage) {
            dispatch(
              finishAssistantMessage({
                id: outbound.assistantMessageId,
              }),
            );
            hasFinalizedMessage = true;
          }
          return;
        }

        // 真正的错误 → 将 assistant 消息标记为失败
        console.error("Chat error:", error);
        dispatch(
          failAssistantMessage({
            id: outbound.assistantMessageId,
            errorMessage:
              error instanceof Error ? error.message : CHAT_STREAM_ERROR_TEXT,
          }),
        );
      } finally {
        // 确保限速器缓冲区被清空并停止定时器
        contentLimiter?.flush();
        reasoningLimiter?.flush();
        contentLimiter?.stop();
        reasoningLimiter?.stop();

        // 仅当仍是当前请求时才清理引用（防止覆盖新请求的 controller）
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
        if (activeRequestIdRef.current === outbound.requestId) {
          activeRequestIdRef.current = null;
        }
        dispatch(setActiveStream(null));
      }
    },
    [currentUser, dispatch],
  );

  /**
   * 发送消息的入口函数。
   *
   * 步骤：
   * 1. 防重检查：空输入 / 正在流式中 / 有 pendingOutbound → 直接返回
   * 2. 取消上次流式请求
   * 3. 立即向 Redux 插入 user 消息 + assistant 占位符（乐观更新）
   * 4. 判断是否有可用会话：
   *    - forceNewSession 或没有可用 sessionId → 调用 createConversation 创建新会话
   *      → 创建成功后更新路由 + 设置 pendingOutbound（由后续 useEffect 触发流式）
   *    - 已有 sessionId → 直接调用 streamMessage 发起 SSE 流式请求
   * 5. 异常时标记 assistant 消息为失败
   *
   * @param content  - 用户输入的文本内容
   * @param aiId     - 选中的 AI 模型 ID
   * @param options  - forceNewSession 等可选参数
   */
  const sendMessage = useCallback(
    async (content: string, aiId?: number, options?: SendMessageOptions) => {
      const nextContent = content.trim();

      // 防重：空输入 / 正在流式中 / 已有 pending 消息
      if (!nextContent || isStreaming || Boolean(pendingOutbound)) {
        return;
      }

      // 取消上一次流式请求（若有）
      cancelActiveStream();

      const requestId = createRuntimeMessageId("chat-request");

      // ── 构建消息对象 ──
      const userMessage: ChatMessage = {
        id: createRuntimeMessageId("chat-user"),
        role: CHAT_ROLES.user,
        content: nextContent,
        timestamp: Date.now(),
        status: CHAT_MESSAGE_STATUS.done,
      };
      const assistantMessage: ChatMessage = {
        id: createRuntimeMessageId("chat-assistant"),
        role: CHAT_ROLES.assistant,
        content: "",
        timestamp: Date.now(),
        status: CHAT_MESSAGE_STATUS.streaming,
      };

      // 乐观插入消息到 Redux
      dispatch(appendUserMessage(userMessage));
      dispatch(appendAssistantPlaceholder(assistantMessage));

      try {
        /**
         * 确定要使用的会话 ID：
         * - forceNewSession 为 true → 强制创建新会话
         * - 否则优先使用 URL 中的 routeSessionId，其次 Redux 中的 currentSessionId
         */
        let activeSessionId =
          options?.forceNewSession === true
            ? null
            : routeSessionId || currentSessionId;

        // ── 无可用会话 → 创建新会话 ──
        if (!activeSessionId) {
          const response = await aiService.createConversation({
            userName: currentUser?.username || "Guest",
            firstMessage: nextContent,
            aiId,
          });

          if (!response?.sessionId) {
            throw new Error(
              "Failed to create conversation: invalid response data",
            );
          }

          activeSessionId = response.sessionId;

          // 将新会话信息写入 Redux
          dispatch(
            setChatRuntimeSession({
              sessionId: activeSessionId,
              title:
                response.conversationTitle ||
                nextContent.slice(0, 24) ||
                activeSessionId,
            }),
          );

          // 替换 URL 为 /chat/:sessionId（replace 避免产生多余历史记录）
          navigateToSession(activeSessionId, {
            replace: true,
          });

          // 刷新侧边栏会话列表缓存
          const userKey = getConversationUserKey(currentUser);
          await queryClient.invalidateQueries({
            queryKey: getConversationsQueryKey(userKey, authEpoch),
          });

          /**
           * 设置 pendingOutbound —— 不在此处直接调用 streamMessage，
           * 而是等到路由同步（routeSessionId === activeSessionId）且 currentSessionId 生效后，
           * 由下方的 useEffect 自动触发。避免路由尚未更新就发起请求导致的竞态问题。
           */
          dispatch(
            setPendingOutbound({
              requestId,
              sessionId: activeSessionId,
              assistantMessageId: assistantMessage.id,
              content: nextContent,
              aiId,
            }),
          );
          return;
        }

        // ── 已有会话 → 直接发起流式请求 ──
        await streamMessage({
          requestId,
          sessionId: activeSessionId,
          assistantMessageId: assistantMessage.id,
          content: nextContent,
          aiId,
        });
      } catch (error: unknown) {
        console.error("Chat error:", error);
        dispatch(
          failAssistantMessage({
            id: assistantMessage.id,
            errorMessage:
              error instanceof Error ? error.message : CHAT_STREAM_ERROR_TEXT,
          }),
        );
      }
    },
    [
      authEpoch,
      cancelActiveStream,
      currentSessionId,
      currentUser,
      dispatch,
      isStreaming,
      navigateToSession,
      pendingOutbound,
      queryClient,
      routeSessionId,
      streamMessage,
    ],
  );

  /**
   * 处理 pendingOutbound：当有待发送的消息且条件就绪时，自动触发流式请求。
   *
   * 触发条件（三者同时满足）：
   * 1. pendingOutbound 存在
   * 2. isStreaming 为 false（不在流式中）
   * 3. URL 和 Redux 中的 sessionId 都和 pendingOutbound.sessionId 一致（路由已同步）
   *
   * 这是 sendMessage → createConversation → setPendingOutbound 流程的后半段：
   * 创建会话后路由发生变更，当路由同步到新 sessionId 时此 effect 自动接管发送。
   */
  useEffect(() => {
    if (!pendingOutbound || isStreaming) {
      return;
    }
    if (
      routeSessionId !== pendingOutbound.sessionId ||
      currentSessionId !== pendingOutbound.sessionId
    ) {
      return;
    }

    // 清除 pending 标记，发起流式请求
    dispatch(setPendingOutbound(null));
    void streamMessage(pendingOutbound);
  }, [
    currentSessionId,
    dispatch,
    isStreaming,
    pendingOutbound,
    routeSessionId,
    streamMessage,
  ]);

  /**
   * 清理过期的 pendingOutbound：
   * 当用户导航到不同的会话页时（routeSessionId 与 pendingOutbound.sessionId 不一致），
   * 将 pending 的 assistant 消息标记为完成并清除 pending 状态。
   *
   * 典型场景：用户快速从新会话页跳转到已有会话，之前的 pending 消息应被废弃。
   */
  useEffect(() => {
    if (!pendingOutbound || !routeSessionId) {
      return;
    }
    if (routeSessionId === pendingOutbound.sessionId) {
      return;
    }

    dispatch(
      finishAssistantMessage({
        id: pendingOutbound.assistantMessageId,
      }),
    );
    dispatch(setPendingOutbound(null));
  }, [dispatch, pendingOutbound, routeSessionId]);

  /**
   * 从 /chat/:sessionId 回到 /chat 时取消进行中的流式请求。
   * resetChatRuntime 只清 Redux，不会 abort 底层 SSE 连接。
   */
  const previousRouteSessionIdRef = useRef<string | null>(routeSessionId);

  useEffect(() => {
    const previousRouteSessionId = previousRouteSessionIdRef.current;
    previousRouteSessionIdRef.current = routeSessionId;

    if (
      previousRouteSessionId !== null &&
      routeSessionId === null &&
      !pendingOutbound
    ) {
      cancelActiveStream();
    }
  }, [cancelActiveStream, pendingOutbound, routeSessionId]);

  /**
   * 组件卸载时清理：如果用户离开了聊天页面，取消活跃的流式请求。
   *
   * 通过 cancelActiveStreamRef 而非直接依赖 cancelActiveStream，
   * 避免因 deps 变化导致 cleanup 函数反复注册 / 注销。
   */
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined") {
        // 仍在聊天页面内 → 不取消（可能是 React 重渲染触发的 cleanup）
        if (window.location.pathname.startsWith(ROUTES.chat)) {
          return;
        }
      }
      cancelActiveStreamRef.current();
    };
  }, []);

  /**
   * 对外暴露 isStreaming 时合并 pendingOutbound 状态 ——
   * 在会话创建完成、路由同步、但流式尚未开始的窗口期，UI 应仍显示"发送中"。
   */
  return {
    messages,
    isStreaming: isStreaming || Boolean(pendingOutbound),
    sendMessage,
    cancelActiveStream,
  };
}
