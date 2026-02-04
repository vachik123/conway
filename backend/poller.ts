import 'dotenv/config';
import https from 'https';
import http from 'http';
import { RepoContextFetcher } from './repo-context.js';

interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

interface PollerConfig {
  githubToken?: string;
  pollInterval: number; // milliseconds
  initialBackoff: number; // milliseconds
  maxBackoff: number; // milliseconds
  backoffMultiplier: number;
  mlServiceUrl?: string;
  backendApiUrl?: string;
}

interface MLScoreResponse {
  event_id: string;
  score: number;
  prediction: number;
  is_anomalous: boolean;
  features: Record<string, number>;
  event_type: string;
  repo: string;
  actor: string;
}

class GitHubEventsPoller {
  private config: PollerConfig;
  private currentBackoff: number;
  private lastEtag: string | null = null;
  private seenEventIds: Set<string> = new Set();
  private pollCount: number = 0;
  private repoContextFetcher: RepoContextFetcher | null = null;

  constructor(config: Partial<PollerConfig> = {}) {
    this.config = {
      githubToken: process.env.GITHUB_TOKEN,
      pollInterval: 60000, // 60 seconds default
      initialBackoff: 5000, // 5 seconds
      maxBackoff: 300000, // 5 minutes
      backoffMultiplier: 2,
      mlServiceUrl: process.env.ML_SERVICE_URL || 'http://localhost:5001',
      backendApiUrl: process.env.BACKEND_API_URL || `http://localhost:${process.env.PORT || 8080}`,
      ...config,
    };
    this.currentBackoff = this.config.initialBackoff;

    if (this.config.githubToken) {
      this.repoContextFetcher = new RepoContextFetcher(this.config.githubToken);
    }
  }

  private async makeRequest(): Promise<{
    data: any[];
    headers: Record<string, string>;
    statusCode: number;
  }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        'User-Agent': 'Conway-GitHub-Sentinel',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };

      if (this.config.githubToken) {
        headers['Authorization'] = `Bearer ${this.config.githubToken}`;
      }

      if (this.lastEtag) {
        headers['If-None-Match'] = this.lastEtag;
      }

      const options: https.RequestOptions = {
        hostname: 'api.github.com',
        path: '/events?per_page=10',
        method: 'GET',
        headers,
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          const headers: Record<string, string> = {};
          Object.entries(res.headers).forEach(([key, value]) => {
            headers[key] = Array.isArray(value) ? value[0] : value || '';
          });

          try {
            const parsed = data ? JSON.parse(data) : [];
            resolve({
              data: parsed,
              headers,
              statusCode: res.statusCode || 500,
            });
          } catch (err) {
            reject(new Error(`Failed to parse response: ${err}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end();
    });
  }

  private async scoreEvent(event: any, repoContext: any = null): Promise<MLScoreResponse | null> {
    return new Promise((resolve) => {
      const requestBody = repoContext
        ? { event, repo_context: repoContext }
        : event;

      const payload = JSON.stringify(requestBody);
      const url = new URL(`${this.config.mlServiceUrl}/score`);

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 5001,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const result = JSON.parse(data);
              resolve(result);
            } else {
              console.error(`ML service error: ${res.statusCode} - ${data}`);
              resolve(null);
            }
          } catch (err) {
            console.error(`Failed to parse ML response: ${err}`);
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        console.error(`ML service request failed: ${err.message}`);
        resolve(null);
      });

      req.write(payload);
      req.end();
    });
  }

  private async scoreCodeQuality(event: any): Promise<any | null> {
    if (event.type !== 'PullRequestEvent' && event.type !== 'PushEvent') {
      return null;
    }

    let prContext = null;
    let commitContext = null;

    if (this.repoContextFetcher) {
      const repoName = event.repo?.name;
      if (repoName) {
        const [owner, repo] = repoName.split('/');

        try {
          if (event.type === 'PullRequestEvent' && event.payload?.number) {
            prContext = await this.repoContextFetcher.fetchPRContext(owner, repo, event.payload.number);
          } else if (event.type === 'PushEvent' && event.payload?.head) {
            commitContext = await this.repoContextFetcher.fetchCommitContext(owner, repo, event.payload.head);
          }
        } catch (err) {
          // non-fatal: scoring continues without PR/commit context
        }
      }
    }

    const eventWithContext = {
      ...event,
      ...(prContext && { _pr_context: prContext }),
      ...(commitContext && { _commit_context: commitContext }),
    };

    return new Promise((resolve) => {
      const payload = JSON.stringify({ event: eventWithContext });
      const url = new URL(`${this.config.mlServiceUrl}/score/code-quality`);

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 5001,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const result = JSON.parse(data);
              resolve(result);
            } else {
              resolve(null);
            }
          } catch (err) {
            resolve(null);
          }
        });
      });

      req.on('error', () => {
        resolve(null);
      });

      req.write(payload);
      req.end();
    });
  }

  private async sendToBackend(event: any, score: any, codeQualityScore: any, category: string, repoContext: any): Promise<void> {
    return new Promise((resolve) => {
      const payload = JSON.stringify({ event, score, codeQualityScore, category, repoContext });
      const url = new URL(`${this.config.backendApiUrl}/internal/event`);

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 3001,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log(`Event ${event.id} sent to backend`);
          } else {
            console.error(`Backend API error: ${res.statusCode} - ${data}`);
          }
          resolve();
        });
      });

      req.on('error', (err) => {
        console.error(`Backend API request failed: ${err.message}`);
        resolve();
      });

      req.write(payload);
      req.end();
    });
  }

  private parseRateLimitHeaders(headers: Record<string, string>): RateLimitInfo | null {
    const limit = headers['x-ratelimit-limit'];
    const remaining = headers['x-ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'];

    if (limit && remaining && reset) {
      return {
        limit: parseInt(limit, 10),
        remaining: parseInt(remaining, 10),
        reset: parseInt(reset, 10),
      };
    }
    return null;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private increaseBackoff(): void {
    const nextBackoff = this.currentBackoff * this.config.backoffMultiplier;
    // Add jitter: randomize between 80% and 120% of calculated backoff
    const jitter = 0.8 + Math.random() * 0.4;
    this.currentBackoff = Math.min(
      nextBackoff * jitter,
      this.config.maxBackoff
    );
  }

  private resetBackoff(): void {
    this.currentBackoff = this.config.initialBackoff;
  }

  private logRateLimitInfo(rateLimitInfo: RateLimitInfo): void {
    const resetDate = new Date(rateLimitInfo.reset * 1000);
    const now = new Date();
    const minutesUntilReset = Math.ceil((resetDate.getTime() - now.getTime()) / 60000);

    console.log('\nRate Limit Status:');
    console.log(`   Remaining: ${rateLimitInfo.remaining}/${rateLimitInfo.limit}`);
    console.log(`   Resets in: ${minutesUntilReset} minutes (${resetDate.toLocaleTimeString()})`);
  }

  async poll(): Promise<void> {
    const isProduction = process.env.NODE_ENV === 'production';

    console.log('\nStarting GitHub Events Poller...');
    console.log(`  Poll interval: ${this.config.pollInterval / 1000}s`);
    console.log(`  Auth token: ${this.config.githubToken ? 'Configured' : 'Not set (rate limits will be lower)'}`);
    console.log(`  ML Service: ${this.config.mlServiceUrl}`);
    console.log(`  Backend API: ${this.config.backendApiUrl}`);
    console.log(`  Repo Context: ${this.repoContextFetcher ? 'Enabled (GraphQL v4 + Check Runs)' : 'Disabled (no token)'}`);
    if (this.repoContextFetcher) {
      console.log(`  Note: GraphQL has separate rate limit (5000 points/hr) from REST API`);
    }
    console.log(`  Security: ${isProduction ? 'Production mode - secrets filtered' : 'Development mode'}`);
    console.log('\n');

    while (true) {
      try {
        this.pollCount++;
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Poll #${this.pollCount} at ${new Date().toLocaleString()}`);
        console.log(`${'='.repeat(60)}`);

        const { data: events, headers, statusCode } = await this.makeRequest();

        const rateLimitInfo = this.parseRateLimitHeaders(headers);
        if (rateLimitInfo) {
          this.logRateLimitInfo(rateLimitInfo);

          if (rateLimitInfo.remaining < 10) {
            console.warn(`Only ${rateLimitInfo.remaining} requests remaining!`);
          }
        }

        if (statusCode === 304) {
          console.log('\nNo new events (304 Not Modified)');
          this.resetBackoff();
        } else if (statusCode === 200) {
          if (headers['etag']) {
            this.lastEtag = headers['etag'];
          }

          const newEvents = events.filter((event) => !this.seenEventIds.has(event.id));

          console.log(`\nReceived ${events.length} events (${newEvents.length} new)`);

          if (newEvents.length > 0) {
            const scoringPromises = newEvents.map(async (event) => {
              this.seenEventIds.add(event.id);

              let repoContext = null;
              let contextRisk = 0;
              if (this.repoContextFetcher && event.repo?.name) {
                repoContext = await this.repoContextFetcher.fetchRepoContext(event.repo.name);
                if (repoContext) {
                  contextRisk = this.repoContextFetcher.calculateContextualRisk(repoContext, event.type);
                }
              }

              const [securityScore, codeQualityScore] = await Promise.all([
                this.scoreEvent(event, repoContext),
                this.scoreCodeQuality(event),
              ]);

              const isSecurity = securityScore && securityScore.is_anomalous;
              const isCodeQuality = codeQualityScore && !codeQualityScore.is_good_practice;

              let category: 'security' | 'code_quality' | 'both' | 'normal' = 'normal';
              if (isSecurity && isCodeQuality) {
                category = 'both';
              } else if (isSecurity) {
                category = 'security';
              } else if (isCodeQuality) {
                category = 'code_quality';
              }

              return { event, securityScore, codeQualityScore, category, repoContext, contextRisk };
            });

            const scoredEvents = await Promise.all(scoringPromises);

            const backendPromises = scoredEvents.map(({ event, securityScore, codeQualityScore, category, repoContext }) =>
              this.sendToBackend(event, securityScore, codeQualityScore, category, repoContext)
            );
            await Promise.all(backendPromises);

            const securityEvents = scoredEvents.filter(({ category }) => category === 'security');
            const codeQualityEvents = scoredEvents.filter(({ category }) => category === 'code_quality');

            if (securityEvents.length > 0 || codeQualityEvents.length > 0) {
              console.log(`\nFound ${securityEvents.length} security anomalies, ${codeQualityEvents.length} code quality issues out of ${newEvents.length} events\n`);

              securityEvents.forEach(({ event, securityScore, repoContext }, index) => {
                console.log(`${'='.repeat(80)}`);
                console.log(`SECURITY ANOMALY ${index + 1}/${securityEvents.length} - Score: ${securityScore?.score.toFixed(3) || 'N/A'} - ID: ${event.id}`);
                console.log(`${'='.repeat(80)}`);
                console.log(`Type:       ${event.type}`);
                console.log(`Actor:      ${event.actor?.login || 'N/A'}`);
                console.log(`Repo:       ${event.repo?.name || 'N/A'}`);
                console.log(`Created:    ${new Date(event.created_at).toLocaleString()}`);

                if (securityScore) {
                  console.log(`\nML Features:`);
                  console.log(`  Force Push to Main:   ${securityScore.features.force_push_to_main === 1 ? 'YES' : 'No'}`);
                  console.log(`  Workflow File Change: ${securityScore.features.is_workflow_file_change === 1 ? 'YES' : 'No'}`);
                  console.log(`  Branch Deletion:      ${securityScore.features.is_branch_deletion === 1 ? 'YES' : 'No'}`);
                  console.log(`  Bot Suspicion:        ${securityScore.features.bot_suspicion_score?.toFixed(2) || 0}`);
                }

                if (repoContext) {
                  console.log(`\nRepo Context:`);
                  console.log(`  Summary:        ${this.repoContextFetcher!.generateContextSummary(repoContext)}`);
                  console.log(`  Stars:          ${repoContext.metadata.stars}`);
                  console.log(`  Age:            ${repoContext.metadata.age_days} days`);
                  console.log(`  Language:       ${repoContext.metadata.primaryLanguage || 'N/A'}`);
                  console.log(`  Branch Protection: ${repoContext.security.hasBranchProtection ? 'YES' : 'NO'}`);
                  console.log(`  Default Branch: ${repoContext.security.defaultBranchName}`);
                  console.log(`  Contributors:   ${repoContext.activity.uniqueContributors}`);
                  console.log(`  Recent Commits: ${repoContext.activity.recentCommitCount}`);

                  if (repoContext.checks) {
                    console.log(`  Check Failure Rate: ${(repoContext.checks.failureRate * 100).toFixed(1)}%`);
                    console.log(`  Avg Check Duration: ${(repoContext.checks.avgDuration / 1000).toFixed(0)}s`);

                    if (repoContext.checks.latestCheckRuns.length > 0) {
                      console.log(`\n  Latest Check Runs:`);
                      repoContext.checks.latestCheckRuns.slice(0, 3).forEach((run: { name: string; status: string; conclusion: string | null }) => {
                        const status = run.conclusion === 'success' ? 'PASS' : run.conclusion === 'failure' ? 'FAIL' : 'PENDING';
                        console.log(`    [${status}] ${run.name}: ${run.status} (${run.conclusion ?? 'pending'})`);
                      });
                    }
                  }

                  if (repoContext.metadata.isArchived) {
                    console.log(`\n  WARNING: Repository is ARCHIVED but still has activity!`);
                  }
                }

                console.log(`${'='.repeat(80)}\n`);
              });

              codeQualityEvents.forEach(({ event, codeQualityScore }, index) => {
                console.log(`${'='.repeat(80)}`);
                console.log(`CODE QUALITY ISSUE ${index + 1}/${codeQualityEvents.length} - Score: ${codeQualityScore?.score.toFixed(3) || 'N/A'} - ID: ${event.id}`);
                console.log(`${'='.repeat(80)}`);
                console.log(`Type:       ${event.type}`);
                console.log(`Actor:      ${event.actor?.login || 'N/A'}`);
                console.log(`Repo:       ${event.repo?.name || 'N/A'}`);
                console.log(`Created:    ${new Date(event.created_at).toLocaleString()}`);
                console.log(`${'='.repeat(80)}\n`);
              });
            } else {
              console.log(`\nAll ${newEvents.length} events scored normal`);
            }

            if (this.seenEventIds.size > 1000) {
              const idsArray = Array.from(this.seenEventIds);
              this.seenEventIds = new Set(idsArray.slice(-1000));
            }
          }

          this.resetBackoff();
        } else if (statusCode === 403 || statusCode === 429) {
          const retryAfter = headers['retry-after'];
          let waitTime: number;

          if (retryAfter) {
            const baseWait = parseInt(retryAfter, 10) * 1000;
            const jitter = 0.9 + Math.random() * 0.2;
            waitTime = baseWait * jitter;
          } else {
            this.increaseBackoff();
            waitTime = this.currentBackoff;
          }

          console.error(`\nRate limited (${statusCode}). Waiting ${(waitTime / 1000).toFixed(1)}s before retry...`);
          await this.sleep(waitTime);
          continue;
        } else {
          console.error(`\nUnexpected status code: ${statusCode}`);
          this.increaseBackoff();
        }

        if (this.repoContextFetcher && this.pollCount % 10 === 0) {
          this.repoContextFetcher.clearOldCache();

          const graphqlRateLimit = this.repoContextFetcher.getGraphQLRateLimit();
          if (graphqlRateLimit) {
            const resetDate = new Date(graphqlRateLimit.reset * 1000);
            const now = new Date();
            const minutesUntilReset = Math.ceil((resetDate.getTime() - now.getTime()) / 60000);

            console.log('\nGraphQL API Status:');
            console.log(`  Points: ${graphqlRateLimit.remaining}/${graphqlRateLimit.limit} remaining (${graphqlRateLimit.used} used)`);
            console.log(`  Resets: ${resetDate.toLocaleString()} (in ${minutesUntilReset} minutes)`);

            if (graphqlRateLimit.remaining < 500) {
              console.warn(`  WARNING: Running low on GraphQL points!`);
            }
          }
        }

        console.log(`\nWaiting ${this.config.pollInterval / 1000}s until next poll...`);
        await this.sleep(this.config.pollInterval);
      } catch (error) {
        console.error('\nError during polling:', error);
        console.error(`Backing off for ${this.currentBackoff / 1000}s...`);
        this.increaseBackoff();
        await this.sleep(this.currentBackoff);
      }
    }
  }
}

const poller = new GitHubEventsPoller({
  pollInterval: 10000,
});

poller.poll().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
