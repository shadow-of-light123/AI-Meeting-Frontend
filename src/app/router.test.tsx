import { render, screen } from "@testing-library/react";
import { Outlet, RouterProvider, createMemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { appRoutes } from "@/app/router";

vi.mock("@/layouts/AppLayout", () => ({
  default: function MockAppLayout() {
    return (
      <div data-testid="app-layout">
        <Outlet />
      </div>
    );
  },
}));

vi.mock("@/components/auth/AuthGuard", () => ({
  default: function MockAuthGuard() {
    return <Outlet />;
  },
}));

vi.mock("@/pages/auth/AuthPage", () => ({
  default: function MockAuthPage() {
    return <div>auth-page</div>;
  },
}));

vi.mock("@/pages/chat/ChatPage", () => ({
  default: function MockChatPage() {
    return <div>chat-page</div>;
  },
}));

vi.mock("@/pages/chat/HomePage", () => ({
  default: function MockHomePage() {
    return <div>home-page</div>;
  },
}));

vi.mock("@/pages/interview/InterviewIntroPage", () => ({
  default: function MockInterviewIntroPage() {
    return <div>interview-intro-page</div>;
  },
}));

vi.mock("@/pages/interview/InterviewPage", () => ({
  default: function MockInterviewPage() {
    return <div>interview-page</div>;
  },
}));

vi.mock("@/pages/interview/InterviewReportPage", () => ({
  default: function MockInterviewReportPage() {
    return <div>interview-report-page</div>;
  },
}));

describe("appRoutes", () => {
  it("loads the auth route lazily", async () => {
    const router = createMemoryRouter(appRoutes, {
      initialEntries: ["/auth"],
    });

    render(<RouterProvider router={router} />);

    expect(await screen.findByText("auth-page")).toBeDefined();
    expect(screen.getByTestId("app-layout")).toBeDefined();
  });

  it("loads authenticated chat routes lazily", async () => {
    const router = createMemoryRouter(appRoutes, {
      initialEntries: ["/chat/session-1"],
    });

    render(<RouterProvider router={router} />);

    expect(await screen.findByText("chat-page")).toBeDefined();
  });
});
