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

const AuthPage = lazy(() => import("@/pages/auth/AuthPage"));
const HomePage = lazy(() => import("@/pages/chat/HomePage"));
const ChatPage = lazy(() => import("@/pages/chat/ChatPage"));
const InterviewIntroPage = lazy(
  () => import("@/pages/interview/InterviewIntroPage"),
);
const InterviewPage = lazy(() => import("@/pages/interview/InterviewPage"));
const InterviewReportPage = lazy(
  () => import("@/pages/interview/InterviewReportPage"),
);

function RouteLoadingScreen() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center bg-white">
      <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
    </div>
  );
}

const withRouteSuspense = (node: ReactNode) => (
  <Suspense fallback={<RouteLoadingScreen />}>{node}</Suspense>
);

export const appRoutes: RouteObject[] = [
  {
    path: ROUTES.home,
    element: <AppLayout />,
    children: [
      {
        path: ROUTES.auth,
        element: withRouteSuspense(<AuthPage />),
      },
      {
        element: <AuthGuard />,
        children: [
          {
            index: true,
            element: withRouteSuspense(<HomePage />),
          },
          {
            path: ROUTES.interviewIntro,
            element: withRouteSuspense(<InterviewIntroPage />),
          },
          {
            path: ROUTES.interviewRoom,
            element: withRouteSuspense(<InterviewPage />),
          },
          {
            path: `${ROUTES.interviewRoom}/:sessionId`,
            element: withRouteSuspense(<InterviewPage />),
          },
          {
            path: ROUTES.interviewReport,
            element: withRouteSuspense(<InterviewReportPage />),
          },
          {
            path: `${ROUTES.chat}/:sessionId?`,
            element: withRouteSuspense(<ChatPage />),
          },
          {
            path: ROUTES.questionBank,
            element: <Navigate to={ROUTES.home} replace />,
          },
          {
            path: ROUTES.questionBankManage,
            element: <Navigate to={ROUTES.home} replace />,
          },
        ],
      },
    ],
  },
];

export const appRouter = createBrowserRouter(appRoutes);
