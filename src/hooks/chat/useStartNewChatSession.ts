import { useCallback } from "react";
import { useAppDispatch } from "@/store/hooks";
import { beginNewChatSession } from "@/store/slices/chatSlice";
import { useChatRouteState } from "@/hooks/chat/useChatRouteState";

/**
 * 统一的「新建对话」入口。
 *
 * 先 beginNewChatSession（清空 runtime + 置过渡标志），再 navigate 到 /chat。
 * 过渡标志会在 URL 同步到 /chat 后清除，期间屏蔽：
 * - 旧 URL 下误触发历史重载（reset 先于 navigate 的中间态）
 * - /chat 下 shouldRedirectToRuntimeSession 跳回旧会话（navigate 先于 reset 的中间态）
 */
export function useStartNewChatSession() {
  const dispatch = useAppDispatch();
  const { navigateToChatRoot } = useChatRouteState();

  return useCallback(() => {
    dispatch(beginNewChatSession());
    navigateToChatRoot({ replace: true });
  }, [dispatch, navigateToChatRoot]);
}
