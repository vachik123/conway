const BACKEND_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_BACKEND_URL) ||
  (import.meta.env?.PROD ? '' : 'http://localhost:3001');

export interface BackendEvent {
  type: 'event'; // Discriminator
  event_id: string;
  repo: string;
  event_type: string;
  timestamp: string;
  actor: string;
  score?: number;
  code_quality_score?: number;
  category?: 'security' | 'code_quality' | 'both' | 'normal';
  features?: Record<string, number>;
  raw_payload?: Record<string, any>; // Full GitHub event JSON
}

export interface BackendSummary {
  type: 'summary'; // Discriminator
  id: number;
  event_id: string;
  event_type: string;
  repo: string;
  actor: string;
  timestamp: string;
  root_cause: string; // newline-separated bullets
  impact: string;     // newline-separated bullets
  next_steps: string; // newline-separated bullets
  raw_summary: string; // JSON string containing classification & one_line_summary
  created_at: string;
}

export interface BackendReset {
  type: 'reset';
  timestamp: string;
}

export type BackendMessage = BackendEvent | BackendSummary | BackendReset;

export function subscribeToBackendStream(
  onMessage: (data: BackendMessage) => void,
  onError?: (error: Event) => void
): () => void {
  const eventSource = new EventSource(`${BACKEND_URL}/stream`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'connected') {
        console.log('Connected to backend SSE stream');
        return;
      }

      if (data.type === 'error') {
        console.error('Backend Error:', data.message || data.error);
        console.error('Event ID:', data.event_id);
        if (data.details) {
          console.error('Error Details:', data.details);
        }
        return;
      }

      onMessage(data as BackendMessage);
    } catch (error) {
      console.error('Failed to parse SSE message:', error);
      console.error('Raw message:', event.data);
    }
  };

  eventSource.onerror = (error) => {
    console.error('SSE connection error:', error);
    if (onError) {
      onError(error);
    }
  };

  return () => {
    eventSource.close();
  };
}

export async function fetchEvents(options?: {
  limit?: number;
  category?: 'security' | 'code_quality' | 'both' | 'normal';
}): Promise<BackendEvent[]> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', options.limit.toString());
  if (options?.category) params.set('category', options.category);

  const url = `${BACKEND_URL}/events${params.toString() ? '?' + params.toString() : ''}`;
  console.log(`Fetching events from: ${url}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const response = await fetch(url, { signal: controller.signal });
  clearTimeout(timeoutId);

  if (!response.ok) {
    console.error(`Failed to fetch events: ${response.status} ${response.statusText}`);
    throw new Error(`Failed to fetch events: ${response.statusText}`);
  }

  const data = await response.json();
  console.log(`Fetched ${data.length} events (category: ${options?.category ?? 'all'})`);
  return data;
}

export async function fetchSummaries(options?: {
  since?: string;
  limit?: number;
}): Promise<BackendSummary[]> {
  const params = new URLSearchParams();
  if (options?.since) params.set('since', options.since);
  if (options?.limit) params.set('limit', options.limit.toString());

  const url = `${BACKEND_URL}/summary${params.toString() ? '?' + params.toString() : ''}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const response = await fetch(url, { signal: controller.signal });
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`Failed to fetch summaries: ${response.statusText}`);
  }

  return response.json();
}

export async function getEventSummary(eventId: string): Promise<BackendSummary> {
  console.log(`Requesting summary for event: ${eventId}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const response = await fetch(`${BACKEND_URL}/event/${eventId}/summary`, { signal: controller.signal });
  clearTimeout(timeoutId);

  if (!response.ok) {
    console.error(`Failed to get summary for ${eventId}: ${response.status} ${response.statusText}`);
    throw new Error(`Failed to get summary: ${response.statusText}`);
  }

  const data = await response.json();

  if (data.status === 'generating') {
    console.log(`Summary for ${eventId} is generating, polling...`);
    return pollForSummary(eventId);
  }

  console.log(`Summary received for event ${eventId}`);
  return data as BackendSummary;
}

async function pollForSummary(eventId: string, attempts = 0): Promise<BackendSummary> {
  if (attempts > 30) {
    console.error(`Summary generation timed out for event ${eventId} after ${attempts} attempts`);
    throw new Error('Summary generation timed out');
  }

  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log(`Polling for summary ${eventId} (attempt ${attempts + 1}/30)...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const response = await fetch(`${BACKEND_URL}/event/${eventId}/summary`, { signal: controller.signal });
  clearTimeout(timeoutId);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})) as { message?: string };
    console.error(`Poll failed for ${eventId}: ${response.status}`, errorData);
    throw new Error(errorData.message ?? `Failed to get summary: ${response.status}`);
  }

  const data = await response.json();

  if (data.status === 'generating') {
    return pollForSummary(eventId, attempts + 1);
  }

  console.log(`Summary ready for event ${eventId}`);
  return data as BackendSummary;
}

export async function resetAll(): Promise<{ events: number; summaries: number; queueJobs: number }> {
  console.log('Requesting full reset...');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const response = await fetch(`${BACKEND_URL}/reset`, { method: 'POST', signal: controller.signal });
  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`Failed to reset: ${response.statusText}`);
  }

  const data = await response.json();
  console.log('Reset complete:', data.cleared);
  return data.cleared;
}