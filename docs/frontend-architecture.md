# Frontend Architecture

This document describes the current frontend layering, state ownership rules, and the main data flows for chat, interview, and sketchpad/audio transcription features.

## 1. Layered Architecture

```mermaid
flowchart TD
  Router["app/router.tsx"] --> Pages["pages/*"]
  Pages --> Controllers["hooks/*PageController"]
  Pages --> Components["components/*"]
  Controllers --> DomainHooks["domain hooks"]
  DomainHooks --> Query["React Query"]
  DomainHooks --> Store["Redux Toolkit"]
  DomainHooks --> Services["services/*"]
  Services --> Request["lib/request.ts"]
  Request --> Backend["Backend APIs / SSE / WS"]
```

### Responsibilities

- `app/`: app entry, top-level providers, router registration
- `pages/`: route composition layer that wires controllers and UI blocks
- `components/`: reusable UI and domain widgets
- `hooks/`: page controllers, domain flows, runtime coordination, infra hooks
- `services/`: API adapters, protocol compatibility, normalization
- `store/`: active runtime state owned by Redux
- `lib/`: shared helpers, request wrappers, generic infrastructure

## 2. Runtime Providers

```mermaid
flowchart LR
  Root["main.tsx"] --> StrictMode["React StrictMode"]
  StrictMode --> Providers["AppProviders"]
  Providers --> Redux["Redux Provider"]
  Providers --> Query["QueryClientProvider"]
  Query --> App["App.tsx"]
```

## 3. State Ownership Rules

```mermaid
flowchart LR
  UIState["Local UI State"]
  Redux["Redux Runtime State"]
  Query["React Query Cache"]
  Remote["Backend State"]

  UIState -->|"input / dialog / collapse"| Pages
  Redux -->|"active session runtime"| Controllers
  Query -->|"read-through cache"| Controllers
  Remote -->|"HTTP / SSE / WS"| Services
```

- Local interaction state stays near the component or domain hook that consumes it.
- Server read caching belongs to React Query.
- Active runtime session state belongs to Redux.
- Backend field normalization belongs to services or shared helpers, not pages.

## 4. Chat Route Architecture

```mermaid
flowchart TD
  ChatPage["pages/chat/ChatPage.tsx"] --> ChatController["useChatPageController"]
  ChatController --> RouteState["useChatRouteState"]
  ChatController --> HistoryLoader["useChatHistoryLoader"]
  ChatController --> SendFlow["useChatSendFlow"]
  ChatController --> ModelList["useModelList"]

  RouteState --> Router["react-router"]
  HistoryLoader --> Query["React Query"]
  HistoryLoader --> Runtime["chatSlice runtime"]
  SendFlow --> Runtime
  SendFlow --> AIService["aiService"]
  SendFlow --> Conversations["conversation query invalidation"]

  ChatPage --> ChatRoom["components/chat/ChatRoom"]
  ChatRoom --> SmartComposer["SmartComposer"]
```

### Chat boundaries

- `useChatRouteState`: parses `sessionId`, `initialQuery`, and model selection from routing state
- `useChatHistoryLoader`: loads and hydrates existing session history into runtime state
- `useChatSendFlow`: creates sessions when needed, streams chunks, and finishes runtime messages
- `chatSlice`: single write entry point for active chat runtime UI state

### Chat data flow

```mermaid
sequenceDiagram
  participant User
  participant Controller as useChatPageController
  participant Route as useChatRouteState
  participant History as useChatHistoryLoader
  participant Send as useChatSendFlow
  participant Store as chatSlice
  participant Query as React Query
  participant API as aiService

  User->>Controller: open /chat/:sessionId
  Controller->>Route: parse route state
  Controller->>History: load history if needed
  History->>Query: fetch conversation history
  Query-->>History: cached or fresh history
  History->>Store: hydrateChatSession(sessionId, messages)

  User->>Controller: send message
  Controller->>Send: sendMessage(content, aiId)
  Send->>Store: append user + assistant placeholder
  Send->>API: createConversation() if needed
  Send->>Store: setChatRuntimeSession(sessionId)
  Send->>API: streamChat()
  API-->>Send: content / reasoning chunks
  Send->>Store: appendAssistantChunk / appendAssistantReasoningChunk
  API-->>Send: done
  Send->>Store: finishAssistantMessage + setActiveStream(null)
```

## 5. Interview Route Architecture

```mermaid
flowchart TD
  InterviewPage["pages/interview/InterviewPage.tsx"] --> InterviewController["useInterviewPageController"]
  InterviewController --> SessionFlow["useInterviewSessionFlow"]
  InterviewController --> ResumeAnalysis["useInterviewResumeAnalysis"]
  InterviewController --> CameraState["useInterviewCameraState"]

  SessionFlow --> RouteRecovery["useInterviewRouteRecovery"]
  SessionFlow --> MessageStream["useInterviewMessageStream"]
  SessionFlow --> ProgressState["useInterviewProgressState"]
  SessionFlow --> AutoSave["useInterviewAutoSave"]
```

### Interview boundaries

- `useInterviewSessionFlow`: interview main-flow composition layer
- `useInterviewRouteRecovery`: restores route, storage, and recent active session context
- `useInterviewMessageStream`: thinking indicator, fake stream output, and message sequencing
- `useInterviewProgressState`: question progress, follow-up state, finish state, and scores
- `useInterviewAutoSave`: completion-side persistence and invalidation

## 6. Current Engineering Rules

- Pages compose flows; they do not own low-level side effects.
- Runtime state changes should go through slice actions rather than ad-hoc setters across the tree.
- Query owns read caching; Redux owns the active runtime interaction state.
- When a hook starts mixing routing, persistence, streaming, and UI mutations, split it into private domain hooks before adding features.
- High-risk flow changes must be backed by hook-level tests, not only page smoke tests.

## 7. Sketchpad and Audio Transcription Boundaries

### UI shell vs process hooks vs infra hooks

- Presentation components render UI and local visual interactions only.
- Process hooks own business sequencing, derived state, and user action orchestration.
- Infra hooks and services own browser APIs, media streams, WebSocket/SSE wiring, and persistence adapters.

### Interview sketchpad structure

```mermaid
flowchart TD
  InterviewPage["InterviewPage"] --> Sketchpad["InterviewSketchpadSheet"]
  Sketchpad --> View["InterviewSketchpadSheetView"]
  Sketchpad --> Storage["useInterviewSketchpadStorage"]
  Sketchpad --> Question["useInterviewSketchpadQuestionState"]
  Sketchpad --> Transcription["useInterviewSketchpadTranscription"]

  Question --> Query["React Query"]
  Query --> InterviewService["interviewService.getCurrentQuestion"]

  Storage --> LocalStorage["localStorage"]
  Transcription --> AudioHook["useAudioToText"]
```

### Audio transcription data flow

```mermaid
sequenceDiagram
  participant UI as SketchpadTranscriptionHook
  participant Controller as useAudioToText
  participant Capture as useMicrophonePcmStream
  participant Transport as useAudioTranscriptionTransport
  participant WS as AudioToTextWebSocket

  UI->>Controller: startRecording()
  Controller->>Transport: connect()
  Controller->>Capture: start()
  Capture-->>Transport: PCM16 chunks
  Transport->>WS: sendAudio()
  WS-->>Transport: partial / final packets
  Transport-->>Controller: onReplace / onArchive / onError
  Controller-->>UI: reducer-driven transcription state
```

### Decision rules for future refactors

- Do not let page or component files hold storage IO, media device access, and server query orchestration at the same time.
- If a UI module needs refs, timers, storage, and remote synchronization together, split it into a shell plus private hooks before adding new features.
- Keep transcription text state inside React reducer state; keep transport and microphone handles in infra refs only.

## 8. Resume Preview Loading Boundary

```mermaid
flowchart TD
  InterviewPage["InterviewPage"] --> UploadCard["InterviewResumeUploadCard"]
  InterviewPage --> PreviewDialog["InterviewResumePreviewDialog"]
  InterviewPage --> ReferenceCard["InterviewResumeReferenceCard"]

  PreviewDialog --> PreviewContent["InterviewResumePreviewContent"]
  ReferenceCard --> MetadataShell["metadata shell"]
  MetadataShell --> InlineToggle["explicit expand action"]
  InlineToggle --> PreviewContent

  PreviewContent --> LazyPdf["lazy InterviewResumePdfDocument"]
  LazyPdf --> PdfViewer["react-pdf / pdfjs-dist worker"]
```

- The preview dialog keeps the full resume review flow.
- The side reference card mounts metadata immediately but only mounts the PDF viewer after an explicit expand action.
- Heavy PDF parsing stays behind the preview boundary instead of piggybacking on sketchpad open state.
