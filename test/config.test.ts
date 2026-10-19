import { afterEach, expect, test, vi } from "vitest"
import { chmod, lchmod, lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { config, parseConfig } from "../src/bao"
import { LocalSetupError, failureData, rpcDiagnostic } from "../src/diagnostics"

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return { ...actual, lstat: vi.fn(actual.lstat), stat: vi.fn(actual.stat) }
})

const settings = { address: "https://bao.invalid", catalogRole: "catalog", readRole: "read" }
const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(lstat).mockReset()
  vi.mocked(stat).mockReset()
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  vi.mocked(lstat).mockImplementation(actual.lstat)
  vi.mocked(stat).mockImplementation(actual.stat)
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(directoryLink = false, fileLink = false) {
  const parent = process.env.OPENCODE_TEST_TMP ?? join(tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  const base = await realpath(await mkdtemp(join(parent, "vault-config-")))
  directories.push(base)
  const targetDirectory = join(base, "target")
  await mkdir(targetDirectory, { mode: 0o700 })
  const file = join(targetDirectory, "config.json")
  const targetFile = fileLink ? join(base, "settings.json") : file
  await writeFile(targetFile, JSON.stringify(settings), { mode: 0o600 })
  if (fileLink) {
    await symlink("../settings.json", file)
    if (process.platform === "darwin") await lchmod(file, 0o777)
  }
  const directory = directoryLink ? join(base, "config") : targetDirectory
  if (directoryLink) {
    await symlink("target", directory)
    if (process.platform === "darwin") await lchmod(directory, 0o777)
  }
  return { base, directory, targetDirectory, targetFile, file }
}

async function rejected(directory: string, diagnostic: "permissions" | "missing" | "json" | "schema", privateText?: string) {
  const error = await config(directory).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(LocalSetupError)
  expect(failureData(error)).toEqual({ diagnostic })
  const text = rpcDiagnostic({ type: "unavailable", data: failureData(error) })
  expect(text).toBeTruthy()
  expect(text).not.toContain(directory)
  if (privateText) expect(text).not.toContain(privateText)
}

test.each([[false, false], [true, false], [false, true], [true, true]])(
  "loads owned secure config with directory symlink %s and file symlink %s",
  async (directoryLink, fileLink) => {
    const f = await fixture(directoryLink, fileLink)
    if (directoryLink) expect((await lstat(f.directory)).mode & 0o777).toBe(0o777)
    if (fileLink) expect((await lstat(f.file)).mode & 0o777).toBe(0o777)
    expect(await config(f.directory)).toEqual(parseConfig(settings))
  },
)

test.each([0o020, 0o002])("rejects target write mode %s on regular and symlink paths", async (mode) => {
  for (const linked of [false, true]) {
    for (const target of ["directory", "file"] as const) {
      const f = await fixture(linked, linked)
      const path = target === "directory" ? f.targetDirectory : f.targetFile
      await chmod(path, (target === "directory" ? 0o700 : 0o600) | mode)
      await rejected(f.directory, "permissions")
    }
  }
})

test("accepts owner-controlled targets with group/world read access", async () => {
  const f = await fixture(true, true)
  await chmod(f.targetDirectory, 0o755)
  await chmod(f.targetFile, 0o644)
  expect(await config(f.directory)).toEqual(parseConfig(settings))
})

test.each(["directory", "file"] as const)("rejects foreign-owned %s links and targets", async (kind) => {
  for (const linked of [false, true]) {
    const f = await fixture(linked, linked)
    const entry = kind === "directory" ? f.directory : f.file
    const target = kind === "directory" ? f.targetDirectory : f.targetFile
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    const linkInfo = await actual.lstat(entry)
    vi.mocked(lstat).mockImplementation(async (path, ...options) => path === entry
      ? Object.assign(linkInfo, { uid: process.getuid!() + 1 })
      : actual.lstat(path, ...options))
    await rejected(f.directory, "permissions")
    vi.mocked(lstat).mockImplementation(actual.lstat)
    const targetInfo = await actual.stat(target)
    vi.mocked(stat).mockImplementation(async (path, ...options) => path === target
      ? Object.assign(targetInfo, { uid: process.getuid!() + 1 })
      : actual.stat(path, ...options))
    await rejected(f.directory, "permissions")
    vi.mocked(stat).mockImplementation(actual.stat)
  }
})

test("missing and dangling directory/file paths fail safely", async () => {
  const f = await fixture()
  await rejected(join(f.base, "absent"), "missing")
  await rm(f.targetFile)
  await rejected(f.directory, "missing")
  await symlink("absent.json", f.file)
  await rejected(f.directory, "missing")
  const dangling = join(f.base, "dangling")
  await symlink("absent", dangling)
  await rejected(dangling, "missing")
  const loop = join(f.base, "loop")
  await symlink("loop", loop)
  await rejected(loop, "permissions")
})

test("symlink config JSON and schema diagnostics omit raw paths and values", async () => {
  const f = await fixture(true, true)
  const privateText = "synthetic-private-config-value"
  await writeFile(f.targetFile, `{${privateText}`)
  await rejected(f.directory, "json", privateText)
  await writeFile(f.targetFile, JSON.stringify({ ...settings, address: `http://${privateText}.invalid` }))
  await rejected(f.directory, "schema", privateText)
})
