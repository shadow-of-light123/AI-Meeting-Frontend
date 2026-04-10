import { fetchEventSource } from "@microsoft/fetch-event-source";
import { getAuthToken } from "@/lib/authToken";
import service, { buildApiUrl } from "@/lib/request";
import type { StreamCallbacks } from "@/types/ai";

export interface CreateAgentSessionParams {
  agentId: number;
  firstMessage?: string;
  userName?: string;
}

export interface CreateAgentSessionResult {
  sessionId: string;
  conversationTitle: string;
}

export interface AgentChatStreamParams {
  sessionId: string;
  inputMessage: string;
  userName: string;
  agentId: number;
  messageSeq?: number;
}

type StreamParseResult = {
  content?: string;
  reasoning?: string;
  done?: boolean;
};

const parseAgentStreamChunk = (raw: string): StreamParseResult => {
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

export const agentService = {
  createSession: (params: CreateAgentSessionParams) => {
    return service.post<CreateAgentSessionResult>(
      "/xunzhi/v1/agents/sessions",
      {
        agentId: params.agentId,
        firstMessage: params.firstMessage,
        userName: params.userName,
      },
    );
  },

  streamChat: async (
    params: AgentChatStreamParams,
    signal: AbortSignal,
    callbacks: StreamCallbacks,
  ) => {
    const token = getAuthToken();
    const url = buildApiUrl(
      `/xunzhi/v1/agents/sessions/${encodeURIComponent(params.sessionId)}/chat`,
      {
        username: params.userName,
      },
    );

    let isComplete = false;

    await fetchEventSource(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        sessionId: params.sessionId,
        inputMessage: params.inputMessage,
        userName: params.userName,
        agentId: params.agentId,
        messageSeq: params.messageSeq,
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

        const parsed = parseAgentStreamChunk(msg.data);
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
