import IORedis from 'ioredis';

export interface QueueJob {
  eventId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  event: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  score: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repoContext: any;
  timestamp: string;
  category: 'security' | 'code_quality';
}

export class Queue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redis: any = null;
  private useInMemory = false;
  private inMemoryQueue: QueueJob[] = [];
  private readonly queueKey = 'conway:summarization_queue';

  async init() {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
      console.log('REDIS_URL not set, using in-memory queue (data lost on restart)');
      this.useInMemory = true;
      return;
    }

    try {
      // @ts-expect-error ioredis default export typing with NodeNext module resolution
      this.redis = new IORedis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => {
          if (times > 5) {
            console.log('Redis unavailable after 5 retries, falling back to in-memory queue');
            this.useInMemory = true;
            return null;
          }
          const delay = Math.min(times * 1000, 10000);
          console.log(`Redis retry attempt ${times}, waiting ${delay}ms...`);
          return delay;
        },
        connectTimeout: 5000,
        lazyConnect: true,
      });

      this.redis.on('connect', () => {
        console.log('Redis connected');
        this.useInMemory = false;
      });

      this.redis.on('error', (err: Error) => {
        console.error('Redis error:', err.message);
      });

      await this.redis.connect();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.log(`Redis connection failed (${errorMessage}), using in-memory queue`);
      this.useInMemory = true;
      this.redis = null;
    }
  }

  async push(job: QueueJob): Promise<void> {
    if (this.useInMemory) {
      this.inMemoryQueue.push(job);
      return;
    }
    if (!this.redis) throw new Error('Queue not initialized');
    await this.redis.rpush(this.queueKey, JSON.stringify(job));
  }

  async pop(): Promise<QueueJob | null> {
    if (this.useInMemory) {
      if (this.inMemoryQueue.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return this.inMemoryQueue.shift() || null;
      }
      return this.inMemoryQueue.shift() || null;
    }

    if (!this.redis) throw new Error('Queue not initialized');

    const result = await this.redis.blpop(this.queueKey, 5);
    if (!result) return null;

    const [, data] = result;
    return JSON.parse(data);
  }

  async length(): Promise<number> {
    if (this.useInMemory) {
      return this.inMemoryQueue.length;
    }
    if (!this.redis) throw new Error('Queue not initialized');
    return await this.redis.llen(this.queueKey);
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  async clear(): Promise<number> {
    if (this.useInMemory) {
      const count = this.inMemoryQueue.length;
      this.inMemoryQueue = [];
      return count;
    }
    if (!this.redis) throw new Error('Queue not initialized');
    const count = await this.redis.llen(this.queueKey);
    await this.redis.del(this.queueKey);
    return count;
  }
}
