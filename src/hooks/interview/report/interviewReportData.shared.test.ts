import { describe, expect, it } from "vitest";
import { buildInterviewReportViewModel } from "@/hooks/interview/report/interviewReportData.shared";

describe("buildInterviewReportViewModel", () => {
  it("prefers radar api data and computes estimated composite score when raw composite is missing", () => {
    const viewModel = buildInterviewReportViewModel(
      {
        id: 1,
        userId: 1,
        sessionId: "session-1",
        resumeScore: 80,
        interviewScore: 90,
        interviewSuggestions: "Focus on ownership\nAdd metrics",
      },
      {
        resumeScore: 81,
        interviewPerformance: 89,
        demeanorEvaluation: 77,
        professionalSkills: 92,
      },
    );

    expect(viewModel.resumeScore).toBe(80);
    expect(viewModel.interviewScore).toBe(90);
    expect(viewModel.compositeScore).toBe(85);
    expect(viewModel.isCompositeEstimated).toBe(true);
    expect(viewModel.radarPoints).toEqual([
      { label: "简历评估", value: 81 },
      { label: "面试表现", value: 89 },
      { label: "仪态表达", value: 77 },
      { label: "专业技能", value: 92 },
    ]);
    expect(viewModel.sortedSuggestions).toEqual([
      "Focus on ownership",
      "Add metrics",
    ]);
    expect(viewModel.reviewFeedback).toEqual({
      overallComment: null,
      highlights: [],
      improvementTips: [],
      nextActions: ["Focus on ownership", "Add metrics"],
    });
  });

  it("falls back to record and snapshot data, and dedupes qa reviews", () => {
    const viewModel = buildInterviewReportViewModel(
      {
        id: 2,
        userId: 1,
        sessionId: "session-2",
        totalScore: 93,
        interviewSuggestionsMap: {
          "2": "Second",
          "1": "First",
        },
        qaReviews: [
          {
            question: "Q1",
            answer: "A1",
            score: 88,
          },
        ],
        sessionSnapshotJson: JSON.stringify({
          radarScores: {
            Communication: 78,
            Delivery: 83,
          },
          qaReviews: [
            {
              question: "Q1",
              answer: "A1",
              score: 88,
            },
            {
              question: "Q2",
              answer: "A2",
              score: 91,
            },
          ],
          interviewDirection: "frontend",
        }),
      },
      null,
    );

    expect(viewModel.compositeScore).toBe(93);
    expect(viewModel.isCompositeEstimated).toBe(false);
    expect(viewModel.sortedSuggestions).toEqual(["First", "Second"]);
    expect(viewModel.radarPoints).toEqual([
      { label: "Communication", value: 78 },
      { label: "Delivery", value: 83 },
    ]);
    expect(viewModel.qaReviews).toEqual([
      {
        question: "Q1",
        answer: "A1",
        score: 88,
      },
      {
        question: "Q2",
        answer: "A2",
        score: 91,
      },
    ]);
    expect(viewModel.interviewDirection).toBe("frontend");
    expect(viewModel.reviewFeedback).toEqual({
      overallComment: null,
      highlights: [],
      improvementTips: [],
      nextActions: ["First", "Second"],
    });
  });

  it("reads structured review feedback from the report payload", () => {
    const viewModel = buildInterviewReportViewModel(
      {
        id: 3,
        userId: 1,
        sessionId: "session-3",
        reviewFeedback: {
          overallComment: "整体不错，但还可以进一步提升表达的稳定性。",
          highlights: ["项目案例比较扎实"],
          improvementTips: ["回答时再压缩一下铺垫部分"],
          nextActions: ["下一次练习时优先加强 STAR 表达"],
        },
      },
      null,
    );

    expect(viewModel.reviewFeedback).toEqual({
      overallComment: "整体不错，但还可以进一步提升表达的稳定性。",
      highlights: ["项目案例比较扎实"],
      improvementTips: ["回答时再压缩一下铺垫部分"],
      nextActions: ["下一次练习时优先加强 STAR 表达"],
    });
  });
});
