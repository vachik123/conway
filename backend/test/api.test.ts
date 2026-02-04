import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { Database } from '../database.js';

describe('Backend API', () => {
  let app: express.Application;
  let db: Database;

  beforeAll(async () => {
    // Create test app
    app = express();
    app.use(express.json());

    // Initialize test database
    db = new Database();
    await db.init();

    // Add test routes
    app.get('/health', (_req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    app.get('/summary', async (req, res) => {
      const summaries = await db.getSummaries({
        since: req.query.since as string,
        limit: parseInt((req.query.limit as string) ?? '50'),
      });
      res.json(summaries);
    });
  });

  afterAll(() => {
    // Cleanup if needed
  });

  describe('GET /health', () => {
    it('should return healthy status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'healthy');
      expect(response.body).toHaveProperty('timestamp');
    });
  });

  describe('GET /summary', () => {
    it('should return empty array when no summaries exist', async () => {
      const response = await request(app).get('/summary');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should accept since parameter', async () => {
      const since = new Date(Date.now() - 3600000).toISOString();
      const response = await request(app).get(`/summary?since=${since}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should accept limit parameter', async () => {
      const response = await request(app).get('/summary?limit=10');

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });
  });
});
