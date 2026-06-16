/**
 * audioToTextWs - 语音转写 WebSocket 客户端
 *
 * ## 文件概览
 *
 * 本文件导出 `AudioToTextWebSocket` 类，封装与后端语音转写服务的 WebSocket 通信。
 * 负责建立连接、发送音频二进制数据、接收增量转写结果、心跳保活及消息去重。
 *
 * ## 在系统中的位置
 *
 *   麦克风采集 (AudioWorklet)
 *       │  PCM / WAV Blob
 *       ▼
 *   AudioToTextWebSocket  ◀── 本文件
 *       │  JSON 消息（转写结果）
 *       ▼
 *   resolveAudioTranscriptionEvent()  ── lib/audioTranscription.ts
 *       │  转换为 AudioTranscriptionEvent
 *       ▼
 *   reduceAudioTranscriptionState()   ── lib/audioTranscription.ts
 *       │  驱动 liveText / finalText 状态机
 *       ▼
 *   useAudioTranscription Hook        ── hooks/audio/
 *       │
 *       ▼
 *   UI 组件（实时字幕、面试答题框等）
 *
 * ## 关键设计
 *
 *   - 心跳保活：每 15 秒发送 ping 命令，防止代理/防火墙断开空闲连接
 *   - 连接中排队：WebSocket 处于 CONNECTING 状态时，音频 chunk 入队（最多 24 个），
 *     连接建立后批量发送，避免音频数据丢失
 *   - 消息去重：基于 timestamp + (kind:type:text) 组合 key 过滤重复消息，
 *     防止后端重传导致转写文本错乱
 *   - 异常隔离：连接未就绪时关闭（code !== 1000），通过 onError 通知调用方
 */

import { getAuthToken } from "@/lib/authToken";
import {
  resolveApiBaseUrl,
  resolveRuntimeWsBaseUrl,
  resolveWsBaseUrl,
} from "@/config/env";
import {
  resolveAudioTranscriptionEvent,
  type AudioToTextIncomingMessage,
} from "@/lib/audioTranscription";

// ============================================================================
// AudioToTextWebSocket 类
// ============================================================================

export class AudioToTextWebSocket {
  // ==========================================================================
  // 私有字段 —— 连接与生命周期
  // ==========================================================================

  /** 原生 WebSocket 实例，null 表示未连接或已断开 */
  private ws: WebSocket | null = null;

  /** 完整的 WebSocket 连接 URL（含 path + token 查询参数） */
  private url: string;

  /** 心跳定时器 ID，用于周期性发送 ping 保持连接活跃 */
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  /** 连接是否曾经成功打开过（用于 onclose 中判断异常断开） */
  private hasOpened = false;

  // ==========================================================================
  // 私有字段 —— 音频数据排队（连接建立前的缓冲）
  // ==========================================================================

  /**
   * 待发送的二进制音频队列
   *
   * 当 WebSocket 处于 CONNECTING 状态时，sendAudio() 无法立即发送数据，
   * 需要将音频 chunk 暂存于此队列中，等待 onopen 事件触发后批量发送。
   */
  private pendingBinaryQueue: Array<ArrayBuffer | Blob> = [];

  /**
   * 队列最大容量
   *
   * 限制排队 chunk 数量，防止连接长时间未建立时内存无限增长。
   * 队列满时采用滑动窗口策略：移除最旧的 chunk，追加新 chunk。
   */
  private readonly maxPendingBinaryChunks = 24;

  // ==========================================================================
  // 私有字段 —— 消息去重
  // ==========================================================================

  /**
   * 上一条已应用消息的时间戳
   *
   * 与 lastMessageKey 配合实现基于 timestamp 的去重：
   *   - 新消息 timestamp < 此值 → 丢弃（乱序到达的旧消息）
   *   - 新消息 timestamp === 此值且 key 相同 → 丢弃（重复消息）
   */
  private lastMessageTimestamp = 0;

  /**
   * 上一条已应用消息的去重 key
   *
   * 格式：`${event.kind}:${message.type}:${text}`
   * 用于识别同一条消息的多次投递。
   */
  private lastMessageKey: string | null = null;

  // ==========================================================================
  // 公开回调 —— 事件通知
  // ==========================================================================

  /**
   * 收到增量转写结果时触发（中间结果，会不断更新）
   * @param text - 当前识别到的文本片段（live text）
   */
  public onTranscription?: (text: string) => void;

  /**
   * 收到最终转写结果时触发（一句话识别完成）
   * @param text - 已确认的最终文本（final text）
   */
  public onFinal?: (text: string) => void;

  /** 连接发生错误时触发 */
  public onError?: (error: string) => void;

  /** WebSocket 连接成功建立时触发（收到 connected 消息后） */
  public onConnected?: () => void;

  /** WebSocket 连接断开时触发 */
  public onDisconnected?: () => void;

  // ==========================================================================
  // 构造函数
  // ==========================================================================

  /**
   * @param userId - 当前用户 ID，拼接在 URL 路径中标识转写会话
   */
  constructor(userId: string) {
    this.url = this.buildWebSocketUrl(userId);
  }

  // ==========================================================================
  // URL 构建
  // ==========================================================================

  /**
   * 解析环境变量中配置的 WebSocket 基础地址
   *
   * 优先级：
   *   1. VITE_WS_BASE_URL 环境变量（显式配置）
   *   2. null（交由 resolveRuntimeWsBaseUrl 根据当前页面协议自动推断）
   */
  private resolveConfiguredWebSocketBaseUrl() {
    return resolveWsBaseUrl(import.meta.env.VITE_WS_BASE_URL);
  }

  /**
   * 构建完整的 WebSocket 连接 URL
   *
   * URL 结构：
   *   ${wsBase}${apiBase}/xunzhi/v1/xunfei/audio-to-text/${userId}?token=${authToken}
   *
   * 示例：
   *   ws://localhost:8002/api/xunzhi/v1/xunfei/audio-to-text/123?token=xxx
   *
   * wsBase 确定方式：
   *   1. 优先使用 VITE_WS_BASE_URL 环境变量
   *   2. 未配置时根据页面协议自动推断（https → wss, http → ws）
   *
   * @param userId - 用户 ID，经过 encodeURIComponent 编码
   */
  private buildWebSocketUrl(userId: string) {
    const wsBase = this.resolveWebSocketBaseUrl();
    const apiBase = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
    const path = `${apiBase}/xunzhi/v1/xunfei/audio-to-text/${encodeURIComponent(userId)}`;
    const token = getAuthToken();

    // 无 Token 时不附加查询参数（通常不会发生，仅做防御）
    if (!token) {
      return `${wsBase}${path}`;
    }

    // 通过查询参数传递认证 Token（WebSocket 无法设置自定义请求头）
    const query = new URLSearchParams();
    query.set("token", token);
    return `${wsBase}${path}?${query.toString()}`;
  }

  /**
   * 确定最终使用的 WebSocket 基础地址
   *
   * 拼接策略：
   *   1. 如果 resolveConfiguredWebSocketBaseUrl 返回了值 → 直接使用
   *   2. 否则根据当前页面的 protocol 自动选择 ws:// 或 wss://
   */
  private resolveWebSocketBaseUrl() {
    const configuredWsBase = this.resolveConfiguredWebSocketBaseUrl();
    return resolveRuntimeWsBaseUrl(window.location, configuredWsBase);
  }

  // ==========================================================================
  // 连接管理
  // ==========================================================================

  /**
   * connect - 建立 WebSocket 连接
   *
   * 幂等操作：如果已有连接处于 CONNECTING 或 OPEN 状态，直接返回不重复创建。
   *
   * 生命周期事件：
   *   onopen    → 标记 hasOpened，发送排队中的音频数据，启动心跳
   *   onmessage → 解析 JSON，通过 handleMessage 分发到对应回调
   *   onerror   → 通知调用方
   *   onclose   → 停止心跳，清理状态；若从未成功打开（非正常关闭）则报错
   */
  connect() {
    // 幂等：已有进行中或已打开的连接时跳过
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING ||
        this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    this.ws = new WebSocket(this.url);
    // 重置消息去重状态，避免新旧连接间的 timestamp/key 干扰
    this.resetMessageCursor();

    // ------------------------------------------------------------------
    // onopen —— 连接建立
    // ------------------------------------------------------------------
    this.ws.onopen = () => {
      console.log("WebSocket Connected");
      this.hasOpened = true;
      // 发送连接建立前排队的音频数据
      this.flushPendingBinaryQueue();
      // 启动心跳定时器，保持连接活跃
      this.startPing();
    };

    // ------------------------------------------------------------------
    // onmessage —— 接收服务端推送的消息
    // ------------------------------------------------------------------
    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as AudioToTextIncomingMessage;
        this.handleMessage(data);
      } catch (error) {
        console.error("Failed to parse WS message", error);
      }
    };

    // ------------------------------------------------------------------
    // onerror —— 连接错误
    // ------------------------------------------------------------------
    this.ws.onerror = (error) => {
      console.error("WebSocket Error", error);
      this.onError?.("WebSocket connection error");
    };

    // ------------------------------------------------------------------
    // onclose —— 连接关闭
    // ------------------------------------------------------------------
    this.ws.onclose = (event) => {
      console.warn("WebSocket Disconnected", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      this.stopPing();

      // 如果连接从未成功打开且不是正常关闭（code 1000），
      // 说明 TCP/HTTP 握手阶段就失败了，需要通知调用方
      if (!this.hasOpened && event.code !== 1000) {
        const details = [event.code ? `code=${event.code}` : null, event.reason]
          .filter(Boolean)
          .join(", ");
        this.onError?.(
          details
            ? `WebSocket closed before ready: ${details}`
            : "WebSocket closed before ready",
        );
      }

      this.onDisconnected?.();
      this.ws = null;
      this.hasOpened = false;
    };
  }

  // ==========================================================================
  // 消息处理
  // ==========================================================================

  /**
   * handleMessage - 解析并分发收到的消息
   *
   * 处理流程：
   *   1. 调用 resolveAudioTranscriptionEvent 将原始 JSON 转换为事件对象
   *   2. 通过 shouldApplyEvent 去重检查
   *   3. 根据事件类型（kind）分发到对应的公开回调
   *
   * 事件类型映射：
   *   reset     → onTranscription("")     清空当前实时文本
   *   replace   → onTranscription(text)   更新增量转写结果（逐句修正）
   *   archive   → onFinal(text)           一句识别完成，归档为最终结果
   *   connected → onConnected()           连接建立确认（业务层握手完成）
   *   control   → 无操作                   控制类消息（开始/停止转录确认）
   *   heartbeat → 无操作                   心跳响应（pong）
   *   error     → onError(message)        服务端返回的错误
   *   unknown   → console.warn            未识别的消息类型
   *
   * 注意：reset 也调用 onTranscription 而非单独的回调，
   *       调用方收到空字符串即表示需要清空当前实时文本。
   */
  private handleMessage(data: AudioToTextIncomingMessage) {
    // 将原始 JSON 消息解析为结构化事件
    const event = resolveAudioTranscriptionEvent(data);

    // 去重检查：丢弃乱序的旧消息或完全重复的消息
    if (!this.shouldApplyEvent(data, event)) {
      return;
    }

    switch (event.kind) {
      case "reset":
        // 新一轮转写开始，清空实时文本
        this.onTranscription?.("");
        break;
      case "replace":
        // 增量转写结果更新（中间结果，会持续修正）
        this.onTranscription?.(event.text);
        break;
      case "archive":
        // 一句话识别完成，文本已确认不再变化
        this.onFinal?.(event.text);
        break;
      case "connected":
        // 业务层握手完成（区别于 WebSocket 层面的 onopen）
        this.onConnected?.();
        break;
      case "control":
      case "heartbeat":
        // 控制确认 / 心跳响应 —— 无需通知调用方
        break;
      case "error":
        // 服务端返回的业务错误
        this.onError?.(event.message);
        break;
      case "unknown":
        // 未识别的消息类型（用于调试和向前兼容）
        console.warn("Unknown message type:", event.type);
        break;
    }
  }

  // ==========================================================================
  // 心跳保活
  // ==========================================================================

  /**
   * 启动心跳定时器
   *
   * 每 15 秒发送一次 ping 命令，防止中间代理、负载均衡器或防火墙
   * 因空闲超时断开 WebSocket 连接。
   *
   * 调用前会先停止已有的定时器，确保不会出现重复心跳。
   */
  private startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      this.sendCommand("ping");
    }, 15000);
  }

  /** 停止心跳定时器并释放引用 */
  private stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ==========================================================================
  // 数据发送
  // ==========================================================================

  /**
   * sendCommand - 发送 JSON 控制命令
   *
   * @param type - 命令类型
   *   - "ping"                 心跳探测
   *   - "start_transcription"  通知服务端开始转写
   *   - "stop_transcription"   通知服务端停止转写
   *   - "get_status"           查询当前转写状态
   *
   * 仅在 WebSocket OPEN 状态下发送，其他状态静默忽略。
   */
  sendCommand(
    type: "ping" | "start_transcription" | "stop_transcription" | "get_status",
  ) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type }));
    }
  }

  /**
   * sendAudio - 发送音频二进制数据
   *
   * @param data - 音频数据块（ArrayBuffer 或 Blob）
   *
   * 发送策略（按连接状态分流）：
   *   - OPEN        → 直接发送
   *   - CONNECTING  → 入队等待（最多 maxPendingBinaryChunks 个），
   *                   连接建立后由 flushPendingBinaryQueue 批量发送
   *   - CLOSING / CLOSED → 打印警告并丢弃
   *
   * 为什么需要排队机制：
   *   connect() 是异步的，调用方可能在 WebSocket 还在握手的 CONNECTING 阶段
   *   就开始发送音频数据。排队可避免这段时间内的数据丢失。
   */
  sendAudio(data: Blob | ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // 连接已就绪，直接发送
      this.ws.send(data);
    } else if (this.ws?.readyState === WebSocket.CONNECTING) {
      // 连接尚未建立，入队等待
      // 队列满时移除最旧的 chunk（滑动窗口），优先保留最近的数据
      if (this.pendingBinaryQueue.length >= this.maxPendingBinaryChunks) {
        this.pendingBinaryQueue.shift();
      }
      this.pendingBinaryQueue.push(data);
    } else {
      // 连接未创建或已断开
      console.warn("Cannot send audio: WebSocket is not open");
    }
  }

  // ==========================================================================
  // 断开连接
  // ==========================================================================

  /**
   * disconnect - 主动断开 WebSocket 连接
   *
   * 清理步骤：
   *   1. 停止心跳定时器
   *   2. 清空待发送音频队列（释放内存）
   *   3. 重置消息去重状态
   *   4. 关闭 WebSocket 连接
   *
   * 注意：此方法不会触发 onDisconnected 回调（主动断开），
   *       onclose 事件仍会触发但 hasOpened 已重置，不会报告错误。
   */
  disconnect() {
    this.stopPing();
    this.pendingBinaryQueue = [];
    this.resetMessageCursor();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ==========================================================================
  // 内部辅助方法
  // ==========================================================================

  /**
   * flushPendingBinaryQueue - 发送排队中的音频数据
   *
   * 在 onopen 事件中调用，将连接建立前暂存的音频 chunk 批量发送出去。
   * 发送后清空队列。
   *
   * 安全检查：
   *   - ws 为 null → 跳过
   *   - readyState 不是 OPEN → 跳过（连接已断开或尚未就绪）
   *   - 队列为空 → 跳过
   */
  private flushPendingBinaryQueue() {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      this.pendingBinaryQueue.length === 0
    ) {
      return;
    }
    this.pendingBinaryQueue.forEach((chunk) => {
      this.ws?.send(chunk);
    });
    this.pendingBinaryQueue = [];
  }

  /** 重置消息去重状态（新连接建立时调用） */
  private resetMessageCursor() {
    this.lastMessageTimestamp = 0;
    this.lastMessageKey = null;
  }

  /**
   * shouldApplyEvent - 判断消息是否应该被应用（去重 + 乱序过滤）
   *
   * 去重规则（两条防线）：
   *
   *   第一层：基于 timestamp（时间戳防线）
   *     - 消息携带 timestamp 字段时：
   *       · timestamp < lastTimestamp  → 丢弃（乱序到达的旧消息）
   *       · timestamp === lastTimestamp && key 相同 → 丢弃（重复投递）
   *     - 消息无 timestamp 时：跳过时间戳检查，进入第二层
   *
   *   第二层：基于 key（内容防线）
   *     - key = `${event.kind}:${message.type}:${text}`
   *     - key 与上一条完全相同 → 丢弃（内容重复）
   *
   * @param message - 原始消息（用于提取 timestamp 和 type）
   * @param event   - 解析后的事件（用于提取 kind 和 text/message）
   * @returns true 表示消息应该被应用，false 表示应丢弃
   */
  private shouldApplyEvent(
    message: AudioToTextIncomingMessage,
    event: ReturnType<typeof resolveAudioTranscriptionEvent>,
  ) {
    // 提取事件中的文本内容用于构建去重 key
    const text =
      "text" in event ? event.text : "message" in event ? event.message : "";

    // 构建去重 key：kind + type + 文本内容
    const nextKey = `${event.kind}:${message.type ?? ""}:${text}`;
    const nextTimestamp =
      typeof message.timestamp === "number" ? message.timestamp : null;

    // --- 第一层：timestamp 防线 ---
    if (nextTimestamp !== null) {
      // 乱序：新消息时间戳比已处理的消息更旧
      if (nextTimestamp < this.lastMessageTimestamp) {
        return false;
      }
      // 重复：同一时间戳 + 同一内容的重复投递
      if (
        nextTimestamp === this.lastMessageTimestamp &&
        nextKey === this.lastMessageKey
      ) {
        return false;
      }
      // 通过防线，更新游标
      this.lastMessageTimestamp = nextTimestamp;
      this.lastMessageKey = nextKey;
      return true;
    }

    // --- 第二层：key 防线（无 timestamp 时使用） ---
    if (nextKey === this.lastMessageKey) {
      return false;
    }
    this.lastMessageKey = nextKey;
    return true;
  }
}
