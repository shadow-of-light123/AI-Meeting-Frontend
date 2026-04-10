import { memo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import ChatBubble from "@/components/chat/ChatBubble";
import { type ChatMessage } from "@/lib/chat";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useChatTtsPlayback } from "@/hooks/audio/useChatTtsPlayback";

type ChatListProps = {
  messages: ChatMessage[];
  topContent?: React.ReactNode;
  assistantAvatarSrc?: string;
  className?: string;
};

function ChatList({
  messages,
  topContent,
  assistantAvatarSrc,
  className,
}: ChatListProps) {
  const scrollRef = useAutoScroll(messages);
  const { loadingMessageId, playingMessageId, toggleMessagePlayback } =
    useChatTtsPlayback(messages);

  return (
    <ScrollArea className={className} ref={scrollRef}>
      <div className="max-w-3xl mx-auto space-y-6 pb-20 ">
        {topContent}
        {messages.map((msg) => (
          <ChatBubble
            key={msg.id}
            role={msg.role}
            content={msg.content}
            reasoning={msg.reasoning}
            status={msg.status}
            variant={msg.variant}
            tts={msg.tts}
            isTtsLoading={loadingMessageId === msg.id}
            isTtsPlaying={playingMessageId === msg.id}
            onTtsToggle={msg.tts ? () => toggleMessagePlayback(msg) : undefined}
            progressSteps={msg.progressSteps}
            activeProgressStep={msg.activeProgressStep}
            assistantAvatarSrc={assistantAvatarSrc}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

export default memo(ChatList);
