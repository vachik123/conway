import type { Database } from './database.js';
import type { Queue, QueueJob } from './queue.js';
import { redactSecrets } from './security.js';

export class SummarizationWorker {
  private apiKey: string;
  private apiUrl = 'https://api.openai.com/v1/chat/completions';
  private modelName = 'gpt-4.1-nano-2025-04-14';
  private running = false;
  private processingEvents = new Set<string>(); // Track events currently being processed
  private onError?: (error: any) => void;

  constructor(
    private db: Database,
    private queue: Queue
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('OPENAI_API_KEY not set, summarization worker will be disabled');
    }
    this.apiKey = apiKey || '';
  }

  start(onSummaryCreated: (summary: any) => void, onError?: (error: any) => void) {
    if (!this.apiKey) {
      console.log('Summarization worker disabled (no API key)');
      return;
    }
    this.running = true;
    this.onError = onError;
    console.log('Summarization worker started');

    this.processLoop(onSummaryCreated).catch((err) => {
      console.error('Fatal worker error:', err);
      process.exit(1);
    });
  }

  stop() {
    this.running = false;
  }

  private async processLoop(onSummaryCreated: (summary: any) => void) {
    while (this.running) {
      try {
        const job = await this.queue.pop();
        if (!job) continue;

        await this.processJob(job, onSummaryCreated);

        await this.sleep(2000);
      } catch (error) {
        console.error('Error processing job:', error);
        await this.sleep(1000);
      }
    }
  }

  private async processJob(job: QueueJob, onSummaryCreated: (summary: any) => void) {
    if (this.processingEvents.has(job.eventId)) {
      console.log(`Skipping duplicate job for event ${job.eventId}`);
      return;
    }

    const existing = await this.db.getSummaryByEventId(job.eventId);
    if (existing) {
      console.log(`Summary already exists for event ${job.eventId}, skipping`);
      return;
    }

    try {
      this.processingEvents.add(job.eventId);
      console.log(`Summarizing event ${job.eventId}...`);
      console.log(`  Category: ${job.category === 'security' ? 'Security' : 'Code Quality'}`);
      console.log(`  Repo: ${job.event.repo?.name || 'unknown'}`);
      console.log(`  Type: ${job.event.type}`);

      const prompt = this.buildPrompt(job);
      console.log(`  Prompt length: ${prompt.length} chars`);

      console.log(`  Calling OpenAI API (${this.modelName})...`);
      const summary = await this.generateSummary(prompt);
      console.log(`  OpenAI API response received (${summary.length} chars)`);

      console.log(`  Parsing response...`);
      const parsed = this.parseSummaryResponse(summary);
      console.log(`  Parsed successfully - Classification: ${parsed.classification}`);

      const summaryRecord = {
        event_id: job.eventId,
        event_type: job.event.type,
        repo: job.event.repo?.name || 'unknown',
        actor: job.event.actor?.login || 'unknown',
        timestamp: job.event.created_at,
        root_cause: parsed.root_cause.join('\n'),
        impact: parsed.impact.join('\n'),
        next_steps: parsed.next_steps.join('\n'),
        raw_summary: JSON.stringify(parsed),
      };

      console.log(`  Storing summary in database...`);
      const result = await this.db.storeSummary(summaryRecord);
      console.log(`  Stored with ID: ${result.id}`);

      const fullSummary = {
        id: result.id,
        ...summaryRecord,
        created_at: new Date().toISOString(),
      };

      console.log(`  Broadcasting to SSE clients...`);
      onSummaryCreated(fullSummary);
      console.log(`Summary ${result.id} created for event ${job.eventId} [${parsed.classification}]`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorObj = error as Record<string, unknown>;
      const is429 = errorMessage.includes('429') ||
                    errorMessage.includes('Too Many Requests') ||
                    errorObj?.status === 429;

      if (is429) {
        console.log(`Rate limited by OpenAI, requeuing event ${job.eventId}`);
        console.log(`  Waiting 60 seconds to let rate limit window reset...`);
        await this.queue.push(job);
        await this.sleep(60000);
      } else {
        console.error(`Failed to process job ${job.eventId}:`, redactSecrets(error));

        if (this.onError) {
          this.onError({
            event_id: job.eventId,
            error: errorMessage,
            details: redactSecrets(error),
            repo: job.event.repo?.name ?? 'unknown',
            timestamp: new Date().toISOString(),
          });
        }
      }
    } finally {
      this.processingEvents.delete(job.eventId);
    }
  }

  private buildPrompt(job: QueueJob): string {
    const { event, score, repoContext, category } = job;

    const isSecurity = category === 'security';

    let prompt = isSecurity
      ? `You are a Senior Security Analyst at GitHub. You are analyzing a potential security incident detected by an ML model.

YOUR GOAL:
1. Analyze the raw event and the ML signals.
2. Determine if this is a real malicious attack, a bad practice (policy violation), or just noise.
3. Provide a structured summary for the security dashboard.`
      : `You are a Senior Code Quality Engineer at GitHub. You are reviewing code quality issues detected by an ML model.

YOUR GOAL:
1. Analyze the code changes, commit patterns, and development practices.
2. Identify code quality issues, technical debt, or poor development practices.
3. Provide actionable feedback for the development team.`;

    prompt += `

EVENT DETAILS:
- Type: ${event.type}
- Repository: ${event.repo?.name || 'N/A'}
- Actor: ${event.actor?.login || 'N/A'}
- Timestamp: ${event.created_at}
`;

    if (event.payload) {
      prompt += '\nEVENT PAYLOAD:\n';
      // Truncate payload if it's too massive to prevent token overflow
      const payloadStr = JSON.stringify(event.payload, null, 2);
      prompt += payloadStr.length > 2000 ? payloadStr.substring(0, 2000) + '... (truncated)' : payloadStr;
    }

    if (score) {
      prompt += `\n\nBEHAVIORAL ANALYSIS (ML MODEL):
- Anomaly Score: ${score.score?.toFixed(3)} / 1.000
- Verdict: ${score.is_anomalous ? 'ANOMALOUS' : 'Normal'}
`;

      if (score.features) {
        prompt += 'Key Risk Signals Detected:\n';
        const signals = [
          score.features.is_workflow_file_change === 1 ? '- Critical: Modification to CI/CD workflow file (Supply Chain Risk)' : null,
          score.features.force_push_to_main === 1 ? '- High: Force push to main/master branch' : null,
          score.features.is_branch_deletion === 1 ? '- High: Deletion of a branch (potential sabotage)' : null,
          score.features.is_new_account === 1 ? '- Medium: Action performed by a new GitHub account' : null,
          score.features.workflow_failure_streak > 0 ? `- Low: ${score.features.workflow_failure_streak} consecutive workflow failures` : null,
        ].filter(Boolean);
        
        prompt += signals.length > 0 ? signals.join('\n') : '- No specific risk patterns identified.';
      }
    }

    // Add repo context (Critical for distinguishing "Student Project" from "Enterprise Hack")
    if (repoContext) {
      prompt += '\n\nREPOSITORY CONTEXT:';
      const meta = repoContext.metadata || {};
      const sec = repoContext.security || {};

      prompt += `\n- Stars: ${meta.stars || 0}`;
      prompt += `\n- Age: ${meta.age_days || 0} days`;
      prompt += `\n- Branch Protection: ${sec.hasBranchProtection ? 'Enabled' : 'DISABLED'}`;
      prompt += `\n- Contributors: ${repoContext.activity?.uniqueContributors || 0}`;
      
      if (meta.isArchived) prompt += '\n- Status: ARCHIVED';
    }

    if (isSecurity) {
      prompt += `\n\nRESPONSE FORMAT:
Provide your analysis in this exact JSON format:
{
  "classification": "ACTIVE_ATTACK" | "POLICY_VIOLATION" | "BENIGN_ANOMALY",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "one_line_summary": "A concise 10-15 word description of what happened",
  "root_cause": ["bullet 1", "bullet 2", "bullet 3"],
  "impact": ["bullet 1", "bullet 2", "bullet 3"],
  "next_steps": ["bullet 1", "bullet 2", "bullet 3"]
}

CLASSIFICATION GUIDELINES:
1. ACTIVE_ATTACK (Red):
   - Intentional malice. Exfiltration of secrets, installing backdoors, nuking history, or mass destruction.
   - Example: Modifying .github/workflows to curl env vars to an external IP.

2. POLICY_VIOLATION (Amber):
   - Dangerous behavior but likely not malicious intent.
   - Examples: 'AutoGreen' vanity bots, developers force-pushing to their own PRs, commiting directly to main because protection is disabled, student projects with sloppy git hygiene.
   - NOTE: If the repo is 'AutoGreen' or has 0 stars/1 contributor, it is likely a Policy Violation, not an Advanced Persistent Threat.

3. BENIGN_ANOMALY (Blue):
   - Weird timing or volume, but harmless content.
   - Example: A legitimate bot closing 50 stale issues at once.

IMPORTANT: The ML model scored this as ${score?.score?.toFixed(3)}. Use the Repository Context to contextualize this score. High score on a 0-star repo is usually a Policy Violation. High score on a 10k-star repo is a Critical Incident.`;
    } else {
      prompt += `\n\nRESPONSE FORMAT:
Provide your analysis in this exact JSON format:
{
  "classification": "CRITICAL_ISSUE" | "POOR_PRACTICE" | "MINOR_CONCERN",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "one_line_summary": "A concise 10-15 word description of the code quality issue",
  "root_cause": ["bullet 1", "bullet 2", "bullet 3"],
  "impact": ["bullet 1", "bullet 2", "bullet 3"],
  "next_steps": ["bullet 1", "bullet 2", "bullet 3"]
}

CLASSIFICATION GUIDELINES:
1. CRITICAL_ISSUE (Red):
   - Severe code quality problems that could lead to bugs, security vulnerabilities, or maintenance nightmares.
   - Examples: Committing secrets, no tests, breaking changes without documentation, massive code duplication.

2. POOR_PRACTICE (Amber):
   - Suboptimal development practices that should be improved.
   - Examples: Inconsistent formatting, missing error handling, poor commit messages, direct commits to main, skipping code review.

3. MINOR_CONCERN (Blue):
   - Small issues or style inconsistencies that don't significantly impact quality.
   - Example: Minor formatting issues, missing comments on simple code.

IMPORTANT: The ML model scored this as ${score?.score?.toFixed(3)} (lower = worse quality). Use the Repository Context to contextualize this score.`;
    }

    return prompt;
  }

  private async generateSummary(prompt: string): Promise<string> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            {
              role: 'system',
              content: 'You are a security analyst. Provide your answer as valid JSON only.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.1,
          max_tokens: 2000,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenAI API Error:', response.status, errorText);
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content;

      if (typeof content !== 'string' || !content) {
        console.error('Unexpected or empty response from OpenAI API');
        console.error('Response data:', JSON.stringify(data, null, 2).substring(0, 1000));
        throw new Error('Empty response from OpenAI');
      }

      return content;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('OpenAI API Error:', errorMessage);
      console.error('Error details:', redactSecrets(error));
      throw error;
    }
  }

  private parseSummaryResponse(text: string): {
    classification: 'ACTIVE_ATTACK' | 'POLICY_VIOLATION' | 'BENIGN_ANOMALY';
    confidence: string;
    one_line_summary: string;
    root_cause: string[];
    impact: string[];
    next_steps: string[];
  } {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.error('Could not find JSON in AI response');
      console.error('Response text:', text.substring(0, 500));
      throw new Error('Could not find JSON in AI response');
    }

    const jsonStr = jsonMatch[1] || jsonMatch[0];

    try {
      const parsed = JSON.parse(jsonStr);

      // Normalize code quality classifications to security classifications for frontend
      let classification = parsed.classification || 'POLICY_VIOLATION';

      const classificationMap: Record<string, string> = {
        'CRITICAL_ISSUE': 'ACTIVE_ATTACK',
        'POOR_PRACTICE': 'POLICY_VIOLATION',
        'MINOR_CONCERN': 'BENIGN_ANOMALY',
      };

      if (classificationMap[classification]) {
        console.log(`  Mapping classification: ${classification} -> ${classificationMap[classification]}`);
        classification = classificationMap[classification];
      }

      const result = {
        classification,
        confidence: parsed.confidence || 'MEDIUM',
        one_line_summary: parsed.one_line_summary || 'Analysis not available',
        root_cause: Array.isArray(parsed.root_cause) ? parsed.root_cause : [],
        impact: Array.isArray(parsed.impact) ? parsed.impact : [],
        next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps : []
      };

      const validClasses = ['ACTIVE_ATTACK', 'POLICY_VIOLATION', 'BENIGN_ANOMALY'];
      if (!validClasses.includes(result.classification)) {
        console.warn(`Invalid classification "${result.classification}", defaulting to POLICY_VIOLATION`);
        result.classification = 'POLICY_VIOLATION';
      }

      return result as any;
    } catch (e) {
      console.error('Failed to parse AI JSON:', e);
      console.error('JSON string:', jsonStr.substring(0, 500));
      throw new Error(`Failed to parse AI JSON: ${e}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}