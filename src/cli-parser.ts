type CLICommand = 'create' | 'attach' | 'import' | 'list' | 'status' | 'remove' | 'start';

const KNOWN_COMMANDS = new Set<CLICommand>(['create', 'attach', 'import', 'list', 'status', 'remove', 'start']);

export interface ParsedCLI {
  command: CLICommand;
  args: Record<string, string | undefined>;
}

/**
 * Parse mm-coder CLI arguments into a structured object.
 * Supports: create, attach, import, list, status, remove, start
 */
export function parseCLIArgs(argv: string[]): ParsedCLI {
  const [cmd, ...rest] = argv;

  if (!cmd || !KNOWN_COMMANDS.has(cmd as CLICommand)) {
    throw new Error(`Unknown command: ${cmd ?? '(none)'}. Valid commands: ${[...KNOWN_COMMANDS].join(', ')}`);
  }

  const command = cmd as CLICommand;
  const args: Record<string, string | undefined> = {};

  // Parse named flags (--key value)
  let i = 0;
  const positionals: string[] = [];

  while (i < rest.length) {
    const cur = rest[i];
    if (cur === undefined) break;
    if (cur.startsWith('--')) {
      const key = cur.slice(2);
      args[key] = rest[i + 1];
      i += 2;
    } else {
      positionals.push(cur);
      i += 1;
    }
  }

  // Map positional args based on command
  switch (command) {
    case 'create':
      if (positionals[0]) args['name'] = positionals[0];
      break;
    case 'attach':
      if (positionals[0]) args['name'] = positionals[0];
      break;
    case 'import':
      if (positionals[0]) args['sessionId'] = positionals[0];
      break;
    case 'status':
      if (positionals[0]) args['name'] = positionals[0];
      break;
    case 'remove':
      if (positionals[0]) args['name'] = positionals[0];
      break;
  }

  return { command, args };
}
