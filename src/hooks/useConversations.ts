import { useCallback, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { aiService } from "@/services/aiService";
import { ROUTES } from "@/lib/constants";
import { useAppDispatch, useAppSelector } from "@/store/hooks";
import { resetChatRuntime } from "@/store/slices/chatSlice";
import type { UserRespDTO } from "@/types/auth";

type ConversationUserIdentity =
  | Pick<UserRespDTO, "id" | "username">
  | null
  | undefined;

type UseConversationsOptions = {
  enabled?: boolean;
};

export const getConversationUserKey = (user: ConversationUserIdentity) => {
  if (!user) return "anonymous";
  if (typeof user.id === "number" && Number.isFinite(user.id) && user.id > 0) {
    return `id:${user.id}`;
  }
  if (user.username) return `username:${user.username}`;
  return "anonymous";
};

export const getConversationsQueryKey = (userKey: string, authEpoch: number) =>
  ["conversations", userKey, authEpoch] as const;

export function useConversations(options: UseConversationsOptions = {}) {
  const { isAuthenticated, currentUser, authEpoch } = useAppSelector(
    (state) => state.user,
  );
  const userKey = getConversationUserKey(currentUser);
  const enabled = (options.enabled ?? true) && isAuthenticated;

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status,
    refetch,
  } = useInfiniteQuery({
    queryKey: getConversationsQueryKey(userKey, authEpoch),
    queryFn: async ({ pageParam = 1 }) => {
      return aiService.getConversations({
        current: pageParam,
        size: 20,
      });
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage || !lastPage.records) return undefined;
      if (lastPage.records.length < 20) return undefined;
      return lastPage.current + 1;
    },
    initialPageParam: 1,
    enabled,
  });

  return {
    conversations: data?.pages.flatMap((page) => page.records) || [],
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    status,
    refetch,
  };
}

export function useDeleteConversation() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { currentUser, authEpoch } = useAppSelector((state) => state.user);
  const { currentSessionId } = useAppSelector((state) => state.chat);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(
    null,
  );

  const deleteConversation = useCallback(
    async (sessionId: string) => {
      if (deletingSessionId) {
        return;
      }

      setDeletingSessionId(sessionId);
      try {
        await aiService.deleteConversation(sessionId);

        const userKey = getConversationUserKey(currentUser);
        await queryClient.invalidateQueries({
          queryKey: getConversationsQueryKey(userKey, authEpoch),
        });

        const isActiveSession =
          location.pathname.includes(sessionId) ||
          currentSessionId === sessionId;

        if (isActiveSession) {
          dispatch(resetChatRuntime());
          navigate(ROUTES.chat);
        }
      } finally {
        setDeletingSessionId(null);
      }
    },
    [
      authEpoch,
      currentSessionId,
      currentUser,
      deletingSessionId,
      dispatch,
      location.pathname,
      navigate,
      queryClient,
    ],
  );

  return {
    deleteConversation,
    deletingSessionId,
  };
}
