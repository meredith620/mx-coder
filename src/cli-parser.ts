type CLICommand = 'create' | 'attach' | 'diagnose' | 'takeover-status' | 'takeover-cancel' | 'import' | 'list' | 'status' | 'remove' | 'start' | 'stop' | 'restart' | 'completion' | 'im' | 'im-init' | 'im-verify' | 'im-run' | 'tui' | 'open' | 'setup' | 'env';
type IMSubcommand = 'init' | 'verify' | 'run';

const KNOWN_COMMANDS = new Set<CLICommand>(['create', 'attach', 'diagnose', 'takeover-status', 'takeover-cancel', 'import', 'list', 'status', 'remove', 'start', 'stop', 'restart', 'completion', 'im', 'im-init', 'im-verify', 'im-run', 'tui', 'open', 'setup', 'env']);
const IM_SUBCOMMANDS = new Set<IMSubcommand>(['init', 'verify', 'run']);

export interface ParsedCLI {
  command: CLICommand;
  subcommand?: IMSubcommand;
  args: Record<string, string | undefined>;
}

/**
 * Parse mx-coder CLI arguments into a structured object.
     * Supports: create, attach, diagnose, takeover-status, takeover-cancel, import, list, status, remove, start, stop, restart, completion, open, im <init|verify|run>, tui
 * Backward compatible: im-init → im init, im-verify → im verify, im-run → im run
 */
export function parseCLIArgs(argv: string[]): ParsedCLI {
  const [cmd, ...rest] = argv;

  if (!cmd || !KNOWN_COMMANDS.has(cmd as CLICommand)) {
    throw new Error(`Unknown command: ${cmd ?? '(none)'}. Valid commands: ${[...KNOWN_COMMANDS].filter(c => !c.startsWith('im-')).join(', ')}`);
  }

  let command = cmd as CLICommand;
  let subcommand: IMSubcommand | undefined;
  let argsRest = rest;

  // Handle `im <subcommand>` style
  if (command === 'im') {
    const sub = rest[0];
    if (!sub || !IM_SUBCOMMANDS.has(sub as IMSubcommand)) {
      throw new Error(`Unknown im subcommand: ${sub ?? '(none)'}. Valid: ${[...IM_SUBCOMMANDS].join(', ')}`);
    }
    subcommand = sub as IMSubcommand;
    argsRest = rest.slice(1);
  }

  // Backward compat: im-init → im init, im-verify → im verify, im-run → im run
  if (command === 'im-init') { command = 'im'; subcommand = 'init'; }
  if (command === 'im-verify') { command = 'im'; subcommand = 'verify'; }
  if (command === 'im-run') { command = 'im'; subcommand = 'run'; }

  const args: Record<string, string | undefined> = {};

  // Parse named flags (--key value or -k value)
  let i = 0;
  const positionals: string[] = [];

// Short-flag aliases: map single-char flag → canonical long key
  const SHORT_FLAGS: Record<string, string> = {
    'n': 'name',
    'w': 'workdir',
    's': 'sessionId',
    'p': 'plugin',
    'c': 'config',
    'C': 'cli',
  };

  while (i < argsRest.length) {
    const cur = argsRest[i];
    if (cur === undefined) break;
    if (cur.startsWith('--')) {
      const key = cur.slice(2);
      args[key] = argsRest[i + 1];
      i += 2;
    } else if (cur.startsWith('-') && cur.length === 2) {
      const shortKey = cur.slice(1);
      const longKey = SHORT_FLAGS[shortKey];
      if (longKey) {
        args[longKey] = argsRest[i + 1];
        i += 2;
      } else {
        positionals.push(cur);
        i += 1;
      }
    } else {
      positionals.push(cur);
      i += 1;
    }
  }

// Map positional args based on command — only if not already set by a flag
  switch (command) {
    case 'create':
      if (positionals[0] && !args['name']) args['name'] = positionals[0];
      break;
    case 'attach':
      if (positionals[0] && !args['name']) args['name'] = positionals[0];
      break;
    case 'diagnose':
      if (positionals[0] && !args['name']) args['name'] = positionals[0];
      break;
    case 'takeover-status':
      if (positionals[0] && !args['name']) args['name'] = positionals[0];
      break;
    case 'takeover-cancel':
      if (positionals[0] && !args['name']) args['name'] = positionals[0];
      break;
    case 'import':
      if (positionals[0] && !args['sessionId']) args['sessionId'] = positionals[0];
      break;
    case 'status':
      if (positionals[0] && !args['name']) args['name'] = positionals[0];
      break;
    case 'remove':
      if (positionals[0] && !args['name']) args['name'] = positionals[0];
      break;
    case 'completion':
      if (positionals[0] && !args['shell']) args['shell'] = positionals[0];
      break;
    case 'open':
      if (positionals[0] && !args['name']) args['name'] = positionals[0];
      break;
    case 'setup':
      if (positionals[0] && !args['target']) args['target'] = positionals[0];
      if (argsRest.includes('--user')) args['user'] = 'true';
      if (argsRest.includes('--dry-run')) args['dry-run'] = 'true';
      if (argsRest.includes('--status')) args['status'] = 'true';
      if (argsRest.includes('--uninstall')) args['uninstall'] = 'true';
      break;
    case 'env':
      if (positionals[0] && !args['action']) args['action'] = positionals[0];
      if (positionals[1] && !args['name']) args['name'] = positionals[1];
      if (positionals[2] && !args['key']) args['key'] = positionals[2];
      if (positionals[3] && !args['value']) args['value'] = positionals[3];
      break;
    case 'im':
      if (subcommand === 'run' && positionals[0] && !args['sessionName']) args['sessionName'] = positionals[0];
      break;
  }

  return { command, ...(subcommand ? { subcommand } : {}), args };
}
