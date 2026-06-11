/**
 * App.tsx — 应用根组件
 *
 * @module app/App
 *
 * ## 在架构中的位置
 *
 * 这是整个 React 应用的**逻辑入口**，在 `src/main.tsx` 中被挂载到 DOM。
 * 它的职责是串联三个核心决策：
 * 1. 启动时检查用户认证状态（Token 是否存在且有效）
 * 2. 认证就绪前显示 Loading 视图，避免"未登录用户先看到需要登录的页面再弹走"的闪烁
 * 3. 认证就绪后挂载完整的 React Router 路由树
 *
 * ## 启动时序
 *
 * ```
 * main.tsx
 *   └─ <Provider store={store}>          // Redux Store 注入
 *       └─ <QueryClientProvider>          // TanStack Query 注入
 *           └─ <App />                    // ← 当前文件
 *               ├─ [检查阶段] 读取 localStorage Token
 *               │    ├─ 无 Token → 直接完成初始化，渲染 Router
 *               │    └─ 有 Token → dispatch(checkAuthStatus())
 *               │         ├─ 成功 → userSlice 填充用户信息
 *               │         ├─ 失败 → Token 过期/无效，userSlice 保持未登录态
 *               │         └─ 无论成败 → setIsInitializing(false)
 *               │
 *               ├─ [Loading 视图] isInitializing=true 时显示居中 Spinner
 *               │
 *               └─ [就绪] 渲染 <RouterProvider router={appRouter} />
 *                    └─ router 内部通过 AuthGuard 组件对受保护路由做二次守卫
 * ```
 *
 * ## 为什么不直接在 router 里做认证检查？
 *
 * 如果 Token 不存在，AuthGuard 可以直接判定未登录。但 Token 存在时，
 * 我们需要调用后端 `/check-login` 接口确认 Token 是否仍然有效。
 * 这个 check 是**异步**的——router 已经挂载、AuthGuard 已经执行守卫逻辑时，
 * check 可能还没返回。这会导致路由闪烁：
 *   用户看到 AuthGuard 拒绝 → 跳转 /auth → check 返回有效 → 再跳回来
 *
 * 在 App 层**同步等待** check 完成后再挂载 router，就避免了这个问题。
 *
 * ## 为什么用 useState 而不用 Redux？
 *
 * `isInitializing` 只在 App 组件生命周期内有效（挂载后几秒内），
 * 不需要全局共享。放进 Redux 反而增加不必要的样板代码。
 *
 * ## 错误处理策略
 *
 * `checkAuthStatus` 失败时我们**吞掉错误**（只 console.log），
 * 因为失败原因通常是 Token 过期或用户未登录——这不是 bug，是正常流程。
 * 路由树照常挂载，AuthGuard 会在用户访问受保护路由时将其重定向到 /auth。
 */

import { useEffect, useState } from "react";
import { RouterProvider } from "react-router-dom";
import { appRouter } from "@/app/router";
import { useAppDispatch } from "@/store/hooks";
import { checkAuthStatus } from "@/store/slices/userSlice";
import { Loader2 } from "lucide-react";
import { getAuthToken } from "@/lib/authToken";

function App() {
  const dispatch = useAppDispatch();

  /**
   * 应用初始化状态。
   *
   * - `true`：正在检查登录态，显示 Loading 视图，不挂载路由树
   * - `false`：检查完成（无论是否登录），挂载路由树
   *
   * 设置为 `true` 的初始值保证了页面第一帧不会渲染 router，
   * 必须经过认证检查。
   */
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    /**
     * 从 localStorage 读取 Token 并向后端验证其有效性。
     *
     * 两种情况直接完成初始化（不发起请求）：
     * - localStorage 中没有 Token → 用户从未登录过
     * - localStorage 中有 Token 但后端判定已失效 → 静默失败，交由 AuthGuard 处理
     *
     * 注意：这里的 try/catch 只捕获 dispatch 本身的 reject（网络错误等），
     * `checkAuthStatus` 内部的 HTTP 错误（401 等）由 request.ts 的拦截器统一处理
     * 并通过 thunk reject 传播到这里。
     */
    const initAuth = async () => {
      const token = getAuthToken();
      if (!token) {
        // 无 Token：无需请求后端，立即完成初始化
        setIsInitializing(false);
        return;
      }

      try {
        // 调用 Redux thunk 验证 Token 有效性
        // .unwrap() 将 createAsyncThunk 的 result action 解包：
        //   fulfilled → 返回 payload
        //   rejected  → 抛出异常
        await dispatch(checkAuthStatus()).unwrap();
      } catch (error) {
        // 即使检查失败（Token 过期、网络错误等），也视为初始化完成。
        // 失败时不执行额外操作——userSlice 的 rejected reducer 已将 state 置为未登录态，
        // AuthGuard 会在路由层面拦截未登录用户。
        console.log("Auth check failed (expected if not logged in):", error);
      } finally {
        // 无论成功或失败，都必须解除 Loading 状态并挂载路由树
        setIsInitializing(false);
      }
    };
    initAuth();
  }, [dispatch]); // dispatch 引用稳定，effect 仅执行一次

  // ---- 初始化中：显示全屏 Loading ----

  if (isInitializing) {
    return (
      // h-screen w-screen：填充整个视口，不依赖父容器
      // bg-white：白色背景，避免深色主题闪烁（项目为亮色设计）
      // flex + items-center + justify-center：居中 Spinner
      <div className="h-screen w-screen flex items-center justify-center bg-white">
        {/*
         * Loader2 是 lucide-react 的动画图标，
         * animate-spin 用 Tailwind 的 CSS 动画驱动其旋转，
         * text-slate-400 柔和的灰色，不抢眼
         */}
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  // ---- 初始化完成：挂载路由树 ----

  // RouterProvider 是 React Router v7 的数据模式入口，
  // appRouter 定义在 @/app/router.tsx 中，包含完整的路由配置、
  // lazy 加载策略和 AuthGuard 守卫。
  return <RouterProvider router={appRouter} />;
}

export default App;
