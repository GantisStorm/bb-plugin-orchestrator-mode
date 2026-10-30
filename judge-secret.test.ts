import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { judgeSecretStore } from "./judge-secret";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("judge secret storage", () => {
  it("moves the existing key without exposing it and saves replacements privately", async () => {
    const root = await mkdtemp(join(tmpdir(), "orch-secret-"));
    roots.push(root);
    const data = join(root, "bb");
    const oldDir = join(data, "plugins", "orchestrator-mode", "secrets");
    const old = join(oldDir, "judgeKey");
    await mkdir(oldDir, { recursive: true, mode: 0o700 });
    await writeFile(old, "synthetic-old-key", { mode: 0o600 });
    const store = judgeSecretStore(data);
    await store.migrate();
    expect(await store.read()).toBe("synthetic-old-key");
    await expect(readFile(old)).rejects.toMatchObject({ code: "ENOENT" });
    const file = join(`${data}.orchestrator-secrets`, "judgeKey");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(`${data}.orchestrator-secrets`)).mode & 0o777).toBe(0o700);
    await store.write("synthetic-new-key");
    expect(await store.read()).toBe("synthetic-new-key");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
