/**
 * Safe env file parser.
 * Supports: KEY=VALUE, export KEY=VALUE, comments (#), blank lines,
 * single/double quoted values.
 * Rejects: command substitution $(...), backticks, variable expansion $VAR,
 * source/. commands, and any syntax requiring eval.
 */

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const UNSAFE_PATTERNS = [
  /\$\(/,       // $( command substitution
  /`/,          // backtick command substitution
  /\$\{/,       // ${VAR} expansion
];

function containsUnsafe(value: string): boolean {
  return UNSAFE_PATTERNS.some(p => p.test(value));
}

function containsVariableExpansion(value: string): boolean {
  // Match $VAR but not inside single quotes (already stripped by caller)
  return /\$[A-Za-z_]/.test(value);
}

export interface EnvEntry {
  key: string;
  value: string;
}

export interface EnvParseError {
  line: number;
  message: string;
}

export interface EnvParseResult {
  entries: EnvEntry[];
  errors: EnvParseError[];
}

/**
 * Mask a secret env value for display: preserve first and last 5 characters.
 * Only keys containing SECRET patterns (KEY, TOKEN, PASSWORD, SECRET, API,
 * AUTH, CREDENTIAL, PRIVATE, ACCESS, etc.) are masked.
 * - non-secret key: return value as-is
 * - secret key, length <= 10: return '**********'
 * - secret key, length > 10: return first5 + '*****' + last5
 */
export function maskEnvValue(key: string, value: string): string {
  const secretPatterns = ['KEY', 'TOKEN', 'PASSWORD', 'SECRET', 'API', 'AUTH',
    'CREDENTIAL', 'PRIVATE', 'ACCESS', 'CERT', 'PWD', 'PASS', 'SIGNATURE'];
  const isSecret = secretPatterns.some(p => key.toUpperCase().includes(p));
  if (!isSecret) return value;
  if (value.length <= 10) return '**********';
  return value.slice(0, 5) + '*****' + value.slice(-5);
}

export function parseEnvFile(content: string): EnvParseResult {
  const entries: EnvEntry[] = [];
  const errors: EnvParseError[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    const lineNum = i + 1;

    // Skip blank lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    // Strip optional "export " prefix
    let line = trimmed;
    if (line.startsWith('export ')) {
      line = line.slice(7).trimStart();
    }

    // Must contain '='
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      errors.push({ line: lineNum, message: `Invalid line: missing '=' separator` });
      continue;
    }

    const key = line.slice(0, eqIdx);
    let value = line.slice(eqIdx + 1);

    // Validate key
    if (!ENV_KEY_RE.test(key)) {
      errors.push({ line: lineNum, message: `Invalid env key: '${key}' (must match ${ENV_KEY_RE.source})` });
      continue;
    }

    // Handle quoted values
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      const quote = value[0];
      const inner = value.slice(1, -1);

      // Check for unsafe patterns even inside quotes
      if (containsUnsafe(inner)) {
        errors.push({ line: lineNum, message: `Unsafe value: command substitution is not allowed` });
        continue;
      }

      // For double-quoted values, also reject variable expansion
      if (quote === '"' && containsVariableExpansion(inner)) {
        errors.push({ line: lineNum, message: `Unsafe value: variable expansion is not allowed` });
        continue;
      }

      entries.push({ key, value: inner });
      continue;
    }

    // Unquoted value — check for all unsafe patterns
    if (containsUnsafe(value)) {
      errors.push({ line: lineNum, message: `Unsafe value: command substitution is not allowed` });
      continue;
    }

    if (containsVariableExpansion(value)) {
      errors.push({ line: lineNum, message: `Unsafe value: variable expansion is not allowed` });
      continue;
    }

    entries.push({ key, value });
  }

  return { entries, errors };
}
