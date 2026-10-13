// SPDX-License-Identifier: Apache-2.0
/** NND-owned objective files, keyed only by a validated session id (§B.1). */
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ENV } from '../env.ts';
import { GOAL_OBJECTIVE_CHAR_LIMIT } from './goal-constants.ts';
import { isGoalFileSessionId } from './goal-payload.ts';

export class ObjectiveInputError extends Error {}
const KEY = /^[a-f0-9]{64}$/;

export class ObjectiveStore {
  private readonly directory: string;

  constructor(dataDir: string = ENV.dataDir) {
    this.directory = join(dataDir, 'goals');
  }

  private path(sessionId: string, key = ''): string {
    if (!isGoalFileSessionId(sessionId)) throw new ObjectiveInputError('Invalid session id');
    if (key !== '' && !KEY.test(key)) throw new ObjectiveInputError('Invalid objective key');
    return join(this.directory, `${sessionId}${key ? `.${key}` : ''}.md`);
  }

  private async checkedDirectory(create: boolean): Promise<boolean> {
    if (create) await mkdir(this.directory, { recursive: true });
    let info;
    try { info = await lstat(this.directory); }
    catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe goals directory');
    return true;
  }

  async read(sessionId: string, key = ''): Promise<string | null> {
    const target = this.path(sessionId, key);
    if (!await this.checkedDirectory(false)) return null;
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe objective file');
      return await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(sessionId: string, content: string): Promise<string> {
    const bounded = content.trim().slice(0, GOAL_OBJECTIVE_CHAR_LIMIT);
    if (!bounded) throw new ObjectiveInputError('Objective content is required');
    // A fresh key for EACH write prevents stale clears from deleting a newer
    // goal generation even when the objective text is identical.
    const key = randomBytes(32).toString('hex');
    const target = this.path(sessionId, key);
    await this.checkedDirectory(true);
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, bounded, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return key;
  }

  async remove(sessionId: string, key = ''): Promise<void> {
    const target = this.path(sessionId, key);
    if (!await this.checkedDirectory(false)) return;
    await rm(target, { force: true });
  }
}
