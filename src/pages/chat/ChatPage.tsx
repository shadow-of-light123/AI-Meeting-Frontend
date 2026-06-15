import ChatHistoryLoadingOverlay from "@/components/chat/ChatHistoryLoadingOverlay";
import ChatPageHeader from "@/components/chat/ChatPageHeader";
import ChatRoom from "@/components/chat/ChatRoom";
import SmartComposer from "@/components/chat/SmartComposer";
import { ModelSelector } from "@/components/home/ModelSelector";
import { useChatPageController } from "@/hooks/chat/useChatPageController";

/**
 * 聊天页面 —— 将 useChatPageController 产出的三大领域状态（历史 / 输入 / 模型）
 * 组合为 ChatRoom 的 props，本身无额外逻辑，仅作装配层。
 *
 * 组件树结构：
 * ```
 * ChatPage
 * └─ ChatRoom                          // 页面骨架：消息列表 + 底部输入区
 *    ├─ (header) ChatPageHeader        // 顶部栏：模型名称
 *    ├─ (messages)                      // 消息列表（ChatRoom 内部渲染）
 *    ├─ (contentOverlay) ChatHistoryLoadingOverlay  // 历史加载时的遮罩
 *    └─ (customComposer) SmartComposer  // 底部输入框
 *       └─ (actions) ModelSelector     // 模型切换下拉
 * ```
 */
export default function ChatPage() {
  // 页面控制器：整合路由、发送、历史加载、模型选择、输入框状态
  const { history, composer, modelSelection } = useChatPageController();

  return (
    <ChatRoom
      // ── 顶部栏 ──
      header={
        <ChatPageHeader
          selectedModelName={modelSelection.selectedModel?.aiName}
        />
      }
      // ── 消息列表数据 ──
      messages={history.messages}
      // ── 输入框受控绑定 ──
      inputValue={composer.input}
      onInputChange={composer.setInput}
      onSend={composer.handleSend}
      // ── 历史加载遮罩（isLoading 为 true 时渲染） ──
      contentOverlay={history.isLoading ? <ChatHistoryLoadingOverlay /> : null}
      // ── 自定义底部输入区（替换默认 input） ──
      customComposer={
        <SmartComposer
          value={composer.input}
          onChange={composer.setInput}
          onSend={composer.handleSend}
          disabled={composer.isBlocked}
          // 模型选择器：仅在模型列表加载完成且已选中模型时渲染
          actions={
            modelSelection.models.length > 0 &&
            modelSelection.selectedModel && (
              <ModelSelector
                models={modelSelection.models}
                selectedModel={modelSelection.selectedModel}
                onSelect={modelSelection.setSelectedModel}
              />
            )
          }
        />
      }
    />
  );
}
