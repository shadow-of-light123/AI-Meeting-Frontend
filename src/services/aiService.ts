import service, { assertRequestAuthorized, buildApiUrl } from "@/lib/request";
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

// ─── SSE 流式解析相关类型与常量 ───

/** 单次 SSE chunk 解析结果 —— 可能同时包含 content 和 reasoning */
type StreamParseResult = {
  content?: string;
  reasoning?: string;
  done?: boolean;
};

/**
 * SSE 流结束标志位集合。
 * 后端可能通过多种字段（type / action / event / finish_reason / event name）
 * 发送这些值来标识流结束。比对时统一归一化为小写。
 */
const STREAM_DONE_MARKERS = new Set([
  "done",
  "end",
  "message_end",
  "message_stop",
  "completed",
  "complete",
  "stop",
]);

/**
 * 推理过程（reasoning/thinking）标志位集合。
 * 当 chunk 的 type 字段命中这些值时，content 被视为推理内容而非正文。
 */
const STREAM_REASONING_MARKERS = new Set([
  "reasoning",
  "reasoning_content",
  "thinking",
  "thinking_content",
]);

/** 将任意值归一化为小写字符串，用于流标志位比对 */
const normalizeStreamMarker = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

/** 判断 value 是否命中 done 标志位集合 */
const isDoneStreamMarker = (value: unknown) =>
  STREAM_DONE_MARKERS.has(normalizeStreamMarker(value));

/**
 * 判断 SSE 事件名或数据是否为结束信号。
 * 同时覆盖自定义事件名（如 "done"、"end"）和 OpenAI 兼容格式（"[DONE]"）。
 */
const isDoneStreamEvent = (value: unknown) =>
  isDoneStreamMarker(value) || normalizeStreamMarker(value) === "[done]";

/**
 * 解析单条 SSE chunk 数据，产出 content / reasoning / done 三种信号。
 *
 * 兼容多种后端响应格式（优先级从高到低）：
 *
 * 1. 纯文本 "[DONE]" → 流结束
 * 2. JSON 解析后：
 *    a. 优先读取嵌套的 data 字段（某些后端将实际数据包在 { data: {...} } 中）
 *    b. type 命中 reasoning 集合 → content 视为推理内容
 *    c. 直接字段 .content / .reasoning / .reasoning_content / .reasoningContent
 *    d. OpenAI 兼容格式：choices[0].delta / choices[0].message 中的字段
 * 3. JSON 解析失败 → 将原始文本作为 content 返回（兜底纯文本流）
 */
const parseAiStreamChunk = (raw: string): StreamParseResult => {
  const payload = raw.trim();
  if (!payload) {
    return {};
  }

  // 纯文本结束信号（OpenAI 兼容）
  if (payload.toUpperCase() === "[DONE]") {
    return { done: true };
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;

    // 某些后端包裹一层 data，优先解包
    const nestedData =
      typeof parsed.data === "object" &&
      parsed.data !== null &&
      !Array.isArray(parsed.data)
        ? (parsed.data as Record<string, unknown>)
        : null;
    const source = nestedData ?? parsed;
    const type = normalizeStreamMarker(source.type);

    // ── done 判断：覆盖多个字段，任一命中即结束 ──
    if (
      source.done === true ||
      isDoneStreamMarker(type) ||
      isDoneStreamMarker(source.action) ||
      isDoneStreamMarker(source.event) ||
      isDoneStreamMarker(source.finish_reason)
    ) {
      return { done: true };
    }

    // ── content / reasoning 提取 ──
    // 直接字段 content：根据 type 区分正文还是推理
    if (typeof source.content === "string") {
      if (STREAM_REASONING_MARKERS.has(type)) {
        return { reasoning: source.content };
      }
      return { content: source.content };
    }

    // 直接字段 reasoning（多种命名变体）
    if (typeof source.reasoning === "string") {
      return { reasoning: source.reasoning };
    }
    if (typeof source.reasoning_content === "string") {
      return { reasoning: source.reasoning_content };
    }
    if (typeof source.reasoningContent === "string") {
      return { reasoning: source.reasoningContent };
    }

    // OpenAI 兼容格式：choices[0].delta / choices[0].message
    const choices = source.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const firstChoice = choices[0] as Record<string, unknown>;
      const delta = firstChoice.delta as Record<string, unknown> | undefined;
      const message = firstChoice.message as
        | Record<string, unknown>
        | undefined;

      // 通过 finish_reason 或 done 判断结束
      if (
        isDoneStreamMarker(firstChoice.finish_reason) ||
        firstChoice.done === true
      ) {
        return { done: true };
      }

      // delta 中的 reasoning（deepseek 等模型）
      if (typeof delta?.reasoning === "string") {
        return { reasoning: delta.reasoning };
      }
      if (typeof delta?.reasoning_content === "string") {
        return { reasoning: delta.reasoning_content };
      }
      // delta 中的 content（最常见路径）
      if (typeof delta?.content === "string") {
        return { content: delta.content };
      }

      // message 中的 reasoning（某些模型放在 message 而非 delta）
      if (typeof message?.reasoning === "string") {
        return { reasoning: message.reasoning };
      }
      if (typeof message?.reasoning_content === "string") {
        return { reasoning: message.reasoning_content };
      }
      if (typeof message?.content === "string") {
        return { content: message.content };
      }
    }

    return {};
  } catch {
    // JSON 解析失败 → 将原始文本作为纯文本 content 处理（兼容非 JSON 流）
    return { content: payload };
  }
};

// ─── AI 服务 API ───

export const aiService = {
  /**
   * 获取 AI 属性（模型）列表。
   * 固定 page size = 100，一次性拉取所有可用模型。
   */
  getAiProperties: (params?: GetAiPropertiesParams) => {
    return service.get<AiPropertiesPageResult>("/xunzhi/v1/ai-properties", {
      params: {
        ...params,
        size: 100,
      },
    });
  },

  /**
   * 分页获取用户的对话会话列表。
   */
  getConversations: (params?: GetConversationsParams) => {
    return service.get<AiConversationsPageResult>(
      "/xunzhi/v1/ai/conversations",
      {
        params,
      },
    );
  },

  /**
   * 获取指定会话的完整历史消息。
   * @param signal - 可选 AbortSignal，用于在组件卸载或路由切换时取消请求
   */
  getConversationHistory: (sessionId: string, signal?: AbortSignal) => {
    return service.get<AiMessageHistoryListResult>(
      `/xunzhi/v1/ai/history/${sessionId}`,
      signal ? { signal } : undefined,
    );
  },

  /**
   * 分页获取指定会话的历史消息（支持滚动分页加载更多）。
   */
  pageHistoryMessages: (params: GetHistoryMessagesPageParams) => {
    return service.get<AiMessageHistoryPageResult>(
      "/xunzhi/v1/ai/history/page",
      {
        params,
      },
    );
  },

  /**
   * 创建新的对话会话。
   */
  createConversation: (data: CreateConversationParams) => {
    return service.post<CreateConversationResponse>(
      "/xunzhi/v1/ai/conversations",
      data,
    );
  },

  /**
   * 删除指定对话会话。
   */
  deleteConversation: (sessionId: string) => {
    return service.delete<null>(
      `/xunzhi/v1/ai/conversations/${encodeURIComponent(sessionId)}`,
    );
  },

  /**
   * SSE 流式对话 —— 使用 fetchEventSource 发起 POST 请求，
   * 通过回调实时接收服务端推送的文本/推理增量。
   *
   * @param params  - 会话 ID、用户消息、模型 ID、消息序号、图片/媒体等
   * @param signal  - AbortSignal，用于取消流式请求
   * @param callbacks - onMessage（正文增量）/ onReasoning（推理增量）/ onDone / onError
   *
   * 流程：
   * 1. 拼接请求 URL（含 username query 参数）
   * 2. 从 localStorage 获取 Token 注入 Authorization 头
   * 3. 通过 fetchEventSource 建立 SSE 连接
   * 4. 每个 onmessage 事件调用 parseAiStreamChunk 解析增量数据
   * 5. 连接关闭或异常时触发 onDone / onError
   */
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

    // 拼接 SSE 请求 URL
    const url = buildApiUrl(
      `/xunzhi/v1/ai/sessions/${encodeURIComponent(sessionId)}/chat`,
      {
        username: userName,
      },
    );

    // 获取 Token 用于 Authorization 头
    const token = assertRequestAuthorized(
      `/xunzhi/v1/ai/sessions/${encodeURIComponent(sessionId)}/chat`,
    );

    /** 是否已收到结束信号（防止 onclose 后重复触发 onDone） */
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
      // 页面不可见时仍保持连接（支持后台持续接收）
      openWhenHidden: true,

      /**
       * 连接打开回调 —— 校验 HTTP 状态码。
       * 4xx（非 429）视为客户端错误直接抛出；
       * 5xx 视为服务端错误。
       */
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

      /**
       * 接收到 SSE 消息时的回调。
       * 1. 先判断 SSE 事件名是否为结束信号（如 "done"、"[DONE]"）
       * 2. 解析 data 字段，提取 content / reasoning / done
       * 3. 分别回调 onReasoning 和 onMessage
       */
      onmessage(msg) {
        // 事件名级别判断结束（如 event: done）
        if (
          isDoneStreamEvent(msg.event) ||
          msg.data.trim().toUpperCase() === "[DONE]"
        ) {
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

      /**
       * 连接关闭回调。
       * 若非正常结束（未收到 done 信号），补发 onDone 避免 UI 卡在 streaming 状态。
       */
      onclose() {
        if (!isComplete) {
          callbacks.onDone?.();
        }
        throw new Error("Connection closed");
      },

      /** 连接错误回调 —— 直接向上层透传错误 */
      onerror(err) {
        callbacks.onError?.(err);
        throw err;
      },
    });
  },
};
