import { adapter } from '../adapters/index.js';
import { statuses, type Config, type Task, type Lock } from '../types/index.js';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string');
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function invalid(kind: string): never { throw new Error(`Invalid ${kind} state. Run agenthub doctor and restore valid data from backup.`); }
export function validateConfig(value: unknown): Config {
    if (!record(value) || typeof value.projectName !== 'string' || typeof value.version !== 'string' || !strings(value.agents) || !value.agents.length || new Set(value.agents).size !== value.agents.length || typeof value.defaultAgent !== 'string' || !value.agents.includes(value.defaultAgent) || !date(value.createdAt) || !date(value.updatedAt) || (value.lastSync !== undefined && !date(value.lastSync)))
        invalid('configuration');
    for (const id of value.agents)
        adapter(id);
    return value as unknown as Config;
}
export function validateTasks(value: unknown): Task[] {
    if (!Array.isArray(value))
        invalid('task');
    for (const t of value)
        if (!record(t) || typeof t.id !== 'string' || !/^task_\d+$/.test(t.id) || typeof t.title !== 'string' || !t.title.trim() || typeof t.description !== 'string' || !statuses.includes(t.status as Task['status']) || !(t.assignedAgent === null || typeof t.assignedAgent === 'string') || !date(t.createdAt) || !date(t.updatedAt) || !strings(t.files) || !strings(t.notes) || !strings(t.dependencies))
            invalid('task');
    if (new Set(value.map(t => t.id)).size !== value.length)
        invalid('task (duplicate IDs)');
    return value as Task[];
}
export function validateLocks(value: unknown): Record<string, Lock> {
    if (!record(value) || Object.values(value).some(l => !record(l) || typeof l.owner !== 'string' || typeof l.taskId !== 'string' || !date(l.createdAt)))
        invalid('lock');
    return value as Record<string, Lock>;
}
