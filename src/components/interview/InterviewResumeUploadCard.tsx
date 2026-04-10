import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import type { ChangeEvent, RefObject } from "react";
import ErrorNotice from "@/components/feedback/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { INTERVIEW_DEFAULTS } from "@/lib/constants";

const RESUME_UPLOAD_STAGES = [
  "正在上传简历",
  "正在解析简历",
  "正在生成面试题",
] as const;

type InterviewResumeUploadCardProps = {
  fileInputRef: RefObject<HTMLInputElement | null>;
  isResumeUploading: boolean;
  resumeUploadStage: number;
  resumeLocalFile: File | null;
  resumeFileUrl: string | null;
  resumeName: string | null;
  resumePreviewError: string | null;
  resumeUploadError: string | null;
  interviewError: string | null;
  onResumeFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenResume: () => void;
};

export default function InterviewResumeUploadCard({
  fileInputRef,
  isResumeUploading,
  resumeUploadStage,
  resumeLocalFile,
  resumeFileUrl,
  resumeName,
  resumePreviewError,
  resumeUploadError,
  interviewError,
  onResumeFileSelect,
  onOpenResume,
}: InterviewResumeUploadCardProps) {
  const normalizedUploadStage = Math.min(
    Math.max(resumeUploadStage, 0),
    RESUME_UPLOAD_STAGES.length - 1,
  );
  const activeUploadLabel = RESUME_UPLOAD_STAGES[normalizedUploadStage];
  const progressPercent =
    ((normalizedUploadStage + 1) / RESUME_UPLOAD_STAGES.length) * 100;
  const hasResumeEntry = Boolean(
    resumeLocalFile || resumeFileUrl || resumeName || resumePreviewError,
  );

  return (
    <Card className="border-dashed border-slate-200 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-slate-900">
            上传简历后开始面试
          </p>
          <p className="mt-1 text-xs text-slate-500">
            当前支持 PDF，系统会基于简历内容生成面试题。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={INTERVIEW_DEFAULTS.resumeAccept}
            className="hidden"
            onChange={onResumeFileSelect}
          />
          <Button
            variant="outline"
            className="rounded-full"
            disabled={isResumeUploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {isResumeUploading ? "上传中..." : "上传简历"}
          </Button>
          {hasResumeEntry ? (
            <Button
              variant="ghost"
              className="rounded-full text-slate-600"
              onClick={onOpenResume}
            >
              查看简历
            </Button>
          ) : null}
          {resumeName ? (
            <span className="max-w-[200px] truncate text-xs text-slate-500">
              {resumeName}
            </span>
          ) : null}
        </div>
      </div>

      {resumeUploadError ? (
        <div className="mt-3">
          <ErrorNotice title="简历上传失败" description={resumeUploadError} />
        </div>
      ) : null}

      {isResumeUploading ? (
        <div className="mt-3 rounded-2xl border border-sky-200 bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,1),_rgba(239,246,255,0.95)_45%,_rgba(248,250,252,0.98)_100%)] px-4 py-4 text-sky-900 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-100 text-sky-700">
              <motion.div
                aria-hidden
                className="absolute inset-0 rounded-2xl bg-sky-200/60"
                animate={{
                  opacity: [0.35, 0.75, 0.35],
                  scale: [0.92, 1.06, 0.92],
                }}
                transition={{
                  duration: 1.8,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              />
              <Loader2 className="relative h-4 w-4 animate-spin" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-900">
                {activeUploadLabel}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {resumeName || "当前简历"}正在处理中，请稍候，准备完成后会直接进入面试。
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {RESUME_UPLOAD_STAGES.map((stage, index) => {
              const isCompleted = index < normalizedUploadStage;
              const isCurrent = index === normalizedUploadStage;

              return (
                <div
                  key={stage}
                  className={[
                    "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                    isCompleted
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "",
                    isCurrent
                      ? "border-sky-200 bg-sky-50 text-sky-700 shadow-sm"
                      : "",
                    !isCompleted && !isCurrent
                      ? "border-slate-200 bg-white/80 text-slate-400"
                      : "",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "h-2 w-2 rounded-full",
                      isCompleted ? "bg-emerald-500" : "",
                      isCurrent ? "bg-sky-500" : "",
                      !isCompleted && !isCurrent ? "bg-slate-300" : "",
                    ].join(" ")}
                  />
                  <span>{stage}</span>
                </div>
              );
            })}
          </div>

          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-200/80">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-sky-500 via-cyan-400 to-emerald-400"
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: 0.45, ease: "easeOut" }}
            />
          </div>
        </div>
      ) : null}

      {interviewError ? (
        <div className="mt-3">
          <ErrorNotice title="面试流程异常" description={interviewError} />
        </div>
      ) : null}
    </Card>
  );
}
