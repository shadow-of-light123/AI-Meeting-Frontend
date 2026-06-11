/**
 * 应用路由配置
 *
 * 本文件定义了整个前端应用的路由树，采用 React Router v7 的 createBrowserRouter
 * 实现客户端路由。所有页面组件通过 React.lazy 进行代码分割，按需加载以减少首屏
 * 包体积。需要登录的页面由 AuthGuard 组件保护，未认证用户会被重定向到登录页。
 *
 * 路由结构一览：
 *
 *   / (AppLayout)                          — 根布局，包含侧边栏 + 内容区
 *   ├── / (index)                          — 首页（营销落地页），无需登录
 *   ├── /auth                              — 登录/注册页，无需登录
 *   └── (AuthGuard)                        — ▼ 以下路由均需登录 ▼
 *       ├── /interview                     — 面试引导页（上传简历、开始面试）
 *       ├── /interview/room                — 面试房间（无 sessionId，新建会话）
 *       ├── /interview/room/:sessionId     — 面试房间（恢复已有会话）
 *       ├── /interview/report              — 面试报告列表页
 *       ├── /interview/report/detail       — 面试报告详情页
 *       ├── /chat/:sessionId?              — AI 对话页（sessionId 可选）
 *       ├── /question-bank                 — （暂未实现，重定向到 /chat）
 *       └── /question-bank/manage          — （暂未实现，重定向到 /chat）
 */

import { Suspense, lazy, type ReactNode } from "react";
import {
  Navigate,
  createBrowserRouter,
  type RouteObject,
} from "react-router-dom";
import { Loader2 } from "lucide-react";
import AuthGuard from "@/components/auth/AuthGuard";
import AppLayout from "@/layouts/AppLayout";
import { ROUTES } from "@/lib/constants";

// =============================================================================
// 懒加载页面组件
// 每个页面独立为一个 chunk，Vite 构建时会自动拆分为独立的 JS 文件，
// 用户导航到对应路由时才会发起网络请求加载该页面代码。
// =============================================================================

/** 登录/注册页面 */
const AuthPage = lazy(() => import("@/pages/auth/AuthPage"));

/** 首页 —— 营销落地页，面向未登录用户展示产品介绍和快捷入口 */
const MarketingHomePage = lazy(
  () => import("@/pages/marketing/MarketingHomePage"),
);

/** AI 对话页面 —— 与 AI 助手进行多轮对话，支持流式响应 */
const ChatPage = lazy(() => import("@/pages/chat/ChatPage"));

/** 面试引导页 —— 上传简历、选择面试方向、开始模拟面试 */
const InterviewIntroPage = lazy(
  () => import("@/pages/interview/InterviewIntroPage"),
);

/** 面试房间页面 —— 实时模拟面试的核心页面，支持语音/文字答题 */
const InterviewPage = lazy(() => import("@/pages/interview/InterviewPage"));

/** 面试报告列表页 —— 展示历史面试记录和成绩概览 */
const InterviewReportPage = lazy(
  () => import("@/pages/interview/InterviewReportPage"),
);

/** 面试报告详情页 —— 查看单次面试的详细报告（含雷达图、答题回放） */
const InterviewReportDetailPage = lazy(
  () => import("@/pages/interview/InterviewReportDetailPage"),
);

// =============================================================================
// Suspense 回退组件
// 在懒加载页面 chunk 尚未下载完成时，显示居中 Loading 动画作为占位。
// =============================================================================

/**
 * 路由加载中占位组件
 *
 * 当用户首次导航到某个懒加载路由时，页面对应的 JS bundle 尚未下载完成，
 * Suspense 会捕获组件中抛出的 Promise 并渲染此 fallback，直到加载完成。
 * 使用 min-h-[40vh] 而非全屏高度，避免 AppLayout 侧边栏下的闪烁感。
 */
function RouteLoadingScreen() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center bg-white">
      <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
    </div>
  );
}

/**
 * 用 Suspense 包裹路由节点的便捷函数
 *
 * 每个路由的 element 都通过此函数包裹，确保懒加载的页面组件在加载期间
 * 显示统一的 Loading 占位，而非空白页面。
 *
 * @param node - 路由对应的 React 节点（通常是一个 JSX 页面组件）
 * @returns 包裹了 Suspense fallback 的 React 节点
 */
const withRouteSuspense = (node: ReactNode) => (
  <Suspense fallback={<RouteLoadingScreen />}>{node}</Suspense>
);

// =============================================================================
// 路由定义
// 采用 React Router v7 的 RouteObject[] 配置式路由，类型安全且易于维护。
// =============================================================================

/**
 * 应用路由树配置
 *
 * 设计要点：
 * 1. 所有页面共享 AppLayout 作为根布局，提供统一的侧边栏导航和移动端抽屉
 * 2. 公开路由（首页、登录）直接放在 AppLayout 的 children 中，无认证限制
 * 3. 需要登录的路由统一包裹在 AuthGuard 的 children 中，实现集中式权限控制
 * 4. 面试房间和对话页使用 URL 参数传递资源 ID：
 *    - :sessionId —— 面试或对话的会话 ID，用于恢复历史会话
 *    - ? 后缀表示该参数可选（如 /chat 不传 sessionId 表示新建对话）
 * 5. 题库相关路由（question-bank）暂未实现，使用 Navigate 重定向到 /chat
 */
export const appRoutes: RouteObject[] = [
  {
    /** 根路径 "/"，渲染 AppLayout 布局壳 */
    path: ROUTES.home,
    element: <AppLayout />,

    /**
     * 子路由在 AppLayout 的 <Outlet /> 中渲染。
     * 路由匹配顺序：React Router 按 children 数组的声明顺序匹配，
     * 因此将 index 路由放在最前面确保首页优先级最高。
     */
    children: [
      // =========================================================================
      // 公开路由 —— 无需登录即可访问
      // =========================================================================

      {
        /**
         * 首页（index 路由）
         *
         * index: true 表示当 URL 精确匹配父路径（"/"）时渲染此路由，
         * 无需指定 path 字段。这是面向未登录用户的营销落地页。
         */
        index: true,
        element: withRouteSuspense(<MarketingHomePage />),
      },
      {
        /**
         * 登录/注册页 —— "/auth"
         *
         * 已登录用户访问此路由时，AuthGuard 内部逻辑会自动重定向到首页，
         * 因此正常情况下登录用户不会看到此页面。
         */
        path: ROUTES.auth,
        element: withRouteSuspense(<AuthPage />),
      },

      // =========================================================================
      // 受保护路由 —— AuthGuard 包裹，未登录自动重定向到 /auth
      //
      // AuthGuard 组件内部调用 checkLoginStatus API 验证 Token 有效性：
      // - 已登录：渲染 <Outlet /> 展示子路由内容
      // - 未登录：渲染 <Navigate to="/auth" replace /> 跳转到登录页
      // - 验证中：显示 Loading 状态，避免闪烁
      // =========================================================================
      {
        /** AuthGuard 本身不定义 path，仅作为 layout route 提供认证守卫 */
        element: <AuthGuard />,
        children: [
          {
            /**
             * 面试引导页 —— "/interview"
             *
             * 功能：上传简历（PDF）、选择面试方向、点击"开始面试"进入面试房间。
             * 这是模拟面试的入口页面，引导用户完成面试前的准备步骤。
             */
            path: ROUTES.interviewIntro,
            element: withRouteSuspense(<InterviewIntroPage />),
          },
          {
            /**
             * 面试房间（新建会话） —— "/interview/room"
             *
             * 不带 sessionId 参数，表示创建一场全新的模拟面试。
             * 进入后 InterviewPage 会初始化新的面试会话流程。
             */
            path: ROUTES.interviewRoom,
            element: withRouteSuspense(<InterviewPage />),
          },
          {
            /**
             * 面试房间（恢复会话） —— "/interview/room/:sessionId"
             *
             * URL 中的 :sessionId 动态参数用于恢复之前中断的面试。
             * 常见场景：用户在面试中途刷新页面或关闭标签页后重新进入，
             * 通过 restoreInterviewSession API 恢复答题进度和对话历史。
             */
            path: `${ROUTES.interviewRoom}/:sessionId`,
            element: withRouteSuspense(<InterviewPage />),
          },
          {
            /**
             * 面试报告列表 —— "/interview/report"
             *
             * 展示用户所有已完成面试的记录列表，通常包含：
             * 面试时间、综合评分、各维度得分概览等摘要信息。
             * 点击某条记录可进入报告详情页。
             */
            path: ROUTES.interviewReport,
            element: withRouteSuspense(<InterviewReportPage />),
          },
          {
            /**
             * 面试报告详情 —— "/interview/report/detail"
             *
             * 展示单次面试的详细分析报告，包括：
             * - 雷达图（多维度能力评估）
             * - 逐题得分与 AI 点评
             * - 神态/语气分析结果
             * - 答题录音/录像回放
             */
            path: ROUTES.interviewReportDetail,
            element: withRouteSuspense(<InterviewReportDetailPage />),
          },
          {
            /**
             * AI 对话页 —— "/chat/:sessionId?"
             *
             * sessionId 为可选参数（? 后缀表示可选）：
             * - /chat          → 新建对话，ChatPage 创建新的 chat session
             * - /chat/abc123   → 恢复已有对话，加载历史消息记录
             *
             * 支持 Markdown 渲染、代码高亮、推理面板展示（ReasoningPanel）
             * 和 SSE 流式响应逐字输出。
             */
            path: `${ROUTES.chat}/:sessionId?`,
            element: withRouteSuspense(<ChatPage />),
          },
          {
            /**
             * 题库页面 —— 暂未实现，重定向到 /chat
             *
             * TODO: 后续实现独立的题库浏览和练习功能后移除此重定向。
             */
            path: ROUTES.questionBank,
            element: <Navigate to={ROUTES.chat} replace />,
          },
          {
            /**
             * 题库管理页面 —— 暂未实现，重定向到 /chat
             *
             * TODO: 后续实现题库 CRUD 管理功能后移除此重定向。
             */
            path: ROUTES.questionBankManage,
            element: <Navigate to={ROUTES.chat} replace />,
          },
        ],
      },
    ],
  },
];

/**
 * 应用路由器实例
 *
 * 由 createBrowserRouter 创建，使用 HTML5 History API 实现客户端路由。
 * 该实例被传入 App.tsx 中的 RouterProvider，驱动整个应用的路由导航。
 *
 * 注意：使用 createBrowserRouter 而非 <BrowserRouter> 组件方式，
 * 是因为配置式路由在类型安全、代码拆分和错误边界方面有更好的支持。
 */
export const appRouter = createBrowserRouter(appRoutes);
