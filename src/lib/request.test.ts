import type { AxiosError } from "axios";
import { describe, expect, it, vi } from "vitest";
import { getAuthToken } from "@/lib/authToken";
import { AppError, ErrorCode } from "@/lib/errors";
import {
  assertRequestAuthorized,
  buildRequestPolicyKey,
  buildApiUrl,
  mapAxiosErrorToAppError,
  requiresAuthTokenForRequest,
  resolveRequestPolicy,
  unwrapResponseData,
} from "@/lib/request";

vi.mock("@/lib/authToken", () => ({
  getAuthToken: vi.fn(),
}));

describe("请求工具函数", () => {
  it("受保护的业务端点需要认证令牌", () => {
    expect(requiresAuthTokenForRequest("/xunzhi/v1/interview/sessions")).toBe(
      true,
    );
    expect(requiresAuthTokenForRequest("/xunzhi/v1/users/login")).toBe(false);
  });

  it("当受保护端点没有令牌时，在请求前抛出未授权错误", () => {
    vi.mocked(getAuthToken).mockReturnValue(null);

    expect(() =>
      assertRequestAuthorized("/xunzhi/v1/interview/sessions"),
    ).toThrow(AppError);
    expect(() =>
      assertRequestAuthorized("/xunzhi/v1/interview/sessions"),
    ).toThrow("Unauthorized");
  });

  it("当令牌存在时，允许访问受保护端点", () => {
    vi.mocked(getAuthToken).mockReturnValue("token-value");

    expect(assertRequestAuthorized("/xunzhi/v1/interview/sessions")).toBe(
      "token-value",
    );
  });

  it("buildApiUrl 应追加查询参数并跳过空值", () => {
    const url = buildApiUrl("/hello", {
      a: 1,
      b: true,
      c: "",
      d: undefined,
      e: null,
    });

    expect(url).toContain("/api/hello");
    expect(url).toContain("a=1");
    expect(url).toContain("b=true");
    expect(url).not.toContain("c=");
    expect(url).not.toContain("d=");
    expect(url).not.toContain("e=");
  });

  it("unwrapResponseData 应返回成功响应的 data 字段", () => {
    const result = unwrapResponseData({
      code: "0",
      message: null,
      data: { ok: true },
      requestId: "r1",
      success: false,
    });

    expect(result).toEqual({ ok: true });
  });

  it("unwrapResponseData 对于非标准响应应返回原始 payload", () => {
    const result = unwrapResponseData({ plain: true });
    expect(result).toEqual({ plain: true });
  });

  it("unwrapResponseData 应在业务响应失败时抛出 AppError", () => {
    expect(() =>
      unwrapResponseData({
        code: "403",
        message: "forbidden",
        data: null,
        requestId: "r2",
        success: false,
      }),
    ).toThrow(AppError);

    try {
      unwrapResponseData({
        code: "403",
        message: "forbidden",
        data: null,
        requestId: "r2",
        success: false,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it("mapAxiosErrorToAppError 应映射 HTTP 状态码", () => {
    const axiosError = {
      message: "Not Found",
      response: {
        status: 404,
      },
    } as AxiosError;

    const mapped = mapAxiosErrorToAppError(axiosError);
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
  });

  it("mapAxiosErrorToAppError 应映射超时和取消错误", () => {
    const timeoutError = {
      message: "timeout",
      code: "ECONNABORTED",
    } as AxiosError;
    expect(mapAxiosErrorToAppError(timeoutError).code).toBe(
      ErrorCode.REQUEST_TIMEOUT,
    );

    const cancelError = {
      message: "cancelled",
      __CANCEL__: true,
    } as unknown as AxiosError;
    expect(mapAxiosErrorToAppError(cancelError).code).toBe(ErrorCode.ABORTED);
  });

  it("resolveRequestPolicy 应默认为 GET 合并请求和 POST 关闭策略", () => {
    expect(resolveRequestPolicy("GET")).toEqual({
      dedupe: "join",
      debounceMs: 0,
      key: undefined,
    });
    expect(resolveRequestPolicy("POST")).toEqual({
      dedupe: "off",
      debounceMs: 0,
      key: undefined,
    });
  });

  it("buildRequestPolicyKey 应对语义相同的 payload 生成稳定的键", () => {
    const keyA = buildRequestPolicyKey({
      method: "post",
      url: "/xunzhi/v1/interview/sessions",
      params: {
        page: 1,
        size: 20,
      },
      data: {
        b: 2,
        a: 1,
      },
    });
    const keyB = buildRequestPolicyKey({
      method: "POST",
      url: "/xunzhi/v1/interview/sessions",
      params: {
        size: 20,
        page: 1,
      },
      data: {
        a: 1,
        b: 2,
      },
    });
    expect(keyA).toBe(keyB);
  });
});
