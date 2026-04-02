export interface LLMRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  tokensUsed: { input: number; output: number };
  model: string;
  durationMs: number;
}

export interface LLMProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  complete(request: LLMRequest): Promise<LLMResponse>;
}
