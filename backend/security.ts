export function redactSecrets(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return redactString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(redactSecrets);
  }

  if (obj !== null && typeof obj === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = redactSecrets(value);
      }
    }
    return redacted;
  }

  return obj;
}

function redactString(str: string): string {
  return str
    .replace(/ghp_[a-zA-Z0-9]{36}/g, 'ghp_[REDACTED]')
    .replace(/sk-ant-api03-[a-zA-Z0-9_-]{95}/g, 'sk-ant-[REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9_-]+/g, 'Bearer [REDACTED]');
}

function isSensitiveKey(key: string): boolean {
  const sensitivePatterns = [
    'token',
    'password',
    'secret',
    'api_key',
    'apikey',
    'auth',
    'authorization',
    'x-api-key',
    'bearer',
  ];

  const lowerKey = key.toLowerCase();
  return sensitivePatterns.some(pattern => lowerKey.includes(pattern));
}

export function safeLog(...args: unknown[]): void {
  const redacted = args.map(redactSecrets);
  console.log(...redacted);
}

export function safeError(...args: unknown[]): void {
  const redacted = args.map(redactSecrets);
  console.error(...redacted);
}
