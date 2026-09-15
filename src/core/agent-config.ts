import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { adapter } from '../adapters/index.js';
import type { ProjectContext } from './context.js';
import { exists, exclusive, json, readJson } from './storage.js';
export interface NativeConfig { model?: string; effort?: string; permissionMode?: string; interactiveCommand?: string; execCommand?: string; printCommand?: string }
const fields = ['model', 'effort', 'permissionMode', 'interactiveCommand', 'execCommand', 'printCommand'];
export function nativeAgent(agent: string) { adapter(agent); if (!['codex', 'claude'].includes(agent)) throw new Error('Native attach supports codex and claude. Generic handoffs remain available.'); }
// A command is an executable (optionally quoted) plus a known mode, never a shell expression.
export function commandParts(value: string, field = 'interactiveCommand'): string[] {
    const match = value.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(.*))?$/);
    if (!match || /[\x00-\x1f$`;|&<>]/.test(value)) throw new Error('Use an executable name or quoted path, without shell expressions or credentials.');
    const executable = match[1] || match[2] || match[3];
    const args = match[4]?.trim().split(/\s+/) || [];
    const allowed = field === 'execCommand' ? ['exec'] : field === 'printCommand' ? ['-p', '--print'] : [];
    if (executable.startsWith('-') || args.length > 1 || args.some(a => !allowed.includes(a))) throw new Error('Interactive command must be an executable only; exec/print commands may append exec or -p respectively. Use native auth, not credentials in commands.');
    return [executable, ...args];
}
function validate(agent: string, value: NativeConfig) {
    nativeAgent(agent);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw new Error('Invalid agent config fields. Credentials are not supported.');
    for (const [key, v] of Object.entries(value)) if (typeof v !== 'string' || !v.trim() || /[\x00-\x1f]/.test(v)) throw new Error(`Invalid ${key}. Use a nonempty single-line value.`);
    if (value.effort && (!['low','medium','high','xhigh'].includes(value.effort) || agent !== 'codex')) throw new Error('Codex effort must be low, medium, high, or xhigh.');
    if (value.permissionMode && (!['default','acceptEdits','bypassPermissions','plan'].includes(value.permissionMode) || agent !== 'claude')) throw new Error('Claude permission mode must be default, acceptEdits, bypassPermissions, or plan.');
    if (value.model?.startsWith('-')) throw new Error('Model name cannot start with a flag prefix.');
    for (const field of ['interactiveCommand','execCommand','printCommand'] as const) if (value[field]) commandParts(value[field], field);
}
export async function readAgentConfigs(hub: ProjectContext): Promise<Record<string, NativeConfig>> {
    if (!await exists(hub.p('agent-config.json'))) return {};
    const configs = await readJson<Record<string, NativeConfig>>(hub.p('agent-config.json'));
    if (!configs || typeof configs !== 'object' || Array.isArray(configs)) throw new Error('Invalid agent-config.json.');
    for (const [agent, value] of Object.entries(configs)) validate(agent,value);
    return configs;
}
export async function agentConfig(hub: ProjectContext, agent: string): Promise<NativeConfig> {
    nativeAgent(agent); const configs = await readAgentConfigs(hub);
    return { interactiveCommand: agent, ...(agent === 'codex' ? {execCommand:'codex exec'} : {printCommand:'claude -p'}), ...configs[agent] };
}
export async function configureAgent(hub: ProjectContext, agent: string, patch: NativeConfig) {
    validate(agent,patch);
    return exclusive(hub.root, async () => {
        const configs = await readAgentConfigs(hub); const value = {...configs[agent], ...patch}; validate(agent,value);
        configs[agent] = value; await json(hub.p('agent-config.json'), configs);
        await hub.log('agent_configured', `Updated native configuration for ${agent}`, agent);
        return agentConfig(hub,agent);
    });
}
export async function executablePath(command: string, cwd: string, env = process.env): Promise<string | null> {
    const dirs = command.includes('/') || command.includes('\\') ? [''] : (env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        const base = path.resolve(cwd,dir,command);
        const candidates = process.platform === 'win32' && !path.extname(base) ? [base, base+'.exe', base+'.com'] : [base];
        for (const file of candidates) try { if ((await fs.stat(file)).isFile()) { await fs.access(file,constants.X_OK); return file; } } catch { /* Next PATH entry. */ }
    }
    return null;
}
export async function agents(hub: ProjectContext) {
    return Promise.all(['codex','claude'].map(async agent => {
        const config = await agentConfig(hub,agent); const [command] = commandParts(config.interactiveCommand!);
        const executable = await executablePath(command,hub.root);
        return {agent, availability:executable ? 'found' : 'missing', executable, mode:'interactive attach (configured, not capability-probed)', config, auth:'unknown', usage:'unknown', limits:'Use native /status inside the attached session.'};
    }));
}
