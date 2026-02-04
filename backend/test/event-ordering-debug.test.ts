/**
 * Event Timeline Ordering Debug Test
 *
 * This test helps identify exactly how event ordering changes between page loads
 * by converting the event timeline into a text format for comparison.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { Database } from '../database.js';
import fs from 'fs';

interface EventWithCategory {
  event_id: string;
  category: string;
  repo: string;
  timestamp: string;
}

interface BatchItem {
  isSecurity: boolean;
  isCodeQuality: boolean;
  repo: string;
  timestamp: string;
  event_id: string;
}

describe('Event Timeline Ordering Debug', () => {
  let db: Database;
  const testDbPath = './test-event-ordering.db';

  beforeEach(async () => {
    // Set DB_PATH environment variable for testing
    process.env.DB_PATH = testDbPath;

    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Initialize new database
    db = new Database();
    await db.init();

    // Seed with 100 test events (10 columns x 10 events each)
    // Include events with same timestamps to expose ordering issues
    const baseTime = new Date('2024-01-15T10:30:00Z').getTime();

    const categories: Array<'security' | 'code_quality' | 'normal'> = ['security', 'code_quality', 'normal'];
    const repos = ['repo-a', 'repo-b', 'repo-c', 'repo-d', 'repo-e'];

    for (let i = 0; i < 100; i++) {
      const eventId = `event-${String(i + 1).padStart(3, '0')}`;
      const category = categories[i % categories.length];
      const repo = repos[i % repos.length];

      // Create groups of events with same timestamp (5 events per timestamp)
      const timeOffset = Math.floor(i / 5) * 1000;
      const timestamp = new Date(baseTime + timeOffset).toISOString();

      const securityScore = category === 'security' ? { score: 0.8 + (i % 10) * 0.02 } : null;
      const codeQualityScore = category === 'code_quality' ? { score: 0.7 + (i % 10) * 0.02 } : null;

      await db.storeEvent(
        {
          id: eventId,
          type: 'PushEvent',
          repo: { name: repo },
          created_at: timestamp
        },
        securityScore,
        codeQualityScore,
        category,
        null
      );
    }
  });

  /**
   * Fetches events and applies the same sorting/batching logic as App.tsx (lines 183-228)
   */
  async function fetchAndBatchEvents(): Promise<BatchItem[][]> {
    // Fetch events from database (simulating what happens on page refresh)
    const security = await db.getAllEvents({ limit: 1000, category: 'security' });
    const codeQuality = await db.getAllEvents({ limit: 1000, category: 'code_quality' });
    const normal = await db.getAllEvents({ limit: 1000, category: 'normal' });

    // Combine all events with their categories (App.tsx lines 183-187)
    const allHistoricalEvents: EventWithCategory[] = [
      ...security.map((e: any) => ({
        event_id: e.id,
        category: e.category || 'security',
        repo: e.repo || 'unknown',
        timestamp: e.created_at
      })),
      ...codeQuality.map((e: any) => ({
        event_id: e.id,
        category: e.category || 'code_quality',
        repo: e.repo || 'unknown',
        timestamp: e.created_at
      })),
      ...normal.map((e: any) => ({
        event_id: e.id,
        category: 'normal',
        repo: e.repo || 'unknown',
        timestamp: e.created_at
      }))
    ];

    // Apply the exact same sorting logic as App.tsx (lines 189-193)
    allHistoricalEvents.sort((a, b) => {
      const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.event_id.localeCompare(b.event_id, undefined, { numeric: true });
    });

    // Create batches exactly like App.tsx (lines 195-228)
    const batches: BatchItem[][] = [];
    const MAX_BATCH_SIZE = 10;
    let currentBatch: BatchItem[] = [];

    allHistoricalEvents.forEach((event: EventWithCategory) => {
      const category = event.category || 'normal';

      currentBatch.push({
        isSecurity: category === 'security' || category === 'both',
        isCodeQuality: category === 'code_quality' || category === 'both',
        repo: event.repo,
        timestamp: event.timestamp,
        event_id: event.event_id
      });

      if (currentBatch.length >= MAX_BATCH_SIZE) {
        batches.push([...currentBatch]);
        currentBatch = [];
      }
    });

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  /**
   * Converts batches to readable text format for comparison
   */
  function convertBatchesToText(batches: BatchItem[][]): string {
    let output = '';

    batches.forEach((batch, columnIndex) => {
      output += `Column ${columnIndex + 1}:\n`;
      batch.forEach((event, eventIndex) => {
        const category = event.isSecurity ? 'security' : (event.isCodeQuality ? 'code_quality' : 'normal');
        output += `  [${eventIndex}] ${event.event_id} (${category}) - ${event.timestamp} - ${event.repo}\n`;
      });
      output += '\n';
    });

    return output;
  }

  it('should maintain consistent order across multiple fetches', async () => {
    // Fetch 1: Get events as historical
    const fetch1Result = await fetchAndBatchEvents();
    const textOutput1 = convertBatchesToText(fetch1Result);

    // Fetch 2: Get events again (simulating refresh)
    const fetch2Result = await fetchAndBatchEvents();
    const textOutput2 = convertBatchesToText(fetch2Result);

    // Log outputs for debugging
    console.log('\n========== FETCH 1 ==========');
    console.log(textOutput1);
    console.log('========== FETCH 2 ==========');
    console.log(textOutput2);
    console.log('=============================\n');

    // Compare - test will FAIL if order differs
    expect(textOutput1).toBe(textOutput2);
  });

  it('should sort events with same timestamp by event_id', async () => {
    const batches = await fetchAndBatchEvents();
    const allEvents = batches.flat();

    // Check that events with same timestamp are sorted by event_id
    const baseTime = new Date('2024-01-15T10:30:00Z').toISOString();
    const sameTimeEvents = allEvents.filter(e => e.timestamp === baseTime);

    // First 5 events should have the same timestamp
    expect(sameTimeEvents.length).toBe(5);
    expect(sameTimeEvents[0].event_id).toBe('event-001');
    expect(sameTimeEvents[1].event_id).toBe('event-002');
    expect(sameTimeEvents[2].event_id).toBe('event-003');
    expect(sameTimeEvents[3].event_id).toBe('event-004');
    expect(sameTimeEvents[4].event_id).toBe('event-005');

    // Verify all events are present
    expect(allEvents.length).toBe(100);
  });

  it('should show event order with detailed timestamps', async () => {
    const batches = await fetchAndBatchEvents();
    const textOutput = convertBatchesToText(batches);

    console.log('\n========== EVENT ORDER DETAIL ==========');
    console.log(textOutput);
    console.log('======================================\n');

    // This test always passes but prints the order for manual inspection
    expect(batches.length).toBeGreaterThan(0);
  });
});
