import { expect, test, vi } from "vitest"
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { encryptionKey, initialize } from "../src/bao"
import { MissingCredential } from "../src/credentials"
import { Sessions } from "../src/state"

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }))

async function temporary() {
  const parent = process.env.OPENCODE_TEST_TMP ?? join(tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, "vault-state-"))
}

test.skipIf(process.platform !== "linux")("Linux initialization waits for a runtime lock after reservation, then creates the ledger", async () => {
  const base = await temporary()
  const directory = join(base, "sessions")
  const lock = join(directory, ".lock")
  const values = new Map<string, string>()
  const credentials = {
    async get(account: string) {
      if (!values.has(account)) throw new MissingCredential()
      return values.get(account)!
    },
    async set(account: string, value: string) {
      values.set(account, value)
      if (account === "snapshot-key") await mkdir(lock, { mode: 0o700 })
    },
  }
  let release!: () => void
  let waiting!: () => void
  const blocked = new Promise<void>((resolve) => { waiting = resolve })
  vi.mocked(sleep).mockImplementationOnce(async () => {
    waiting()
    await new Promise<void>((resolve) => { release = resolve })
  })
  const initial = initialize(credentials, directory)
  try {
    await Promise.race([blocked, initial])
    expect(sleep).toHaveBeenCalledWith(20)
    await expect(lstat(join(directory, "ledger"))).rejects.toMatchObject({ code: "ENOENT" })
    await rmdir(lock)
    release()
    await initial
    expect(await new Sessions(directory, () => encryptionKey(credentials)).read("synthetic")).toEqual({ version: 0, active: {}, history: [] })
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    release?.()
    await Promise.allSettled([initial])
    await rm(base, { recursive: true, force: true })
  }
})

test("initialization preserves unexpected state and refuses to replace a ledger", async () => {
  const base = await temporary()
  const directory = join(base, "sessions")
  const sessions = new Sessions(directory, Buffer.alloc(32, 3))
  const other = join(directory, "unexpected")
  const ledger = join(directory, "ledger")
  try {
    await mkdir(directory, { mode: 0o700 })
    await writeFile(other, "synthetic-unknown-state")
    await expect(sessions.initialize()).rejects.toMatchObject({ diagnostic: "state" })
    await expect(lstat(ledger)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(other, "utf8")).toBe("synthetic-unknown-state")
    await rm(other)
    await sessions.initialize()
    const first = await readFile(ledger)
    await expect(sessions.initialize()).rejects.toMatchObject({ diagnostic: "state" })
    expect((await readFile(ledger)).equals(first)).toBe(true)
  } finally { await rm(base, { recursive: true, force: true }) }
})
