import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Recover what the previous agent did without asking it: both native CLIs keep local session logs as they run.
// Formats are undocumented, so every reader is best-effort and tolerant; a miss yields null, never an error.
export interface TranscriptEntry { role: 'user' | 'assistant' | 'tool'; text: string; time?: string }
export interface Transcript { source: string; file: string; entries: TranscriptEntry[] }
const clip = (s: string, n: number) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const within = (time: unknown, since: number, until: number) => { const t = typeof time === 'string' ? Date.parse(time) : NaN; return !Number.isFinite(t) || (t >= since - 120000 && t <= until + 120000); };
async function readLines(file: string, maxBytes = 8 * 1024 * 1024) {
    const stat = await fs.stat(file); if (stat.size > maxBytes) { const handle = await fs.open(file); try { const buffer = Buffer.alloc(maxBytes); const {bytesRead} = await handle.read(buffer, 0, maxBytes, stat.size - maxBytes); return buffer.toString('utf8', 0, bytesRead).split('\n').slice(1); } finally { await handle.close(); } }
    return (await fs.readFile(file, 'utf8')).split('\n');
}
function parse(lines: string[]) { const out: Record<string, unknown>[] = []; for (const line of lines) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* Partial trailing line. */ } } return out; }
const toolSummary = (name: unknown, input: unknown) => { const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>; const detail = i.file_path ?? i.path ?? i.command ?? i.cmd ?? i.pattern ?? i.query ?? i.url ?? ''; return clip(`${String(name ?? 'tool')} ${typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.join(' ') : ''}`, 160); };

export function claudeEntries(records: Record<string, unknown>[], since: number, until: number): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    for (const r of records) {
        if (r.isSidechain === true || !within(r.timestamp, since, until)) continue;
        const message = r.message as {content?: unknown} | undefined; const content = message?.content;
        if (r.type === 'user') {
            if (typeof content === 'string') { if (!content.startsWith('<')) entries.push({role: 'user', text: clip(content, 600), time: String(r.timestamp ?? '')}); }
            else if (Array.isArray(content)) for (const c of content as Record<string, unknown>[]) if (c.type === 'text' && typeof c.text === 'string' && !c.text.startsWith('<')) entries.push({role: 'user', text: clip(c.text, 600), time: String(r.timestamp ?? '')});
        } else if (r.type === 'assistant' && Array.isArray(content)) {
            for (const c of content as Record<string, unknown>[]) {
                if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) entries.push({role: 'assistant', text: clip(c.text, 900), time: String(r.timestamp ?? '')});
                else if (c.type === 'tool_use') entries.push({role: 'tool', text: toolSummary(c.name, c.input), time: String(r.timestamp ?? '')});
            }
        }
    }
    return entries;
}
export function codexEntries(records: Record<string, unknown>[], since: number, until: number): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    for (const r of records) {
        if (r.type !== 'response_item' || !within(r.timestamp, since, until)) continue;
        const p = r.payload as Record<string, unknown> | undefined; if (!p) continue;
        if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant') && Array.isArray(p.content)) {
            for (const c of p.content as Record<string, unknown>[]) { const text = typeof c.text === 'string' ? c.text : ''; if (!text.trim() || (p.role === 'user' && text.startsWith('<'))) continue; entries.push({role: p.role as 'user' | 'assistant', text: clip(text, p.role === 'user' ? 600 : 900), time: String(r.timestamp ?? '')}); }
        } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
            let input: unknown = p.input ?? p.arguments; if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {command: input}; } }
            entries.push({role: 'tool', text: toolSummary(p.name, input), time: String(r.timestamp ?? '')});
        }
    }
    return entries;
}
async function newestMatching(dir: string, filter: (name: string) => boolean, since: number, until: number, depth = 0): Promise<string[]> {
    let names: import('node:fs').Dirent[] = []; try { names = await fs.readdir(dir, {withFileTypes: true}); } catch { return []; }
    const files: string[] = [];
    for (const entry of names) { const full = path.join(dir, entry.name); if (entry.isDirectory() && depth < 3) files.push(...await newestMatching(full, filter, since, until, depth + 1)); else if (entry.isFile() && filter(entry.name)) { try { const stat = await fs.stat(full); if (stat.mtimeMs >= since - 60000 && stat.birthtimeMs <= until + 60000) files.push(full); } catch { /* Skip. */ } } }
    return files;
}
// Locate the native log for a session: same working directory, overlapping the session's time window.
export async function nativeTranscript(agent: string, workdir: string, startedAt: string, endedAt: string | null, home = os.homedir()): Promise<Transcript | null> {
    const since = Date.parse(startedAt), until = endedAt ? Date.parse(endedAt) : Date.now();
    if (!Number.isFinite(since)) return null;
    const real = await fs.realpath(workdir).catch(() => workdir);
    const sameDir = (cwd: unknown) => typeof cwd === 'string' && (cwd === workdir || cwd === real);
    if (agent === 'claude') {
        for (const file of (await newestMatching(path.join(home, '.claude', 'projects'), n => n.endsWith('.jsonl'), since, until)).sort()) {
            const records = parse(await readLines(file));
            if (!records.some(r => sameDir(r.cwd))) continue;
            const entries = claudeEntries(records, since, until); if (entries.length) return {source: 'Claude Code session log', file, entries};
        }
    } else if (agent === 'codex') {
        for (const file of (await newestMatching(path.join(home, '.codex', 'sessions'), n => n.startsWith('rollout-') && n.endsWith('.jsonl'), since, until)).sort()) {
            const records = parse(await readLines(file));
            const meta = records.find(r => r.type === 'session_meta')?.payload as Record<string, unknown> | undefined;
            if (!sameDir(meta?.cwd) && !records.some(r => sameDir((r.payload as Record<string, unknown> | undefined)?.cwd))) continue;
            const entries = codexEntries(records, since, until); if (entries.length) return {source: 'Codex session log', file, entries};
        }
    }
    return null;
}
// Terminal output captured by the dashboard, with escape sequences removed and redraw noise collapsed.
export function cleanTerminalOutput(raw: string) {
    const text = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b[\[\]()][0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\r/g, '\n');
    const lines: string[] = []; for (const line of text.split('\n')) { const t = line.replace(/\s+$/, ''); if (!t.trim()) { if (lines.at(-1) !== '') lines.push(''); continue; } if (lines.at(-1) !== t) lines.push(t); }
    return lines.join('\n').trim();
}
export function renderTranscript(transcript: Transcript, agentName: string, maxChars = 6000) {
    const label = {user: 'you', assistant: agentName, tool: 'tool'};
    const lines = transcript.entries.map(e => `[${label[e.role]}] ${e.text}`);
    let out = lines.join('\n'); if (out.length > maxChars) out = '[earlier turns omitted]\n' + out.slice(-maxChars).replace(/^[^\n]*\n/, '');
    return `${out}\n\n(Source: ${transcript.source}, ${transcript.entries.length} turns, ${transcript.file})`;
}

// The native CLIs print a recognizable message when a subscription limit is hit. Detecting it in the terminal stream is what
// lets AgentHub mark a lane "out of usage", notify, and arm the other agent without anyone reading the screen.
const LIMIT=/(?:you(?:'ve| have) (?:hit|reached|exceeded) (?:your|the) (?:[\w-]+ )?limit|usage limit (?:reached|exceeded|hit)|out of (?:extra )?usage|rate limit(?:ed| reached| exceeded| hit)|quota (?:exceeded|reached)|limit (?:has been )?reached)/i;
const RESET=/(?:resets?|try again|available(?: again)?|come back|until)(?: at| in| on| around)?\s*:?\s*((?:\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2}|\d+\s*(?:h(?:ours?)?|m(?:in(?:utes?)?)?|d(?:ays?)?)(?:\s*(?:and\s*)?\d+\s*(?:h(?:ours?)?|m(?:in(?:utes?)?)?))?)(?:[^\n.!]{0,30}?\b(?:[A-Z]{2,4}|\(?[A-Z][a-z]+\/[A-Z][\w_]+\)?))?)/i;
export interface LimitHit { message: string; resetsAt: string | null }
export function detectLimit(text: string): LimitHit | null {
    for (const raw of text.split('\n').reverse()) {
        const line = raw.replace(/[│┃|╭╰╮╯─━]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!line || line.length > 400 || !LIMIT.test(line)) continue;
        if (/[{};=]|\b(?:const|let|var|function|return|import|def|class)\b/.test(line)) continue; // Code that talks about limits is not a limit.
        const reset = RESET.exec(line);
        return { message: line.slice(0, 200), resetsAt: reset ? reset[1].trim() : null };
    }
    return null;
}
// A short state-of-play ahead of the raw tail: what was asked, what was touched, what ran, what it said last.
export function briefing(transcript: Transcript, agentName: string) {
    const users = transcript.entries.filter(e => e.role === 'user'), tools = transcript.entries.filter(e => e.role === 'tool'), replies = transcript.entries.filter(e => e.role === 'assistant');
    const files = new Set<string>(); const commands: string[] = [];
    for (const t of tools) {
        const [name, ...rest] = t.text.split(' '); const detail = rest.join(' ');
        if (/^(?:edit|write|multiedit|notebookedit|apply_patch|create|str_replace|update)/i.test(name)) { for (const m of detail.match(/(?:[\w@.-]+\/)*[\w@.-]+\.[a-z0-9]{1,8}\b/gi) || []) files.add(m); }
        else if (/^(?:bash|shell|exec|run|terminal|command)/i.test(name) && detail) commands.push(detail.slice(0, 120));
    }
    const lastWords = replies.at(-1)?.text; const limit = detectLimit(transcript.entries.slice(-4).map(e => e.text).join('\n'));
    const lines = [
        users.length ? `Last request from you: ${users.at(-1)!.text}` : '',
        files.size ? `Files ${agentName} edited (${files.size}): ${[...files].slice(-20).join(', ')}` : `Files edited: none recorded`,
        commands.length ? `Last commands it ran: ${commands.slice(-4).map(c => `\`${c}\``).join('; ')}` : '',
        lastWords ? `Its last words: ${lastWords}` : '',
        limit ? `It stopped because of a usage limit${limit.resetsAt ? ` (resets ${limit.resetsAt})` : ''}; assume the last step is unfinished.` : '',
        `Turns in the log: ${transcript.entries.length} (${users.length} from you, ${replies.length} replies, ${tools.length} tool calls).`,
    ].filter(Boolean);
    return lines.join('\n');
}
