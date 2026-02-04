import BetterSqlite3 from 'better-sqlite3';
import { join } from 'path';

export interface Event {
  id: string;
  type: string;
  repo: string;
  actor: string;
  created_at: string;
  payload: string; // JSON
  score: number | null;
  code_quality_score: number | null;
  category: 'security' | 'code_quality' | 'both' | 'normal' | null;
  repo_context: string | null; // JSON
  stored_at: string;
}

export interface Summary {
  id: number;
  event_id: string;
  event_type: string;
  repo: string;
  actor: string;
  timestamp: string;
  root_cause: string;
  impact: string;
  next_steps: string;
  raw_summary: string; // JSON from LLM response
  created_at: string;
}

export class Database {
  private db: BetterSqlite3.Database | null = null;

  async init() {
    // Railway provides volume at /app/data
    const dbPath = process.env.DB_PATH ?? join('/app/data', 'conway.db');
    this.db = new BetterSqlite3(dbPath);

    console.log(`Database initialized at ${dbPath}`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        repo TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        score REAL,
        code_quality_score REAL,
        category TEXT,
        repo_context TEXT,
        stored_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
      CREATE INDEX IF NOT EXISTS idx_events_repo ON events(repo);
      CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);

      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        repo TEXT NOT NULL,
        actor TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        root_cause TEXT NOT NULL,
        impact TEXT NOT NULL,
        next_steps TEXT NOT NULL,
        raw_summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_created_at ON summaries(created_at);
      CREATE INDEX IF NOT EXISTS idx_summaries_event_id ON summaries(event_id);

      CREATE TABLE IF NOT EXISTS counters (
        category TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0
      );

      -- Initialize counter for normal events
      INSERT OR IGNORE INTO counters (category, count) VALUES ('normal', 0);
    `);
  }

  async storeEvent(
    event: any,
    score: any,
    codeQualityScore: any,
    category: 'security' | 'code_quality' | 'normal',
    repoContext: any
  ): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO events (id, type, repo, actor, created_at, payload, score, code_quality_score, category, repo_context, stored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.id,
      event.type,
      event.repo?.name ?? 'unknown',
      event.actor?.login ?? 'unknown',
      event.created_at,
      JSON.stringify(event),
      score?.score || null,
      codeQualityScore?.score || null,
      category,
      repoContext ? JSON.stringify(repoContext) : null,
      new Date().toISOString()
    );
  }

  async storeSummary(summary: Omit<Summary, 'id' | 'created_at'>): Promise<{id: number, wasInserted: boolean}> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO summaries (event_id, event_type, repo, actor, timestamp, root_cause, impact, next_steps, raw_summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      summary.event_id,
      summary.event_type,
      summary.repo,
      summary.actor,
      summary.timestamp,
      summary.root_cause,
      summary.impact,
      summary.next_steps,
      summary.raw_summary,
      new Date().toISOString()
    );

    return {
      id: result.lastInsertRowid as number,
      wasInserted: result.changes > 0
    };
  }

  async getSummaries(options: { since?: string; limit?: number } = {}): Promise<Summary[]> {
    if (!this.db) throw new Error('Database not initialized');

    const { since, limit = 50 } = options;

    let query = 'SELECT * FROM summaries';
    const params: any[] = [];

    if (since) {
      query += ' WHERE created_at > ?';
      params.push(since);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as Summary[];
  }

  async getEvent(eventId: string): Promise<Event | null> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT * FROM events WHERE id = ?');
    return (stmt.get(eventId) as Event) || null;
  }

  async getSummaryByEventId(eventId: string): Promise<Summary | null> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT * FROM summaries WHERE event_id = ?');
    return (stmt.get(eventId) as Summary) || null;
  }

  async getAllEvents(options: { limit?: number; category?: string } = {}): Promise<Event[]> {
    if (!this.db) throw new Error('Database not initialized');

    const { limit = 100, category } = options;

    let query = 'SELECT * FROM events';
    const params: any[] = [];

    if (category) {
      query += ' WHERE category = ?';
      params.push(category);
    }

    query += ' ORDER BY created_at ASC, id ASC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as Event[];
  }

  async cleanupOldNormalEvents(keepCount: number = 100): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    this.db.exec(`
      DELETE FROM events
      WHERE category = 'normal'
      AND id NOT IN (
        SELECT id FROM events
        WHERE category = 'normal'
        ORDER BY created_at DESC
        LIMIT ${keepCount}
      )
    `);
  }

  async incrementNormalCounter(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      UPDATE counters SET count = count + 1 WHERE category = 'normal'
    `);

    stmt.run();
  }

  async getTotalCounts(): Promise<{ totalSecurity: number; totalCodeQuality: number; totalNormal: number; total: number }> {
    if (!this.db) throw new Error('Database not initialized');

    // Get counts for security and code_quality from events table
    const eventsStmt = this.db.prepare(`
      SELECT
        SUM(CASE WHEN category = 'security' THEN 1 ELSE 0 END) as security,
        SUM(CASE WHEN category = 'code_quality' THEN 1 ELSE 0 END) as code_quality
      FROM events
    `);

    const eventsResult = eventsStmt.get() as { security: number | null; code_quality: number | null } | undefined;

    const counterStmt = this.db.prepare(`
      SELECT count FROM counters WHERE category = 'normal'
    `);

    const counterResult = counterStmt.get() as { count: number } | undefined;

    const totalSecurity = eventsResult?.security ?? 0;
    const totalCodeQuality = eventsResult?.code_quality ?? 0;
    const totalNormal = counterResult?.count ?? 0;

    return {
      totalSecurity,
      totalCodeQuality,
      totalNormal,
      total: totalSecurity + totalCodeQuality + totalNormal
    };
  }

  async clearAll(): Promise<{ eventsCleared: number; summariesCleared: number }> {
    if (!this.db) throw new Error('Database not initialized');

    const eventsCount = (this.db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }).count;
    const summariesCount = (this.db.prepare('SELECT COUNT(*) as count FROM summaries').get() as { count: number }).count;

    this.db.exec('DELETE FROM events');
    this.db.exec('DELETE FROM summaries');
    this.db.exec("UPDATE counters SET count = 0 WHERE category = 'normal'");

    console.log(`Database cleared: ${eventsCount} events, ${summariesCount} summaries`);

    return {
      eventsCleared: eventsCount,
      summariesCleared: summariesCount
    };
  }
}
