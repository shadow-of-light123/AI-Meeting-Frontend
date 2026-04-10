import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import { resolveAppEnv } from "@/config/env";
import {
  AppError,
  ErrorCode,
  type ErrorCode as ErrorCodeValue,
} from "@/lib/errors";
import { getAuthToken } from "@/lib/authToken";

export interface BaseResponse<T = unknown> {
  code: string;
  message: string | null;
  data: T;
  requestId: string | null;
  success: boolean;
}

export type ApiResponse<T = unknown> = BaseResponse<T>;

export interface HttpClient {
  get<T>(url: string, config?: AxiosRequestConfig): Promise<T>;
  delete<T>(url: string, config?: AxiosRequestConfig): Promise<T>;
  post<T, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<T>;
  put<T, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<T>;
  patch<T, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<T>;
}

export const getApiBaseUrl = () => resolveAppEnv().apiBaseUrl;

export const buildApiUrl = (
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
) => {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const baseUrl = `${getApiBaseUrl()}${normalizedPath}`;

  if (!query) {
    return baseUrl;
  }

  const searchParams = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }
    searchParams.set(key, String(value));
  });

  const queryString = searchParams.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
};

export const mapBusinessCode = (code: string | undefined): ErrorCodeValue => {
  switch (code) {
    case "401":
      return ErrorCode.UNAUTHORIZED;
    case "403":
      return ErrorCode.FORBIDDEN;
    default:
      return ErrorCode.OPERATION_FAILED;
  }
};

export const isBaseResponse = <T>(
  payload: unknown,
): payload is BaseResponse<T> => {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return "data" in payload && ("code" in payload || "success" in payload);
};

export const unwrapResponseData = <T>(payload: BaseResponse<T> | T): T => {
  if (isBaseResponse<T>(payload)) {
    if (payload.code === "0" || payload.success) {
      return payload.data;
    }

    throw new AppError(
      mapBusinessCode(payload.code),
      payload.message || "Request failed",
      payload,
    );
  }

  return payload;
};

export const unwrapResponse = <T>(
  response: AxiosResponse<BaseResponse<T> | T>,
): T => {
  return unwrapResponseData(response.data);
};

export const mapAxiosErrorToAppError = (error: AxiosError): AppError => {
  if (axios.isCancel(error)) {
    return new AppError(ErrorCode.ABORTED, "Request was cancelled", error);
  }

  if (error.response) {
    switch (error.response.status) {
      case 400:
        return new AppError(
          ErrorCode.INVALID_PARAMS,
          "Invalid request parameters",
          error,
        );
      case 401:
        return new AppError(
          ErrorCode.UNAUTHORIZED,
          "Unauthorized. Please sign in again.",
          error,
        );
      case 403:
        return new AppError(ErrorCode.FORBIDDEN, "Permission denied", error);
      case 404:
        return new AppError(
          ErrorCode.RESOURCE_NOT_FOUND,
          "Requested resource not found",
          error,
        );
      case 500:
        return new AppError(
          ErrorCode.UNKNOWN_ERROR,
          "Internal server error",
          error,
        );
      default:
        return new AppError(
          ErrorCode.UNKNOWN_ERROR,
          `Request failed with status ${error.response.status}`,
          error,
        );
    }
  }

  if (error.code === "ECONNABORTED") {
    return new AppError(ErrorCode.REQUEST_TIMEOUT, "Request timeout", error);
  }

  if (typeof window !== "undefined" && !window.navigator.onLine) {
    return new AppError(
      ErrorCode.NETWORK_ERROR,
      "Network disconnected. Please check your connection.",
      error,
    );
  }

  return new AppError(
    ErrorCode.NETWORK_ERROR,
    error.message || "Network request failed",
    error,
  );
};

export const createAxiosClient = (): AxiosInstance => {
  return axios.create({
    baseURL: getApiBaseUrl(),
    timeout: 10_000,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
    },
  });
};

const axiosInstance = createAxiosClient();

axiosInstance.interceptors.request.use(
  (config) => {
    const token = getAuthToken();
    if (!token) {
      return config;
    }

    const headers = new AxiosHeaders(config.headers);
    headers.set("Authorization", `Bearer ${token}`);
    config.headers = headers;

    return config;
  },
  (error) =>
    Promise.reject(
      new AppError(ErrorCode.UNKNOWN_ERROR, "Failed to send request", error),
    ),
);

axiosInstance.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => Promise.reject(mapAxiosErrorToAppError(error)),
);

const service: HttpClient = {
  async get<T>(url: string, config?: AxiosRequestConfig) {
    const response = await axiosInstance.get<BaseResponse<T> | T>(url, config);
    return unwrapResponse(response);
  },
  async delete<T>(url: string, config?: AxiosRequestConfig) {
    const response = await axiosInstance.delete<BaseResponse<T> | T>(
      url,
      config,
    );
    return unwrapResponse(response);
  },
  async post<T, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ) {
    const response = await axiosInstance.post<BaseResponse<T> | T>(
      url,
      data,
      config,
    );
    return unwrapResponse(response);
  },
  async put<T, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ) {
    const response = await axiosInstance.put<BaseResponse<T> | T>(
      url,
      data,
      config,
    );
    return unwrapResponse(response);
  },
  async patch<T, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ) {
    const response = await axiosInstance.patch<BaseResponse<T> | T>(
      url,
      data,
      config,
    );
    return unwrapResponse(response);
  },
};

export default service;
