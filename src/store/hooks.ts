/**
 * Redux 类型安全 Hooks。
 *
 * 封装原生的 useDispatch / useSelector，注入 RootState 和 AppDispatch 类型。
 * 全项目统一使用这两个 Hook，不要直接导入 react-redux 的 useDispatch / useSelector。
 *
 * 为什么需要封装？
 * - 原生的 useDispatch 返回的 dispatch 函数不知道 thunk 的类型信息
 * - 原生的 useSelector 不知道全局 state 的类型结构
 * - 每次组件中都手写类型注解既繁琐又容易出错
 * - 一处封装，全局受益
 */

import {
  type TypedUseSelectorHook,
  useDispatch,
  useSelector,
} from "react-redux";
import type { RootState, AppDispatch } from "./index";

/**
 * 类型安全的 dispatch Hook。
 *
 * 返回的 dispatch 函数已包含完整的 AppDispatch 类型：
 * - 能接收同步 action creator（如 dispatch(resetChatRuntime())）
 * - 能接收异步 thunk（如 dispatch(checkAuthStatus())）
 * - 参数类型检查（缺少必填字段或类型不匹配会报编译错误）
 *
 * 使用示例：
 * ```ts
 * const dispatch = useAppDispatch();
 * dispatch(appendUserMessage(message));  // message 会自动校验类型
 * ```
 */
export const useAppDispatch = () => useDispatch<AppDispatch>();

/**
 * 类型安全的 selector Hook。
 *
 * 选择器回调函数的参数 state 自动具有 RootState 类型，
 * 因此 state.chat.messages、state.user.currentUser 等都有完整的类型推导和智能提示。
 *
 * 当 selector 返回的值发生变化（浅比较）时，组件自动重渲染。
 *
 * 使用示例：
 * ```ts
 * const messages = useAppSelector((state) => state.chat.messages);
 * const currentUser = useAppSelector((state) => state.user.currentUser);
 * ```
 */
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
