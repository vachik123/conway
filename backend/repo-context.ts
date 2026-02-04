import https from 'https';

export interface RepoContext {
  repo: string;
  metadata: {
    stars: number;
    watchers: number;
    forks: number;
    openIssues: number;
    age_days: number;
    primaryLanguage: string | null;
    isArchived: boolean;
    hasWikiEnabled: boolean;
    hasIssuesEnabled: boolean;
  };
  security: {
    hasBranchProtection: boolean;
    defaultBranchName: string;
    vulnerabilityAlertsEnabled: boolean;
  };
  activity: {
    recentCommitCount: number;
    uniqueContributors: number;
    hasRecentActivity: boolean;
  };
  checks?: {
    latestCheckRuns: CheckRunSummary[];
    failureRate: number;
    avgDuration: number;
  };
}

export interface CheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PRContext {
  number: number;
  title: string;
  body: string;
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: {
    message: string;
    additions: number;
    deletions: number;
  }[];
  files: {
    path: string;
    additions: number;
    deletions: number;
  }[];
  reviews: {
    totalCount: number;
  };
  comments: {
    totalCount: number;
  };
}

export interface CommitContext {
  sha: string;
  message: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  committedDate: string;
  author: {
    name: string;
    email: string;
  };
}

export class RepoContextFetcher {
  private githubToken: string;
  private cache: Map<string, { data: RepoContext; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 300000; // 5 minutes
  private lastGraphQLRateLimit: {
    limit: number;
    remaining: number;
    used: number;
    reset: number;
    resource: string;
  } | null = null;

  constructor(githubToken: string) {
    this.githubToken = githubToken;
  }

  /**
   * Get current GraphQL rate limit status
   */
  getGraphQLRateLimit() {
    return this.lastGraphQLRateLimit;
  }

  hasGraphQLCapacity(minPoints = 50): boolean {
    if (!this.lastGraphQLRateLimit) {
      return true;
    }

    const now = Math.floor(Date.now() / 1000);
    if (now >= this.lastGraphQLRateLimit.reset) {
      return true;
    }

    return this.lastGraphQLRateLimit.remaining >= minPoints;
  }

  async fetchRepoContext(repoFullName: string): Promise<RepoContext | null> {
    const cached = this.cache.get(repoFullName);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    if (!this.hasGraphQLCapacity(50)) {
      if (this.lastGraphQLRateLimit) {
        const resetDate = new Date(this.lastGraphQLRateLimit.reset * 1000);
        const minutesUntilReset = Math.ceil((resetDate.getTime() - Date.now()) / 60000);
        console.warn(`Skipping GraphQL request for ${repoFullName} - insufficient points (${this.lastGraphQLRateLimit.remaining} remaining). Resets in ${minutesUntilReset} min.`);
      }
      return null;
    }

    const [owner, name] = repoFullName.split('/');
    if (!owner || !name) {
      console.error(`Invalid repo name: ${repoFullName}`);
      return null;
    }

    try {
      const graphqlData = await this.fetchGraphQLData(owner, name);
      if (!graphqlData) return null;

      const checkRunsData = await this.fetchCheckRuns(owner, name);

      const context: RepoContext = {
        repo: repoFullName,
        metadata: {
          stars: graphqlData.stargazerCount || 0,
          watchers: graphqlData.watchers?.totalCount || 0,
          forks: graphqlData.forkCount || 0,
          openIssues: graphqlData.issues?.totalCount || 0,
          age_days: this.calculateAgeDays(graphqlData.createdAt),
          primaryLanguage: graphqlData.primaryLanguage?.name || null,
          isArchived: graphqlData.isArchived || false,
          hasWikiEnabled: graphqlData.hasWikiEnabled || false,
          hasIssuesEnabled: graphqlData.hasIssuesEnabled || false,
        },
        security: {
          hasBranchProtection: graphqlData.branchProtectionRules?.totalCount > 0,
          defaultBranchName: graphqlData.defaultBranchRef?.name || 'main',
          vulnerabilityAlertsEnabled: graphqlData.hasVulnerabilityAlertsEnabled || false,
        },
        activity: {
          recentCommitCount: graphqlData.defaultBranchRef?.target?.history?.totalCount || 0,
          uniqueContributors: new Set(
            graphqlData.defaultBranchRef?.target?.history?.nodes?.map(
              (commit: any) => commit.author?.user?.login
            ) || []
          ).size,
          hasRecentActivity: this.hasRecentActivity(graphqlData),
        },
      };

      if (checkRunsData) {
        context.checks = checkRunsData;
      }

      this.cache.set(repoFullName, { data: context, timestamp: Date.now() });

      return context;
    } catch (error) {
      console.error(`Failed to fetch repo context for ${repoFullName}:`, error);
      return null;
    }
  }

  private async fetchGraphQLData(owner: string, name: string): Promise<any> {
    const query = `
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          createdAt
          stargazerCount
          forkCount
          isArchived
          hasWikiEnabled
          hasIssuesEnabled
          hasVulnerabilityAlertsEnabled
          primaryLanguage {
            name
          }
          watchers {
            totalCount
          }
          issues(states: OPEN) {
            totalCount
          }
          defaultBranchRef {
            name
            target {
              ... on Commit {
                history(first: 20) {
                  totalCount
                  nodes {
                    author {
                      user {
                        login
                      }
                    }
                    committedDate
                  }
                }
              }
            }
          }
          branchProtectionRules {
            totalCount
          }
        }
      }
    `;

    const variables = { owner, name };
    const payload = JSON.stringify({ query, variables });

    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'api.github.com',
        path: '/graphql',
        method: 'POST',
        timeout: 30000,
        headers: {
          'User-Agent': 'Conway-GitHub-Sentinel',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${this.githubToken}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';

        const headers = res.headers;
        if (headers['x-ratelimit-limit']) {
          this.lastGraphQLRateLimit = {
            limit: parseInt(headers['x-ratelimit-limit'] as string, 10),
            remaining: parseInt(headers['x-ratelimit-remaining'] as string, 10),
            used: parseInt(headers['x-ratelimit-used'] as string, 10),
            reset: parseInt(headers['x-ratelimit-reset'] as string, 10),
            resource: headers['x-ratelimit-resource'] as string,
          };

          const resetDate = new Date(this.lastGraphQLRateLimit.reset * 1000);
          const now = new Date();
          const minutesUntilReset = Math.ceil((resetDate.getTime() - now.getTime()) / 60000);

          console.log('\nGraphQL API Rate Limit:');
          console.log(`  Points Used: ${this.lastGraphQLRateLimit.used}/${this.lastGraphQLRateLimit.limit}`);
          console.log(`  Points Remaining: ${this.lastGraphQLRateLimit.remaining}`);
          console.log(`  Resets in: ${minutesUntilReset} minutes (${resetDate.toLocaleTimeString()})`);

          if (this.lastGraphQLRateLimit.remaining < 500) {
            console.warn(`  WARNING: Only ${this.lastGraphQLRateLimit.remaining} points remaining!`);
          }
        }

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.errors) {
              console.error('GraphQL errors:', parsed.errors);

              const rateLimitError = parsed.errors.find((err: Record<string, unknown>) =>
                err.type === 'RATE_LIMITED' || (err.message as string)?.includes('rate limit')
              );

              if (rateLimitError && this.lastGraphQLRateLimit) {
                const resetDate = new Date(this.lastGraphQLRateLimit.reset * 1000);
                console.error('\nGraphQL Rate Limit Exceeded!');
                console.error(`  Used all ${this.lastGraphQLRateLimit.limit} points for this hour.`);
                console.error(`  Rate limit resets at: ${resetDate.toLocaleString()}`);
                console.error(`  Time until reset: ${Math.ceil((resetDate.getTime() - Date.now()) / 60000)} minutes\n`);
              }

              resolve(null);
            } else {
              resolve(parsed.data?.repository);
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('GraphQL request timed out'));
      });
      req.write(payload);
      req.end();
    });
  }

  async fetchPRContext(owner: string, repo: string, prNumber: number): Promise<PRContext | null> {
    const query = `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            number
            title
            body
            createdAt
            mergedAt
            additions
            deletions
            changedFiles
            commits(first: 100) {
              nodes {
                commit {
                  message
                  additions
                  deletions
                }
              }
            }
            files(first: 100) {
              nodes {
                path
                additions
                deletions
              }
            }
            reviews {
              totalCount
            }
            comments {
              totalCount
            }
          }
        }
      }
    `;

    const variables = { owner, repo, pr: prNumber };

    try {
      const data = await this.executeGraphQLQuery(query, variables);
      if (!data?.repository?.pullRequest) return null;

      const pr = data.repository.pullRequest;
      return {
        number: pr.number,
        title: pr.title || '',
        body: pr.body || '',
        createdAt: pr.createdAt,
        mergedAt: pr.mergedAt,
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changedFiles: pr.changedFiles || 0,
        commits: pr.commits?.nodes?.map((node: any) => ({
          message: node.commit.message || '',
          additions: node.commit.additions || 0,
          deletions: node.commit.deletions || 0,
        })) || [],
        files: pr.files?.nodes?.map((node: any) => ({
          path: node.path || '',
          additions: node.additions || 0,
          deletions: node.deletions || 0,
        })) || [],
        reviews: {
          totalCount: pr.reviews?.totalCount || 0,
        },
        comments: {
          totalCount: pr.comments?.totalCount || 0,
        },
      };
    } catch (error) {
      console.error(`Failed to fetch PR context for ${owner}/${repo}#${prNumber}:`, error);
      return null;
    }
  }

  async fetchCommitContext(owner: string, repo: string, sha: string): Promise<CommitContext | null> {
    const query = `
      query($owner: String!, $repo: String!, $sha: String!) {
        repository(owner: $owner, name: $repo) {
          object(expression: $sha) {
            ... on Commit {
              oid
              message
              additions
              deletions
              changedFiles
              committedDate
              author {
                name
                email
              }
            }
          }
        }
      }
    `;

    const variables = { owner, repo, sha };

    try {
      const data = await this.executeGraphQLQuery(query, variables);
      if (!data?.repository?.object) return null;

      const commit = data.repository.object;
      return {
        sha: commit.oid,
        message: commit.message || '',
        additions: commit.additions || 0,
        deletions: commit.deletions || 0,
        changedFiles: commit.changedFiles || 0,
        committedDate: commit.committedDate,
        author: {
          name: commit.author?.name || '',
          email: commit.author?.email || '',
        },
      };
    } catch (error) {
      console.error(`Failed to fetch commit context for ${owner}/${repo}@${sha}:`, error);
      return null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async executeGraphQLQuery(query: string, variables: Record<string, unknown>): Promise<any> {
    const payload = JSON.stringify({ query, variables });

    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'api.github.com',
        path: '/graphql',
        method: 'POST',
        timeout: 30000,
        headers: {
          'User-Agent': 'Conway-GitHub-Sentinel',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${this.githubToken}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';

        const headers = res.headers;
        if (headers['x-ratelimit-limit']) {
          this.lastGraphQLRateLimit = {
            limit: parseInt(headers['x-ratelimit-limit'] as string, 10),
            remaining: parseInt(headers['x-ratelimit-remaining'] as string, 10),
            used: parseInt(headers['x-ratelimit-used'] as string, 10),
            reset: parseInt(headers['x-ratelimit-reset'] as string, 10),
            resource: headers['x-ratelimit-resource'] as string,
          };
        }

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.errors) {
              console.error('GraphQL errors:', parsed.errors);
              resolve(null);
            } else {
              resolve(parsed.data);
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('GraphQL query timed out'));
      });
      req.write(payload);
      req.end();
    });
  }

  private async fetchCheckRuns(owner: string, repo: string): Promise<{
    latestCheckRuns: CheckRunSummary[];
    failureRate: number;
    avgDuration: number;
  } | null> {
    interface CheckRunResponse {
      name: string;
      status: string;
      conclusion: string | null;
      started_at: string;
      completed_at: string | null;
    }

    return new Promise((resolve) => {
      const options: https.RequestOptions = {
        hostname: 'api.github.com',
        path: `/repos/${owner}/${repo}/commits/HEAD/check-runs`,
        method: 'GET',
        timeout: 30000,
        headers: {
          'User-Agent': 'Conway-GitHub-Sentinel',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${this.githubToken}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const parsed = JSON.parse(data);
              const checkRuns: CheckRunResponse[] = parsed.check_runs ?? [];

              const latestCheckRuns: CheckRunSummary[] = checkRuns.slice(0, 10).map((run) => ({
                name: run.name,
                status: run.status,
                conclusion: run.conclusion,
                startedAt: run.started_at,
                completedAt: run.completed_at,
              }));

              const completedRuns = checkRuns.filter((run) => run.status === 'completed');
              const failedRuns = completedRuns.filter(
                (run) =>
                  run.conclusion === 'failure' ||
                  run.conclusion === 'timed_out' ||
                  run.conclusion === 'cancelled'
              );

              const durations = completedRuns
                .filter((run) => run.started_at && run.completed_at)
                .map((run) => {
                  const start = new Date(run.started_at).getTime();
                  const end = new Date(run.completed_at!).getTime();
                  return end - start;
                });

              resolve({
                latestCheckRuns,
                failureRate: completedRuns.length > 0 ? failedRuns.length / completedRuns.length : 0,
                avgDuration: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
              });
            } else {
              resolve(null);
            }
          } catch (err) {
            console.error('Failed to parse check runs:', err);
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        console.error('Check runs request failed:', err);
        resolve(null);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.end();
    });
  }

  private calculateAgeDays(createdAt: string): number {
    const created = new Date(createdAt);
    const now = new Date();
    return Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
  }

  private hasRecentActivity(repoData: Record<string, unknown>): boolean {
    const defaultBranchRef = repoData.defaultBranchRef as Record<string, unknown> | undefined;
    const target = defaultBranchRef?.target as Record<string, unknown> | undefined;
    const history = target?.history as Record<string, unknown> | undefined;
    const commits = (history?.nodes as Array<Record<string, unknown>>) ?? [];
    if (commits.length === 0) return false;

    const latestCommit = commits[0];
    if (!latestCommit?.committedDate) return false;

    const commitDate = new Date(latestCommit.committedDate as string);
    const daysSinceLastCommit = (Date.now() - commitDate.getTime()) / (1000 * 60 * 60 * 24);

    return daysSinceLastCommit <= 7;
  }

  calculateContextualRisk(context: RepoContext, eventType: string): number {
    let risk = 0;

    if (context.metadata.age_days < 30) risk += 0.3;
    if (context.metadata.stars < 10) risk += 0.2;

    if (context.metadata.isArchived) risk += 0.5;
    if (!context.metadata.hasIssuesEnabled && eventType === 'IssuesEvent') risk += 0.3;

    if (!context.security.hasBranchProtection) risk += 0.2;

    if (context.checks && context.checks.failureRate > 0.5) risk += 0.3;

    if (context.activity.uniqueContributors < 3 && context.activity.recentCommitCount > 10) {
      risk += 0.2;
    }

    return Math.min(risk, 1.0);
  }

  generateContextSummary(context: RepoContext): string {
    const parts: string[] = [];

    parts.push(`${context.metadata.stars} ⭐`);
    parts.push(`${context.metadata.age_days}d old`);

    if (context.metadata.primaryLanguage) {
      parts.push(context.metadata.primaryLanguage);
    }

    if (context.metadata.isArchived) {
      parts.push('ARCHIVED');
    }

    if (!context.security.hasBranchProtection) {
      parts.push('NO BRANCH PROTECTION');
    }

    if (context.checks && context.checks.failureRate > 0.3) {
      parts.push(`${(context.checks.failureRate * 100).toFixed(0)}% check fails`);
    }

    return parts.join(' | ');
  }

  clearOldCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.cache.delete(key);
      }
    }
  }
}
