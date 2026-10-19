import { expect, test } from "vitest"
import { build } from "esbuild"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

const run = promisify(execFile)
const root = fileURLToPath(new URL("..", import.meta.url))
const entrypoints = ["index", "tui", "rpc", "cli"]

test("release entrypoints match a fresh deterministic build", async () => {
  const options = {
    absWorkingDir: root, entryPoints: entrypoints.map((name) => `src/${name}.ts`),
    bundle: true, platform: "node" as const, target: "node22", format: "esm" as const,
    packages: "external" as const, outdir: "dist", write: false,
  }
  const first = await build(options)
  const second = await build(options)
  expect(first.outputFiles).toHaveLength(4)
  for (const [index, output] of first.outputFiles!.entries()) {
    expect(Buffer.from(output.contents)).toEqual(await readFile(output.path))
    expect(output.contents).toEqual(second.outputFiles![index]!.contents)
    expect(output.text).not.toContain(root)
  }
})

test("packed release installs and loads with lifecycle scripts disabled", async () => {
  const parent = process.env.OPENCODE_TEST_TMP ?? join(tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, "vault-package-"))
  try {
    const artifact = join(directory, "artifact")
    const consumer = join(directory, "consumer")
    await mkdir(artifact)
    await mkdir(consumer)
    await run("pnpm", ["pack", "--pack-destination", artifact], { cwd: root })
    const archives = await readdir(artifact)
    expect(archives).toEqual(["opencode-vault-0.1.0.tgz"])
    const tarball = join(artifact, archives[0]!)
    const { stdout: contents } = await run("tar", ["-tzf", tarball])
    expect(contents.trim().split("\n").sort()).toEqual([
      "package/README.md", ...entrypoints.map((name) => `package/dist/${name}.js`), "package/package.json",
    ].sort())
    await writeFile(join(consumer, "package.json"), JSON.stringify({
      private: true, type: "module", packageManager: "pnpm@10.10.0",
      scripts: { preinstall: "node -e \"throw new Error('Lifecycle scripts must stay disabled')\"" },
      dependencies: { "opencode-vault": `file:${tarball}` },
    }))
    await run("pnpm", ["install", "--ignore-scripts", "--lockfile=false", "--store-dir", join(directory, "store"), "--registry", "https://registry.npmjs.org"], {
      cwd: consumer, timeout: 180000, maxBuffer: 1024 * 1024,
    })
    const installed = join(consumer, "node_modules", "opencode-vault")
    expect((await readdir(installed)).sort()).toEqual(["README.md", "dist", "node_modules", "package.json"])
    for (const name of entrypoints) {
      expect(await readFile(join(installed, "dist", `${name}.js`))).toEqual(await readFile(resolve(root, "dist", `${name}.js`)))
    }
    // Resolve Effect beside the installed package, as its own imports do.
    await writeFile(join(consumer, "check.mjs"), `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      import server from 'opencode-vault';
      import tui from 'opencode-vault/tui';
      import { BaoRpc } from 'opencode-vault/rpc';
      const require = createRequire(import.meta.resolve('opencode-vault'));
      const { Effect } = await import(pathToFileURL(require.resolve('effect')).href);
      assert.equal(server.id, 'opencode.bao');
      assert.equal(tui.id, 'opencode.bao.tui');
      assert.ok(BaoRpc);
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const ctx = new Proxy({}, { get() { throw new Error('Unexpected context access'); } });
      await Effect.runPromise(Effect.scoped(server.effect(ctx)));
      assert.equal(await tui.setup(ctx), undefined);
    `)
    await run(process.execPath, [join(consumer, "check.mjs")], { cwd: consumer })
    await expect(run(process.execPath, [join(installed, "dist", "cli.js"), "not-a-command"], { cwd: consumer })).rejects.toMatchObject({
      code: 1, stdout: "", stderr: "Bao unavailable. Use /bao-login in OpenCode or retry opencode-bao login; check trusted configuration and dedicated role. Do not reset existing state.\n",
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 240000)
