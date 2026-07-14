import { createHash } from 'node:crypto';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const pollIntervalMs = 100;
const acquisitionTimeoutMs = 5 * 60 * 1000;
const malformedLockGraceMs = 5 * 1000;

function ownerIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function removeStaleLock(lockPath) {
  let metadata;
  try {
    metadata = await stat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    if (Date.now() - metadata.mtimeMs < malformedLockGraceMs) return;
  }
  if (ownerIsAlive(owner?.pid)) return;

  const current = await stat(lockPath).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (current?.dev === metadata.dev && current.ino === metadata.ino) {
    await rm(lockPath, { force: true });
  }
}

export async function acquireRepositoryMutationLock(repositoryRoot) {
  const identity = createHash('sha256').update(resolve(repositoryRoot)).digest('hex').slice(0, 24);
  const lockPath = join(tmpdir(), `tixkit-repository-mutation-${identity}.lock`);
  const deadline = Date.now() + acquisitionTimeoutMs;

  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for repository mutation lock: ${lockPath}`, {
          cause: error,
        });
      }
      await delay(pollIntervalMs);
      continue;
    }

    let acquired;
    try {
      acquired = await handle.stat();
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const current = await stat(lockPath);
          if (current.dev === acquired.dev && current.ino === acquired.ino) {
            await rm(lockPath, { force: true });
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        } finally {
          await handle.close();
        }
      };
    } catch (error) {
      const cleanupErrors = [];
      try {
        const current = await stat(lockPath);
        if (
          acquired === undefined ||
          (current.dev === acquired.dev && current.ino === acquired.ino)
        ) {
          await rm(lockPath, { force: true });
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') cleanupErrors.push(cleanupError);
      }
      try {
        await handle.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new Error(`Repository mutation lock cleanup failed: ${cleanupErrors.join('; ')}`, {
          cause: error,
        });
      }
      throw error;
    }
  }
}
