import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AiConversation } from "@/types/ai";

type SidebarSessionListProps = {
  conversations: AiConversation[];
  activePathname: string;
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  deletingSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
};

export default function SidebarSessionList({
  conversations,
  activePathname,
  hasNextPage,
  isFetchingNextPage,
  deletingSessionId,
  onOpenSession,
  onDeleteSession,
}: SidebarSessionListProps) {
  return (
    <>
      {conversations.map((conversation) => {
        const isActive = activePathname.includes(conversation.sessionId);
        const isDeleting = deletingSessionId === conversation.sessionId;

        return (
          <div
            key={conversation.sessionId}
            className={cn(
              "group mb-1 flex w-full min-w-0 items-center gap-1 overflow-hidden rounded-xl px-3 py-2 transition-colors",
              isActive
                ? "bg-secondary text-secondary-foreground"
                : "hover:bg-slate-100",
            )}
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left outline-none"
              onClick={() => onOpenSession(conversation.sessionId)}
            >
              <div className="flex w-full flex-col gap-0.5 overflow-hidden">
                <span className="truncate text-sm font-medium text-slate-700">
                  {conversation.title || "无标题会话"}
                </span>
                <span className="truncate text-[10px] text-slate-400">
                  {conversation.createTime
                    ? new Date(conversation.createTime).toLocaleDateString()
                    : "Unknown date"}{" "}
                  · {conversation.aiName || "Unknown model"}
                </span>
              </div>
            </button>

            <button
              type="button"
              aria-label="删除会话"
              disabled={Boolean(deletingSessionId)}
              className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-md p-1 text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50",
                isDeleting && "opacity-50",
              )}
              onClick={() => onDeleteSession(conversation.sessionId)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      {isFetchingNextPage ? (
        <div className="py-2 text-center text-xs text-slate-400">加载中...</div>
      ) : null}

      {!hasNextPage && conversations.length > 0 ? (
        <div className="py-2 text-center text-xs text-slate-300">
          没有更多了
        </div>
      ) : null}

      {!isFetchingNextPage && conversations.length === 0 ? (
        <div className="py-4 text-center text-xs text-slate-400">
          暂无会话记录
        </div>
      ) : null}
    </>
  );
}
