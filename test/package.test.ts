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
const files = [...entrypoints.map((name) => `${name}.js`), "gui-experimental.cjs"]

function expectNoGitPreparation(manifest: { scripts: Record<string, string> }) {
  // pacote 21.5.1 lib/git.js #prepareDir checks these keys, independently of ignoreScripts.
  for (const script of ["postinstall", "build", "preinstall", "install", "prepack", "prepare"]) {
    expect(manifest.scripts).not.toHaveProperty(script)
  }
  expect(manifest).not.toHaveProperty("workspaces")
}

test("release metadata bypasses pacote Git dependency preparation", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  expect(manifest.version).toBe("0.2.0")
  expectNoGitPreparation(manifest)
})

test("release entrypoints match a fresh deterministic build", async () => {
  const shared = { absWorkingDir: root, bundle: true, platform: "node" as const, target: "node22", write: false }
  const configs = [
    { ...shared, entryPoints: entrypoints.map((name) => `src/${name}.ts`), format: "esm" as const, packages: "external" as const, outdir: "dist" },
    { ...shared, entryPoints: ["src/gui.ts"], format: "cjs" as const, external: ["@opencode/plugin/gui", "@opencode/plugin/rpc"], outfile: "dist/gui-experimental.cjs" },
  ]
  for (const options of configs) {
    const first = await build(options)
    const second = await build(options)
    for (const [index, output] of first.outputFiles!.entries()) {
      expect(Buffer.from(output.contents)).toEqual(await readFile(output.path))
      expect(output.contents).toEqual(second.outputFiles![index]!.contents)
      expect(output.text).not.toContain(root)
    }
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
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
    const archives = await readdir(artifact)
    expect(archives).toEqual([`${manifest.name}-${manifest.version}.tgz`])
    const tarball = join(artifact, archives[0]!)
    const { stdout: metadata } = await run("tar", ["-xOf", tarball, "package/package.json"])
    const packedManifest = JSON.parse(metadata)
    expect(packedManifest.name).toBe(manifest.name)
    expect(packedManifest.version).toBe(manifest.version)
    expectNoGitPreparation(packedManifest)
    const { stdout: contents } = await run("tar", ["-tzf", tarball])
    expect(contents.trim().split("\n").sort()).toEqual([
      "package/README.md", ...files.map((name) => `package/dist/${name}`), "package/package.json",
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
    for (const name of files) {
      expect(await readFile(join(installed, "dist", name))).toEqual(await readFile(resolve(root, "dist", name)))
    }
    // Resolve Effect beside the installed package, as its own imports do.
    await writeFile(join(consumer, "check.mjs"), `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      import server from 'opencode-vault';
      import tui from 'opencode-vault/tui';
      import { BaoRpc } from 'opencode-vault/rpc';
      const require = createRequire(import.meta.resolve('opencode-vault'));
      const { Effect } = await import(pathToFileURL(require.resolve('effect')).href);
      assert.equal(server.id, 'opencode-vault');
      assert.equal(tui.id, 'opencode.bao.tui');
      assert.equal(BaoRpc.id, 'opencode.bao');
      const bundle = import.meta.resolve('opencode-vault/gui-experimental');
      assert.ok(bundle.endsWith('/dist/gui-experimental.cjs'));
      const rpc = { Rpc: { define(value) { assert.deepEqual(value, BaoRpc); return value; } } };
      const gui = { Plugin: { define: (value) => value }, Command: Symbol('Command') };
      const module = { exports: {} };
      new Function('require', 'module', 'exports', readFileSync(new URL(bundle), 'utf8'))((name) => {
        if (name === '@opencode/plugin/gui') return gui;
        if (name === '@opencode/plugin/rpc') return rpc;
        if (name === 'node:os') return { homedir: () => '[inert module node:os]' };
        if (name === 'node:path') return { join: () => '[inert module node:path]' };
        throw new Error('Unexpected GUI external: ' + name);
      }, module, module.exports);
      const commands = [];
      assert.equal(module.exports.default.os, undefined);
      module.exports.default.setup({ signal: new AbortController().signal, add(token, command) {
        assert.equal(token, gui.Command);
        commands.push(command.slash.name);
      } });
      assert.deepEqual(commands, ['bao-login', 'bao']);
      Object.defineProperty(process, 'platform', { value: 'win32' });
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
