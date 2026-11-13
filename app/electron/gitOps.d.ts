// Types for electron/gitOps.js (the main process runs it as plain JavaScript); the result shapes are the ones the
// page gets through desktop.git.
import type {
  GitBlameLine, GitBranchList, GitBranchMergeResult, GitChange, GitCommitResult, GitConflictFile, GitConflicts, GitFileTexts, GitGraph,
  GitMergeResult, GitMergeTarget, GitPatch, GitPushCheck, GitPushResult, GitRemoteChange, GitRepoState, GitResolution, GitResolvedResult,
  GitRevertResult, GitStash, GitStashResult,
} from "../src/core/desktop";

export type Git = (cwd: string, args: string[], options?: {
  timeoutMs?: number; maxBytes?: number; allowCodes?: number[]; truncate?: boolean; extraEnv?: Record<string, string | undefined>;
  input?: string | null;
}) => Promise<{ out: string; code: number; truncated: boolean }>;

export const shaPattern: RegExp;
export const massDeleteShare: number;
export class GitRefusal extends Error {
  details: Record<string, unknown>;
}
export function createGit(options?: { spawn?: unknown; env?: NodeJS.ProcessEnv }): Git;
export const ownHosts: Record<string, string>;
export function remoteHost(url: string): string | null;
export function credentialName(host: string, chosen: string | undefined): string | null;
export function withCredentials(git: Git, tokenFor: (host: string) => Promise<string | null> | string | null): Git;
export function remoteEnv(git: Git, cwd: string, url: string | null): Promise<Record<string, string | undefined>>;
export function authRefusal(host: string | null): GitRefusal;
export function checkSha(sha: string): string;
export function checkPath(p: string): string;
export function checkBranchName(git: Git, cwd: string, name: string): Promise<string>;
export function repoState(git: Git, cwd: string): Promise<GitRepoState>;
export function status(git: Git, cwd: string): Promise<GitChange[]>;
export function workingDiff(git: Git, cwd: string, file: string): Promise<GitPatch>;
export function showCommit(git: Git, cwd: string, sha: string): Promise<GitPatch>;
export function listFiles(git: Git, cwd: string, rev: string): Promise<string[]>;
export function blame(git: Git, cwd: string, rev: string, file: string): Promise<GitBlameLine[]>;
export function remoteDefault(git: Git, cwd: string): Promise<string | null>;
export function branches(git: Git, cwd: string): Promise<GitBranchList>;
export function graph(git: Git, cwd: string, options?: { max?: number; skip?: number }): Promise<GitGraph>;
export function createBranch(git: Git, cwd: string, name: string, from: string): Promise<{ name: string; head: string }>;
export function deleteBranch(git: Git, cwd: string, name: string, protectedNames?: string[]): Promise<void>;
export function switchBranch(git: Git, cwd: string, name: string): Promise<string>;
export function mergeBranch(git: Git, cwd: string, source: string): Promise<GitBranchMergeResult>;
export function mergeCurrentInto(git: Git, cwd: string, target: string): Promise<GitBranchMergeResult>;
export function commit(git: Git, cwd: string, options: { paths: string[]; message: string; allowMassDelete?: boolean }): Promise<GitCommitResult>;
export function restoreCommit(git: Git, cwd: string, sha: string, options?: { allowMassDelete?: boolean }): Promise<GitRevertResult>;
export function stashList(git: Git, cwd: string): Promise<GitStash[]>;
export function stashPush(git: Git, cwd: string, options?: { paths?: string[]; message?: string; includeUntracked?: boolean }): Promise<GitStashResult>;
export function stashRestore(git: Git, cwd: string, sha: string): Promise<GitStashResult>;
export function stashDelete(git: Git, cwd: string, sha: string): Promise<void>;
export function remoteHeads(git: Git, cwd: string): Promise<Record<string, string>>;
export function fetchRemote(git: Git, cwd: string): Promise<GitRemoteChange[]>;
export function mergeDryRun(git: Git, cwd: string, local: string, remote: string): Promise<{ clean: boolean; conflicts: string[] | null }>;
export function pushCheck(git: Git, cwd: string, branch?: string | null): Promise<GitPushCheck>;
export function push(git: Git, cwd: string, options?: { allowMassDelete?: boolean; branch?: string | null }): Promise<GitPushResult>;
export function mergeRemote(git: Git, cwd: string): Promise<GitMergeResult>;
export function mergeConflicts(git: Git, cwd: string, target: GitMergeTarget): Promise<GitConflicts>;
export function mergeFile(git: Git, cwd: string, versions: Pick<GitConflictFile, "base" | "receiving" | "incoming">): Promise<GitFileTexts>;
export function mergeDiff(git: Git, cwd: string, receiving: string, tree: string, file: string): Promise<GitPatch>;
export function mergeResolved(git: Git, cwd: string, options: {
  target: GitMergeTarget; receiving: string; incoming: string; message: string; files: GitResolution[];
}): Promise<GitResolvedResult>;
