/**
 * @file 对话运行时共享工具函数与类型定义
 *
 * 本文件提供聊天页面（ChatPage）运行时所需的共享类型、常量和工具函数，
 * 被 chatRuntime 体系中的其他模块（如 ChatPageController、ChatSendFlow）共同引用。
 * 职责定位：纯数据转换 / 纯工具函数，不涉及任何 React Hooks 或组件状态。
 */

import { CHAT_ROLES, ROUTES } from "@/lib/constants";
import { CHAT_MESSAGE_STATUS, type ChatMessage } from "@/lib/chat";
import type { AiMessageHistory, AiProperty } from "@/types/ai";

/**
 * 通过 React Router 的 location.state 传递到聊天页面的可选项参数。
 *
 * - `initialQuery`：用户从其他页面跳转时携带的预填问题文本（如在首页直接输入后跳转）。
 * - `model`：用户指定的初始 AI 模型（如从首页模型选择器带入），
 *   若为 null 或省略则使用默认模型。
 */
export type ChatPageLocationState = {
  initialQuery?: string;
  model?: AiProperty | null;
};

/** 历史会话列表加载时的占位提示文本。 */
export const CHAT_HISTORY_LOADING_TITLE = "正在加载会话...";

/**
 * SSE 流式消息处理异常时的用户可见错误提示。
 * 当 fetchEventSource 连接中断或数据解析失败时展示。
 */
export const CHAT_STREAM_ERROR_TEXT = "消息流处理中断，请稍后重试或重新发送。";

/**
 * 根据会话 ID 构建聊天页面的路由路径。
 *
 * 使用 encodeURIComponent 编码 sessionId 以防止特殊字符破坏 URL 结构。
 *
 * @param sessionId - 后端返回的会话唯一标识
 * @returns 形如 `/chat/{sessionId}` 的完整路由路径
 */
export const buildChatSessionPath = (sessionId: string) =>
  `${ROUTES.chat}/${encodeURIComponent(sessionId)}`;

/**
 * 规范化从 location.state 中读取的 initialQuery 值。
 *
 * 由于 location.state 的类型在运行时不可靠（可能为用户传入的任意值），
 * 函数先进行类型守卫再 trim，确保返回规范的字符串或 null。
 *
 * @param value - 从路由状态中取出的原始 initialQuery
 * @returns 修剪后的非空字符串，若输入非法或为空则返回 null
 */
export const normalizeInitialQuery = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * 将后端返回的历史消息记录（AiMessageHistory）转换为前端统一的消息模型（ChatMessage）。
 *
 * 转换逻辑：
 * - 空值 / undefined 输入安全处理为 []
 * - `messageType === 1` 映射为用户消息，否则为 AI 助手消息
 * - 将 reasoningContent（推理过程）附加到消息对象中（可选字段）
 * - 将后端字符串时间转换为时间戳数字，缺失时兜底 Date.now()
 * - 若后端标记了 errorMessage，则将消息状态设为 error
 * - 最后按时间戳升序排列，确保消息顺序正确
 *
 * @param messages - 后端返回的历史消息列表（可能为 null / undefined）
 * @returns 排序后的前端 ChatMessage 数组
 */
export const normalizeHistoryMessages = (
  messages: AiMessageHistory[] | null | undefined,
): ChatMessage[] => {
  return (messages ?? [])
    .map((message) => ({
      id: message.id,
      role: message.messageType === 1 ? CHAT_ROLES.user : CHAT_ROLES.assistant,
      content: message.messageContent,
      reasoning: message.reasoningContent || undefined,
      timestamp: new Date(message.createTime || Date.now()).getTime(),
      status: message.errorMessage
        ? CHAT_MESSAGE_STATUS.error
        : CHAT_MESSAGE_STATUS.done,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
};

/**
 * 生成运行时消息的唯一 ID。
 *
 * 组合策略：前缀 + 时间戳（毫秒精度）+ 随机字符串（6 位 base-36），
 * 在单次运行时中保证唯一性，同时通过前缀标识消息来源（如 "user"、"assistant"）。
 *
 * @param prefix - 消息来源标识前缀，用于在调试 / 日志中区分消息类型
 * @returns 形如 `user-1718400000000-a3b2c1` 的唯一 ID 字符串
 */
export const createRuntimeMessageId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
