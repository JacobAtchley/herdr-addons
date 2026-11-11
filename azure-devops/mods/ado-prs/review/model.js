// Neutral review model shared by the view and the providers. Pure.

/** Vote keys → ADO vote values (also the neutral vote vocabulary). */
export const VOTES = { approve: 10, approveWithSuggestions: 5, reset: 0, waitForAuthor: -5, reject: -10 };

/** @param {number} n @returns {string|undefined} the VOTES key for a vote value */
export function voteName(n) {
  return Object.keys(VOTES).find((k) => VOTES[k] === n);
}

/**
 * @typedef {{org: string, project: string, repoId: string, id: number}} Ref
 * @typedef {{from: number|null, to: number}} Range  iteration ids; from:null = against the target branch
 * @typedef {{id: string, name: string, vote: number, required: boolean, isGroup: boolean}} Reviewer
 * @typedef {{id: string|number, name: string, state: 'pass'|'fail'|'running'|'pending'|'notApplicable',
 *   kind: 'build'|'policy'|'check', link?: {project: string, build: number}|{url: string},
 *   reason?: string, optional: boolean}} Gate
 * @typedef {{id: number, title: string|null, url: string}} WorkItem
 * @typedef {{id: number, url: string, title: string, description: string, repo: string, project: string,
 *   projectId: string, source: string, target: string, author: {name: string, id: string}, created: string,
 *   isDraft: boolean, status: string, reviewers: Reviewer[], gates: Gate[], workItems: WorkItem[],
 *   versions: {latest: number, all: number[]}}} PullRequest
 * @typedef {{path: string, oldPath?: string, change: 'add'|'edit'|'delete'|'rename', binary?: boolean,
 *   changeTrackingId?: number}} FileChange
 * @typedef {{id: number, author: string, body: string, created: string, isMine: boolean}} Comment
 * @typedef {{path: string, side: 'left'|'right', startLine: number, endLine: number}} ThreadFile
 * @typedef {{id: number, status: 'active'|'resolved'|'pending', rawStatus?: string, file?: ThreadFile,
 *   comments: Comment[]}} Thread
 * @typedef {{old: string|null, new: string|null, binary: boolean}} FileContents
 * @typedef {{file: string, side: 'left'|'right', line: number, endLine?: number, lineLength?: number,
 *   endLineLength?: number} | {general: true}} CommentTarget
 * @typedef {{
 *   capabilities: {votes: string[], draft: boolean},
 *   me(): Promise<{id: string, name: string}>,
 *   getPullRequest(ref: Ref): Promise<PullRequest>,
 *   listFiles(ref: Ref, range: Range): Promise<FileChange[]>,
 *   getFileContents(ref: Ref, file: FileChange, range: Range): Promise<FileContents>,
 *   listThreads(ref: Ref, range: Range): Promise<Thread[]>,
 *   addThread(ref: Ref, args: {target: CommentTarget, body: string, range: Range, file?: FileChange}): Promise<Thread>,
 *   reply(ref: Ref, threadId: number, body: string): Promise<Comment>,
 *   setThreadStatus(ref: Ref, threadId: number, status: string): Promise<Thread>,
 *   vote(ref: Ref, key: string): Promise<number>,
 *   setDraft(ref: Ref, isDraft: boolean): Promise<boolean>,
 * }} Provider
 */
