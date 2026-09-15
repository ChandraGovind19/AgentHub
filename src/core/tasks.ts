import type { Task } from '../types/index.js';
import type { ProjectContext } from './context.js';
import { exclusive, json, now } from './storage.js';
export function nextTaskId(tasks: Task[]) { return `task_${String(Math.max(0, ...tasks.map(t => Number(t.id.slice(5)))) + 1).padStart(3, '0')}`; }
export async function completeTask(hub: ProjectContext, id: string, options: { note?: string; unlock?: boolean; keepLocks?: boolean } = {}) {
    if (options.unlock && options.keepLocks) throw new Error('Choose either --unlock or --keep-locks, not both.');
    return exclusive(hub.root, async () => {
        const tasks = await hub.tasks();
        const task = tasks.find(t => t.id === id);
        if (!task) throw new Error(`Unknown task ${id}. Run agenthub task list.`);
        const locks = await hub.locks();
        const relatedFiles = Object.keys(locks).filter(file => locks[file].taskId === id);
        task.status = 'done'; task.updatedAt = now();
        if (options.note?.trim()) task.notes.push(options.note.trim());
        if (options.unlock) for (const file of relatedFiles) delete locks[file];
        await json(hub.p('tasks/tasks.json'), tasks);
        if (options.unlock) await json(hub.p('locks.json'), locks);
        await hub.log('task_completed', `Completed ${id}; ${options.unlock ? 'released' : 'kept'} ${relatedFiles.length} locks`, task.assignedAgent || 'user');
        if (task.assignedAgent) await hub.agentActivity(task.assignedAgent, `Completed ${id}: ${task.title}`);
        return { task, relatedFiles, releasedFiles: options.unlock ? relatedFiles : [], remainingFiles: options.unlock ? [] : relatedFiles };
    });
}
