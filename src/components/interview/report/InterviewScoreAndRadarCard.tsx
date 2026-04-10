import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import InterviewRadarChart from "@/components/interview/report/InterviewRadarChart";
import type { RadarPoint } from "@/components/interview/report/types";

type InterviewScoreAndRadarCardProps = {
  resumeScore: number | null;
  interviewScore: number | null;
  compositeScore: number | null;
  isCompositeEstimated: boolean;
  radarPoints: RadarPoint[];
};

const formatScore = (value: number | null) =>
  value === null ? "--" : String(value);

export default function InterviewScoreAndRadarCard({
  resumeScore,
  interviewScore,
  compositeScore,
  isCompositeEstimated,
  radarPoints,
}: InterviewScoreAndRadarCardProps) {
  return (
    <Card className="p-6 border-slate-100">
      <div className="grid md:grid-cols-3 gap-4">
        <div className="rounded-lg bg-slate-50 p-4">
          <p className="text-xs text-slate-500">简历得分</p>
          <p className="text-2xl font-semibold text-slate-900">
            {formatScore(resumeScore)}
          </p>
        </div>
        <div className="rounded-lg bg-slate-50 p-4">
          <p className="text-xs text-slate-500">回答得分</p>
          <p className="text-2xl font-semibold text-slate-900">
            {formatScore(interviewScore)}
          </p>
        </div>
        <div className="rounded-lg bg-slate-50 p-4">
          <p className="text-xs text-slate-500">综合评分</p>
          <p className="text-2xl font-semibold text-slate-900">
            {formatScore(compositeScore)}
          </p>
          {isCompositeEstimated && (
            <p className="mt-1 text-[10px] text-slate-400">估算值</p>
          )}
        </div>
      </div>
      <Separator className="my-6" />
      <div className="grid md:grid-cols-[0.9fr_1.1fr] gap-6 items-center">
        <div>
          <p className="text-sm font-medium text-slate-900">能力雷达图</p>
          <p className="text-xs text-slate-500 mt-1">
            基于本次会话实际数据计算，若后端未返回则显示为空。
          </p>
          <div className="mt-4 space-y-3">
            {radarPoints.length > 0 ? (
              radarPoints.map((item) => (
                <div key={item.label} className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{item.label}</span>
                    <span>{item.value}</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100">
                    <div
                      className="h-2 rounded-full bg-indigo-500"
                      style={{ width: `${item.value}%` }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                暂无雷达维度数据
              </div>
            )}
          </div>
        </div>
        <InterviewRadarChart points={radarPoints} />
      </div>
    </Card>
  );
}
