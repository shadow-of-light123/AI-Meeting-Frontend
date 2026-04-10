export type RadarPoint = {
  label: string;
  value: number;
};

export type QaReview = {
  question: string;
  answer: string;
  score: number | null;
};

export type ReviewFeedback = {
  overallComment: string | null;
  highlights: string[];
  improvementTips: string[];
  nextActions: string[];
};
