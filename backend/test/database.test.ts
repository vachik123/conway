/**
 * Database functionality tests
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { Database, Summary } from '../database.js';
import fs from 'fs';

describe('Database', () => {
  let db: Database;
  const testDbPath = './test-conway.db';

  beforeEach(async () => {
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Initialize new database
    db = new Database();
    await db.init();
  });

  describe('storeEvent', () => {
    it('should store an event successfully', async () => {
      const testEvent = {
        id: 'test-event-123',
        type: 'PushEvent',
        repo: { name: 'test/repo' },
        actor: { login: 'testuser' },
        created_at: new Date().toISOString(),
      };

      await db.storeEvent(
        testEvent,
        { score: 0.75 },
        { score: 0.5 },
        'security',
        null
      );

      const stored = await db.getEvent('test-event-123');
      expect(stored).toBeTruthy();
      expect(stored?.id).toBe('test-event-123');
      expect(stored?.type).toBe('PushEvent');
      expect(stored?.score).toBe(0.75);
      expect(stored?.category).toBe('security');
    });

    it('should handle missing optional fields', async () => {
      const testEvent = {
        id: 'test-event-456',
        type: 'IssuesEvent',
        created_at: new Date().toISOString(),
      };

      await db.storeEvent(testEvent, null, null, 'normal', null);

      const stored = await db.getEvent('test-event-456');
      expect(stored).toBeTruthy();
      expect(stored?.score).toBeNull();
      expect(stored?.category).toBe('normal');
    });
  });

  describe('storeSummary', () => {
    it('should store a summary successfully', async () => {
      const testSummary = {
        event_id: 'test-event-123',
        event_type: 'PushEvent',
        repo: 'test/repo',
        actor: 'testuser',
        timestamp: new Date().toISOString(),
        root_cause: 'Test root cause',
        impact: 'Test impact',
        next_steps: 'Test next steps',
        raw_summary: JSON.stringify({ test: 'data' }),
      };

      const result = await db.storeSummary(testSummary);
      expect(result.wasInserted).toBe(true);
      expect(result.id).toBeGreaterThan(0);

      const stored = await db.getSummaryByEventId('test-event-123');
      expect(stored).toBeTruthy();
      expect(stored?.root_cause).toBe('Test root cause');
    });

    it('should prevent duplicate summaries for same event', async () => {
      const testSummary = {
        event_id: 'test-event-789',
        event_type: 'PushEvent',
        repo: 'test/repo',
        actor: 'testuser',
        timestamp: new Date().toISOString(),
        root_cause: 'First summary',
        impact: 'Test impact',
        next_steps: 'Test next steps',
        raw_summary: '{}',
      };

      const first = await db.storeSummary(testSummary);
      expect(first.wasInserted).toBe(true);

      // Try to insert duplicate
      const duplicate = await db.storeSummary({
        ...testSummary,
        root_cause: 'Second summary',
      });
      expect(duplicate.wasInserted).toBe(false);
    });
  });

  describe('getSummaries', () => {
    it('should filter by since parameter', async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 3600000).toISOString();

      // Store old summary
      await db.storeSummary({
        event_id: 'old-event',
        event_type: 'PushEvent',
        repo: 'test/repo',
        actor: 'user',
        timestamp: past,
        root_cause: 'Old',
        impact: 'Test',
        next_steps: 'Test',
        raw_summary: '{}',
      });

      // Store new summary
      await db.storeSummary({
        event_id: 'new-event',
        event_type: 'PushEvent',
        repo: 'test/repo',
        actor: 'user',
        timestamp: now.toISOString(),
        root_cause: 'New',
        impact: 'Test',
        next_steps: 'Test',
        raw_summary: '{}',
      });

      const recent = await db.getSummaries({ since: past });
      expect(recent.length).toBeGreaterThan(0);
      expect(recent.every((s: Summary) => s.created_at > past)).toBe(true);
    });
  });
});
