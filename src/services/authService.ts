/**
 * 认证服务层
 *
 * 封装所有与用户认证相关的 HTTP 请求，包括登录、注册、登出、登录状态检查、
 * 用户信息查询等。本模块是前端与后端 `/xunzhi/v1/users/*` API 之间的桥梁。
 *
 * 核心设计：
 * 1. **双重凭据机制**：
 *    - Bearer Token（localStorage）：用于大多数 /xunzhi/v1/* API 的 Authorization header
 *    - HTTP-only Cookie（JSESSIONID）：浏览器自动携带，用于 checkLogin 等白名单端点，
 *      JS 无法直接读写，实现"Cookie 有效 → 刷新 Token"的无感续期
 * 2. **数据规范化**：后端 JSON 字段可能使用 camelCase 或 snake_case，
 *    本模块通过 normalizeUser / toNumber / toString 等工具函数统一清洗数据，
 *    确保前端拿到的 UserRespDTO 字段格式一致。
 * 2. **Token 提取**：后端 AuthPayloadDTO 结构不统一（Token 可能放在顶层
 *    或 data 嵌套对象中，字段名可能是 token / accessToken / authToken），
 *    extractTokenFromAuthPayload 按优先级依次尝试，提升兼容性。
 * 3. **用户提取**：后端返回的用户对象可能直接在 payload 顶层，也可能嵌套在
 *    payload.user 或 payload.currentUser 中，extractUserFromAuthPayload
 *    逐一尝试解析。
 * 4. **登出保护**：logout 方法使用 try/finally 确保无论后端请求是否成功，
 *    本地 Token 都会被清除，避免前端陷入"假登录"状态。
 */

import service from "@/lib/request";
import { clearAuthToken, setAuthToken } from "@/lib/authToken";
import { AppError, ErrorCode } from "@/lib/errors";
import type {
  AuthPayloadDTO,
  ResultBoolean,
  ResultVoid,
  UserActualRespDTO,
  UserLoginReqDTO,
  UserRegisterReqDTO,
  UserRespDTO,
} from "@/types/auth";

// =============================================================================
// 基础类型守卫与值转换工具
//
// 后端的 JSON 响应中字段类型不总是可预测的（例如数字可能以字符串形式返回），
// 以下工具函数用于安全地将 unknown 值转换为期望的 TypeScript 类型，
// 避免运行时 NaN 或类型错误。
// =============================================================================

/**
 * 判断值是否为普通对象（非 null，非数组）。
 * 用于快速校验后端返回的 payload 是否可进行字段访问。
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * 将 unknown 值安全转换为 number。
 *
 * - 已是有效 number → 直接返回
 * - 是有效数字字符串 → 转换为 number 后返回
 * - 无法转换 → 返回 undefined（调用方自行处理默认值）
 *
 * 处理了 NaN 和空字符串等边界情况，确保不会出现 NaN 污染。
 */
const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isNaN(value) ? undefined : value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

/**
 * 将 unknown 值安全转换为 string。
 *
 * - 已是 string → 直接返回
 * - 是 number 或 boolean → 调用 String() 转换
 * - 无法转换 → 返回 undefined
 */
const toString = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return undefined;
};

// =============================================================================
// 数据标准化
//
// 后端的表字段使用 snake_case 命名（如 real_name, create_time），
// 但部分接口可能返回 camelCase（realName, createTime）。
// normalizeUser 对两种命名风格都做兼容取值，统一输出 camelCase 的 UserRespDTO。
// =============================================================================

/**
 * 将后端返回的原始用户数据标准化为 UserRespDTO。
 *
 * 兼容策略：
 * - 字段取值时同时尝试 camelCase 和 snake_case 键名（例如 raw.realName ?? raw.real_name）
 * - 通过 toNumber / toString 进行类型安全转换，避免后端返回字符串数字时类型不匹配
 * - username 必填：如果标准化后 username 为空字符串，返回 null 表示解析失败
 *
 * @param raw - 后端返回的原始数据（unknown，需运行时校验）
 * @returns 标准化后的 UserRespDTO，解析失败返回 null
 */
const normalizeUser = (raw: unknown): UserRespDTO | null => {
  if (!isRecord(raw)) return null;

  const username = toString(raw.username) || "";
  if (!username) return null;

  return {
    id: toNumber(raw.id),
    username,
    // camelCase 优先，snake_case 兜底
    realName: toString(raw.realName ?? raw.real_name),
    phone: toString(raw.phone),
    mail: toString(raw.mail),
    avatar: toString(raw.avatar),
    deletionTime: toNumber(raw.deletionTime ?? raw.deletion_time),
    createTime: toString(raw.createTime ?? raw.create_time),
    updateTime: toString(raw.updateTime ?? raw.update_time),
    delFlag: toNumber(raw.delFlag ?? raw.del_flag) as 0 | 1 | undefined,
  };
};

/**
 * 从认证 Payload 中提取用户对象。
 *
 * 后端不同接口返回的用户对象位置不一致，本函数按优先级依次尝试：
 *   1. payload 本身是否就是用户对象（直接传给 normalizeUser）
 *   2. payload.user —— 最常见的嵌套路径
 *   3. payload.currentUser —— 部分旧接口使用的键名
 *
 * 一旦某个路径成功解析出有效 UserRespDTO 即返回，不再继续尝试。
 *
 * @param payload - 认证接口返回的完整 payload
 * @returns UserRespDTO 或 null（无法提取时）
 */
const extractUserFromAuthPayload = (payload: unknown): UserRespDTO | null => {
  // 先尝试直接解析（payload 本身就是用户对象，无嵌套）
  const direct = normalizeUser(payload);
  if (direct) return direct;

  // 再尝试从 payload.user 和 payload.currentUser 嵌套路径提取
  if (!isRecord(payload)) return null;
  return normalizeUser(payload.user) || normalizeUser(payload.currentUser);
};

/**
 * 从认证 Payload 中提取 Token 字符串。
 *
 * Token 字段名和位置可能因后端版本不同而变化，本函数按以下优先级尝试：
 *
 *   顶层（payload 根对象）：
 *     payload.token → payload.accessToken → payload.authToken
 *
 *   嵌套（payload.data 对象内）：
 *     payload.data.token → payload.data.accessToken → payload.data.authToken
 *
 * 获取到 Token 后会自动 trim() 去除首尾空格。
 *
 * @param payload - 认证接口返回的完整 payload
 * @returns Token 字符串或 null（未找到时）
 */
const extractTokenFromAuthPayload = (payload: unknown): string | null => {
  if (!isRecord(payload)) return null;

  // 第一优先级：顶层字段
  const directToken = toString(
    payload.token ?? payload.accessToken ?? payload.authToken,
  )?.trim();
  if (directToken) return directToken;

  // 第二优先级：data 嵌套对象内
  const nestedData = payload.data;
  if (isRecord(nestedData)) {
    const nestedToken = toString(
      nestedData.token ?? nestedData.accessToken ?? nestedData.authToken,
    )?.trim();
    if (nestedToken) return nestedToken;
  }

  return null;
};

// =============================================================================
// authService 对象 —— 对外暴露的认证 API 方法集合
//
// 每个方法对应后端 /xunzhi/v1/users/* 的一个端点。
// 方法签名使用项目中定义的 DTO 类型确保类型安全。
// login / checkLogin 成功后会通过 extractTokenFromAuthPayload
// 从响应中提取 Token 并写入 localStorage，后续请求通过 Axios 拦截器自动携带。
// =============================================================================

export const authService = {
  /**
   * 用户登录
   *
   * 发送用户名/密码到后端，成功后：
   * 1. 从响应 payload 中提取 Token 并存入 localStorage
   * 2. 从响应 payload 中提取用户信息并返回
   *
   * 注意：Token 和 user 缺一不可 —— 任一缺失都会抛出 Error，
   * 防止前端进入"登录成功但无凭据"的不一致状态。
   *
   * @param data - 登录请求体 { username, password }
   * @returns 标准化后的用户信息 UserRespDTO
   * @throws Error - Token 或用户信息缺失时
   */
  login: async (data: UserLoginReqDTO) => {
    const payload = await service.post<AuthPayloadDTO>(
      "/xunzhi/v1/users/login",
      data,
    );
    const token = extractTokenFromAuthPayload(payload);
    if (token) {
      setAuthToken(token);
    }

    const user = extractUserFromAuthPayload(payload);
    if (!user) {
      throw new Error("Login succeeded but user info is missing");
    }
    if (!token) {
      throw new Error("Login succeeded but token is missing");
    }
    return user;
  },

  /**
   * 用户注册
   *
   * 发送注册信息（用户名、密码、真实姓名、手机号、邮箱）到后端。
   * 与 login 不同，register 不自动设置 Token —— 注册成功后用户仍需手动登录。
   *
   * @param data - 注册请求体 UserRegisterReqDTO
   * @returns ResultVoid（成功为 null）
   */
  register: (data: UserRegisterReqDTO) => {
    return service.post<ResultVoid>("/xunzhi/v1/users/register", data);
  },

  /**
   * 检查登录状态（双token机制）
   *
   * 在应用启动时（App.tsx 初始化阶段）或 AuthGuard 鉴权时调用。
   *
   * **鉴权机制**：
   * 此接口在白名单（AUTH_FREE_API_PATHS）中，请求拦截器不会注入 Authorization
   * header，即请求时不携带 localStorage 中的 Token。后端通过 HTTP-only Cookie
   * （如 JSESSIONID）识别用户 —— Cookie 在登录时由后端 Set-Cookie 写入，
   * 浏览器自动附加到同域请求，JS 无法直接读写。因此即使前端 Token 丢失
   * （如清除了 localStorage），只要 Cookie 中的 Session 仍然有效，
   * 就能恢复登录态。
   *
   * 成功后：
   * 1. 如果响应中包含 Token，更新 localStorage（覆盖旧 Token 或首次写入）
   *    —— 这实现了"Cookie 有效 → 刷新 Token"的无感续期
   * 2. 返回当前登录用户的信息
   *
   * 失败时抛出 AppError(UNAUTHORIZED)，调用方据此判断是否需要跳转登录页。
   *
   * 注意：因为白名单机制，即使 localStorage 中没有 Token 也不会触发
   * 请求拦截器的 401 前置检查，因此可以在应用启动时安全调用而不会死循环。
   *
   * @returns 当前登录用户的 UserRespDTO
   * @throws AppError(UNAUTHORIZED) - 用户未登录或 Cookie/Session 已失效
   */
  checkLogin: async () => {
    const payload = await service.get<AuthPayloadDTO>(
      "/xunzhi/v1/users/check-login",
    );
    const token = extractTokenFromAuthPayload(payload);
    if (token) {
      setAuthToken(token);
    }

    const user = extractUserFromAuthPayload(payload);
    if (!user) {
      throw new AppError(ErrorCode.UNAUTHORIZED, "User is not logged in");
    }
    return user;
  },

  /**
   * 用户登出
   *
   * 向后端发送登出请求使服务端 session 失效，
   * 同时无论请求成功与否，通过 try/finally 确保清除本地 Token。
   *
   * 设计要点：finally 中的 clearAuthToken() 保证即使网络错误或
   * 后端异常，前端也会进入未登录状态，用户不会被"卡"在假登录中。
   *
   * @returns 登出结果（通常为 null）
   */
  logout: async () => {
    try {
      return await service.post<ResultVoid>("/xunzhi/v1/users/logout");
    } finally {
      clearAuthToken();
    }
  },

  /**
   * 获取指定用户的基本信息
   *
   * 根据用户名查询用户公开资料，不要求当前用户已登录（匿名可调用）。
   *
   * @param username - 目标用户名（URL 路径参数）
   * @returns 用户信息 UserRespDTO
   */
  getUser: (username: string) => {
    return service.get<UserRespDTO>(`/xunzhi/v1/users/${username}`);
  },

  /**
   * 获取指定用户的完整信息
   *
   * 与 getUser 的区别在于返回更详细的用户资料（UserActualRespDTO），
   * 路径中多一层 /actual 表示实际/完整信息。
   *
   * @param username - 目标用户名
   * @returns 用户完整信息 UserActualRespDTO
   */
  getUserActual: (username: string) => {
    return service.get<UserActualRespDTO>(
      `/xunzhi/v1/users/actual/${username}`,
    );
  },

  /**
   * 检查用户名是否已被占用
   *
   * 常用于注册表单中的实时校验（失焦触发），判断用户输入的用户名是否可用。
   * 通过 URL query parameter 传递 username。
   *
   * @param username - 待检查的用户名
   * @returns ResultBoolean —— true 表示已存在（不可用），false 表示可用
   */
  hasUsername: (username: string) => {
    return service.get<ResultBoolean>("/xunzhi/v1/users/has-username", {
      params: { username },
    });
  },
};
