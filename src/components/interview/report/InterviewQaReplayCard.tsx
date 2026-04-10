import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { QaReview } from "@/components/interview/report/types";

type InterviewQaReplayCardProps = {
  qaReviews: QaReview[];
  isRecordLoading: boolean;
  recordError: string | null;
};

export default function InterviewQaReplayCard({
  qaReviews,
  isRecordLoading,
  recordError,
}: InterviewQaReplayCardProps) {
  const handleExport = () => {
    if (qaReviews.length === 0) return;

    const content = qaReviews
      .map((item, index) => {
        const lines = [
          `第 ${index + 1} 题`,
          `问题：${item.question}`,
          `回答：${item.answer}`,
        ];
        if (item.score !== null) {
          lines.push(`得分：${item.score}`);
        }
        return lines.join("\n");
      })
      .join("\n\n--------------------\n\n");

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "interview-qa-replay.txt";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="p-6 border-slate-100">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-900">面试问答回放</p>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full"
          onClick={handleExport}
          disabled={qaReviews.length === 0}
        >
          导出问答
        </Button>
      </div>
      <div className="mt-4 space-y-4">
        {isRecordLoading ? (
          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            正在加载问答回放...
          </div>
        ) : recordError ? (
          <div className="rounded-lg bg-rose-50 p-3 text-xs text-rose-600">
            {recordError}
          </div>
        ) : qaReviews.length > 0 ? (
          qaReviews.map((item, index) => (
            <div
              key={`${index}-${item.question}`}
              className="rounded-lg border border-slate-100 p-4"
            >
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium text-slate-900">
                  {item.question}
                </p>
                {item.score !== null && (
                  <div className="shrink-0 text-xs text-indigo-500">
                    得分 {item.score}
                  </div>
                )}
              </div>
              <p className="mt-2 text-xs leading-6 text-slate-500">
                {item.answer}
              </p>
            </div>
          ))
        ) : (
          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
            暂无问答回放数据
          </div>
        )}
      </div>
    </Card>
  );
}
