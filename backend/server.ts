import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { Database, Event } from './database.js';
import { Queue } from './queue.js';
import { SummarizationWorker } from './summarization-worker.js';
import { redactSecrets } from './security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = parseInt(process.env.PORT ?? '8080', 10);

const db = new Database();
const queue = new Queue();
const worker = new SummarizationWorker(db, queue);

app.use(cors());
app.use(express.json());

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));
}

const sseClients = new Set<express.Response>();

const MAX_SUMMARIES_PER_CATEGORY = parseInt(process.env.MAX_SUMMARIES_PER_CATEGORY ?? '10', 10);

const API_BUDGET = {
  security: 0,
  code_quality: 0,
};

const pendingEvents = new Set<string>();

function canGenerateSummary(category: 'security' | 'code_quality'): boolean {
  return API_BUDGET[category] < MAX_SUMMARIES_PER_CATEGORY;
}

function incrementSummaryCount(category: 'security' | 'code_quality'): void {
  API_BUDGET[category]++;
  console.log(`API Budget (${category}): ${API_BUDGET[category]}/${MAX_SUMMARIES_PER_CATEGORY} summaries used this deployment`);
}

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/stats', async (_req, res) => {
  try {
    const stats = await db.getTotalCounts();
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/events', async (req, res) => {
  try {
    const limit = parseInt((req.query.limit as string) ?? '100', 10);
    const category = req.query.category as string | undefined;
    const events = await db.getAllEvents({ limit, category });

    const formatted = events.map((event: Event) => {
      let rawPayload = null;
      let repoContext = null;

      try {
        if (event.payload) {
          rawPayload = JSON.parse(event.payload);
        }
        if (event.repo_context) {
          repoContext = JSON.parse(event.repo_context);
        }
      } catch (e) {
        console.error('Failed to parse event payload/context:', e);
      }

      return {
        event_id: event.id,
        event_type: event.type,
        repo: event.repo,
        actor: event.actor,
        timestamp: event.created_at,
        stored_at: event.stored_at, // Include for stable sort ordering
        score: event.score,
        code_quality_score: event.code_quality_score,
        category: event.category,
        raw_payload: rawPayload,
        repo_context: repoContext,
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.get('/summary', async (req, res) => {
  try {
    const since = req.query.since as string | undefined;
    const limit = parseInt((req.query.limit as string) ?? '50', 10);

    const summaries = await db.getSummaries({ since, limit });
    res.json(summaries);
  } catch (error) {
    console.error('Error fetching summaries:', error);
    res.status(500).json({ error: 'Failed to fetch summaries' });
  }
});

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write('data: {"type":"connected"}\n\n');

  sseClients.add(res);
  console.log(`SSE client connected. Total clients: ${sseClients.size}`);

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`SSE client disconnected. Total clients: ${sseClients.size}`);
  });
});

app.post('/internal/event', async (req, res) => {
  try {
    const { event, score, codeQualityScore, category, repoContext } = req.body;

    if (!event || !event.id) {
      return res.status(400).json({ error: 'Invalid event data' });
    }

    if (category === 'normal') {
      await db.incrementNormalCounter();
      await db.storeEvent(event, score, codeQualityScore, category, null);

      broadcastEvent({
        event_id: event.id,
        event_type: event.type,
        repo: event.repo?.name || 'unknown',
        actor: event.actor?.login || 'unknown',
        timestamp: event.created_at,
        score: 0,
        code_quality_score: 0,
        category: 'normal',
      });

      return res.json({ status: 'counted', eventId: event.id });
    }

    await db.storeEvent(event, score, codeQualityScore, category || 'normal', repoContext);

    broadcastEvent({
      event_id: event.id,
      event_type: event.type,
      repo: event.repo?.name || 'unknown',
      actor: event.actor?.login || 'unknown',
      timestamp: event.created_at,
      score: score?.score || 0,
      code_quality_score: codeQualityScore?.score || 0,
      category: category ?? 'normal',
      raw_payload: event, // Include full event payload
    });

    console.log(`Stored ${category} event ${event.id}`);

    return res.json({ status: 'stored', eventId: event.id });
  } catch (error) {
    console.error('Error processing event:', redactSecrets(error));
    return res.status(500).json({ error: 'Failed to process event' });
  }
});

app.get('/event/:eventId/summary', async (req, res) => {
  try {
    const { eventId } = req.params;

    const existingSummary = await db.getSummaryByEventId(eventId);
    if (existingSummary) {
      pendingEvents.delete(eventId);
      return res.json(existingSummary);
    }

    if (pendingEvents.has(eventId)) {
      return res.json({ status: 'generating', eventId, message: 'Summary is being generated' });
    }

    const event = await db.getEvent(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const category = event.category === 'code_quality' ? 'code_quality' : 'security';

    if (!canGenerateSummary(category)) {
      console.log(`Summary budget exhausted for ${category} (${API_BUDGET[category]}/${MAX_SUMMARIES_PER_CATEGORY})`);
      return res.status(429).json({
        error: 'Summary budget exhausted',
        message: `Maximum ${MAX_SUMMARIES_PER_CATEGORY} AI summaries per ${category} category reached. Refresh page after deployment restart.`,
        category,
        used: API_BUDGET[category],
        max: MAX_SUMMARIES_PER_CATEGORY
      });
    }

    const eventData = JSON.parse(event.payload);
    const repoContext = event.repo_context ? JSON.parse(event.repo_context) : null;
    const score = event.score ? { score: event.score } : null;

    pendingEvents.add(eventId);
    incrementSummaryCount(category);

    await queue.push({
      eventId,
      event: eventData,
      score,
      repoContext,
      timestamp: event.created_at,
      category,
    });

    return res.json({ status: 'generating', eventId, message: 'Summary is being generated' });
  } catch (error) {
    console.error('Error generating summary:', redactSecrets(error));
    return res.status(500).json({ error: 'Failed to generate summary' });
  }
});

function broadcast(type: string, payload: Record<string, unknown>) {
  const data = JSON.stringify({ type, ...payload });
  const message = `data: ${data}\n\n`;

  sseClients.forEach((client) => {
    try {
      client.write(message);
    } catch (error) {
      sseClients.delete(client);
    }
  });
}

function broadcastEvent(event: any) {
  broadcast('event', event);
}

export function broadcastSummary(summary: any) {
  if (summary.event_id) {
    pendingEvents.delete(summary.event_id);
  }
  broadcast('summary', summary);
}

function broadcastError(error: any) {
  broadcast('error', error);
}

function broadcastReset() {
  broadcast('reset', { timestamp: new Date().toISOString() });
}

app.post('/reset', async (_req, res) => {
  try {
    console.log('Reset requested - clearing all data...');

    const dbResult = await db.clearAll();
    const queueCleared = await queue.clear();

    API_BUDGET.security = 0;
    API_BUDGET.code_quality = 0;
    pendingEvents.clear();

    broadcastReset();

    console.log(`Reset complete: ${dbResult.eventsCleared} events, ${dbResult.summariesCleared} summaries, ${queueCleared} queue jobs`);

    res.json({
      status: 'reset',
      cleared: {
        events: dbResult.eventsCleared,
        summaries: dbResult.summariesCleared,
        queueJobs: queueCleared
      }
    });
  } catch (error) {
    console.error('Error during reset:', error);
    res.status(500).json({ error: 'Failed to reset data' });
  }
});

if (process.env.NODE_ENV === 'production') {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}

async function start() {
  await db.init();
  await queue.init();
  worker.start(broadcastSummary, broadcastError);

  const isProd = process.env.NODE_ENV === 'production';

  app.listen(port, () => {
    console.log(`Backend API Server running on http://localhost:${port}`);
    console.log(`Mode: ${isProd ? 'Production' : 'Development'}`);
  });
}

start().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
