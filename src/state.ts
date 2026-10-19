import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, rm, rmdir, stat, readdir, open } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { validateEnvironment } from "./environment"
import { LocalSetupError } from "./diagnostics"

export type Snapshot = { version: number; active: Record<string, Record<string, string>>; history: string[] }
type Ledger = { sessions: Record<string, number>; history: string[] }
const empty = (): Snapshot => ({ version: 0, active: {}, history: [] })
const failure = () => new LocalSetupError("state")

export class Sessions {
  constructor(readonly directory: string, readonly key: Buffer | (() => Promise<Buffer>)) {}

  private async resolveKey() {
    const key = typeof this.key === "function" ? await this.key() : this.key
    if (key.length !== 32) throw failure()
    return key
  }

  private id(session: string) {
    if (!session || session.length > 256) throw failure()
    return createHash("sha256").update(session).digest("hex")
  }

  private async encrypted(name: string, value: unknown, exclusive = false) {
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", await this.resolveKey(), nonce)
    cipher.setAAD(Buffer.from(name))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    const destination = join(this.directory, name)
    const temporary = `${destination}.${randomBytes(8).toString("hex")}`
    try {
      const file = await open(exclusive ? destination : temporary, "wx", 0o600)
      try { await file.writeFile(Buffer.concat([nonce, cipher.getAuthTag(), encrypted])); await file.sync() }
      finally { await file.close() }
      if (!exclusive) await rename(temporary, destination)
      const directory = await open(this.directory, "r")
      try { await directory.sync() } finally { await directory.close() }
    } finally { await rm(temporary, { force: true }) }
  }

  private async decoded(name: string) {
    const bytes = await readFile(join(this.directory, name))
    const decipher = createDecipheriv("aes-256-gcm", await this.resolveKey(), bytes.subarray(0, 12))
    decipher.setAAD(Buffer.from(name))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString())
  }

  // Only the explicit first-use helper creates the ledger; runtime reads never recreate it.
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if ((await readdir(this.directory)).length) throw failure()
    await this.encrypted("ledger", { sessions: {}, history: [] }, true)
  }

  private async locked<A>(work: () => Promise<A>): Promise<A> {
    const lock = join(this.directory, ".lock")
    let acquired = false
    try {
      const info = await stat(this.directory)
      if (info.uid !== process.getuid!() || (info.mode & 0o077)) throw failure()
      for (let i = 0; i < 100; i++) {
        try { await mkdir(lock, { mode: 0o700 }); acquired = true; break }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw failure()
          await sleep(20)
        }
      }
      if (!acquired) throw failure()
      return await work()
    } catch (error) { throw error instanceof LocalSetupError ? error : failure() }
    finally { if (acquired) await rmdir(lock) }
  }

  private async current(session: string): Promise<{ ledger: Ledger; snapshot: Snapshot }> {
    const id = this.id(session)
    const ledger = await this.decoded("ledger") as Ledger
    if (!ledger?.sessions || Array.isArray(ledger.sessions) || typeof ledger.sessions !== "object" || !Array.isArray(ledger.history) || !ledger.history.every((value) => typeof value === "string")) throw failure()
    let snapshot: Snapshot
    if (Object.hasOwn(ledger.sessions, id)) {
      snapshot = await this.decoded(id)
      if (!Number.isSafeInteger(ledger.sessions[id]) || snapshot?.version !== ledger.sessions[id] || !snapshot.active || typeof snapshot.active !== "object" || Array.isArray(snapshot.active)) throw failure()
      for (const env of Object.values(snapshot.active)) validateEnvironment(env)
    } else {
      try { await stat(join(this.directory, id)); throw failure() }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      snapshot = empty()
    }
    return { ledger, snapshot: { ...snapshot, history: ledger.history } }
  }

  async read(session: string) { return this.locked(async () => (await this.current(session)).snapshot) }

  async enable(session: string, bundle: string, values: Record<string, string>, expected?: number) {
    validateEnvironment(values)
    const version = expected ?? (await this.read(session)).version
    await this.locked(async () => {
      const { ledger, snapshot } = await this.current(session)
      if (snapshot.version !== version) throw new LocalSetupError("stale")
      if (Object.hasOwn(snapshot.active, bundle)) return
      const occupied = new Set(Object.values(snapshot.active).flatMap(Object.keys))
      if (Object.keys(values).some((key) => occupied.has(key))) throw new LocalSetupError("conflict")
      Object.defineProperty(snapshot.active, bundle, { value: { ...values }, enumerable: true, configurable: true, writable: true })
      ledger.history = [...new Set([...ledger.history, ...Object.values(values).filter((value) => [...value].length > 5)])]
      snapshot.version++
      ledger.sessions[this.id(session)] = snapshot.version
      await this.encrypted("ledger", ledger)
      await this.encrypted(this.id(session), { version: snapshot.version, active: snapshot.active })
    })
  }

  async disable(session: string, bundle: string, expected?: number) {
    const version = expected ?? (await this.read(session)).version
    await this.locked(async () => {
      const { ledger, snapshot } = await this.current(session)
      if (snapshot.version !== version) throw new LocalSetupError("stale")
      delete snapshot.active[bundle]
      snapshot.version++
      ledger.sessions[this.id(session)] = snapshot.version
      await this.encrypted("ledger", ledger)
      await this.encrypted(this.id(session), { version: snapshot.version, active: snapshot.active })
    })
  }

  async overlay(session: string) {
    return Object.freeze(Object.assign(Object.create(null), ...Object.values((await this.read(session)).active))) as Readonly<Record<string, string>>
  }
}
