import { useCallback, useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { useModelList } from "@/hooks/useModelList";
import { useChatHistoryLoader } from "@/hooks/chat/useChatHistoryLoader";
import { useChatRouteState } from "@/hooks/chat/useChatRouteState";
import { useChatSendFlow } from "@/hooks/chat/useChatSendFlow";
import {
  finishStartingNewChatSession,
  resetChatRuntime,
} from "@/store/slices/chatSlice";

/**
 * 聊天页面主控制器 —— 将路由状态、对话发送、历史加载、模型选择、输入框状态
 * 整合为统一的页面级接口，供 ChatPage 组件直接消费。
 *
 * 职责划分：
 * - useChatRouteState      → 从 URL 解析 sessionId / initialQuery / initialModel
 * - useChatSendFlow        → 消息列表、流式状态、sendMessage / cancelActiveStream
 * - useModelList           → 可用模型列表 + 当前选中模型（initialModel 作为默认值）
 * - useChatHistoryLoader   → 按 routeSessionId 加载历史消息（含会话有效性校验）
 *
 * 关键副作用：
 * 1. 当 Redux 中的 currentSessionId 与 URL 不一致时，自动重定向到当前运行时会话
 * 2. 当 URL 携带 initialQuery 时，自动触发一次发送（"新会话首条消息"）
 */
export function useChatPageController() {
  const dispatch = useAppDispatch();

  // ─── 从 URL 中解析路由状态 ───
  const {
    routeSessionId, // URL 中的会话 ID（可能为空，表示新会话）
    initialQuery, // URL query 参数中的预设问题
    initialModel, // URL query 参数中的预设模型
    hasPendingInitialQuery, // 是否存在尚未发送的 initialQuery
    shouldRedirectToRuntimeSession, // 是否需要重定向到 Redux 中的 currentSessionId
    locationKey, // 路由 key（用于判断是否为同一次导航）
    navigateToSession, // 跳转到指定会话页
    navigateToChatRoot, // 跳转到聊天根路径
  } = useChatRouteState();

  // ─── 对话发送流程（消息列表、流式状态、发送/取消） ───
  const { messages, isStreaming, sendMessage, cancelActiveStream } =
    useChatSendFlow({
      routeSessionId, // URL 会话 ID —— sendMessage 内部用其判断是否需要新建会话
      navigateToSession, // 新建会话成功后调用，将 URL 替换为带 sessionId 的路径
    });

  // ─── 模型选择（initialModel 作为初始默认值） ───
  const { selectedModel, setSelectedModel, models } =
    useModelList(initialModel);

  // ─── 历史消息加载 ───
  const { isHistoryLoading } = useChatHistoryLoader({
    routeSessionId, // 要加载的会话 ID
    hasPendingInitialQuery, // 有 pending query 时暂停加载，避免与发送竞态
    cancelActiveStream, // 加载历史时取消当前流式请求
    navigateToChatRoot, // 会话不存在时跳转回根路径
  });

  // ─── 输入框状态（完全由本 Hook 托管） ───
  const [input, setInput] = useState("");

  /**
   * 防止同一 initialQuery 被重复发送的标记。
   * 存储已处理过的 locationKey，当路由 key 变化时才允许再次触发发送。
   */
  const handledInitialQueryKeyRef = useRef<string | null>(null);

  // Redux 中的当前运行时会话 ID（与 URL 中的 sessionId 可能不同）
  const { currentSessionId, isStartingNewSession } = useAppSelector(
    (state) => state.chat,
  );

  /** 新建会话过渡完成：URL 已到 /chat 且 runtime 已清空，再清除标志 */
  useEffect(() => {
    if (!routeSessionId && isStartingNewSession && !currentSessionId) {
      dispatch(finishStartingNewChatSession());
    }
  }, [currentSessionId, dispatch, isStartingNewSession, routeSessionId]);

  /**
   * 重定向同步：
   * 当 Redux 中已有运行时会话（currentSessionId），但 URL 路径与之不匹配时，
   * 自动将浏览器地址栏替换为当前会话的路径。
   *
   * 典型场景：用户在首页直接发送消息，聊天页新建会话后 URL 需要从 /chat 变为 /chat/:sessionId
   */
  useEffect(() => {
    if (!shouldRedirectToRuntimeSession || !currentSessionId) {
      return;
    }

    navigateToSession(currentSessionId, {
      replace: true, // replace 而非 push，避免浏览器回退时重新触发此逻辑
    });
  }, [currentSessionId, navigateToSession, shouldRedirectToRuntimeSession]);

  /**
   * 初始查询自动发送：
   * 当 URL 携带 initialQuery 且为新的 locationKey 时，自动发起一次对话请求。
   *
   * 触发条件：
   * 1. initialQuery 非空
   * 2. 该 locationKey 尚未被处理过（通过 handledInitialQueryKeyRef 去重）
   * 3. 已确定可用的模型 ID（优先 initialModel.id，其次 selectedModel.id）
   *
   * 发送前会重置聊天运行时状态（清空旧消息），并以 forceNewSession 强制创建新会话。
   */
  useEffect(() => {
    // initialQuery 为空时清除已处理标记，以便下次进入时能正常触发
    if (!initialQuery) {
      handledInitialQueryKeyRef.current = null;
      return;
    }

    // 同一个 locationKey 只处理一次，避免 React 严格模式或重渲染导致重复发送
    if (handledInitialQueryKeyRef.current === locationKey) {
      return;
    }

    // 优先使用 URL 指定的模型，否则回退到当前选中模型
    const initialModelId = initialModel?.id ?? selectedModel?.id;
    if (initialModelId === undefined || initialModelId === null) {
      return;
    }

    handledInitialQueryKeyRef.current = locationKey;
    // 清空当前聊天运行时（消息列表、流式状态等），为新会话做准备
    dispatch(resetChatRuntime());
    // 发送首条消息，forceNewSession 确保创建全新会话
    void sendMessage(initialQuery, initialModelId, {
      forceNewSession: true,
    });
  }, [
    dispatch,
    initialModel,
    initialQuery,
    locationKey,
    selectedModel,
    sendMessage,
  ]);

  /**
   * 输入框是否应被锁定 —— 流式响应进行中或历史消息加载中时禁止发送新消息。
   */
  const isComposerBlocked = isStreaming || isHistoryLoading;

  /**
   * 用户点击发送 / 按下回车时的处理函数。
   * 1. 空输入或发送被锁定时不响应
   * 2. 清空输入框
   * 3. 调用 sendMessage 发送消息
   */
  const handleSend = useCallback(() => {
    const nextInput = input.trim();
    if (!nextInput || isComposerBlocked) {
      return;
    }

    setInput("");
    void sendMessage(nextInput, selectedModel?.id);
  }, [input, isComposerBlocked, selectedModel, sendMessage]);

  // ─── 返回值按领域分组，方便调用方（ChatPage）按需解构 ───
  return {
    /** 历史消息相关状态 */
    history: {
      messages, // 当前会话的消息列表
      isLoading: isHistoryLoading, // 历史消息是否正在加载中
    },
    /** 输入框相关状态与操作 */
    composer: {
      input, // 输入框文本
      setInput, // 更新输入框文本
      isBlocked: isComposerBlocked, // 输入框是否锁定
      handleSend, // 发送操作
    },
    /** 模型选择相关状态 */
    modelSelection: {
      models, // 可用模型列表
      selectedModel, // 当前选中模型
      setSelectedModel, // 切换模型
    },
  };
}
