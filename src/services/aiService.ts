import service, { buildApiUrl } from "@/lib/request";
import { getAuthToken } from "@/lib/authToken";
import type {
  AiConversationsPageResult,
  AiMessageHistoryListResult,
  AiMessageHistoryPageResult,
  AiPropertiesPageResult,
  ChatStreamParams,
  CreateConversationParams,
  CreateConversationResponse,
  GetAiPropertiesParams,
  GetConversationsParams,
  GetHistoryMessagesPageParams,
  StreamCallbacks,
} from "@/types/ai";
import { fetchEventSource } from "@microsoft/fetch-event-source";

type StreamParseResult = {
  content?: string;
  reasoning?: string;
  done?: boolean;
};

const parseAiStreamChunk = (raw: string): StreamParseResult => {
  if (raw === "[DONE]") {
    return { done: true };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const type =
      typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";

    if (typeof parsed.content === "string") {
      if (type === "reasoning" || type === "reasoning_content") {
        return { reasoning: parsed.content };
      }
      return { content: parsed.content };
    }

    const choices = parsed.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const firstChoice = choices[0] as Record<string, unknown>;
      const delta = firstChoice.delta as Record<string, unknown> | undefined;
      const message = firstChoice.message as
        | Record<string, unknown>
        | undefined;
      if (typeof delta?.content === "string") {
        return { content: delta.content };
      }
      if (typeof message?.content === "string") {
        return { content: message.content };
      }
    }

    if (
      typeof parsed.action === "string" &&
      parsed.action.toLowerCase() === "done"
    ) {
      return { done: true };
    }

    return {};
  } catch {
    return { content: raw };
  }
};

export const aiService = {
  getAiProperties: (params?: GetAiPropertiesParams) => {
    return service.get<AiPropertiesPageResult>("/xunzhi/v1/ai-properties", {
      params: {
        ...params,
        size: 100,
      },
    });
  },

  getConversations: (params?: GetConversationsParams) => {
    return service.get<AiConversationsPageResult>(
      "/xunzhi/v1/ai/conversations",
      {
        params,
      },
    );
  },

  getConversationHistory: (sessionId: string, signal?: AbortSignal) => {
    return service.get<AiMessageHistoryListResult>(
      `/xunzhi/v1/ai/history/${sessionId}`,
      signal ? { signal } : undefined,
    );
  },

  pageHistoryMessages: (params: GetHistoryMessagesPageParams) => {
    return service.get<AiMessageHistoryPageResult>(
      "/xunzhi/v1/ai/history/page",
      {
        params,
      },
    );
  },

  createConversation: (data: CreateConversationParams) => {
    return service.post<CreateConversationResponse>(
      "/xunzhi/v1/ai/conversations",
      data,
    );
  },

  streamChat: async (
    params: ChatStreamParams,
    signal: AbortSignal,
    callbacks: StreamCallbacks,
  ) => {
    const {
      sessionId,
      userName,
      inputMessage,
      aiId,
      messageSeq,
      imageUrls,
      mediaList,
    } = params;
    const url = buildApiUrl(
      `/xunzhi/v1/ai/sessions/${encodeURIComponent(sessionId)}/chat`,
      {
        username: userName,
      },
    );
    const token = getAuthToken();

    let isComplete = false;

    await fetchEventSource(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        sessionId,
        inputMessage,
        userName,
        aiId,
        messageSeq,
        imageUrls,
        mediaList,
      }),
      signal,
      openWhenHidden: true,

      async onopen(response) {
        if (response.ok) {
          return;
        }
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          throw new Error(`Failed to send chat: ${response.statusText}`);
        }
        throw new Error(`Server error: ${response.statusText}`);
      },

      onmessage(msg) {
        if (msg.event === "end" || msg.data === "[DONE]") {
          isComplete = true;
          callbacks.onDone?.();
          return;
        }

        const parsed = parseAiStreamChunk(msg.data);
        if (parsed.done) {
          isComplete = true;
          callbacks.onDone?.();
          return;
        }
        if (parsed.reasoning) {
          callbacks.onReasoning?.(parsed.reasoning);
        }
        if (parsed.content) {
          callbacks.onMessage(parsed.content);
        }
      },

      onclose() {
        if (!isComplete) {
          callbacks.onDone?.();
        }
        throw new Error("Connection closed");
      },

      onerror(err) {
        callbacks.onError?.(err);
        throw err;
      },
    });
  },
};
