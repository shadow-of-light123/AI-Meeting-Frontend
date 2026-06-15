/**
 * Redux Store 配置入口。
 *
 * 职责：
 * 1. 使用 configureStore 创建全局唯一的 Store 实例
 * 2. 将所有 Slice 的 reducer 组合为全局 state 树
 * 3. 导出 RootState 和 AppDispatch 类型，供整个应用的类型安全使用
 *
 * 当前注册的 Slice：
 * - user：用户认证状态（登录/登出/Token 校验）
 * - chat：聊天运行时状态（消息列表/流式状态/会话信息）
 *
 * 新增 Slice 时在此添加 reducer 键值对即可自动接入全局 state。
 */

import { configureStore } from "@reduxjs/toolkit";
import userReducer from "./slices/userSlice";
import chatReducer from "./slices/chatSlice";

/**
 * 全局 Store 实例。
 *
 * configureStore 内部自动完成：
 * - 组合多个 reducer（通过 reducer 对象的 key 映射到 state 的一级字段）
 * - 添加 redux-thunk 中间件（支持 dispatch 接收函数/异步 thunk）
 * - 启用 Redux DevTools 浏览器插件（仅非生产环境）
 */
export const store = configureStore({
  reducer: {
    user: userReducer, // state.user → userSlice 管理
    chat: chatReducer, // state.chat → chatSlice 管理
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware(),
  devTools: process.env.NODE_ENV !== "production",
});

/**
 * 全局 State 树的 TypeScript 类型。
 *
 * ReturnType<typeof store.getState> 确保类型始终与实际的 reducer 组合保持同步，
 * 无需手动维护 State 接口定义。
 *
 * 使用示例：
 * ```ts
 * const messages = useAppSelector((state: RootState) => state.chat.messages);
 * ```
 */
export type RootState = ReturnType<typeof store.getState>;

/**
 * Dispatch 函数的 TypeScript 类型。
 *
 * 已包含 thunk 中间件的类型信息，因此 dispatch 可以接收：
 * - 同步 action 对象（{ type, payload }）
 * - createAsyncThunk 返回的 thunk 函数
 *
 * 用于 useAppDispatch 的类型定义。
 */
export type AppDispatch = typeof store.dispatch;
