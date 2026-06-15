// ─── 类型定义 ───

/** 创建 TextStreamLimiter 的配置项 */
export interface TextStreamLimiterOptions {
  /** 每次 tick 推送完整累积值时的回调（参数为截止目前的全部文本，非增量） */
  onUpdate: (value: string) => void;
  /** tick 间隔（毫秒），默认 40ms */
  intervalMs?: number;
  /** 每次 tick 从缓冲区取出的字符数，默认 12 */
  charsPerTick?: number;
  /** 初始已累积文本（用于恢复已有内容后继续限速输出） */
  initialValue?: string;
}

/** TextStreamLimiter 实例接口 */
export interface TextStreamLimiter {
  /** 向缓冲区追加文本 chunk */
  push: (chunk: string) => void;
  /** 立即将缓冲区中剩余文本全部输出，然后停止定时器 */
  flush: () => void;
  /** 丢弃缓冲区中所有未输出的文本，停止定时器 */
  stop: () => void;
  /** 获取当前已累积输出的完整文本 */
  getValue: () => string;
}

// ─── 默认值 ───

/** 默认 tick 间隔：40ms → 约 25fps 的更新频率，肉眼感知流畅 */
const DEFAULT_INTERVAL_MS = 40;
/** 默认每次取出字符数：12 → 每秒约 300 字符（12 × 25），接近普通阅读速度 */
const DEFAULT_CHARS_PER_TICK = 12;

/**
 * 创建文本流限速器 —— 控制前端逐字渲染的速率。
 *
 * 工作方式：
 * - SSE 回调中高频调用 `push(chunk)` 追加文本到内部缓冲区
 * - 内部以 `intervalMs` 间隔的定时器从缓冲区头部取出 `charsPerTick` 个字符，
 *   追加到累积值，并通过 `onUpdate` 回调通知外部
 * - 缓冲区为空时自动停止定时器（省资源），有新 push 时自动重启
 *
 * 设计意图：
 * 后端 SSE 推送速度不可控（可能瞬间几十 KB），直接渲染会导致文字闪现或
 * UI 卡顿。通过限速器将高速流入的文本排队，以可控速率逐批渲染，实现打字机效果。
 *
 * 使用场景：
 * - AI 对话正文的逐字输出（content）
 * - 推理/思考过程的逐字输出（reasoning）
 *
 * @example
 * const limiter = createTextStreamLimiter({
 *   intervalMs: 40,
 *   charsPerTick: 12,
 *   onUpdate: (fullText) => dispatch(appendChunk({ id, content: fullText })),
 * });
 * sse.onMessage = (chunk) => limiter.push(chunk);
 * sse.onDone = () => limiter.flush();  // 确保剩余字符全部输出
 */
export function createTextStreamLimiter(
  options: TextStreamLimiterOptions,
): TextStreamLimiter {
  // ── 参数归一化（最小值保护） ──
  const intervalMs =
    options.intervalMs && options.intervalMs > 0
      ? options.intervalMs
      : DEFAULT_INTERVAL_MS;
  const charsPerTick =
    options.charsPerTick && options.charsPerTick > 0
      ? options.charsPerTick
      : DEFAULT_CHARS_PER_TICK;

  // ── 内部状态 ──
  /** 已累积输出的完整文本（每次 tick 追加 charsPerTick 个字符） */
  let value = options.initialValue ?? "";
  /** 待输出缓冲区（SSE 回调写入，定时器取出） */
  let pending = "";
  /** 定时器句柄（缓冲区为空时自动清除，有数据时自动启动） */
  let timer: ReturnType<typeof setInterval> | null = null;

  /** 停止定时器（不丢弃缓冲区，不触发 onUpdate） */
  const stopTimer = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  /**
   * 每次定时器 tick 执行的核心逻辑：
   * 1. 从缓冲区头部截取 charsPerTick 个字符
   * 2. 追加到累积值 value
   * 3. 通过 onUpdate 回调通知外部（传完整累积文本，非增量）
   * 4. 若缓冲区已空，自动停止定时器
   */
  const tick = () => {
    if (!pending) {
      stopTimer();
      return;
    }

    const nextChunk = pending.slice(0, charsPerTick);
    pending = pending.slice(nextChunk.length);
    value += nextChunk;
    options.onUpdate(value);

    if (!pending) {
      stopTimer();
    }
  };

  /**
   * 确保定时器在运行（幂等）。
   * 在 push 新数据时调用，若定时器已停止则重新启动。
   */
  const ensureTimer = () => {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
  };

  // ── 对外暴露的实例接口 ──

  return {
    /**
     * 追加文本块到缓冲区。
     * 首次 push 时先执行一次 tick（立即输出第一批字符），再启动定时器，
     * 避免首字符延迟一个 intervalMs 才出现。
     */
    push(chunk: string) {
      if (!chunk) return;
      pending += chunk;

      if (!timer) {
        // 首次 push：立即输出首帧，后续由定时器接管
        tick();
        ensureTimer();
      }
    },

    /**
     * 清空缓冲区：将剩余待输出文本一次性追加到 value，立即触发 onUpdate，
     * 然后停止定时器。用于 SSE 流结束时确保没有遗漏的字符。
     */
    flush() {
      if (!pending) return;
      value += pending;
      pending = "";
      options.onUpdate(value);
      stopTimer();
    },

    /**
     * 强制停止：丢弃缓冲区中所有未输出的文本，停止定时器。
     * 用于流被取消或出错时，不输出不完整的残余内容。
     */
    stop() {
      pending = "";
      stopTimer();
    },

    /** 获取当前已累积输出的完整文本 */
    getValue() {
      return value;
    },
  };
}
