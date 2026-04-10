export type AudioToTextIncomingMessage = {
  type?: string | null;
  message?: string | null;
  data?: string | null;
  isSnapshot?: boolean | null;
  updateAction?: string | null;
  timestamp?: number | null;
};

export type AudioTranscriptionEvent =
  | { kind: "reset" }
  | { kind: "replace"; text: string }
  | { kind: "archive"; text: string }
  | { kind: "connected" }
  | { kind: "control" }
  | { kind: "heartbeat" }
  | { kind: "error"; message: string }
  | { kind: "unknown"; type?: string | null };

export type AudioTranscriptionState = {
  liveText: string;
  finalText: string;
};

export const createInitialAudioTranscriptionState =
  (): AudioTranscriptionState => ({
    liveText: "",
    finalText: "",
  });

const normalizeText = (value?: string | null) => value?.trim() ?? "";

export const resolveAudioTranscriptionEvent = (
  message: AudioToTextIncomingMessage,
): AudioTranscriptionEvent => {
  const text = normalizeText(message.data);

  if (message.updateAction === "replace" || message.type === "transcription") {
    return {
      kind: "replace",
      text,
    };
  }

  if (message.updateAction === "archive" || message.type === "final") {
    return {
      kind: "archive",
      text,
    };
  }

  switch (message.type) {
    case "connected":
      return { kind: "connected" };
    case "transcription_started":
      return { kind: "reset" };
    case "transcription_stopped":
    case "status":
      return { kind: "control" };
    case "heartbeat":
    case "pong":
      return { kind: "heartbeat" };
    case "error":
      return {
        kind: "error",
        message:
          normalizeText(message.message) || text || "Transcription error",
      };
    default:
      return {
        kind: "unknown",
        type: message.type,
      };
  }
};

export const reduceAudioTranscriptionState = (
  state: AudioTranscriptionState,
  event: AudioTranscriptionEvent,
): AudioTranscriptionState => {
  switch (event.kind) {
    case "reset":
      return createInitialAudioTranscriptionState();
    case "replace":
      if (event.text === state.liveText && !state.finalText) {
        return state;
      }
      return {
        ...state,
        liveText: event.text,
        finalText: "",
      };
    case "archive": {
      const finalizedText =
        normalizeText(event.text) ||
        normalizeText(state.liveText) ||
        normalizeText(state.finalText);
      if (!finalizedText) {
        return state;
      }

      if (
        finalizedText === state.finalText &&
        finalizedText === state.liveText
      ) {
        return state;
      }

      return {
        liveText: finalizedText,
        finalText: finalizedText,
      };
    }
    default:
      return state;
  }
};

export const getMergedAudioTranscription = (state: AudioTranscriptionState) =>
  normalizeText(state.finalText) || normalizeText(state.liveText);
