import { promises as fs } from 'node:fs';
import path from 'node:path';
import { adapter } from '../adapters/index.js';
import type { ProjectContext } from './context.js';
import { exclusive, exists, json, now, stamp, write } from './storage.js';
import { nextTaskId } from './tasks.js';
export const sectionNames = ['Summary of Changes', 'Files Modified', 'Important Decisions', 'Follow-up Tasks', 'AgentHub Memory Updates'] as const;
export type Sections = Record<typeof sectionNames[number], string>;
// Ignore fenced examples, unknown sections, and nested headings. Only exact known headings count.
export function parseSummary(text: string): Sections {
    const sections = Object.fromEntries(sectionNames.map(s => [s, ''])) as Sections;
    let active: typeof sectionNames[number] | undefined;
    let fence: string | undefined;
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (marker) {
            if (!fence) fence = marker[1];
            else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && /^[ \t]*$/.test(line.slice(marker[0].length))) fence = undefined;
            continue;
        }
        if (fence) continue;
        const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
        if (heading) { active = sectionNames.find(s => s.toLowerCase() === heading[1].toLowerCase()); continue; }
        if (active) sections[active] += line + '\n';
    }
    for (const name of sectionNames) sections[name] = sections[name].trim();
    return sections;
}
export function listItems(text: string): string[] {
    return [...new Set(text.split('\n').map(line => line.match(/^\s{0,3}(?:[-*+] |\d+[.)] )(?:\[[ xX]\] )?(.+)$/)?.[1]?.trim()).filter((v): v is string => !!v && !/^(?:none\.?|n\/a|no (?:changes|decisions|follow-up tasks)\.?|\.\.\.)$/i.test(v)))];
}
export function nextDecisionId(text: string) { return Math.max(0, ...[...text.matchAll(/^## DEC-(\d+):/gm)].map(m => Number(m[1]))) + 1; }
export async function readNotes(hub: ProjectContext) { const file = hub.p('memory/notes.md'); return await exists(file) ? fs.readFile(file, 'utf8') : '# Durable Notes\n'; }
export interface ExtractionPlan { summary: string; files: string[]; ignoredFiles: string[]; decisions: string[]; followUps: string[]; memoryUpdates: string; taskId?: string; agent: string }
export async function extractionPlan(hub: ProjectContext, text: string, agent: string, taskId?: string): Promise<ExtractionPlan> {
    if (!text.trim()) throw new Error('Summary cannot be empty.');
    adapter(agent);
    const tasks = await hub.tasks();
    if (taskId && !tasks.some(t => t.id === taskId)) throw new Error(`Unknown task ${taskId}.`);
    const sections = parseSummary(text); const files: string[] = []; const ignoredFiles: string[] = [];
    for (const item of listItems(sections['Files Modified'])) {
        // Accept a bare path or exactly one backtick-wrapped path, not prose/link destinations.
        const candidate = item.match(/^`([^`]+)`$/)?.[1] || item;
        if (/[\x00-\x1f<>:"|?*`\[\]{}]/.test(candidate) || /\\|\s[-–—]\s|\]\(|^\//.test(candidate) || (!item.startsWith('`') && /\s/.test(candidate))) { ignoredFiles.push(item); continue; }
        try { const file = await hub.fileName(candidate); if (!file) throw new Error('Not a file'); const full = path.join(hub.root, file); if (await exists(full) && (await fs.stat(full)).isDirectory()) throw new Error('Directory'); files.push(file); } catch { ignoredFiles.push(item); }
    }
    return { summary: sections['Summary of Changes'], files: [...new Set(files)], ignoredFiles, decisions: listItems(sections['Important Decisions']), followUps: listItems(sections['Follow-up Tasks']), memoryUpdates: sections['AgentHub Memory Updates'], taskId, agent };
}
export async function extractIngest(hub: ProjectContext, text: string, agent: string, taskId?: string, dryRun = false) {
    if (dryRun) return { dryRun: true, plan: await extractionPlan(hub, text, agent, taskId) };
    return exclusive(hub.root, async () => {
        const plan = await extractionPlan(hub, text, agent, taskId);
        const tasks = await hub.tasks(); const task = tasks.find(t => t.id === taskId);
        let decisions = await fs.readFile(hub.p('memory/decisions.md'), 'utf8');
        let decisionId = nextDecisionId(decisions);
        const date = now(); const file = hub.p('logs/agent-summaries', `${stamp()}-${agent}.md`);
        const source = `Agent: ${agent}; task: ${taskId || '(not specified)'}; imported: ${date}; source: ${path.relative(hub.root, file)}`;
        for (const decision of plan.decisions) decisions += `\n## DEC-${String(decisionId++).padStart(3, '0')}: ${decision}\n\n${source}\n`;
        const notes = plan.memoryUpdates ? `${await readNotes(hub)}\n## Imported Memory Updates\n\n${source}\n\n${plan.memoryUpdates}\n` : undefined;
        if (task) { task.files = [...new Set([...task.files, ...plan.files])]; task.notes.push(`Imported summary: ${path.relative(hub.root, file)}\n${plan.summary || '(No Summary of Changes section; see imported file.)'}`); task.updatedAt = date; }
        const createdTasks: string[] = [];
        for (const title of plan.followUps) {
            const id = nextTaskId(tasks); createdTasks.push(id);
            tasks.push({ id, title, description: '', status: 'todo', assignedAgent: null, createdAt: date, updatedAt: date, files: [], dependencies: [], notes: [`Follow-up from ingest. ${source}`] });
        }
        await hub.ensureAgent(agent);
        await write(file, `# Imported Summary\n\n${source}\n\n${text}\n`);
        await json(hub.p('tasks/tasks.json'), tasks);
        if (plan.decisions.length) await write(hub.p('memory/decisions.md'), decisions);
        if (notes !== undefined) await write(hub.p('memory/notes.md'), notes);
        await hub.agentActivity(agent, `Extracted summary${taskId ? ` for ${taskId}` : ''}`);
        await hub.log('summary_extracted', `${path.relative(hub.root, file)}; follow-up tasks: ${createdTasks.join(', ') || 'none'}`, agent);
        return { dryRun: false, file, plan, createdTasks };
    });
}
