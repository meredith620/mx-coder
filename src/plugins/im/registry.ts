import * as path from 'path';
import * as os from 'os';
import {
  createConnectedMattermostPlugin,
  getMattermostCommandHelpText,
  verifyMattermostConnection,
  writeMattermostConfigTemplate,
} from './mattermost.js';
import type { IMPlugin } from '../types.js';

const DEFAULT_IM_PLUGIN = 'mattermost';

export interface IMPluginFactory {
  load(configPath: string, opts?: { sessionCount?: number; activeCount?: number }): Promise<IMPlugin>;
  getDefaultConfigPath(): string;
  writeConfigTemplate(configPath: string): void;
  verifyConnection(configPath?: string): Promise<{ ok: true; config: unknown; botUserId: string }>;
  getCommandHelpText(cliPluginName?: string, supportedNativeCommands?: string[]): string;
}

const IM_PLUGINS: Record<string, IMPluginFactory> = {
  'mattermost': {
    load: async (configPath: string, opts = {}) => {
      return createConnectedMattermostPlugin(configPath, opts);
    },
    getDefaultConfigPath: () => path.join(os.homedir(), '.mx-coder', 'config.json'),
    writeConfigTemplate: writeMattermostConfigTemplate,
    verifyConnection: verifyMattermostConnection,
    getCommandHelpText: getMattermostCommandHelpText,
  },
  // 未来扩展：'discord': { ... },
};

export function getIMPluginFactory(name: string): IMPluginFactory {
  const factory = IM_PLUGINS[name];
  if (!factory) throw new Error(`Unknown IM plugin: ${name}`);
  return factory;
}

export function listIMPlugins(): string[] {
  return Object.keys(IM_PLUGINS);
}

export function getDefaultIMPluginName(): string {
  return DEFAULT_IM_PLUGIN;
}
