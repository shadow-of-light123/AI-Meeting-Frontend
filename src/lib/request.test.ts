import type { AxiosError } from "axios";
import { describe, expect, it } from "vitest";
import { AppError, ErrorCode } from "@/lib/errors";
import {
  buildApiUrl,
  mapAxiosErrorToAppError,
  unwrapResponseData,
} from "@/lib/request";

describe("request utilities", () => {
  it("buildApiUrl should append query params and skip empty values", () => {
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

  it("unwrapResponseData should return base response data for success payload", () => {
    const result = unwrapResponseData({
      code: "0",
      message: null,
      data: { ok: true },
      requestId: "r1",
      success: false,
    });

    expect(result).toEqual({ ok: true });
  });

  it("unwrapResponseData should return raw payload for non-base response", () => {
    const result = unwrapResponseData({ plain: true });
    expect(result).toEqual({ plain: true });
  });

  it("unwrapResponseData should throw AppError for failed business response", () => {
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

  it("mapAxiosErrorToAppError should map http status codes", () => {
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

  it("mapAxiosErrorToAppError should map timeout and cancellation", () => {
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
});
