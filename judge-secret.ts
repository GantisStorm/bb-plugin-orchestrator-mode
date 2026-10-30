import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export function judgeSecretStore(dataDir: string) {
  const base = resolve(dataDir);
  const dir = `${base}.orchestrator-secrets`;
  const file = join(dir, "judgeKey");
  const legacy = join(base, "plugins", "orchestrator-mode", "secrets", "judgeKey");
  function read(path: string): string | null {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error("Judge key file is not private");
      }
      if (stat.size > 512) throw new Error("Judge key file is too large");
      return readFileSync(fd, "utf8") || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  function prepare() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Judge key directory is not private");
    }
  }

  function migrate() {
    if (read(file) !== null || read(legacy) === null) return;
    prepare();
    try {
      linkSync(legacy, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    unlinkSync(legacy);
  }

  function write(key: string) {
    prepare();
    const temporary = join(dir, `.judgeKey-${randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, key, "utf8");
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  return { migrate, read: () => read(file), write };
}
