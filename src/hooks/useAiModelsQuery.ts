import { useQuery } from "@tanstack/react-query";
import { aiService } from "@/services/aiService";
import { useAppSelector } from "@/store/hooks";
import type { AiProperty } from "@/types/ai";
import type { UserRespDTO } from "@/types/auth";

/**
 * 模型查询的用户身份类型 —— 只需要用户的 id 和 username 来构造缓存键，
 * 避免传入整个 UserRespDTO 对象导致不必要的依赖。
 */
type ModelUserIdentity =
  | Pick<UserRespDTO, "id" | "username">
  | null
  | undefined;

/** {@link useAiModelsQuery} 的可选参数 */
type UseAiModelsQueryOptions = {
  /** 是否启用查询，默认为 true。设为 false 可阻止（如页面未激活时） */
  enabled?: boolean;
};

/**
 * 将用户身份对象转换为字符串形式的缓存键标识。
 *
 * 优先级：
 *   1. 有合法数字 id → "id:{id}"
 *   2. 有 username   → "username:{username}"
 *   3. 兜底         → "anonymous"（未登录或信息不全时）
 */
const getAiModelsUserKey = (user: ModelUserIdentity) => {
  if (!user) return "anonymous";
  if (typeof user.id === "number" && Number.isFinite(user.id) && user.id > 0) {
    return `id:${user.id}`;
  }
  if (user.username) return `username:${user.username}`;
  return "anonymous";
};

/**
 * TanStack Query 的查询键工厂，用于获取可用 AI 模型列表。
 *
 * @param userKey  - {@link getAiModelsUserKey} 生产的用户标识字符串
 * @param authEpoch - 用户认证状态变更纪元（递增可自动失效旧缓存）
 * @returns 只读元组 `["ai-models", userKey, authEpoch]`
 */
export const getAiModelsQueryKey = (userKey: string, authEpoch: number) =>
  ["ai-models", userKey, authEpoch] as const;

/**
 * 获取当前用户可用 AI 模型列表的 Hook。
 *
 * 内部使用 TanStack Query 缓存请求结果；依赖 `authEpoch` 确保用户登录/登出后
 * 缓存自动失效并重新获取。仅当用户已认证时才发起请求。
 *
 * @param options.enabled - 是否启用查询（默认 true）
 * @returns React Query 结果（data 解构为 models），外加 `models` 字段（类型安全的 AI 模型列表）
 *
 * @example
 * ```tsx
 * const { models, isLoading, error } = useAiModelsQuery();
 * // models 始终为 AiProperty[] 类型，即使接口返回空也保证是数组
 * ```
 */
export function useAiModelsQuery(options: UseAiModelsQueryOptions = {}) {
  // 从 Redux 读取用户认证状态
  const { isAuthenticated, currentUser, authEpoch } = useAppSelector(
    (state) => state.user,
  );

  const userKey = getAiModelsUserKey(currentUser);
  // 只有已认证且用户未主动禁用查询时才发起请求
  const enabled = (options.enabled ?? true) && isAuthenticated;

  const query = useQuery({
    queryKey: getAiModelsQueryKey(userKey, authEpoch),
    queryFn: async () => {
      // 只查询已启用的模型（isEnabled: 1）
      const response = await aiService.getAiProperties({ isEnabled: 1 });
      return response?.records ?? [];
    },
    enabled,
  });

  return {
    ...query,
    // 暴露类型安全的 models 字段，即使 data 为 undefined 也保证返回空数组
    models: (query.data ?? []) as AiProperty[],
  };
}
