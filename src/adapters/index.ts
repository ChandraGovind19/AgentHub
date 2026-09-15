import type { AgentAdapter } from '../types/index.js';
export function adapter(id: string): AgentAdapter {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id))
        throw new Error('Agent names must start with a lowercase letter and contain only letters, digits, _ or - (maximum 64 characters).');
    const displayName = id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude Code' : id;
    return { id, displayName, description: `Handoff adapter for ${displayName}`, supportsDirectLaunch: ['codex', 'claude'].includes(id),
        handoffInstructions: `You are ${displayName} working in this project. Inspect Git status and project instructions before editing. Respect other agents’ file locks. ${id === 'claude' ? 'Explain architecture decisions and maintain project consistency. ' : ''}Summarize changes and validation for AgentHub. Native session transcripts and usage data are not imported.` };
}
