import { useLocation } from "react-router-dom";
import { Card } from "@/components/ui/card";
import InterviewReportHeader from "@/components/interview/report/InterviewReportHeader";
import InterviewScoreAndRadarCard from "@/components/interview/report/InterviewScoreAndRadarCard";
import InterviewConclusionCard from "@/components/interview/report/InterviewConclusionCard";
import InterviewNextActionsCard from "@/components/interview/report/InterviewNextActionsCard";
import InterviewQaReplayCard from "@/components/interview/report/InterviewQaReplayCard";
import { useInterviewReportData } from "@/hooks/interview/report/useInterviewReportData";

export default function InterviewReportPage() {
  const location = useLocation();
  const reportSessionId =
    (location.state as { sessionId?: string } | null)?.sessionId || null;

  const {
    isRecordLoading,
    recordError,
    resumeScore,
    interviewScore,
    compositeScore,
    isCompositeEstimated,
    radarPoints,
    sortedSuggestions,
    interviewDirection,
    qaReviews,
    reviewFeedback,
  } = useInterviewReportData(reportSessionId);

  return (
    <div className="h-full overflow-y-auto bg-white">
      <div className="max-w-7xl mx-auto px-6 py-10 space-y-8">
        <InterviewReportHeader />

        {!reportSessionId && (
          <Card className="p-4 border-amber-100 bg-amber-50 text-amber-700 text-sm">
            未获取到会话 ID，当前显示为空报告。请从面试流程结束后进入本页。
          </Card>
        )}

        <div className="grid items-start gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <InterviewScoreAndRadarCard
              resumeScore={resumeScore}
              interviewScore={interviewScore}
              compositeScore={compositeScore}
              isCompositeEstimated={isCompositeEstimated}
              radarPoints={radarPoints}
            />
            <InterviewNextActionsCard
              reviewFeedback={reviewFeedback}
              sortedSuggestions={sortedSuggestions}
              isRecordLoading={isRecordLoading}
              recordError={recordError}
            />
          </div>
          <InterviewConclusionCard
            interviewDirection={interviewDirection}
            reviewFeedback={reviewFeedback}
            isRecordLoading={isRecordLoading}
            recordError={recordError}
          />
        </div>

        <InterviewQaReplayCard
          qaReviews={qaReviews}
          isRecordLoading={isRecordLoading}
          recordError={recordError}
        />
      </div>
    </div>
  );
}
