import { spawn } from 'node:child_process';
export interface ClipboardCommand { command: string; args: string[] }
export function clipboardCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
    if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
    if (platform === 'win32') return [{ command: 'clip', args: [] }];
    return [{ command: 'wl-copy', args: [] }, { command: 'xclip', args: ['-selection', 'clipboard'] }, { command: 'xsel', args: ['--clipboard', '--input'] }];
}
export async function runClipboard(command: ClipboardCommand, text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command.command, command.args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
        let stderr = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('Clipboard command timed out.')); }, 5000);
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${command.command} exited ${code}: ${stderr.trim()}`)); });
        child.stdin.on('error', () => { /* Process close/error supplies the actionable failure. */ });
        // Windows clip reads UTF-16LE reliably; Unix clipboard tools expect UTF-8.
        child.stdin.end(command.command === 'clip' ? Buffer.from('\ufeff' + text, 'utf16le') : text);
    });
}
export async function copyToClipboard(text: string, platform: NodeJS.Platform = process.platform, run = runClipboard): Promise<void> {
    const failures: string[] = [];
    for (const command of clipboardCommands(platform)) {
        try { await run(command, text); return; } catch (error) { failures.push(`${command.command}: ${(error as Error).message}`); }
    }
    throw new Error(`Clipboard copy failed. Install/enable ${clipboardCommands(platform).map(c => c.command).join(', ')} and a desktop clipboard session. ${failures.join('; ')}`);
}
