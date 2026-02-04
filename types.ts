export interface IncidentSummary {
  id: string;
  repo: string;
  eventType: string;
  timestamp: string;
  actor: string;

  oneLineSummary?: string;

  rootCause?: string[];
  impact?: string[];
  nextSteps?: string[];

  rawPayload?: Record<string, unknown>;
  rawSummary?: Record<string, unknown>;
  repoContext?: Record<string, unknown>;

  mlScore?: number;
  codeQualityScore?: number;
  category?: 'security' | 'code_quality' | 'both' | 'normal';

  summaryLoading?: boolean;
  summaryError?: string;
}
