import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type ChatProgressBubbleProps = {
  label: string;
  steps: string[];
  activeStep: number;
};

export default function ChatProgressBubble({
  label,
  steps,
  activeStep,
}: ChatProgressBubbleProps) {
  const normalizedActiveStep = Math.min(
    Math.max(activeStep, 0),
    Math.max(steps.length - 1, 0),
  );
  const progressPercent =
    steps.length > 1 ? ((normalizedActiveStep + 1) / steps.length) * 100 : 100;

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full rounded-[26px] border border-slate-200/90 bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,1),_rgba(240,249,255,0.94)_42%,_rgba(248,250,252,0.98)_100%)] px-4 py-4 text-slate-700 shadow-[0_10px_30px_rgba(148,163,184,0.12)]"
    >
      <div className="flex items-start gap-3">
        <div className="relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-sky-100 text-sky-700">
          <motion.div
            aria-hidden
            className="absolute inset-0 rounded-2xl bg-sky-200/60"
            animate={{ opacity: [0.35, 0.75, 0.35], scale: [0.92, 1.06, 0.92] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          />
          <Loader2 className="relative h-4 w-4 animate-spin" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">{label}</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            请稍候，系统正在处理本轮回答并准备下一步反馈。
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {steps.map((step, index) => {
          const isCompleted = index < normalizedActiveStep;
          const isCurrent = index === normalizedActiveStep;

          return (
            <div
              key={step}
              className={cn(
                "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors",
                isCompleted &&
                  "border-emerald-200 bg-emerald-50 text-emerald-700",
                isCurrent && "border-sky-200 bg-sky-50 text-sky-700 shadow-sm",
                !isCompleted &&
                  !isCurrent &&
                  "border-slate-200 bg-white/80 text-slate-400",
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  isCompleted && "bg-emerald-500",
                  isCurrent && "bg-sky-500",
                  !isCompleted && !isCurrent && "bg-slate-300",
                )}
              />
              <span>{step}</span>
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
  );
}
