/**
 * useSSEStream - 基于 EventSource 的 SSE（Server-Sent Events）流式数据 Hook
 *
 * 用途：
 *   通过浏览器原生 EventSource API 连接 SSE 端点，接收服务端推送的流式数据，
 *   逐 token 解析并回调给调用方，适用于 AI 对话流式输出、实时通知等场景。
 *
 * 设计要点：
 *   - 每次调用 start() 会自动关闭前一个连接，确保同一时间只有一个 SSE 连接
 *   - 通过 useRef 持有 EventSource 实例，避免闭包过期问题
 *   - 通过 useCallback 稳定 start / stop 引用，减少子组件不必要重渲染
 *   - 解析 [DONE] 信号和 JSON 格式的 done 标记两种结束方式
 *
 * 注意：
 *   本 Hook 基于原生 EventSource（仅支持 GET 请求）。
 *   项目中 AI/Agent 对话的实际 SSE 流式请求使用 @microsoft/fetch-event-source
 *   （支持 POST 请求），由 chatSlice 通过 appendAssistantChunk 增量更新消息。
 *   此 Hook 适用于简单的 GET SSE 场景。
 */

import { useCallback, useRef, useState } from "react";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * StreamHandlers - SSE 流事件回调集合
 *
 * 每个回调均为可选，调用方按需传入：
 *   - onOpen:  SSE 连接成功建立时触发
 *   - onToken: 收到新的文本 token 时触发，传入解析后的 token 字符串
 *   - onDone:  流式传输完成（收到 [DONE] 或 done:true 标记）时触发
 *   - onError: 连接发生错误时触发，传入 Error 对象
 */
type StreamHandlers = {
  onOpen?: () => void;
  onToken?: (token: string) => void;
  onDone?: () => void;
  onError?: (error: Error) => void;
};

// ============================================================================
// 工具函数
// ============================================================================

/**
 * parseToken - 解析 SSE 事件数据
 *
 * 处理服务端返回的三种可能格式：
 *   1. "[DONE]" 字符串        → 标记流结束（OpenAI 风格协议）
 *   2. JSON { token, done }   → 标准结构化响应，done 为 true 时流结束
 *   3. 纯文本 token            → 直接作为 token 返回（兜底处理）
 *
 * @param data - SSE event.data 原始字符串
 * @returns { done: boolean; token: string }
 *   - done: 是否到达流末尾
 *   - token: 解析出的文本片段（done 为 true 时 token 为空字符串）
 */
const parseToken = (data: string) => {
  // 收到 [DONE] 标记，流式输出结束
  if (data === "[DONE]") {
    return { done: true, token: "" };
  }
  try {
    // 尝试按 JSON 解析，提取 token 和 done 字段
    const parsed = JSON.parse(data) as { token?: string; done?: boolean };
    return { done: Boolean(parsed.done), token: parsed.token ?? data };
  } catch {
    // JSON 解析失败，将原始数据作为 token 返回（兼容纯文本 SSE）
    return { done: false, token: data };
  }
};

// ============================================================================
// useSSEStream Hook
// ============================================================================

/**
 * useSSEStream - 创建和管理 SSE 连接的 React Hook
 *
 * 使用示例：
 * ```tsx
 * const { start, stop, isStreaming } = useSSEStream();
 *
 * // 开始接收流
 * start("/api/stream/chat?message=hello", {
 *   onOpen: () => console.log("连接已建立"),
 *   onToken: (token) => setText(prev => prev + token),
 *   onDone: () => console.log("流式传输完成"),
 *   onError: (err) => console.error(err),
 * });
 *
 * // 主动停止
 * stop();
 * ```
 *
 * @returns { start, stop, isStreaming }
 *   - start:      启动 SSE 连接（传入 URL 和可选的 StreamHandlers 回调）
 *   - stop:       关闭当前 SSE 连接并重置状态
 *   - isStreaming: 当前是否正在接收流式数据
 */
export default function useSSEStream() {
  // ==========================================================================
  // 内部状态
  // ==========================================================================

  /**
   * sourceRef - 持有当前 EventSource 实例的引用
   *
   * 为什么用 useRef 而非 useState：
   *   EventSource 实例不需要触发重渲染，用 ref 可以避免闭包问题，
   *   确保 stop() 始终能关闭当前活跃的连接。
   */
  const sourceRef = useRef<EventSource | null>(null);

  /**
   * isStreaming - 当前流式连接状态
   *
   * 用于 UI 层面的加载状态展示（如显示/隐藏 loading 动画、禁用发送按钮等）。
   * start 时设为 true，stop 或连接出错时设为 false。
   */
  const [isStreaming, setIsStreaming] = useState(false);

  // ==========================================================================
  // 操作方法
  // ==========================================================================

  /**
   * stop - 停止当前 SSE 连接
   *
   * 操作：
   *   1. 关闭并释放 EventSource 实例（如果存在）
   *   2. 将 isStreaming 状态重置为 false
   *
   * 安全性：
   *   sourceRef.current 为空时跳过关闭操作（幂等），可安全重复调用。
   * 引用稳定性：
   *   无外部依赖（空数组），引用永不变化。
   */
  const stop = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  /**
   * start - 启动 SSE 连接
   *
   * @param url      - SSE 端点 URL（仅支持 GET，查询参数需拼接在 URL 中）
   * @param handlers - 可选的事件回调对象（onOpen / onToken / onDone / onError）
   *
   * 执行流程：
   *   1. 先调用 stop() 关闭前一个连接（确保同时只有一个 SSE 连接）
   *   2. 创建新的 EventSource 并存入 sourceRef
   *   3. 注册 onopen / onmessage / onerror 事件处理器
   *   4. 收到消息时通过 parseToken 解析数据，根据结果分发到对应回调
   *   5. 连接出错时自动触发 stop() 清理状态
   *
   * 终止条件（触发 onDone + stop）：
   *   - 收到 [DONE] 信号
   *   - 收到 JSON 中 done: true
   *   - 连接发生错误（触发 onError）
   */
  const start = useCallback(
    (url: string, handlers?: StreamHandlers) => {
      // 先关闭已有连接，保证单一连接
      stop();

      // 创建新的 EventSource 连接
      const source = new EventSource(url);
      sourceRef.current = source;
      setIsStreaming(true);

      // 连接建立成功
      source.onopen = () => {
        handlers?.onOpen?.();
      };

      // 收到服务端推送的消息
      source.onmessage = (event) => {
        const { done, token } = parseToken(event.data);

        if (done) {
          // 流式输出结束：通知调用方 → 清理连接
          handlers?.onDone?.();
          stop();
          return;
        }

        if (token) {
          // 正常 token：逐字/逐段传递给调用方
          handlers?.onToken?.(token);
        }
      };

      // 连接发生错误
      source.onerror = () => {
        handlers?.onError?.(new Error("SSE 连接失败"));
        stop();
      };
    },
    [stop],
  );

  // ==========================================================================
  // 返回值
  // ==========================================================================

  /**
   * 返回给调用方的 API：
   *   - start(url, handlers): 启动 SSE 连接
   *   - stop():              关闭 SSE 连接
   *   - isStreaming:          当前流状态（boolean）
   */
  return { start, stop, isStreaming };
}
