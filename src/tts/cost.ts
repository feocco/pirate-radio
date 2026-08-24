const TTS_USD_PER_MILLION_CHARS = 15;
const DEFAULT_BUDGET_USD = 1;

export function estimateTtsCost(characterCount: number): number {
  return (characterCount / 1_000_000) * TTS_USD_PER_MILLION_CHARS;
}

export function assertWithinBudget(
  characterCount: number,
  allowOverBudget: boolean,
  budgetUsd = DEFAULT_BUDGET_USD,
): number {
  const estimatedCostUsd = estimateTtsCost(characterCount);
  if (!allowOverBudget && estimatedCostUsd > budgetUsd) {
    throw new Error(
      `Estimated xAI TTS cost $${estimatedCostUsd.toFixed(2)} exceeds the $${budgetUsd.toFixed(
        2,
      )} budget. Pass --allow-over-budget to continue.`,
    );
  }
  return estimatedCostUsd;
}
