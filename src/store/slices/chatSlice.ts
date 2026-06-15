/**
 * 聊天运行时 Slice —— 管理消息列表、SSE 流式状态、会话信息的运行时状态。
 *
 * ## 设计定位
 *
 * 本 Slice 管理的是聊天页面的"运行时"状态，特点：
 * - 消息列表是实时变化的（SSE 逐字追加，每 40ms 一次）
 * - 生命周期与聊天会话绑定（切换会话时重置）
 * - 不与服务端缓存绑定（消息列表不由 React Query 管理）
 *
 * 与之对照：侧边栏的会话列表属于"服务端缓存"，由 React Query 管理，
 * 仅在创建新会话或删除会话时通过 invalidateQueries 刷新。
 *
 * ## 关键状态字段
 *
 * - messages：当前会话的消息列表（用户消息 + AI 消息）
 * - isStreaming：是否有 SSE 流式响应正在进行
 * - currentSessionId / currentSessionTitle：当前活跃的会话标识
 * - pendingOutbound：新建会话后等待路由同步的待发送消息
 *   （创建会话 → URL 更新需要时间，期间消息暂存于此，URL 同步后自动发送）
 * - activeStream*：当前活跃的 SSE 流追踪信息
 *   （requestId 用于竞态判断，sessionId/messageId 用于 UI 展示）
 * - isStartingNewSession：新建会话的过渡标志
 *   （屏蔽过渡期间的历史重载和运行时重定向）
 *
 * ## Reducer 命名约定
 *
 * - reset*：完全重置（清空所有状态回初始值）
 * - begin* / finish*：过渡状态开关（成对出现）
 * - set*：赋值操作（覆盖单个或少量字段）
 * - append*：追加操作（向数组或字符串追加）
 * - hydrate*：水合操作（从外部数据源批量填充状态）
 * - finish* / fail*：终态标记（流式完成 / 流式失败）
 */

import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ChatMessage } from "@/lib/chat";
import { checkAuthStatus, logoutUser } from "@/store/slices/userSlice";

// ─── 类型定义 ───

/**
 * 待发送消息的元信息。
 *
 * 用于"新建会话 → 等路由同步 → 再发 SSE 请求"的异步编排：
 * 1. sendMessage 调用 createConversation 创建会话
 * 2. 将消息信息存入 pendingOutbound（不直接发送）
 * 3. 路由同步到新 sessionId 后，由 useChatSendFlow 的 useEffect 消费并发送
 */
export interface PendingOutbound {
  /** 本次请求的唯一标识（用于竞态控制） */
  requestId: string;
  /** 目标会话 ID */
  sessionId: string;
  /** 已插入消息列表的 assistant 占位消息 ID（流式 chunk 需要追加到此消息） */
  assistantMessageId: string;
  /** 用户输入的原始内容 */
  content: string;
  /** 选中的 AI 模型 ID（可选） */
  aiId?: number;
}

/** 聊天运行时的完整状态 */
export interface ChatState {
  /** 当前会话的消息列表 */
  messages: ChatMessage[];
  /** SSE 流式响应是否正在进行 */
  isStreaming: boolean;
  /** 最近的错误消息（用于 UI 展示错误提示） */
  error: string | null;
  /** 当前会话 ID */
  currentSessionId: string | null;
  /** 当前会话标题 */
  currentSessionTitle: string | null;
  /** 新建会话后等待路由同步的待发送消息，路由就绪后自动发送 */
  pendingOutbound: PendingOutbound | null;
  /** 当前活跃 SSE 流的请求 ID（用于竞态判断） */
  activeStreamRequestId: string | null;
  /** 当前活跃 SSE 流的会话 ID */
  activeStreamSessionId: string | null;
  /** 当前活跃 SSE 流对应的 assistant 消息 ID */
  activeStreamMessageId: string | null;
  /** 正在切换到空白新会话，过渡期间禁止历史重载与运行时重定向 */
  isStartingNewSession: boolean;
}

// ─── 初始状态 ───

export const initialState: ChatState = {
  messages: [],
  isStreaming: false,
  error: null,
  currentSessionId: null,
  currentSessionTitle: null,
  pendingOutbound: null,
  activeStreamRequestId: null,
  activeStreamSessionId: null,
  activeStreamMessageId: null,
  isStartingNewSession: false,
};

// ─── 工具函数 ───

/**
 * 将状态重置为初始值。
 *
 * 提取为独立函数以便在多个地方复用：
 * - resetChatRuntime reducer（用户主动重置）
 * - extraReducers（登出/Token 过期时级联清理）
 * - beginNewChatSession reducer（新建会话过渡）
 */
const resetRuntimeState = (state: ChatState) => {
  state.messages = [];
  state.isStreaming = false;
  state.error = null;
  state.currentSessionId = null;
  state.currentSessionTitle = null;
  state.pendingOutbound = null;
  state.activeStreamRequestId = null;
  state.activeStreamSessionId = null;
  state.activeStreamMessageId = null;
  state.isStartingNewSession = false;
};

// ─── Slice 定义 ───

export const chatSlice = createSlice({
  name: "chat",
  initialState,
  reducers: {
    // ═══ 运行时生命周期 ═══

    /** 完全重置聊天运行时（新建对话、加载失败等场景） */
    resetChatRuntime: (state) => {
      resetRuntimeState(state);
    },

    /**
     * 开始新建对话过渡。
     *
     * 先清空 runtime 再设置过渡标志。过渡标志用于屏蔽两种竞态：
     * 1. 旧 URL 下误触发历史重载（reset 先于 navigate 的窗口期）
     * 2. /chat 下 shouldRedirectToRuntimeSession 跳回旧会话
     *
     * URL 同步到 /chat 后由 useChatPageController 调用 finishStartingNewChatSession 清除标志。
     */
    beginNewChatSession: (state) => {
      resetRuntimeState(state);
      state.isStartingNewSession = true;
    },

    /** 清除新建对话过渡标志（URL 已同步到 /chat 且 runtime 已清空后调用） */
    finishStartingNewChatSession: (state) => {
      state.isStartingNewSession = false;
    },

    // ═══ 会话设置 ═══

    /**
     * 设置当前运行时会话信息。
     *
     * 与 hydrateChatSession 的区别：不操作消息列表（用于新建会话场景）。
     */
    setChatRuntimeSession: (
      state,
      action: PayloadAction<{ sessionId: string; title: string }>,
    ) => {
      state.currentSessionId = action.payload.sessionId;
      state.currentSessionTitle = action.payload.title;
      state.error = null;
    },

    /**
     * 水合会话：将服务端返回的历史消息和会话信息批量写入 Redux。
     *
     * 除了填充消息列表，还会清理所有流式相关状态（isStreaming、pendingOutbound 等），
     * 确保从历史会话加载回来的状态是干净的。
     */
    hydrateChatSession: (
      state,
      action: PayloadAction<{
        sessionId: string;
        title: string;
        messages: ChatMessage[];
      }>,
    ) => {
      state.currentSessionId = action.payload.sessionId;
      state.currentSessionTitle = action.payload.title;
      state.messages = action.payload.messages;
      state.error = null;
      state.isStreaming = false;
      state.pendingOutbound = null;
      state.activeStreamRequestId = null;
      state.activeStreamSessionId = null;
      state.activeStreamMessageId = null;
    },

    // ═══ 发送流程编排 ═══

    /**
     * 设置待发送消息。
     *
     * 新建会话后不直接发送 SSE 请求，而是先将消息信息存为 pendingOutbound，
     * 等路由同步到新 sessionId 后由 useChatSendFlow 的 useEffect 消费。
     *
     * 传入 null 可清除已消费或已废弃的 pending 消息。
     */
    setPendingOutbound: (
      state,
      action: PayloadAction<PendingOutbound | null>,
    ) => {
      state.pendingOutbound = action.payload;
    },

    // ═══ 消息操作 ═══

    /** 向消息列表追加用户消息（乐观更新，不等服务端确认） */
    appendUserMessage: (state, action: PayloadAction<ChatMessage>) => {
      state.messages.push(action.payload);
      state.error = null;
    },

    /** 向消息列表追加 AI 助手占位消息（content 为空，状态为 streaming） */
    appendAssistantPlaceholder: (state, action: PayloadAction<ChatMessage>) => {
      state.messages.push(action.payload);
      state.error = null;
    },

    /**
     * 增量追加 AI 消息正文内容。
     *
     * SSE 每次回调传入的 chunk 是累加后的完整文本（后端模式），
     * 因此直接覆盖 message.content 即可，不需要字符串拼接。
     *
     * 通过 TextStreamLimiter 控制前端渲染速率（40ms 间隔，每次 12 字符），
     * 所以用户体验上仍是逐字出现的效果。
     */
    appendAssistantChunk: (
      state,
      action: PayloadAction<{ id: string; content: string }>,
    ) => {
      const message = state.messages.find(
        (item) => item.id === action.payload.id,
      );
      if (!message) {
        return; // 消息已被移除（如切换会话时清空了消息列表）
      }
      message.content = action.payload.content;
      message.status = "streaming";
    },

    /**
     * 增量追加 AI 推理过程内容。
     *
     * 与 appendAssistantChunk 机制相同，但写入的是 reasoning 字段。
     * 推理内容在 UI 上以可折叠面板展示，区别于正文。
     */
    appendAssistantReasoningChunk: (
      state,
      action: PayloadAction<{ id: string; reasoning: string }>,
    ) => {
      const message = state.messages.find(
        (item) => item.id === action.payload.id,
      );
      if (!message) {
        return;
      }
      message.reasoning = action.payload.reasoning;
      message.status = "streaming";
    },

    /**
     * 将 AI 助手消息标记为完成状态。
     *
     * SSE 流正常结束时（onDone 回调）调用。之后消息气泡不再显示加载动画。
     */
    finishAssistantMessage: (state, action: PayloadAction<{ id: string }>) => {
      const message = state.messages.find(
        (item) => item.id === action.payload.id,
      );
      if (!message) {
        return;
      }
      message.status = "done";
    },

    /**
     * 将 AI 助手消息标记为错误状态。
     *
     * 如果消息正文为空（流式尚未产生任何内容就断开），则填入错误提示文本，
     * 确保 UI 上始终有可读的错误信息而非空白气泡。
     */
    failAssistantMessage: (
      state,
      action: PayloadAction<{ id: string; errorMessage: string }>,
    ) => {
      const message = state.messages.find(
        (item) => item.id === action.payload.id,
      );
      if (!message) {
        return;
      }
      if (!message.content.trim()) {
        message.content = action.payload.errorMessage;
      }
      message.status = "error";
      state.error = action.payload.errorMessage;
    },

    // ═══ 流式追踪 ═══

    /**
     * 设置当前活跃的 SSE 流追踪信息。
     *
     * 传入 action payload → 设置追踪字段（isStreaming = true）
     * 传入 null → 清除所有追踪字段（isStreaming = false）
     *
     * activeStreamRequestId 是竞态控制的核心：
     * - useChatSendFlow 中每个回调通过 isActiveRequest() 比较 requestId，
     *   确保只有最新请求的回调才写入 Redux，旧请求的回调数据被丢弃。
     */
    setActiveStream: (
      state,
      action: PayloadAction<{
        requestId: string;
        sessionId: string;
        messageId: string;
      } | null>,
    ) => {
      state.isStreaming = Boolean(action.payload);
      state.activeStreamRequestId = action.payload?.requestId ?? null;
      state.activeStreamSessionId = action.payload?.sessionId ?? null;
      state.activeStreamMessageId = action.payload?.messageId ?? null;
    },
  },

  /**
   * extraReducers：响应跨 Slice 的 action。
   *
   * 监听 userSlice 的认证相关 thunk：
   * - checkAuthStatus 失败且需要清除认证 → 清空聊天运行时
   * - logoutUser 成功 → 清空聊天运行时
   *
   * 确保登出 / Token 过期后，聊天页不会残留上一个用户的敏感数据。
   */
  extraReducers: (builder) => {
    builder
      .addCase(checkAuthStatus.rejected, (state, action) => {
        if (!action.payload?.shouldClearAuth) {
          return;
        }
        resetRuntimeState(state);
      })
      .addCase(logoutUser.fulfilled, (state) => {
        resetRuntimeState(state);
      });
  },
});

// ─── 导出 ───

export const {
  resetChatRuntime,
  beginNewChatSession,
  finishStartingNewChatSession,
  setChatRuntimeSession,
  hydrateChatSession,
  setPendingOutbound,
  appendUserMessage,
  appendAssistantPlaceholder,
  appendAssistantChunk,
  appendAssistantReasoningChunk,
  finishAssistantMessage,
  failAssistantMessage,
  setActiveStream,
} = chatSlice.actions;

export default chatSlice.reducer;
