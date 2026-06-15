/**
 * 用户认证 Slice —— 管理登录态、用户信息、Token 校验的完整生命周期。
 *
 * ## 状态设计
 *
 * State 包含五个字段：
 * - currentUser：当前登录用户的信息（null = 未登录）
 * - isAuthenticated：认证成功的标记，用于路由守卫快速判断
 * - loading：是否正在进行认证相关的异步操作
 * - error：最近一次认证失败的错误消息
 * - authEpoch：身份变更版本号，每次登录/登出/身份切换时自增，
 *   用于让依赖用户身份的 React Query 失效缓存
 *
 * ## authEpoch 的设计意图
 *
 * 用户 A 登录 → authEpoch = 1
 * 用户 A 登出 → authEpoch = 2
 * 用户 B 登录 → authEpoch = 3
 *
 * 会话列表等 React Query 缓存将 authEpoch 作为 queryKey 的一部分：
 * ```ts
 * queryKey: ["conversations", userKey, authEpoch]
 * ```
 * authEpoch 变化 → queryKey 变化 → React Query 自动重新请求数据，
 * 确保切换用户后不会看到上一个用户的缓存数据。
 *
 * ## Thunk 列表
 *
 * - loginUser：发送登录请求，成功后写入用户信息
 * - checkAuthStatus：启动时验证 localStorage Token 是否仍然有效
 * - logoutUser：通知后端登出，清除客户端认证状态
 */

import { createAsyncThunk, createSlice } from "@reduxjs/toolkit";
import { clearAuthToken } from "@/lib/authToken";
import { AppError, ErrorCode } from "@/lib/errors";
import { authService } from "@/services/authService";
import type { UserLoginReqDTO, UserRespDTO } from "@/types/auth";

// ─── State 类型与初始值 ───

interface UserState {
  /** 当前登录用户信息，null 表示未登录 */
  currentUser: UserRespDTO | null;
  /** 后端 Token 是否有效 */
  isAuthenticated: boolean;
  /** 是否正在进行登录/登出/Token 校验 */
  loading: boolean;
  /** 最近一次认证操作失败的错误信息 */
  error: string | null;
  /** 身份变更版本号：每次登录、登出、身份切换时 +1 */
  authEpoch: number;
}

const initialState: UserState = {
  currentUser: null,
  isAuthenticated: false,
  loading: false,
  error: null,
  authEpoch: 0,
};

// ─── 工具函数 ───

/**
 * 获取用户身份唯一标识字符串。
 *
 * 用于判断当前用户是否发生了变化：
 * - 未登录 → "anonymous"
 * - 已登录 → "{userId}:{username}"
 *
 * 比较新旧 identity 可判断是否需要递增 authEpoch。
 */
const getUserIdentityKey = (user: UserRespDTO | null) => {
  if (!user) {
    return "anonymous";
  }
  return `${user.id ?? "none"}:${user.username}`;
};

// ─── rejectValue 类型 ───

/** checkAuthStatus 的 reject 载荷，区分"不可恢复的错误"和"Token 过期" */
type AuthStatusRejectValue = {
  message: string;
  /** 是否需要清除客户端 Token（401/403 时清除，网络错误时保留） */
  shouldClearAuth: boolean;
};

// ─── Thunk 定义 ───

/**
 * 登录 thunk。
 *
 * 调用 authService.login 向后端发送用户名/密码，
 * 成功后返回 UserRespDTO，失败时通过 rejectWithValue 传递错误消息。
 *
 * createAsyncThunk 泛型：
 *   第一参数：fulfilled 时 action.payload 的类型（UserRespDTO）
 *   第二参数：调用 loginUser(data) 时 data 的类型（UserLoginReqDTO）
 *   第三参数：thunkAPI 配置，rejectValue 为 rejected 时 action.payload 的类型
 */
export const loginUser = createAsyncThunk<
  UserRespDTO,
  UserLoginReqDTO,
  { rejectValue: string }
>("user/login", async (data, { rejectWithValue }) => {
  try {
    return await authService.login(data);
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Login failed";
    return rejectWithValue(errorMessage);
  }
});

/**
 * Token 校验 thunk（应用启动时调用）。
 *
 * 调用 authService.checkLogin 验证 localStorage 中 Token 的有效性。
 *
 * 错误区分策略：
 * - 401/403 → shouldClearAuth = true，清除本地 Token
 * - 其他错误（网络中断等）→ shouldClearAuth = false，保留 Token 以便重试
 *
 * AppError.from(error) 是项目的统一错误处理工具，
 * 能将 axios 错误、网络错误等统一转为带有 ErrorCode 的 AppError 实例。
 */
export const checkAuthStatus = createAsyncThunk<
  UserRespDTO,
  void,
  { rejectValue: AuthStatusRejectValue }
>("user/checkAuth", async (_, { rejectWithValue }) => {
  try {
    return await authService.checkLogin();
  } catch (error: unknown) {
    const appError = AppError.from(error);
    return rejectWithValue({
      message: appError.message || "Failed to check authentication status",
      shouldClearAuth:
        appError.code === ErrorCode.UNAUTHORIZED ||
        appError.code === ErrorCode.FORBIDDEN,
    });
  }
});

/**
 * 登出 thunk。
 *
 * 先调用 authService.logout 通知后端（即使失败也继续清除本地状态），
 * Redux 状态由 extraReducers 中的 logoutUser.fulfilled 统一处理。
 */
export const logoutUser = createAsyncThunk<void, void, { rejectValue: string }>(
  "user/logout",
  async (_, { rejectWithValue }) => {
    try {
      await authService.logout();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Logout failed";
      return rejectWithValue(errorMessage);
    }
  },
);

// ─── Slice 定义 ───

export const userSlice = createSlice({
  name: "user",
  initialState,
  reducers: {
    /** 清除错误信息（常用于用户切换表单输入时） */
    clearError: (state) => {
      state.error = null;
    },
  },
  /**
   * extraReducers：响应三个 thunk 的 pending / fulfilled / rejected action。
   *
   * builder.addCase() 按 thunk 名称分组，每个 thunk 三个生命周期：
   * - pending：请求发出前（设置 loading，清除旧 error）
   * - fulfilled：请求成功（写入数据，标记已认证）
   * - rejected：请求失败（记录错误，必要时清除认证状态）
   */
  extraReducers: (builder) => {
    builder
      // ── loginUser ──
      .addCase(loginUser.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(loginUser.fulfilled, (state, action) => {
        state.loading = false;
        state.error = null;
        state.isAuthenticated = true;
        state.currentUser = action.payload;
        state.authEpoch += 1; // 身份变更，通知 React Query 刷新
      })
      .addCase(loginUser.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? "Login failed";
      })

      // ── checkAuthStatus ──
      .addCase(checkAuthStatus.fulfilled, (state, action) => {
        const prevIdentity = getUserIdentityKey(state.currentUser);
        const nextIdentity = getUserIdentityKey(action.payload);

        state.isAuthenticated = true;
        state.currentUser = action.payload;
        state.error = null;

        // 仅当用户身份真正变化时才递增 authEpoch
        // 避免同一用户重复进入页面时无效刷新
        if (prevIdentity !== nextIdentity) {
          state.authEpoch += 1;
        }
      })
      .addCase(checkAuthStatus.rejected, (state, action) => {
        state.loading = false;
        state.error =
          action.payload?.message ?? "Failed to check authentication status";

        // 网络错误等保留 Token，不清除认证状态
        if (!action.payload?.shouldClearAuth) {
          return;
        }

        // Token 过期 / 无效 → 彻底清除认证状态
        clearAuthToken();
        if (state.isAuthenticated || state.currentUser) {
          state.authEpoch += 1;
        }
        state.isAuthenticated = false;
        state.currentUser = null;
      })

      // ── logoutUser ──
      .addCase(logoutUser.fulfilled, (state) => {
        state.isAuthenticated = false;
        state.currentUser = null;
        state.loading = false;
        state.error = null;
        state.authEpoch += 1; // 登出也是身份变更
      })
      .addCase(logoutUser.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? "Logout failed";
      });
  },
});

export const { clearError } = userSlice.actions;
export default userSlice.reducer;
