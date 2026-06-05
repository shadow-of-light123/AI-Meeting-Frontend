/**
 * request.ts —— 项目 HTTP 请求层的统一封装
 *
 * 核心职责：
 * 1. 基于 Axios 实例，统一 baseURL、超时、Content-Type
 * 2. 自动注入 Authorization Token（除登录/注册等白名单路径外）
 * 3. 后端统一响应格式 BaseResponse<T> 自动解包为 data
 * 4. Axios 错误 → AppError 统一映射（含 401/403 等业务状态码）
 * 5. 请求去重与防抖：通过 requestPolicy 支持四种并发策略
 * 6. SSE 以外的所有 HTTP 请求均通过此模块发出
 *
 * 数据流向：
 * 组件/Hook → service(方法) → executeWithPolicy → withDebounce → withInflightDedup
 *   → axiosInstance.request → 拦截器(注入Token) → 后端
 *   ← 拦截器(错误映射) ← axiosInstance.response
 *   ← unwrapResponse(解包BaseResponse)
 */

import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import { resolveAppEnv } from "@/config/env";
import {
  AppError,
  ErrorCode,
  type ErrorCode as ErrorCodeValue,
} from "@/lib/errors";
import { getAuthToken } from "@/lib/authToken";

// ============================================================================
// 类型定义
// ============================================================================

/** 后端统一返回的响应格式 */
export interface BaseResponse<T = unknown> {
  /** 业务状态码，"0" 表示成功 */
  code: string;
  /** 错误/提示消息 */
  message: string | null;
  /** 实际业务数据 */
  data: T;
  /** 请求追踪 ID */
  requestId: string | null;
  /** 请求是否成功 */
  success: boolean;
}

export type ApiResponse<T = unknown> = BaseResponse<T>;

/**
 * 请求去重策略：
 * - off:            不进行去重，每次调用都发起真实请求
 * - join:           同一 key 的并发请求共享首个请求的结果（适用于 GET 幂等查询）
 * - cancel-previous: 新请求到达时取消上一个尚未完成的同 key 请求
 * - reject:         同一 key 已有进行中的请求时直接拒绝新请求（适用于防止重复提交）
 */
export type RequestDedupeStrategy =
  | "off"
  | "join"
  | "cancel-previous"
  | "reject";

/** 单次请求的策略配置 */
export type RequestPolicy = {
  /** 手动指定的去重 key；不填则自动根据 method + url + params + data 生成 */
  key?: string;
  /** 去重策略，GET 默认为 "join"，其他方法默认为 "off" */
  dedupe?: RequestDedupeStrategy;
  /** 防抖等待时间(ms)，0 表示不防抖 */
  debounceMs?: number;
};

/** 扩展 AxiosRequestConfig，添加 requestPolicy 字段 */
export type AppRequestConfig<D = unknown> = AxiosRequestConfig<D> & {
  requestPolicy?: RequestPolicy;
};

/** HTTP 客户端接口，所有方法均自动解包 BaseResponse 并返回 data */
export interface HttpClient {
  get<T>(url: string, config?: AppRequestConfig): Promise<T>;
  delete<T>(url: string, config?: AppRequestConfig): Promise<T>;
  post<T, D = unknown>(
    url: string,
    data?: D,
    config?: AppRequestConfig<D>,
  ): Promise<T>;
  put<T, D = unknown>(
    url: string,
    data?: D,
    config?: AppRequestConfig<D>,
  ): Promise<T>;
  patch<T, D = unknown>(
    url: string,
    data?: D,
    config?: AppRequestConfig<D>,
  ): Promise<T>;
}

// ============================================================================
// 基础配置
// ============================================================================

/** 获取当前环境的 API baseURL（默认 /api） */
export const getApiBaseUrl = () => resolveAppEnv().apiBaseUrl;

/**
 * 无需携带 Token 的 API 路径白名单
 * 这些路径在请求拦截器中会跳过 Authorization 注入
 */
const AUTH_FREE_API_PATHS = new Set([
  "/xunzhi/v1/users/login",
  "/xunzhi/v1/users/register",
  "/xunzhi/v1/users/check-login",
]);

// ============================================================================
// URL 路径处理
// ============================================================================

/** 去除 URL 中的查询参数和 hash 部分，只保留纯净路径 */
const trimQueryAndHash = (path: string) => {
  const queryIndex = path.indexOf("?");
  const hashIndex = path.indexOf("#");
  const stopIndexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  if (stopIndexes.length === 0) {
    return path;
  }
  return path.slice(0, Math.min(...stopIndexes));
};

/**
 * 将任意格式的请求 URL 归一化为绝对路径形式（用于去重 key 生成和鉴权判断）
 * - 完整 URL(http://...)  → 提取 pathname
 * - 相对路径              → 去掉 baseURL 前缀后返回
 * - 空值                  → 返回 ""
 */
const normalizeRequestPath = (url?: string) => {
  if (!url) {
    return "";
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const parsed = new URL(url);
      return trimQueryAndHash(parsed.pathname || "");
    } catch {
      return "";
    }
  }

  const baseUrl = getApiBaseUrl();
  const normalizedRelative = url.startsWith("/") ? url : `/${url}`;
  if (normalizedRelative.startsWith(baseUrl)) {
    return trimQueryAndHash(normalizedRelative.slice(baseUrl.length));
  }

  return trimQueryAndHash(normalizedRelative);
};

// ============================================================================
// 认证相关
// ============================================================================

/**
 * 判断请求是否需要注入 Token
 * 规则：以 /xunzhi/v1/ 开头的路径需要 Token，但白名单路径除外
 */
export const requiresAuthTokenForRequest = (url?: string) => {
  const path = normalizeRequestPath(url);
  if (!path.startsWith("/xunzhi/v1/")) {
    return false;
  }
  return !AUTH_FREE_API_PATHS.has(path);
};

/**
 * 断言当前请求已授权：如果需要 Token 但本地没有，直接抛出 UNAUTHORIZED 错误
 * 返回 Token 字符串供调用方用于构造 fetch/SSE 等非 Axios 请求的 Authorization 头
 */
export const assertRequestAuthorized = (url: string | undefined) => {
  const token = getAuthToken();
  if (requiresAuthTokenForRequest(url) && !token) {
    throw new AppError(
      ErrorCode.UNAUTHORIZED,
      "Unauthorized. Please sign in again.",
    );
  }
  return token;
};

/**
 * 拼接完整的 API URL
 * @param path  接口路径（如 /xunzhi/v1/ai/conversations）
 * @param query 可选的查询参数对象，自动过滤 null/undefined/空字符串
 */
export const buildApiUrl = (
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
) => {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const baseUrl = `${getApiBaseUrl()}${normalizedPath}`;

  if (!query) {
    return baseUrl;
  }

  const searchParams = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    searchParams.set(key, String(value));
  });

  const queryString = searchParams.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
};

// ============================================================================
// 响应解包 & 错误映射
// ============================================================================

/** 将后端业务状态码映射为前端标准 ErrorCode */
export const mapBusinessCode = (code: string | undefined): ErrorCodeValue => {
  switch (code) {
    case "401":
      return ErrorCode.UNAUTHORIZED;
    case "403":
      return ErrorCode.FORBIDDEN;
    default:
      return ErrorCode.OPERATION_FAILED;
  }
};

/** 类型守卫：判断 payload 是否满足 BaseResponse 结构 */
export const isBaseResponse = <T>(
  payload: unknown,
): payload is BaseResponse<T> => {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return "data" in payload && ("code" in payload || "success" in payload);
};

/**
 * 从 BaseResponse<T> | T 中提取业务数据 T
 * - 如果是 BaseResponse 且 code==="0" 或 success===true → 返回 data
 * - 如果是 BaseResponse 但业务失败 → 抛出 AppError
 * - 如果不是 BaseResponse → 原样返回
 */
export const unwrapResponseData = <T>(payload: BaseResponse<T> | T): T => {
  if (isBaseResponse<T>(payload)) {
    if (payload.code === "0" || payload.success) {
      return payload.data;
    }

    throw new AppError(
      mapBusinessCode(payload.code),
      payload.message || "Request failed",
      payload,
    );
  }

  return payload;
};

/** 从 AxiosResponse 中解包业务数据（调用 unwrapResponseData） */
export const unwrapResponse = <T>(
  response: AxiosResponse<BaseResponse<T> | T>,
): T => {
  return unwrapResponseData(response.data);
};

/**
 * 将 Axios 层的错误统一转换为 AppError
 * 覆盖：请求取消、HTTP 状态码(400/401/403/404/500)、超时、断网
 */
export const mapAxiosErrorToAppError = (error: AxiosError): AppError => {
  // Axios CancelToken / AbortController 触发的取消
  if (axios.isCancel(error)) {
    return new AppError(ErrorCode.ABORTED, "Request was cancelled", error);
  }

  // 服务端返回了 HTTP 响应
  if (error.response) {
    switch (error.response.status) {
      case 400:
        return new AppError(
          ErrorCode.INVALID_PARAMS,
          "Invalid request parameters",
          error,
        );
      case 401:
        return new AppError(
          ErrorCode.UNAUTHORIZED,
          "Unauthorized. Please sign in again.",
          error,
        );
      case 403:
        return new AppError(ErrorCode.FORBIDDEN, "Permission denied", error);
      case 404:
        return new AppError(
          ErrorCode.RESOURCE_NOT_FOUND,
          "Requested resource not found",
          error,
        );
      case 500:
        return new AppError(
          ErrorCode.UNKNOWN_ERROR,
          "Internal server error",
          error,
        );
      default:
        return new AppError(
          ErrorCode.UNKNOWN_ERROR,
          `Request failed with status ${error.response.status}`,
          error,
        );
    }
  }

  // 超时
  if (error.code === "ECONNABORTED") {
    return new AppError(ErrorCode.REQUEST_TIMEOUT, "Request timeout", error);
  }

  // 浏览器断网
  if (typeof window !== "undefined" && !window.navigator.onLine) {
    return new AppError(
      ErrorCode.NETWORK_ERROR,
      "Network disconnected. Please check your connection.",
      error,
    );
  }

  // 其他网络错误
  return new AppError(
    ErrorCode.NETWORK_ERROR,
    error.message || "Network request failed",
    error,
  );
};

// ============================================================================
// 请求去重 key 生成 —— 稳定序列化
// ============================================================================

/**
 * 将任意 JS 值稳定地序列化为字符串（用于生成请求去重的唯一 key）
 *
 * 为什么不用 JSON.stringify？
 * - JSON.stringify 的对象属性顺序取决于插入顺序，相同语义的请求可能生成不同的 key
 * - 此处按 key 排序后序列化，保证 {a:1,b:2} 和 {b:2,a:1} 生成相同字符串
 * - 对 FormData、循环引用等边界情况有专门处理
 */
const stableSerialize = (
  value: unknown,
  seen = new WeakSet<object>(),
): string => {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof URLSearchParams) {
    return value.toString();
  }
  // FormData 不可枚举，统一用占位符
  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return "[form-data]";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
  }
  if (typeof value === "object") {
    // 循环引用检测
    if (seen.has(value as object)) {
      return "[circular]";
    }
    seen.add(value as object);
    const record = value as Record<string, unknown>;
    const serialized = Object.keys(record)
      .sort()
      .map((key) => `${key}:${stableSerialize(record[key], seen)}`)
      .join(",");
    seen.delete(value as object);
    return `{${serialized}}`;
  }
  return String(value);
};

/**
 * 生成请求去重的唯一 key
 * - 如果有 explicitKey，直接使用
 * - 否则自动按 METHOD::PATH::params=X::data=Y 格式拼接
 */
export const buildRequestPolicyKey = (args: {
  method: string;
  url: string;
  params?: unknown;
  data?: unknown;
  explicitKey?: string;
}) => {
  const normalizedExplicitKey = args.explicitKey?.trim();
  if (normalizedExplicitKey) {
    return normalizedExplicitKey;
  }
  const normalizedMethod = args.method.toUpperCase();
  const normalizedPath = normalizeRequestPath(args.url) || args.url;
  const serializedParams = stableSerialize(args.params);
  const serializedData = stableSerialize(args.data);
  return `${normalizedMethod}::${normalizedPath}::params=${serializedParams}::data=${serializedData}`;
};

/**
 * 解析并规范化请求策略
 * - GET 请求默认 dedupe 策略为 "join"（并发合并），其他方法默认为 "off"
 * - debounceMs 仅当为正整数时生效
 */
export const resolveRequestPolicy = (
  method: string,
  requestPolicy?: RequestPolicy,
) => {
  const normalizedMethod = method.trim().toUpperCase();
  const dedupe: RequestDedupeStrategy =
    requestPolicy?.dedupe ?? (normalizedMethod === "GET" ? "join" : "off");
  const debounceMsRaw = requestPolicy?.debounceMs;
  const debounceMs =
    typeof debounceMsRaw === "number" && Number.isFinite(debounceMsRaw)
      ? Math.max(0, Math.floor(debounceMsRaw))
      : 0;

  return {
    dedupe,
    debounceMs,
    key: requestPolicy?.key?.trim() || undefined,
  };
};

// ============================================================================
// 请求去重 & 防抖引擎（模块级全局状态）
// ============================================================================

/**
 * 进行中的请求条目
 * - controller: 用于 cancel-previous 策略时取消旧请求
 * - promise:    用于 join 策略时复用并发请求的结果
 */
type InflightRequestEntry<T = unknown> = {
  controller: AbortController;
  promise: Promise<T>;
};

/** 防抖等待中的回调收集器 */
type DebounceResolver<T> = {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

/** 防抖请求条目：收集同一 key 下多次调用的 resolve/reject，定时器到期后执行最新的一次 run() */
type DebounceRequestEntry<T = unknown> = {
  timerId: ReturnType<typeof setTimeout> | null;
  /** 要执行的最新请求函数（连续触发时始终更新为最后一次） */
  run: () => Promise<T>;
  /** 等待结果的回调列表 */
  resolvers: DebounceResolver<T>[];
};

/** 全局 inflight 请求 Map：key → 进行中的请求 */
const inflightRequestMap = new Map<string, InflightRequestEntry<unknown>>();
/** 全局防抖请求 Map：key → 待执行的防抖条目 */
const debounceRequestMap = new Map<string, DebounceRequestEntry<unknown>>();

/**
 * 将外部 AbortSignal 绑定到内部 AbortController
 * 当外部 signal 被 abort 时，内部 controller 也会 abort
 */
const bindAbortSignal = (
  controller: AbortController,
  signal?: AxiosRequestConfig["signal"],
) => {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    controller.abort();
    return;
  }
  if (typeof (signal as AbortSignal).addEventListener === "function") {
    (signal as AbortSignal).addEventListener(
      "abort",
      () => controller.abort(),
      {
        once: true,
      },
    );
  }
};

/** 从 config 中移除 requestPolicy 字段，避免传入 Axios */
const stripRequestPolicy = <D>(
  config?: AppRequestConfig<D>,
): AxiosRequestConfig<D> => {
  if (!config) {
    return {};
  }
  const axiosConfig = { ...config } as AxiosRequestConfig<D> & {
    requestPolicy?: RequestPolicy;
  };
  delete axiosConfig.requestPolicy;
  return axiosConfig;
};

/**
 * 防抖执行：在 debounceMs 内多次调用同一 key 的请求时，
 * 只执行最后一次，但所有调用方共享同一个结果
 *
 * 典型场景：搜索输入框实时联想，用户连续输入时不立即发请求，
 * 等停止输入 debounceMs 后再发一次
 */
const withDebounce = <T>(
  requestKey: string,
  debounceMs: number,
  run: () => Promise<T>,
): Promise<T> => {
  if (debounceMs <= 0) {
    return run();
  }

  const existing = debounceRequestMap.get(requestKey) as
    | DebounceRequestEntry<T>
    | undefined;

  // 同一 key 已有等待中的防抖 → 重置定时器，替换为最新的 run
  if (existing) {
    if (existing.timerId !== null) {
      clearTimeout(existing.timerId);
    }
    existing.run = run;
    return new Promise<T>((resolve, reject) => {
      existing.resolvers.push({ resolve, reject });
      existing.timerId = setTimeout(async () => {
        const active = debounceRequestMap.get(requestKey) as
          | DebounceRequestEntry<T>
          | undefined;
        if (!active) {
          return;
        }
        debounceRequestMap.delete(requestKey);
        try {
          const result = await active.run();
          active.resolvers.forEach((entry) => entry.resolve(result));
        } catch (error) {
          active.resolvers.forEach((entry) => entry.reject(error));
        }
      }, debounceMs);
    });
  }

  // 首次调用 → 创建防抖条目
  const created: DebounceRequestEntry<T> = {
    timerId: null,
    run,
    resolvers: [],
  };
  debounceRequestMap.set(requestKey, created as DebounceRequestEntry<unknown>);

  return new Promise<T>((resolve, reject) => {
    created.resolvers.push({ resolve, reject });
    created.timerId = setTimeout(async () => {
      const active = debounceRequestMap.get(requestKey) as
        | DebounceRequestEntry<T>
        | undefined;
      if (!active) {
        return;
      }
      debounceRequestMap.delete(requestKey);
      try {
        const result = await active.run();
        active.resolvers.forEach((entry) => entry.resolve(result));
      } catch (error) {
        active.resolvers.forEach((entry) => entry.reject(error));
      }
    }, debounceMs);
  });
};

/**
 * Inflight 去重：根据 dedupe 策略处理并发重复请求
 *
 * join:            已有同 key 请求在进行 → 直接返回该请求的 Promise（共享结果）
 * reject:          已有同 key 请求在进行 → 抛出 AppError 拒绝新请求
 * cancel-previous: 已有同 key 请求在进行 → abort 旧请求，发起新请求
 * off:             不做任何处理，直接发起新请求
 */
const withInflightDedup = <T, D>(args: {
  requestKey: string;
  dedupe: RequestDedupeStrategy;
  config?: AxiosRequestConfig<D>;
  run: (config: AxiosRequestConfig<D>) => Promise<T>;
}) => {
  const existing = inflightRequestMap.get(args.requestKey) as
    | InflightRequestEntry<T>
    | undefined;

  if (existing) {
    if (args.dedupe === "join") {
      return existing.promise;
    }
    if (args.dedupe === "reject") {
      throw new AppError(
        ErrorCode.OPERATION_FAILED,
        "Duplicate request is in progress, please retry later.",
      );
    }
    if (args.dedupe === "cancel-previous") {
      existing.controller.abort();
    }
  }

  const controller = new AbortController();
  bindAbortSignal(controller, args.config?.signal);
  const mergedConfig: AxiosRequestConfig<D> = {
    ...(args.config ?? {}),
    signal: controller.signal,
  };

  // 请求完成后自动从 inflightMap 中清除
  const promise = args.run(mergedConfig).finally(() => {
    const active = inflightRequestMap.get(args.requestKey);
    if (active?.promise === promise) {
      inflightRequestMap.delete(args.requestKey);
    }
  });

  if (args.dedupe !== "off") {
    inflightRequestMap.set(args.requestKey, {
      controller,
      promise,
    } as InflightRequestEntry<unknown>);
  }

  return promise;
};

// ============================================================================
// Axios 实例 & 拦截器
// ============================================================================

/**
 * 创建 Axios 实例
 * - baseURL 为 VITE_API_BASE_URL（默认 /api）
 * - 默认超时 10s（长耗时接口如面试答题需单独增加 timeout）
 */
export const createAxiosClient = (): AxiosInstance => {
  return axios.create({
    baseURL: getApiBaseUrl(),
    timeout: 10_000,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
    },
  });
};

const axiosInstance = createAxiosClient();

/**
 * 请求拦截器
 * - 对于需要认证的路径，自动从 localStorage 读取 Token 并注入 Authorization 头
 * - 白名单路径（登录/注册/检查登录态）跳过注入
 */
axiosInstance.interceptors.request.use(
  (config) => {
    const token = assertRequestAuthorized(config.url);

    if (token) {
      const headers = new AxiosHeaders(config.headers);
      headers.set("Authorization", `Bearer ${token}`);
      config.headers = headers;
    }

    return config;
  },
  (error) =>
    Promise.reject(
      new AppError(ErrorCode.UNKNOWN_ERROR, "Failed to send request", error),
    ),
);

/**
 * 响应拦截器
 * - 成功响应不做处理，留给 executeWithPolicy 中的 unwrapResponse 解包
 * - 错误响应统一通过 mapAxiosErrorToAppError 转换为 AppError
 */
axiosInstance.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => Promise.reject(mapAxiosErrorToAppError(error)),
);

// ============================================================================
// 请求策略执行管道
// ============================================================================

/**
 * 单次请求的执行管道，按顺序经过以下环节：
 * 1. resolveRequestPolicy   → 解析出 dedupe / debounceMs / key
 * 2. buildRequestPolicyKey  → 生成请求去重 key
 * 3. stripRequestPolicy     → 移除 requestPolicy 避免进入 Axios
 * 4. withDebounce           → 防抖（debounceMs > 0 时生效）
 * 5. withInflightDedup      → 并发去重（dedupe !== "off" 时生效）
 * 6. run(config)            → 实际发起请求
 */
const executeWithPolicy = <T, D>(args: {
  method: "GET" | "DELETE" | "POST" | "PUT" | "PATCH";
  url: string;
  data?: D;
  config?: AppRequestConfig<D>;
  run: (config: AxiosRequestConfig<D>) => Promise<T>;
}) => {
  const policy = resolveRequestPolicy(args.method, args.config?.requestPolicy);
  const requestKey = buildRequestPolicyKey({
    method: args.method,
    url: args.url,
    params: args.config?.params,
    data: args.data,
    explicitKey: policy.key,
  });
  const axiosConfig = stripRequestPolicy(args.config);

  const runWithDedupe = () =>
    withInflightDedup({
      requestKey,
      dedupe: policy.dedupe,
      config: axiosConfig,
      run: args.run,
    });

  return withDebounce(requestKey, policy.debounceMs, runWithDedupe);
};

// ============================================================================
// 统一 HTTP 客户端（默认导出）
// ============================================================================

/**
 * 项目中所有 HTTP 请求的统一入口
 *
 * 使用方式：
 * ```
 * import service from "@/lib/request";
 *
 * // 普通 GET
 * const data = await service.get("/xunzhi/v1/ai/conversations", { params: { current: 1 } });
 *
 * // 带防抖/去重策略的 POST
 * const result = await service.post("/xunzhi/v1/interview/answer", payload, {
 *   requestPolicy: { dedupe: "reject", debounceMs: 250 },
 * });
 * ```
 *
 * 每种方法都会：
 * 1. 经过 executeWithPolicy 管道（去重/防抖）
 * 2. 经过 Axios 拦截器（注入 Token / 错误映射）
 * 3. 自动解包 BaseResponse，直接返回 data
 */
const service: HttpClient = {
  async get<T>(url: string, config?: AppRequestConfig) {
    return executeWithPolicy<T, unknown>({
      method: "GET",
      url,
      config,
      run: async (axiosConfig) => {
        const response = await axiosInstance.get<BaseResponse<T> | T>(
          url,
          axiosConfig,
        );
        return unwrapResponse(response);
      },
    });
  },
  async delete<T>(url: string, config?: AppRequestConfig) {
    return executeWithPolicy<T, unknown>({
      method: "DELETE",
      url,
      config,
      run: async (axiosConfig) => {
        const response = await axiosInstance.delete<BaseResponse<T> | T>(
          url,
          axiosConfig,
        );
        return unwrapResponse(response);
      },
    });
  },
  async post<T, D = unknown>(
    url: string,
    data?: D,
    config?: AppRequestConfig<D>,
  ) {
    return executeWithPolicy<T, D>({
      method: "POST",
      url,
      data,
      config,
      run: async (axiosConfig) => {
        const response = await axiosInstance.post<BaseResponse<T> | T>(
          url,
          data,
          axiosConfig,
        );
        return unwrapResponse(response);
      },
    });
  },
  async put<T, D = unknown>(
    url: string,
    data?: D,
    config?: AppRequestConfig<D>,
  ) {
    return executeWithPolicy<T, D>({
      method: "PUT",
      url,
      data,
      config,
      run: async (axiosConfig) => {
        const response = await axiosInstance.put<BaseResponse<T> | T>(
          url,
          data,
          axiosConfig,
        );
        return unwrapResponse(response);
      },
    });
  },
  async patch<T, D = unknown>(
    url: string,
    data?: D,
    config?: AppRequestConfig<D>,
  ) {
    return executeWithPolicy<T, D>({
      method: "PATCH",
      url,
      data,
      config,
      run: async (axiosConfig) => {
        const response = await axiosInstance.patch<BaseResponse<T> | T>(
          url,
          data,
          axiosConfig,
        );
        return unwrapResponse(response);
      },
    });
  },
};

export default service;
