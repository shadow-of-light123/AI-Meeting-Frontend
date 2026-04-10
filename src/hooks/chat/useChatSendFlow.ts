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
import { CHAT_ROLES } from "@/lib/constants";
import { CHAT_MESSAGE_STATUS, type ChatMessage } from "@/lib/chat";
import { createTextStreamLimiter, type TextStreamLimiter } from "@/lib/streamLimiter";
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
  setChatRuntimeSession,
} from "@/store/slices/chatSlice";

type SendMessageOptions = {
  forceNewSession?: boolean;
};

type UseChatSendFlowOptions = {
  routeSessionId: string | null;
  navigateToSession: (sessionId: string, options?: { replace?: boolean }) => void;
};

export function useChatSendFlow({
  routeSessionId,
  navigateToSession,
}: UseChatSendFlowOptions) {
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const { messages, isStreaming, currentSessionId } = useAppSelector(
    (state) => state.chat,
  );
  const { currentUser, authEpoch } = useAppSelector((state) => state.user);

  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const runtimeSessionIdRef = useRef<string | null>(currentSessionId);

  useEffect(() => {
    runtimeSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const cancelActiveStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    activeRequestIdRef.current = null;
    dispatch(setActiveStream(null));
  }, [dispatch]);

  const sendMessage = useCallback(
    async (content: string, aiId?: number, options?: SendMessageOptions) => {
      const nextContent = content.trim();
      if (!nextContent || isStreaming) {
        return;
      }

      cancelActiveStream();

      const requestId = createRuntimeMessageId("chat-request");
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

      dispatch(appendUserMessage(userMessage));
      dispatch(appendAssistantPlaceholder(assistantMessage));

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      activeRequestIdRef.current = requestId;

      let contentLimiter: TextStreamLimiter | null = null;
      let reasoningLimiter: TextStreamLimiter | null = null;

      const isActiveRequest = (activeSessionId: string) =>
        activeRequestIdRef.current === requestId &&
        abortControllerRef.current === abortController &&
        runtimeSessionIdRef.current === activeSessionId;

      try {
        let activeSessionId =
          options?.forceNewSession === true
            ? null
            : routeSessionId || currentSessionId;

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
          runtimeSessionIdRef.current = activeSessionId;
          dispatch(
            setChatRuntimeSession({
              sessionId: activeSessionId,
              title: response.conversationTitle || activeSessionId,
            }),
          );
          navigateToSession(activeSessionId, {
            replace: true,
          });

          const userKey = getConversationUserKey(currentUser);
          await queryClient.invalidateQueries({
            queryKey: getConversationsQueryKey(userKey, authEpoch),
          });
        } else {
          runtimeSessionIdRef.current = activeSessionId;
        }

        dispatch(
          setActiveStream({
            requestId,
            sessionId: activeSessionId,
            messageId: assistantMessage.id,
          }),
        );

        contentLimiter = createTextStreamLimiter({
          intervalMs: 40,
          charsPerTick: 12,
          onUpdate: (nextChunk) => {
            if (!isActiveRequest(activeSessionId)) {
              return;
            }
            dispatch(
              appendAssistantChunk({
                id: assistantMessage.id,
                content: nextChunk,
              }),
            );
          },
        });

        reasoningLimiter = createTextStreamLimiter({
          intervalMs: 40,
          charsPerTick: 12,
          onUpdate: (nextChunk) => {
            if (!isActiveRequest(activeSessionId)) {
              return;
            }
            dispatch(
              appendAssistantReasoningChunk({
                id: assistantMessage.id,
                reasoning: nextChunk,
              }),
            );
          },
        });

        await aiService.streamChat(
          {
            sessionId: activeSessionId,
            inputMessage: nextContent,
            userName: currentUser?.username || "Guest",
            aiId,
          },
          abortController.signal,
          {
            onMessage: (chunk) => {
              if (!isActiveRequest(activeSessionId)) {
                return;
              }
              contentLimiter?.push(chunk);
            },
            onReasoning: (chunk) => {
              if (!isActiveRequest(activeSessionId)) {
                return;
              }
              reasoningLimiter?.push(chunk);
            },
            onDone: () => {
              if (!isActiveRequest(activeSessionId)) {
                return;
              }
              contentLimiter?.flush();
              reasoningLimiter?.flush();
              dispatch(
                finishAssistantMessage({
                  id: assistantMessage.id,
                }),
              );
              dispatch(setActiveStream(null));
              activeRequestIdRef.current = null;
              abortControllerRef.current = null;
            },
            onError: (error) => {
              if (error.message === "Connection closed") {
                return;
              }
              console.error("Stream error callback:", error);
            },
          },
        );
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.message === "Connection closed")
        ) {
          return;
        }

        console.error("Chat error:", error);
        dispatch(
          failAssistantMessage({
            id: assistantMessage.id,
            errorMessage:
              error instanceof Error ? error.message : CHAT_STREAM_ERROR_TEXT,
          }),
        );
      } finally {
        contentLimiter?.flush();
        reasoningLimiter?.flush();
        contentLimiter?.stop();
        reasoningLimiter?.stop();

        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
        if (activeRequestIdRef.current === requestId) {
          activeRequestIdRef.current = null;
        }
        dispatch(setActiveStream(null));
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
      queryClient,
      routeSessionId,
    ],
  );

  useEffect(
    () => () => {
      cancelActiveStream();
    },
    [cancelActiveStream],
  );

  return {
    messages,
    isStreaming,
    sendMessage,
    cancelActiveStream,
  };
}
