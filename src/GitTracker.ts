import simpleGit, { SimpleGit } from 'simple-git';
import { GitState } from './types';

export class GitTracker {
  private readonly git: SimpleGit;
  private cachedIsRepo: boolean | undefined;

  constructor(private readonly workspaceRoot: string) {
    this.git = simpleGit({
      baseDir: workspaceRoot,
      binary: 'git',
      maxConcurrentProcesses: 1
    });
  }

  async capture(): Promise<GitState | undefined> {
    try {
      if (this.cachedIsRepo === undefined) {
        this.cachedIsRepo = await this.git.checkIsRepo();
      }
      if (!this.cachedIsRepo) { return undefined; }

      const [status, log, unstagedDiff, stagedDiff] = await Promise.all([
        this.git.status(),
        this.git.log({ maxCount: 1 }),
        this.git.diff(),
        this.git.diff(['--cached'])
      ]);

      const latest = log.latest;
      return {
        branch: status.current ?? '',
        commitHash: latest?.hash ?? '',
        commitMessage: latest?.message ?? '',
        diff: this.joinDiffs(stagedDiff, unstagedDiff)
      };
    } catch {
      return undefined;
    }
  }

  async currentBranch(): Promise<string | undefined> {
    try {
      const status = await this.git.status();
      return status.current ?? undefined;
    } catch {
      return undefined;
    }
  }

  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  private joinDiffs(stagedDiff: string, unstagedDiff: string): string {
    return [stagedDiff, unstagedDiff].filter(Boolean).join('\n');
  }
}
