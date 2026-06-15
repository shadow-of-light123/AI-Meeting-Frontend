import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { APP_BRAND_NAME } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { useStartNewChatSession } from "@/hooks/chat/useStartNewChatSession";

type SidebarHeaderProps = {
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
};

export default function SidebarHeader({
  isCollapsed,
  onToggleCollapse,
}: SidebarHeaderProps) {
  const startNewChatSession = useStartNewChatSession();

  return (
    <div
      className={cn(
        "flex items-center px-4 py-4",
        isCollapsed ? "justify-center" : "justify-between",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2",
          isCollapsed && "w-full justify-center",
        )}
      >
        <img
          src="/xunzhi-mark.svg"
          alt={APP_BRAND_NAME}
          className="h-7 w-7 rounded-full border border-slate-200 object-cover"
        />
        {!isCollapsed && (
          <span className="text-sm font-medium text-slate-900">
            {APP_BRAND_NAME}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        {!isCollapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-full"
            onClick={startNewChatSession}
            title="新建会话"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
        {onToggleCollapse && (
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-7 w-7", isCollapsed && "absolute right-2 top-4")}
            onClick={onToggleCollapse}
          >
            {isCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
