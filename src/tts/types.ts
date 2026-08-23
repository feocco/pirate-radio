export interface TtsRequest {
  title: string;
  text: string;
  outputPath: string;
  allowOverBudget: boolean;
  includeTimestamps?: boolean;
}

export interface TtsResult {
  provider: string;
  outputPath: string;
  estimatedCostUsd: number;
  words?: { word: string; start: number; end: number }[];
}

export interface TtsProvider {
  name: string;
  synthesize(request: TtsRequest): Promise<TtsResult>;
}
