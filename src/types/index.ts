export const statuses = ['todo', 'in_progress', 'blocked', 'review', 'done'] as const;
export type Status = typeof statuses[number];
export interface Task {
    id: string;
    title: string;
    description: string;
    status: Status;
    assignedAgent: string | null;
    createdAt: string;
    updatedAt: string;
    files: string[];
    dependencies: string[];
    notes: string[];
}
export interface Config {
    projectName: string;
    version: string;
    agents: string[];
    defaultAgent: string;
    createdAt: string;
    updatedAt: string;
    lastSync?: string;
}
export interface Lock {
    owner: string;
    taskId: string;
    createdAt: string;
}
export interface AgentAdapter {
    id: string;
    displayName: string;
    description: string;
    handoffInstructions: string;
    supportsDirectLaunch: boolean;
}
export interface GitState {
    available: boolean;
    repository: boolean;
    branch: string;
    changes: {
        status: string;
        file: string;
        original?: string;
    }[];
    stagedStat: string;
    unstagedStat: string;
}
