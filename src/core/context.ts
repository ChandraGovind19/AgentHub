import type { Task, Lock, AgentAdapter } from '../types/index.js';
// Narrow interface keeps feature services independent of the Hub facade.
export interface ProjectContext {
    readonly root: string;
    p(...parts: string[]): string;
    tasks(): Promise<Task[]>;
    locks(): Promise<Record<string, Lock>>;
    fileName(file: string): Promise<string>;
    ensureAgent(id: string): Promise<AgentAdapter>;
    agentActivity(id: string, message: string): Promise<void>;
    log(type: string, message: string, agent?: string): Promise<void>;
}
