/**
 * JINI Agent Tool Registry
 *
 * The public tool contract follows Cline's AgentTool shape (name, description,
 * JSON input schema, execute(context)); registration lifecycle follows OpenCode's
 * explicit add/update/remove/namespace registry model.
 *
 * This is a JINI-native adapter, not a vendored copy of either upstream runtime.
 */
import type { Tool } from '../toolTypes';
import type { ActionClass } from '../permission';

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parallelSafe?: boolean;
  executionMode?: 'sequential' | 'parallel';
  /** Declares the permission class; omitted means config/write-capable, never read-only. */
  action?: ActionClass;
  /** Optional resource label for audit/permission records. */
  resource?: string | ((input: Record<string, unknown>) => string);
}

export interface AgentToolContext {
  agentId: string;
  pluginId?: string;
  signal?: AbortSignal;
}

export interface AgentTool extends AgentToolDefinition {
  execute(input: Record<string, unknown>, context: AgentToolContext): Promise<unknown> | unknown;
}

export interface RegisteredToolInfo {
  name: string;
  description: string;
  source: 'builtin' | 'plugin';
  pluginId?: string;
  enabled: boolean;
  parallelSafe: boolean;
  action?: ActionClass;
}

interface Entry {
  name: string;
  tool: Tool;
  source: 'builtin' | 'plugin';
  pluginId?: string;
  agentTool?: AgentTool;
  enabled: boolean;
  action?: ActionClass;
  resource?: AgentTool['resource'];
}

export interface ToolExecutionContext {
  agentId: string;
  signal?: AbortSignal;
}

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function validateSchema(schema: unknown, name: string): asserts schema is Record<string, unknown> {
  if (!isRecord(schema) || (schema.type !== undefined && schema.type !== 'object')) {
    throw new Error('Tool "' + name + '" must declare an object inputSchema.');
  }
  if (schema.properties !== undefined && !isRecord(schema.properties)) {
    throw new Error('Tool "' + name + '" inputSchema.properties must be an object.');
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) {
    throw new Error('Tool "' + name + '" inputSchema.required must be an array of strings.');
  }
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Registry guarantees unique, namespaced tool IDs and exposes immutable snapshots.
 * Tool execution itself remains outside this class so JINI's single authorization,
 * receipt, cancellation and audit choke point is always used.
 */
export class AgentToolRegistry {
  private readonly entries = new Map<string, Entry>();

  registerBuiltin(name: string, tool: Tool): void {
    if (!NAME_RE.test(name)) throw new Error('Invalid tool name "' + name + '".');
    if (this.entries.has(name)) throw new Error('Tool "' + name + '" is already registered.');
    if (!tool || typeof tool.run !== 'function' || typeof tool.description !== 'string') {
      throw new Error('Tool "' + name + '" has an invalid implementation.');
    }
    validateSchema(tool.parameters, name);
    this.entries.set(name, { name, tool, source: 'builtin', enabled: true });
  }

  registerPluginTools(pluginId: string, tools: readonly AgentTool[]): { names: string[]; dispose: () => void } {
    const id = String(pluginId ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) throw new Error('Plugin id must be 2–64 safe characters.');
    if (!Array.isArray(tools)) throw new Error('Plugin tools must be an array.');
    const prefix = this.namespace(id);
    const pending: Entry[] = [];
    const localNames = new Set<string>();

    for (const definition of tools) {
      if (!definition || typeof definition !== 'object') throw new Error('Plugin "' + id + '" supplied an invalid tool.');
      const localName = String(definition.name ?? '').trim();
      if (!NAME_RE.test(localName)) throw new Error('Plugin "' + id + '" has an invalid tool name "' + localName + '".');
      const name = prefix + localName;
      if (name.length > 64) throw new Error('Namespaced tool "' + name + '" exceeds the 64-character limit.');
      if (localNames.has(name) || this.entries.has(name)) throw new Error('Tool "' + name + '" is already registered.');
      localNames.add(name);
      if (typeof definition.description !== 'string' || !definition.description.trim()) {
        throw new Error('Tool "' + name + '" needs a description.');
      }
      if (typeof definition.execute !== 'function') throw new Error('Tool "' + name + '" needs an execute function.');
      validateSchema(definition.inputSchema, name);
      const action = definition.action ?? 'config';
      if ((definition.parallelSafe === true || definition.executionMode === 'parallel') && action !== 'read') {
        throw new Error('Parallel custom tools must explicitly declare action: read.');
      }
      if (definition.resource !== undefined && typeof definition.resource !== 'string' && typeof definition.resource !== 'function') {
        throw new Error('Tool resource must be a string or a function.');
      }
      const agentTool: AgentTool = { ...definition, name, action };
      const tool: Tool = {
        description: agentTool.description,
        parameters: agentTool.inputSchema,
        parallelSafe: agentTool.parallelSafe === true || agentTool.executionMode === 'parallel',
        run: async (args) => stringifyOutput(await agentTool.execute(args, { agentId: 'main', pluginId: id })),
      };
      pending.push({ name, tool, source: 'plugin', pluginId: id, agentTool, enabled: true, action, resource: agentTool.resource });
    }

    // Validate the whole contribution before mutating the registry: no partial installs.
    for (const entry of pending) this.entries.set(entry.name, entry);
    let active = true;
    return {
      names: pending.map((entry) => entry.name),
      dispose: () => {
        if (!active) return;
        active = false;
        for (const entry of pending) {
          if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name);
        }
      },
    };
  }

  namespace(pluginId: string): string {
    const slug = safeSlug(String(pluginId ?? ''));
    if (!slug) throw new Error('Plugin namespace cannot be empty.');
    return 'plugin_' + slug + '_';
  }

  executionPolicy(name: string, input: Record<string, unknown>): { action: ActionClass; resource: string } | undefined {
    const entry = this.entries.get(name);
    if (!entry?.agentTool) return undefined;
    let resource = 'tool:' + name;
    try {
      const configured = entry.resource;
      resource = typeof configured === 'function' ? String(configured(input) ?? resource) : (configured ?? resource);
    } catch {
      // A broken resource formatter must not prevent the conservative action classification.
    }
    return { action: entry.action ?? 'config', resource: resource.slice(0, 256) };
  }

  get(name: string): RegisteredToolInfo | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return this.info(entry);
  }

  list(options: { includeDisabled?: boolean } = {}): RegisteredToolInfo[] {
    return [...this.entries.values()]
      .filter((entry) => options.includeDisabled === true || entry.enabled)
      .map((entry) => this.info(entry))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  update(name: string, patch: { enabled?: boolean; description?: string; parameters?: Record<string, unknown>; parallelSafe?: boolean }): void {
    const entry = this.entries.get(name);
    if (!entry) throw new Error('Unknown tool "' + name + '".');
    if (patch.description !== undefined) {
      if (!patch.description.trim()) throw new Error('Tool description cannot be empty.');
      entry.tool.description = patch.description;
      if (entry.agentTool) entry.agentTool.description = patch.description;
    }
    if (patch.parameters !== undefined) {
      validateSchema(patch.parameters, name);
      entry.tool.parameters = patch.parameters;
      if (entry.agentTool) entry.agentTool.inputSchema = patch.parameters;
    }
    if (patch.parallelSafe !== undefined) {
      entry.tool.parallelSafe = patch.parallelSafe;
      if (entry.agentTool) entry.agentTool.parallelSafe = patch.parallelSafe;
    }
    if (patch.enabled !== undefined) entry.enabled = patch.enabled;
  }

  remove(name: string): boolean {
    const entry = this.entries.get(name);
    if (!entry || entry.source === 'builtin') return false;
    return this.entries.delete(name);
  }

  toToolMap(contextProvider: () => ToolExecutionContext = () => ({ agentId: 'main' })): Record<string, Tool> {
    const result: Record<string, Tool> = Object.create(null) as Record<string, Tool>;
    for (const entry of this.entries.values()) {
      if (!entry.enabled) continue;
      if (!entry.agentTool) {
        result[entry.name] = entry.tool;
        continue;
      }
      const agentTool = entry.agentTool;
      result[entry.name] = {
        description: agentTool.description,
        parameters: agentTool.inputSchema,
        parallelSafe: agentTool.parallelSafe === true || agentTool.executionMode === 'parallel',
        run: async (args) => stringifyOutput(await agentTool.execute(args, {
          ...contextProvider(),
          pluginId: entry.pluginId,
        })),
      };
    }
    return result;
  }

  private info(entry: Entry): RegisteredToolInfo {
    return {
      name: entry.name,
      description: entry.tool.description,
      source: entry.source,
      ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
      enabled: entry.enabled,
      parallelSafe: entry.tool.parallelSafe === true,
      ...(entry.action ? { action: entry.action } : {}),
    };
  }
}

export const agentToolRegistry = new AgentToolRegistry();
