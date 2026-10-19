import { afterEach, expect, test, vi } from "vitest"
import { build } from "esbuild"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes, createHash } from "node:crypto"
import { Effect, Scope, Fiber, JsonSchema, Schema, SchemaRepresentation } from "effect"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { install, shellOverlay } from "../src/index"
import { Bao, type Config, type Credentials, LoginBusy, MissingCredential, initialize, week, encryptionKey, parseConfig, readiness, config } from "../src/bao"
import { LocalSetupError, diagnostics } from "../src/diagnostics"
import { Sessions } from "../src/state"
import { Scrubber, marker } from "../src/redact"
import { runProcess } from "../src/process"
import tui from "../src/tui"
import { BaoRpc } from "../src/rpc"

const directories: string[] = []
const setSystemTime = (time: number) => vi.setSystemTime(time)
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function temporary() {
  const directory = await mkdtemp(fileURLToPath(new URL("../.test-tmp-", import.meta.url)))
  directories.push(directory)
  return directory
}
async function sessions() { const state = new Sessions(join(await temporary(), "sessions"), randomBytes(32)); await state.initialize(); return state }
const settings: Config = { address: "https://bao.invalid", mount: "kv", prefix: "env", oidc: "oidc", bao: "/not-used", catalogRole: "opencode-env-catalog", readRole: "opencode-env-read", parentTokenPolicies: ["opencode-parent"], parentIdentityPolicies: [] }
const parentIdentity = (now = Date.now()) => ({ creation_time: Math.floor(now / 1000), creation_ttl: week, explicit_max_ttl: week, ttl: week - 1, expire_time: new Date(Math.floor(now / 1000) * 1000 + week * 1000).toISOString(), meta: { role: "opencode" }, policies: ["opencode-parent"], identity_policies: [], type: "service" })
const loginAuth = { client_token: "synthetic-parent", lease_duration: week, token_type: "service", token_policies: ["opencode-parent"], identity_policies: [], policies: ["opencode-parent"] }
const context = (sessionID: string) => ({ sessionID, agent: "build", messageID: "message", id: "call", progress: () => Effect.void }) as unknown as Tool.Context
const invocation = (): ShellCreateBefore => ({ command: "unchanged", cwd: "/", shell: "/bin/sh", timeout: 12, env: { PATH: "/usr/bin:/bin", BASE: "same" } })

test("stale CAS during a deferred bundle read survives locked state and native RPC without a mutation", async () => {
  const state = await sessions()
  const bao = new Bao(settings)
  let entered!: () => void
  const fetching = new Promise<void>((resolve) => { entered = resolve })
  let release!: (value: Record<string, string>) => void
  vi.spyOn(bao, "bundle").mockImplementation(async () => { entered(); return new Promise((resolve) => { release = resolve }) })
  const f = adapter(state, () => Effect.succeed({ content: "native" }), bao)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* f.install
    const rpcContext = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
    const call = (version: number) => f.methods().enable({ sessionID: "a", bundle: "alpha", version }, rpcContext) as Effect.Effect<unknown, unknown>
    const pending = Effect.runPromise(Effect.match(call(0), { onFailure: (error) => error, onSuccess: () => "unexpected success" }))
    yield* Effect.promise(() => fetching)
    yield* Effect.promise(() => state.disable("a", "other", 0))
    release({ PRIVATE_KEY: "synthetic-private-stale-value" })
    const expected = { type: "unavailable", message: diagnostics.stale, data: { diagnostic: "stale" } }
    expect(yield* Effect.promise(() => pending)).toEqual(expected)
    // A stale version observed before fetching has the same safe reason.
    expect(yield* call(0).pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => "unexpected success" }))).toEqual(expected)
    expect(bao.bundle).toHaveBeenCalledTimes(1)
    expect(yield* Effect.promise(() => state.read("a"))).toEqual({ version: 1, active: {}, history: [] })
  })))
})

test("native RPC never forwards arbitrary exceptions or mutated typed-error messages", async () => {
  const state = await sessions()
  const bao = new Bao(settings)
  const privateText = "synthetic-private-token-body-stderr-envkey"
  const typed = new LocalSetupError("http", "bundle", 403)
  typed.message = privateText
  const f = adapter(state, () => Effect.succeed({ content: "native" }), bao)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* f.install
    const rpcContext = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
    const read = vi.spyOn(bao, "bundle")
    for (const error of [new Error(privateText), typed]) {
      read.mockRejectedValueOnce(error)
      const result = yield* (f.methods().enable({ sessionID: "a", bundle: "alpha", version: 0 }, rpcContext) as Effect.Effect<unknown, unknown>).pipe(Effect.match({ onFailure: (failure) => failure, onSuccess: () => "unexpected success" }))
      expect(JSON.stringify(result)).not.toContain(privateText)
      if (error === typed) expect(result).toEqual({ type: "unavailable", message: new LocalSetupError("http", "bundle", 403).message, data: { diagnostic: "http", stage: "bundle", httpStatus: 403 } })
      else expect(result).toEqual({ type: "unavailable", message: "Bao operation unavailable; use /bao-login or check trusted configuration", data: {} })
    }
    expect((yield* Effect.promise(() => state.read("a"))).version).toBe(0)
  })))
})

test("actual locked key conflict survives native RPC to the fourth marked bundle toast after three confirmations", async () => {
  const state = await sessions()
  const bao = new Bao(settings)
  const names = ["alpha", "bravo", "charlie", "delta", "echo"]
  vi.spyOn(bao, "catalog").mockResolvedValue(names)
  const read = vi.spyOn(bao, "bundle").mockImplementation(async (name) => ({ [name === "delta" ? "alpha" : name]: `synthetic-private-${name}-value` }))
  const f = adapter(state, () => Effect.succeed({ content: "native" }), bao)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* f.install
    const rpcContext = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
    const failures: unknown[] = []
    const call = async (method: string, input: unknown) => {
      const result = await Effect.runPromise(Effect.match(f.methods()[method](input, rpcContext) as Effect.Effect<unknown, unknown>, {
        onSuccess: (value) => ({ value }), onFailure: (error) => ({ error }),
      }))
      if ("error" in result) { failures.push(result.error); throw result.error }
      return result.value
    }
    const mutations = vi.fn((input) => call("enable", input))
    const toast = vi.fn()
    let commands: any[] = []
    let options: any
    const cleanup = yield* Effect.promise(() => Promise.resolve(tui.setup({
      client: { rpc: () => ({ status: (input: unknown) => call("status", input), enable: mutations }) }, location: { directory: "/project" },
      storage: { memory: (_key: string, { initial }: any) => [initial, (mutate: Function) => mutate(initial)] },
      keymap: { layer: (factory: Function) => { commands = factory().commands } },
      ui: { toast: { show: toast }, router: { current: () => ({ type: "session", sessionID: "a" }) }, dialog: { select: async (value: any) => {
        options = value
        for (const name of names) options.actions[0].onTrigger(name)
        return "echo"
      } } },
    } as any)))
    yield* Effect.promise(() => commands.find((command) => command.id === "bao.bundles").run())
    expect(read.mock.calls.map(([name]) => name)).toEqual(names.slice(0, 4))
    expect(mutations.mock.calls.map(([input]) => input.version)).toEqual([0, 1, 2, 3])
    expect(failures).toEqual([{ type: "unavailable", message: diagnostics.conflict, data: { diagnostic: "conflict" } }])
    expect(toast.mock.lastCall![0].message).toContain("3 of 5 changes confirmed; enable delta failed")
    expect(toast.mock.lastCall![0].message).toContain("Remaining 1 changes NOT attempted")
    expect(toast.mock.lastCall![0].message).toContain("may already have applied")
    expect(toast.mock.lastCall![0].message).toContain(diagnostics.conflict)
    expect(JSON.stringify([failures, toast.mock.calls])).not.toContain("synthetic-private")
    const snapshot = yield* Effect.promise(() => state.read("a"))
    expect(snapshot.version).toBe(3)
    expect(Object.keys(snapshot.active)).toEqual(names.slice(0, 3))
    yield* Effect.promise(() => Promise.resolve(cleanup?.()))
  })))
})

function adapter(state: Sessions, native: Tool.Info["execute"], bao: Bao | null = new Bao(settings), ready?: () => Promise<boolean>, configurationError?: LocalSetupError, loadBao?: () => Promise<Bao>) {
  if (bao && !vi.isMockFunction(bao.catalog)) vi.spyOn(bao, "catalog").mockResolvedValue(["alpha", "beta"])
  const hooks: Record<string, (event: any) => Effect.Effect<void>> = {}
  const tool = { name: "shell", description: "native", input: {}, execute: native }
  let methods: any
  let additions = 0
  const registration = Effect.succeed({ dispose: Effect.void })
  const ctx = {
    location: { directory: "/project" },
    tool: { transform: (edit: Function) => Effect.sync(() => {
      edit({ update: (id: string, update: Function) => { expect(id).toBe("shell"); update(tool) }, add: () => additions++ })
      return { dispose: Effect.void }
    }) },
    shell: { hook: (name: string, callback: any) => { hooks[`shell.${name}`] = callback; return registration } },
    session: {
      hook: (name: string, callback: any) => { hooks[name] = callback; return registration },
      get: () => Effect.succeed({ location: { directory: "/project" } }),
    },
    rpc: { register: (_definition: unknown, handlers: any) => { methods = handlers; return registration } },
  } as unknown as PluginContext
  return { hooks, tool, install: install(ctx, state, bao ?? undefined, ready, configurationError, loadBao), methods: () => methods, additions: () => additions }
}

test("native-shaped adapter: real Effect runtime keeps concurrent model sessions isolated", async () => {
  const state = await sessions()
  await state.enable("a", "alpha", { SYNTHETIC: "alpha-secret" })
  await state.enable("b", "beta", { SYNTHETIC: "beta-secret" })
  const ambient = process.env.SYNTHETIC
  const events: ShellCreateBefore[] = []
  const native: Tool.Info["execute"] = (_input, _context) => Effect.gen(function* () {
    const event = invocation()
    yield* Effect.sleep(Math.floor(Math.random() * 8))
    yield* fixture.hooks["shell.create.before"]!(event)
    events.push(event)
    const output = yield* Effect.promise(async () => {
      const child = await runProcess("/bin/sh", ["-c", 'printf "%s" "$SYNTHETIC"'], { env: event.env })
      expect(child.exitCode).toBe(0)
      return child.stdout
    })
    return { content: output }
  })
  const fixture = adapter(state, native)
  const output = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    return yield* Effect.all(Array.from({ length: 60 }, (_, i) => fixture.tool.execute({}, context(i % 2 ? "a" : "b"))), { concurrency: "unbounded" })
  })))
  expect(output.map((result) => result.content)).toEqual(Array.from({ length: 60 }, (_, i) => i % 2 ? "alpha-secret" : "beta-secret"))
  expect(new Set(events.map((event) => event.env)).size).toBe(60)
  expect(events.every((event) => event.command === "unchanged" && event.timeout === 12 && event.env.BASE === "same")).toBe(true)
  expect(fixture.additions()).toBe(0)
  expect(fixture.tool.description).toBe("native")
  expect(process.env.SYNTHETIC).toBe(ambient)
  const direct = invocation()
  await Effect.runPromise(fixture.hooks["shell.create.before"]!(direct))
  expect(direct.env.SYNTHETIC).toBeUndefined()
})

test("pristine no-config hooks are unchanged, create nothing, and observe explicit synthetic login across instances", async () => {
  const parent = await temporary()
  const directory = join(parent, "sessions")
  const accounts = new Map<string, string>()
  const credentials: Credentials = {
    get: async (account) => { if (!accounts.has(account)) throw new MissingCredential(); return accounts.get(account)! },
    set: async (account, value) => { accounts.set(account, value) },
  }
  const state = new Sessions(directory, () => encryptionKey(credentials))
  const native = vi.fn(() => Effect.succeed({ content: "native" }))
  const noConfig = adapter(state, native, null, readiness(credentials, directory), new LocalSetupError("missing"))
  const bao = new Bao({ ...settings, bao: process.execPath }, credentials, (async () => Response.json({ data: parentIdentity() })) as typeof fetch, async () => ({ stdout: JSON.stringify({ auth: loginAuth }), stderr: "private-url", exitCode: 0 }))
  const login = bao.login.bind(bao)
  bao.login = (options) => login({ ...options, directory })
  const configured = adapter(state, native, bao, readiness(credentials, directory))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* noConfig.install
    yield* configured.install
    expect((yield* noConfig.tool.execute({}, context("a"))).content).toBe("native")
    for (const name of Object.keys(noConfig.hooks)) {
      const event = { ...invocation(), sessionID: "a", frame: "opaque", request: new Request("https://model.invalid", { method: "POST", body: "opaque" }), system: ["unchanged"], messages: [{ type: "unsupported" }], options: {}, tools: {}, headers: { custom: "unchanged" }, url: "wss://model.invalid", baseURL: "https://model.invalid" }
      const original = { ...event }
      yield* noConfig.hooks[name]!(event)
      expect(event).toEqual(original)
      expect(event.request).toBe(original.request)
      expect(event.env).toBe(original.env)
    }
    expect(yield* Effect.promise(() => readdir(parent))).toEqual([])
    expect(accounts.size).toBe(0)
    expect(noConfig.additions()).toBe(0)
    const error = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
    const missing = yield* Effect.exit(noConfig.methods().login({}, error) as Effect.Effect<unknown, unknown>)
    expect(JSON.stringify(missing)).toContain("examples/config.json")
    yield* configured.tool.execute({}, context("a"))
    yield* configured.methods().login({}, error) as Effect.Effect<unknown, unknown>
    // No active bundle/auth is needed for normal work after initialization.
    accounts.delete("auth")
    yield* configured.tool.execute({}, context("a"))
    yield* Effect.promise(() => state.enable("a", "alpha", { SECRET: "synthetic-first-use-secret" }))
    for (const fixture of [configured, noConfig]) {
      const event = { sessionID: "a", frame: '{"text":"synthetic-first-use-secret"}' }
      yield* fixture.hooks["experimental.ws.send"]!(event)
      expect(event.frame).toContain(marker)
    }
    accounts.delete("snapshot-key")
    for (const fixture of [configured, noConfig]) {
      expect((yield* Effect.exit(fixture.tool.execute({}, context("a"))))._tag).toBe("Failure")
      expect((yield* Effect.exit(fixture.hooks["experimental.ws.send"]!({ sessionID: "a", frame: "{}" })))._tag).toBe("Failure")
    }
  })))
})

test("partial anchors, corrupt state, locked credentials and observed-state deletion never downgrade to pristine", async () => {
  for (const kind of ["marker", "key", "directory", "corrupt", "missing-directory", "locked"] as const) {
    const directory = join(await temporary(), "sessions")
    const accounts = new Map<string, string>()
    const credentials: Credentials = { get: async (account) => { if (kind === "locked") throw new Error("private-backend-output"); if (!accounts.has(account)) throw new MissingCredential(); return accounts.get(account)! }, set: async (account, value) => { accounts.set(account, value) } }
    if (kind === "marker") accounts.set("initialized", "v1")
    if (kind === "key") accounts.set("snapshot-key", randomBytes(32).toString("base64"))
    if (kind === "directory") await mkdir(directory, { mode: 0o700 })
    if (kind === "corrupt" || kind === "missing-directory") {
      await initialize(credentials, directory)
      if (kind === "corrupt") await writeFile(join(directory, "ledger"), "corrupt")
      else await rm(directory, { recursive: true })
    }
    const ready = readiness(credentials, directory)
    const state = new Sessions(directory, () => encryptionKey(credentials))
    const fixture = adapter(state, () => Effect.succeed({}), null, ready)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* fixture.install
      expect((yield* Effect.exit(fixture.tool.execute({}, context("a"))))._tag).toBe("Failure")
      for (const name of Object.keys(fixture.hooks).filter((name) => !name.startsWith("shell."))) {
        expect((yield* Effect.exit(fixture.hooks[name]!({ sessionID: "a" })))._tag).toBe("Failure")
      }
      accounts.clear()
      if (kind !== "locked") {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
        expect((yield* Effect.exit(fixture.tool.execute({}, context("a"))))._tag).toBe("Failure")
      }
    })))
  }
})

test("a request after independent initialization never reuses an older pending absent-credential probe", async () => {
  const directory = join(await temporary(), "sessions")
  const accounts = new Map<string, string>()
  const credentials: Credentials = {
    get: async (account) => { if (!accounts.has(account)) throw new MissingCredential(); return accounts.get(account)! },
    set: async (account, value) => { accounts.set(account, value) },
  }
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  let absentReads = 0
  const delayed: Credentials = {
    ...credentials,
    get: async (account) => {
      if (accounts.has(account)) return credentials.get(account)
      if (++absentReads === 2) enter()
      await held
      throw new MissingCredential()
    },
  }
  const ready = readiness(delayed, directory)
  const oldRequest = ready()
  await entered
  try {
    await initialize(credentials, directory)
    const writer = new Sessions(directory, () => encryptionKey(credentials))
    await writer.enable("origin", "alpha", { SECRET: "synthetic-race-secret" })
    const fixture = adapter(new Sessions(directory, () => encryptionKey(delayed)), () => Effect.succeed({}), null, ready)
    await Effect.runPromise(Effect.scoped(fixture.install))
    const afterCommit = ready()
    const event = { sessionID: "copy", frame: '{"text":"synthetic-race-secret"}' }
    const outbound = Effect.runPromise(fixture.hooks["experimental.ws.send"]!(event))
    release()
    const [, observed] = await Promise.all([oldRequest, afterCommit, outbound])
    expect(observed).toBe(true)
    expect(event.frame).toContain(marker)
    expect(event.frame).not.toContain("synthetic-race-secret")
  } finally {
    release()
    await oldRequest
  }
})

test("configuration diagnostics are typed and sanitize malformed schema, policy and file contents", async () => {
  const directory = join(await temporary(), "config")
  await expect(config(directory)).rejects.toEqual(new LocalSetupError("missing"))
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(directory, "config.json"), "private-token-invalid-json", { mode: 0o600 })
  await expect(config(directory)).rejects.toEqual(new LocalSetupError("json"))
  await writeFile(join(directory, "config.json"), JSON.stringify({ ...settings, address: "private-token" }))
  await expect(config(directory)).rejects.toEqual(new LocalSetupError("schema"))
  await writeFile(join(directory, "config.json"), JSON.stringify({ ...settings, parentTokenPolicies: ["root-private-token"] }))
  expect((await config(directory)).parentTokenPolicies).toEqual(["root-private-token"])
  await writeFile(join(directory, "config.json"), JSON.stringify(settings), { mode: 0o600 })
  expect(await config(directory)).toEqual(settings)
  await chmod(join(directory, "config.json"), 0o666)
  await expect(config(directory)).rejects.toEqual(new LocalSetupError("permissions"))
  expect(() => parseConfig({ ...settings, bao: "relative-private-value" })).toThrow(diagnostics.executable)
  expect(Object.values(diagnostics).join(" ")).not.toContain("private-token")
})

test("RPC forwards only allowlisted setup diagnostics for login and status, never raw configuration errors", async () => {
  const state = await sessions()
  for (const diagnostic of Object.keys(diagnostics) as (keyof typeof diagnostics)[]) {
    const fixture = adapter(state, () => Effect.succeed({}), null, async () => true, new LocalSetupError(diagnostic))
    const failures: unknown[] = []
    const rpcContext = { error: (type: string, message: string, data: unknown) => { const error = { type, message, data }; failures.push(error); return error } }
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* fixture.install
      yield* Effect.exit(fixture.methods().login({}, rpcContext) as Effect.Effect<unknown, unknown>)
      yield* Effect.exit(fixture.methods().status({ sessionID: "a" }, rpcContext) as Effect.Effect<unknown, unknown>)
    })))
    expect(failures).toEqual(Array.from({ length: 2 }, () => ({ type: "unavailable", message: diagnostics[diagnostic], data: { diagnostic } })))
  }
})

test("same installed RPC handlers reload missing, invalid and repaired trusted configuration without implicit login or storage initialization", async () => {
  const directory = join(await temporary(), "sessions")
  const key = vi.fn(async () => { throw new Error("must not initialize or read a key") })
  const state = new Sessions(directory, key)
  const read = vi.spyOn(state, "read")
  let ownerConfig: unknown
  const bao = new Bao(settings)
  bao.catalog = vi.fn(async () => [])
  const login = vi.fn(async () => {})
  bao.login = login
  const load = vi.fn(async () => {
    if (ownerConfig === undefined) throw new LocalSetupError("missing")
    parseConfig(ownerConfig)
    return bao
  })
  const fixture = adapter(state, () => Effect.succeed({}), null, async () => false, new LocalSetupError("missing"), load)
  const failures: unknown[] = []
  const rpcContext = { error: (type: string, message: string, data: unknown) => { const error = { type, message, data }; failures.push(error); return error } }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    yield* fixture.tool.execute({}, context("a"))
    yield* fixture.hooks["experimental.ws.send"]!({ sessionID: "a", frame: "opaque" })
    expect(load).not.toHaveBeenCalled()
    const loginHandler = fixture.methods().login
    const statusHandler = fixture.methods().status
    const callLogin = () => loginHandler({}, rpcContext) as Effect.Effect<unknown, unknown>
    const callStatus = () => statusHandler({ sessionID: "a" }, rpcContext) as Effect.Effect<unknown, unknown>
    expect((yield* Effect.exit(callLogin()))._tag).toBe("Failure")
    expect((yield* Effect.exit(callStatus()))._tag).toBe("Failure")
    ownerConfig = { ...settings, address: "synthetic-private-invalid-address" }
    expect((yield* Effect.exit(callLogin()))._tag).toBe("Failure")
    expect((yield* Effect.exit(callStatus()))._tag).toBe("Failure")
    ownerConfig = { ...settings }
    expect(yield* callStatus()).toEqual({ sessionID: "a", version: 0, bundles: [], protectedValues: 0 })
    expect(login).not.toHaveBeenCalled()
    expect(yield* callLogin()).toEqual({ authenticated: true })
    expect(login).toHaveBeenCalledTimes(1)
    ownerConfig = { ...settings, parentTokenPolicies: ["root-private-policy"] }
    expect(yield* callLogin()).toEqual({ authenticated: true })
    ownerConfig = { ...settings }
    expect(yield* callLogin()).toEqual({ authenticated: true })
    expect(login).toHaveBeenCalledTimes(3)
    expect(fixture.methods().login).toBe(loginHandler)
    expect(fixture.methods().status).toBe(statusHandler)
  })))
  expect(failures).toEqual(["missing", "missing", "schema", "schema"].map((diagnostic) => ({ type: "unavailable", message: diagnostics[diagnostic as keyof typeof diagnostics], data: { diagnostic } })))
  expect(read).not.toHaveBeenCalled()
  expect(key).not.toHaveBeenCalled()
  expect(await readdir(join(directory, ".."))).toEqual([])
  expect(fixture.additions()).toBe(0)
})

test("enable reloads configuration once per action while existing history protection stays independent", async () => {
  const state = await sessions()
  let unavailable = true
  const bao = new Bao(settings)
  const bundle = vi.fn(async () => ({ SECRET: "synthetic-reloaded-secret" }))
  bao.catalog = vi.fn(async () => ["alpha", "beta"])
  const login = vi.fn(async () => {})
  bao.bundle = bundle
  bao.login = login
  const load = vi.fn(async () => { if (unavailable) throw new LocalSetupError("missing"); return bao })
  const fixture = adapter(state, () => Effect.succeed({}), null, async () => true, undefined, load)
  const rpcContext = { error: () => new Error("unavailable") }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    const enable = () => fixture.methods().enable({ sessionID: "a", bundle: "alpha", version: 0 }, rpcContext) as Effect.Effect<unknown, unknown>
    expect((yield* Effect.exit(enable()))._tag).toBe("Failure")
    unavailable = false
    expect(yield* enable()).toEqual({ sessionID: "a", version: 1, bundles: [{ name: "alpha", enabled: true, keys: 1 }, { name: "beta", enabled: false, keys: 0 }], protectedValues: 1 })
    expect(load).toHaveBeenCalledTimes(2)
    expect(bundle).toHaveBeenCalledTimes(1)
    unavailable = true
    const event = { sessionID: "a", frame: '{"text":"synthetic-reloaded-secret"}' }
    yield* fixture.hooks["experimental.ws.send"]!(event)
    expect(event.frame).toContain(marker)
    expect(load).toHaveBeenCalledTimes(2)
    expect((yield* Effect.exit(fixture.methods().status({ sessionID: "a" }, rpcContext) as Effect.Effect<unknown, unknown>))._tag).toBe("Failure")
  })))
  expect(login).not.toHaveBeenCalled()
  expect((await state.overlay("a")).SECRET).toBe("synthetic-reloaded-secret")
})

test("status merges deleted loaded bundles; failed catalog allows disable without authentication or a value fetch", async () => {
  const state = await sessions()
  await state.enable("a", "removed.bundle", { SECRET: "synthetic-retained-secret" })
  const bao = new Bao(settings)
  const catalog = vi.fn(async () => ["new.bundle"])
  const bundle = vi.fn()
  const parent = vi.fn()
  bao.catalog = catalog
  bao.bundle = bundle
  bao.parent = parent
  const fixture = adapter(state, () => Effect.succeed({}), bao)
  const rpcContext = { error: () => new Error("unavailable") }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    const status = () => fixture.methods().status({ sessionID: "a" }, rpcContext) as Effect.Effect<import("../src/rpc").Status>
    expect((yield* status()).bundles).toEqual([{ name: "new.bundle", enabled: false, keys: 0 }, { name: "removed.bundle", enabled: true, keys: 1 }])
    catalog.mockRejectedValue(new Error("synthetic-private-auth-error"))
    const failedCatalog = yield* status()
    expect(failedCatalog.catalogUnavailable).toBe(true)
    expect(failedCatalog.bundles).toEqual([{ name: "removed.bundle", enabled: true, keys: 1 }])
    expect(JSON.stringify(failedCatalog)).not.toContain("synthetic-private")
    const disabled = yield* fixture.methods().disable({ sessionID: "a", bundle: "removed.bundle", version: failedCatalog.version }, rpcContext) as Effect.Effect<import("../src/rpc").Status>
    expect(disabled.bundles).toEqual([])
    expect(disabled.protectedValues).toBe(1)
    expect(catalog).toHaveBeenCalledTimes(2)
    expect((yield* Effect.exit(status()))._tag).toBe("Failure")
  })))
  expect(bundle).not.toHaveBeenCalled()
  expect(parent).not.toHaveBeenCalled()
  expect(await state.overlay("a")).toEqual({})
})

test("snapshot is immutable per invocation; native cancellation finalizer and fork inheritance survive wrapper", async () => {
  const state = await sessions()
  await state.enable("a", "alpha", { SYNTHETIC: "alpha-secret" })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  let cancelled = false
  const fixture = adapter(state, () => Effect.gen(function* () {
    started()
    yield* Effect.promise(() => gate)
    const event = invocation()
    yield* shellOverlay(event)
    return { content: event.env.SYNTHETIC }
  }).pipe(Effect.onInterrupt(() => Effect.sync(() => { cancelled = true }))))
  const task = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    return yield* fixture.tool.execute({}, context("a"))
  })))
  await entered
  await state.disable("a", "alpha")
  release()
  expect((await task).content).toBe("alpha-secret")
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const scope = yield* Scope.Scope
    let child!: Fiber.Fiber<string | undefined>
    const background = adapter(state, () => Effect.gen(function* () {
      child = yield* Effect.forkIn(Effect.gen(function* () {
        yield* Effect.sleep(1)
        const event = invocation()
        yield* shellOverlay(event)
        return event.env.SYNTHETIC
      }), scope)
      return { content: "background" }
    }))
    yield* background.install
    yield* Effect.promise(() => state.enable("a", "alpha", { SYNTHETIC: "second-secret" }))
    expect((yield* background.tool.execute({}, context("a"))).content).toBe("background")
    expect(yield* Fiber.join(child)).toBe("second-secret")
    let nativeStarted!: () => void
    const nativeEntered = new Promise<void>((resolve) => { nativeStarted = resolve })
    const cancellable = adapter(state, () => Effect.gen(function* () {
      nativeStarted()
      return yield* Effect.never
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => { cancelled = true }))))
    yield* cancellable.install
    const running = yield* Effect.forkChild(cancellable.tool.execute({}, context("a")))
    yield* Effect.promise(() => nativeEntered)
    yield* Fiber.interrupt(running)
  })))
  expect(cancelled).toBe(true)
})

test("threshold counts Unicode points; common raw, JSON, URL and base64 encodings are fully removed", () => {
  const short = "😀😀😀😀😀"
  const long = "😀😀😀😀😀😀"
  const secret = 'a+"/é secret'
  const scrub = new Scrubber([short, long, secret, "abcde", "abcdef"])
  expect(scrub.text(short)).toBe(short)
  expect(scrub.text("abcde")).toBe("abcde")
  expect(scrub.text(long)).toBe(marker)
  const unicode = secret.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")
  for (const value of [secret, JSON.stringify(secret).slice(1, -1), unicode, unicode.replace("00e9", "00E9"), encodeURIComponent(secret), encodeURIComponent(secret).replace("%C3", "%c3"), encodeURIComponent(secret).replaceAll("%20", "+"), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64").replace(/=+$/, ""), Buffer.from(secret).toString("base64url"), Buffer.from(secret).toString("base64url") + "="]) {
    expect(scrub.text(`before ${value} after`)).not.toContain(secret)
    expect(scrub.text(value)).toContain(marker)
  }
  expect(scrub.frame(JSON.stringify({ content: secret }))).toBe(JSON.stringify({ content: marker }))
  expect(new Scrubber(["REDACTED"]).text("REDACTED")).not.toContain("REDACTED")
  expect(new Scrubber(["abcdef", "abcdefghijk"]).text("abcabcdefghijkdef")).not.toContain("abcdef")
})

test("ciphertext survives restart, disable retains protection, conflicts and tampering reject", async () => {
  const state = await sessions()
  await state.enable("a", "alpha", { SECRET: "synthetic-secret", SHORT: "abcde" })
  const files = await readdir(state.directory)
  const ciphertext = await readFile(join(state.directory, files[0]!))
  expect(ciphertext.includes(Buffer.from("synthetic-secret"))).toBe(false)
  const restart = new Sessions(state.directory, state.key)
  expect((await restart.overlay("a")).SECRET).toBe("synthetic-secret")
  await expect(restart.enable("a", "beta", { SECRET: "other-secret" })).rejects.toThrow(diagnostics.conflict)
  await restart.disable("a", "alpha")
  expect(await restart.overlay("a")).toEqual({})
  expect((await restart.read("a")).history).toEqual(["synthetic-secret"])
  expect(await restart.overlay("new-session")).toEqual({})
  await expect(new Sessions(state.directory, randomBytes(32)).read("a")).rejects.toThrow("unavailable")
  await restart.enable("b", "alpha", { A: "alpha-secret" })
  await new Sessions(state.directory, state.key).enable("b", "beta", { B: "beta-secret" })
  expect(await restart.overlay("b")).toEqual({ A: "alpha-secret", B: "beta-secret" })
})

test("all request kinds, HTTP and WebSocket scrub readable text; RPC is metadata-only", async () => {
  const state = await sessions()
  await state.enable("a", "alpha", { SECRET: "synthetic-secret" })
  await state.disable("a", "alpha")
  const fixture = adapter(state, () => Effect.succeed({}))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    for (const name of ["context", "title", "compaction", "generate"]) {
      const event = { sessionID: "a", system: [{ type: "text", text: "synthetic-secret" }], messages: [{ content: "synthetic-secret" }], options: { custom: "synthetic-secret" }, tools: { shell: { description: "synthetic-secret" } } }
      yield* fixture.hooks[name]!(event)
      expect(JSON.stringify(event)).not.toContain("synthetic-secret")
    }
    for (const kind of ["primary", "title", "compaction", "generate"]) {
      const event = { sessionID: "a", kind, request: new Request("https://model.invalid", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "synthetic-secret" }) }) }
      yield* fixture.hooks["http.request"]!(event)
      expect(yield* Effect.promise(() => event.request.text())).toContain(marker)
    }
    const ws = { sessionID: "a", frame: '{"input":"synthetic-secret"}' }
    yield* fixture.hooks["experimental.ws.send"]!(ws)
    expect(ws.frame).toContain(marker)
    for (const name of ["model.request", "experimental.ws.handshake"]) {
      const event = { sessionID: "a", baseURL: "https://model.invalid/synthetic-secret", url: "wss://model.invalid/synthetic-secret", headers: { custom: "synthetic-secret" } }
      yield* fixture.hooks[name]!(event)
      expect(event.headers.custom).toBe(marker)
      expect(name === "model.request" ? event.baseURL : event.url).not.toContain("synthetic-secret")
    }
    const bad = { sessionID: "a", request: new Request("https://model.invalid", { method: "POST", body: "opaque" }) }
    yield* fixture.hooks["http.request"]!(bad)
    expect(yield* Effect.promise(() => bad.request.text())).toBe("opaque")
    const malformed = { sessionID: "a", frame: "not-json" }
    yield* fixture.hooks["experimental.ws.send"]!(malformed)
    expect(malformed.frame).toBe("not-json")
    const status = yield* fixture.methods().status({ sessionID: "a" }, { error: () => new Error("unavailable") }) as Effect.Effect<import("../src/rpc").Status>
    expect(JSON.stringify(status)).not.toContain("synthetic-secret")
    expect(JSON.stringify(status)).not.toContain("SECRET")
    expect(status.protectedValues).toBe(1)
  })))
  for (const value of [{ type: "image", data: "opaque" }, { type: "unknown-opaque" }, { inlineData: "opaque" }]) expect(new Scrubber(["synthetic-secret"]).json(value)).toEqual(value)
})

test("model and WebSocket handshakes omit invalid redacted header names without blocking dispatch", async () => {
  const secret = "synthetic-header-secret"
  const state = await sessions()
  await state.enable("origin", "alpha", { SECRET: secret })
  await state.disable("origin", "alpha")
  const fixture = adapter(state, () => Effect.succeed({}))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    for (const name of ["model.request", "experimental.ws.handshake"]) {
      const credentials = { Authorization: secret, "Proxy-Authorization": secret, "X-API-Key": secret, "Api-Key": secret, "X-Goog-Api-Key": secret }
      const event = { sessionID: "unrelated", baseURL: "https://model.invalid", url: "wss://model.invalid", headers: { [secret]: secret, "x-public": "public", "x-text": secret, ...credentials } }
      yield* fixture.hooks[name]!(event)
      expect(() => new Headers(event.headers)).not.toThrow()
      expect(event.headers).toEqual({ "x-public": "public", "x-text": marker, ...credentials })
      expect(Object.hasOwn(event.headers, secret)).toBe(false)
    }
  })))
})

test("provider payloads and SDK options dispatch after disable and in unrelated sessions", async () => {
  const state = await sessions()
  await state.enable("origin", "alpha", { SECRET: "synthetic-provider-secret" })
  await state.disable("origin", "alpha")
  class Options { constructor(readonly value = "public-option") {} method() { return this.value } }
  const options = new Options()
  const payload = {
    model: "synthetic-model",
    input: [{ role: "assistant", content: [{ type: "reasoning", encrypted_content: "opaque-reasoning" }, { type: "input_image", image_url: "https://image.invalid/public.png" }] }, { role: "user", content: [{ type: "input_text", text: "synthetic-provider-secret" }] }],
    tools: [{ type: "custom", name: "tool", input_schema: { type: "object", properties: { type: { type: "string", enum: ["arbitrary-provider-name", "custom"] } } } }],
    inlineData: { mime_type: "audio/wav", data: "opaque-audio" },
  }
  const fixture = adapter(new Sessions(state.directory, state.key), () => Effect.succeed({}))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    for (const sessionID of ["origin", "unrelated"]) {
      for (const name of ["context", "title", "compaction", "generate"]) {
        const event = { sessionID, system: [], messages: payload.input, tools: payload.tools, options: { sdk: options, provider: payload.inlineData } }
        yield* fixture.hooks[name]!(event)
        expect(JSON.stringify(event)).not.toContain("synthetic-provider-secret")
        expect(event.options.sdk).toBe(options)
        expect(event.options.sdk.method()).toBe("public-option")
        expect(event.tools).toEqual(payload.tools)
      }
      const controller = new AbortController()
      const event = { sessionID, request: new Request("https://model.invalid/responses", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer synthetic-provider-secret" }, body: JSON.stringify(payload), signal: controller.signal, redirect: "error" }) }
      yield* fixture.hooks["http.request"]!(event)
      expect(event.request.method).toBe("POST")
      expect(event.request.redirect).toBe("error")
      expect(event.request.headers.get("authorization")).toBe("Bearer synthetic-provider-secret")
      const body = yield* Effect.promise(() => event.request.json())
      expect(body).toEqual(new Scrubber(["synthetic-provider-secret"]).json(payload))
      controller.abort()
      expect(event.request.signal.aborted).toBe(true)
      const frame = { sessionID, frame: JSON.stringify({ type: "response.create", response: payload }) }
      yield* fixture.hooks["experimental.ws.send"]!(frame)
      expect(JSON.parse(frame.frame).response).toEqual(body)
      const text = { sessionID, request: new Request("https://model.invalid", { method: "POST", body: "not JSON: synthetic-provider-secret" }) }
      yield* fixture.hooks["http.request"]!(text)
      expect(yield* Effect.promise(() => text.request.text())).toBe(`not JSON: ${marker}`)
      const malformed = { sessionID, frame: "{ synthetic-provider-secret" }
      yield* fixture.hooks["experimental.ws.send"]!(malformed)
      expect(malformed.frame).toBe(`{ ${marker}`)
      const binary = { sessionID, request: new Request("https://model.invalid", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([137, 80, 78, 71, 0, 255]) }) }
      yield* fixture.hooks["http.request"]!(binary)
      expect(new Uint8Array(yield* Effect.promise(() => binary.request.arrayBuffer()))).toEqual(new Uint8Array([137, 80, 78, 71, 0, 255]))
    }
  })))
})

test("missing trusted configuration still protects snapshots; missing key backend fails closed", async () => {
  const state = await sessions()
  await state.enable("a", "alpha", { SECRET: "synthetic-secret" })
  const fixture = adapter(state, () => Effect.succeed({}), null)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    const event = { sessionID: "a", frame: '{"input":"synthetic-secret"}' }
    yield* fixture.hooks["experimental.ws.send"]!(event)
    expect(event.frame).toContain(marker)
    const status = fixture.methods().status({ sessionID: "a" }, { error: () => new Error("unavailable") }) as Effect.Effect<unknown, unknown>
    expect((yield* Effect.exit(status))._tag).toBe("Failure")
  })))
  const unavailable = new Sessions(state.directory, async () => { throw Object.assign(new Error("backend absent"), { code: "ENOENT" }) })
  await expect(unavailable.read("a")).rejects.toThrow("unavailable")
})

test("configured read role requests short-lived grants; revoke even on failure; expiry never disables loaded bundle", async () => {
  const calls: { path: string; token: string; body: any }[] = []
  const auth = { token: "synthetic-parent", expires: Date.now() + week * 1000 }
  const credentials: Credentials = { get: async () => JSON.stringify(auth), set: async () => {} }
  const http = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    const token = (init.headers as Record<string, string>)["X-Vault-Token"]!
    calls.push({ path, token, body: init.body ? JSON.parse(init.body as string) : undefined })
    if (path.endsWith("lookup-self") && token === "synthetic-parent") return Response.json({ data: parentIdentity() })
    if (path.includes("create/")) return Response.json({ auth: { client_token: "synthetic-child", lease_duration: 60, renewable: false, orphan: false, token_type: "service", policies: ["alpha-read"] } })
    if (path.endsWith("lookup-self")) return Response.json({ data: { path: "auth/token/create/opencode-env-read", orphan: false, renewable: false, explicit_max_ttl: 60 } })
    if (path.includes("/data/")) return Response.json({ data: { data: { SECRET: "synthetic-secret" } } })
    return Response.json({})
  }) as typeof fetch
  const bao = new Bao(settings, credentials, http)
  await expect(bao.bundle("../outside")).rejects.toThrow("Unknown")
  expect(calls).toHaveLength(0)
  const data = await bao.bundle("alpha")
  const creation = calls.find((call) => call.path.includes("create/"))!
  expect(creation.path).toBe("/v1/auth/token/create/opencode-env-read")
  expect(creation.body).toEqual({ ttl: "60s", explicit_max_ttl: "60s", renewable: false, no_default_policy: true, display_name: "opencode-bao", type: "service" })
  expect(calls.filter((call) => call.path.includes("/data/")).every((call) => call.token === "synthetic-child")).toBe(true)
  expect(calls.at(-1)!.path).toBe("/v1/auth/token/revoke-self")
  const state = await sessions()
  await state.enable("a", "alpha", data)
  auth.expires = Date.now() - 1
  await expect(bao.bundle("alpha")).rejects.toThrow("unavailable")
  expect((await state.overlay("a")).SECRET).toBe("synthetic-secret")
  const failing = new Bao(settings, { ...credentials, get: async () => JSON.stringify({ ...auth, expires: Date.now() + 10000 }) }, (async (url: string, init: RequestInit) => url.includes("/data/") ? new Response("", { status: 403 }) : http(url, init)) as typeof fetch)
  await expect(failing.bundle("alpha")).rejects.toThrow("unavailable")
  expect(calls.at(-1)!.path).toBe("/v1/auth/token/revoke-self")
})

test("snapshot key initialization does not replace unavailable or existing keys", async () => {
  const directory = join(await temporary(), "sessions")
  const values = new Map<string, string>()
  let sets = 0
  const credentials: Credentials = { get: async (account) => { if (!values.has(account)) throw new MissingCredential(); return values.get(account)! }, set: async (account, value) => { values.set(account, value); sets++ } }
  await initialize(credentials, directory)
  expect(sets).toBe(2)
  await initialize(credentials, directory)
  expect(sets).toBe(2)
  await expect(initialize({ ...credentials, get: async () => { throw new Error("locked") } }, directory)).rejects.toThrow("locked")
  values.delete("snapshot-key")
  await expect(initialize(credentials, directory)).rejects.toThrow("unavailable")
  expect(sets).toBe(2)
})

test("missing or malformed child tokens stop before secret reads", async () => {
  for (const patch of [{ client_token: undefined }, { client_token: "" }, { client_token: 1 }]) {
    const paths: string[] = []
    const http = (async (url: string, init: RequestInit) => {
      paths.push(new URL(url).pathname)
      if (url.endsWith("lookup-self") && (init.headers as Record<string, string>)["X-Vault-Token"] === "synthetic-parent") return Response.json({ data: parentIdentity() })
      if (url.includes("/create/")) return Response.json({ auth: { orphan: false, renewable: false, policies: ["alpha-read"], token_type: "service", ...patch } })
      return Response.json({})
    }) as unknown as typeof fetch
    const bao = new Bao(settings, { get: async () => JSON.stringify({ token: "synthetic-parent", expires: Date.now() + 10000 }), set: async () => {} }, http)
    await expect(bao.bundle("alpha")).rejects.toThrow("unavailable")
    expect(paths.some((path) => path.includes("/data/"))).toBe(false)
    expect(paths.at(-1)).toBe("/v1/auth/token/create/opencode-env-read")
  }
})

test("usable short or administrative identities remain Bao server policy", async () => {
  const saved: string[] = []
  const credentials: Credentials = { get: async () => { if (!saved.length) throw new MissingCredential(); return saved.at(-1)! }, set: async (account, value) => { expect(account).toBe("auth"); saved.push(value) } }
  let identity: any = parentIdentity()
  const bao = new Bao(settings, credentials, (async () => Response.json({ data: identity })) as unknown as typeof fetch)
  await bao.acceptLogin({ ...loginAuth, lease_duration: 1800 })
  expect(saved).toHaveLength(1)
  identity = { ...identity, meta: { role: "admin" } }
  await bao.acceptLogin(loginAuth)
  identity = { ...identity, meta: { role: "opencode" }, explicit_max_ttl: 1800 }
  await bao.acceptLogin(loginAuth)
  identity = { ...identity, explicit_max_ttl: week }
  await bao.acceptLogin(loginAuth)
  expect(saved).toHaveLength(4)
  expect(JSON.parse(saved[0]!).expires - Date.now()).toBeGreaterThan(604795000)
  identity = { ...identity, policies: ["root"] }
  await bao.acceptLogin(loginAuth)
  expect(saved).toHaveLength(5)
})

test("protected registry and shared history survive restart; missing snapshots, ledger, key or initialization marker block", async () => {
  const state = await sessions()
  await state.enable("origin", "alpha", { SECRET: "synthetic-shared-secret" })
  const restarted = new Sessions(state.directory, state.key)
  expect((await restarted.read("copy")).history).toContain("synthetic-shared-secret")
  expect(await restarted.overlay("copy")).toEqual({})
  await rm(join(state.directory, createHash("sha256").update("origin").digest("hex")))
  await expect(restarted.overlay("origin")).rejects.toThrow("unavailable")
  const fixture = adapter(restarted, () => Effect.succeed({}))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    expect((yield* Effect.exit(fixture.hooks["experimental.ws.send"]!({ sessionID: "origin", frame: "{}" })))._tag).toBe("Failure")
    const copy = { sessionID: "unrelated-copy", frame: '{"text":"synthetic-shared-secret"}' }
    yield* fixture.hooks["experimental.ws.send"]!(copy)
    expect(copy.frame).not.toContain("synthetic-shared-secret")
  })))
  await rm(join(state.directory, "ledger"))
  await expect(new Sessions(state.directory, state.key).read("new")).rejects.toThrow("unavailable")
  await rm(state.directory, { recursive: true })
  await expect(new Sessions(state.directory, state.key).read("new")).rejects.toThrow("unavailable")

  const directory = join(await temporary(), "sessions")
  const accounts = new Map<string, string>()
  let writes = 0
  const credentials: Credentials = { get: async (account) => { if (!accounts.has(account)) throw new MissingCredential(); return accounts.get(account)! }, set: async (account, value) => { writes++; accounts.set(account, value) } }
  await initialize(credentials, directory)
  const initialized = new Sessions(directory, () => encryptionKey(credentials))
  await initialized.enable("a", "alpha", { SECRET: "synthetic-secret" })
  const savedKey = accounts.get("snapshot-key")!
  accounts.delete("snapshot-key")
  await expect(new Sessions(directory, () => encryptionKey(credentials)).read("copy")).rejects.toThrow("unavailable")
  await expect(initialize(credentials, directory)).rejects.toThrow("unavailable")
  accounts.set("snapshot-key", savedKey)
  accounts.delete("initialized")
  await expect(new Sessions(directory, () => encryptionKey(credentials)).read("copy")).rejects.toThrow("unavailable")
  await expect(initialize(credentials, directory)).rejects.toThrow("unavailable")
  accounts.set("initialized", "v1")
  await rm(join(directory, "ledger"))
  await expect(initialize(credentials, directory)).rejects.toThrow("unavailable")
  await rm(directory, { recursive: true })
  await expect(initialize(credentials, directory)).rejects.toThrow("unavailable")
  expect(writes).toBe(2)
})

test("host history commits before snapshot exposure, and interrupted snapshot commits fail closed", async () => {
  const state = await sessions()
  const backend = state as any
  const encrypted = backend.encrypted.bind(state)
  backend.encrypted = async (name: string, value: unknown) => {
    if (name !== "ledger") {
      expect((await backend.decoded("ledger")).history).toContain("synthetic-precommitted-secret")
      throw new Error("synthetic snapshot write failure")
    }
    await encrypted(name, value)
  }
  await expect(state.enable("a", "alpha", { SECRET: "synthetic-precommitted-secret" })).rejects.toThrow("unavailable")
  const restart = new Sessions(state.directory, state.key)
  await expect(restart.overlay("a")).rejects.toThrow("unavailable")
  expect((await restart.read("copy")).history).toContain("synthetic-precommitted-secret")
})

test("separate Node processes share the host union and lock without environment inheritance", async () => {
  const state = await sessions()
  await state.enable("parent", "alpha", { PARENT_VALUE: "synthetic-parent-value" })
  const entry = join(await temporary(), "state.mjs")
  await build({ entryPoints: [fileURLToPath(new URL("../src/state.ts", import.meta.url))], outfile: entry, bundle: true, platform: "node", target: "node22", format: "esm", packages: "external" })
  const source = `
    import { Sessions } from ${JSON.stringify(pathToFileURL(entry).href)};
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const state = new Sessions(${JSON.stringify(state.directory)}, Buffer.from(input, "base64"));
    await state.enable("child", "beta", { CHILD_VALUE: "synthetic-child-value" }, 0);
    const copy = await state.read("copy");
    console.log(JSON.stringify({ protectedParent: copy.history.includes("synthetic-parent-value"), inherited: Object.keys(await state.overlay("copy")).length }));
  `
  const child = runProcess(process.execPath, ["--input-type=module", "-e", source], { env: {}, input: (state.key as Buffer).toString("base64") })
  await state.enable("concurrent-parent", "alpha", { CONCURRENT_VALUE: "synthetic-concurrent-value" }, 0)
  const { stdout: output, stderr: errors, exitCode: exit } = await child
  expect(exit).toBe(0)
  expect(errors).toBe("")
  expect(JSON.parse(output)).toEqual({ protectedParent: true, inherited: 0 })
  const history = (await new Sessions(state.directory, state.key).read("copy")).history
  expect(history).toContain("synthetic-parent-value")
  expect(history).toContain("synthetic-child-value")
  expect(history).toContain("synthetic-concurrent-value")
  expect(await state.overlay("copy")).toEqual({})
})

test("global semantic, HTTP and WS redaction covers UTF8 hex and bounded MIME base64 while provider credentials survive", async () => {
  const secret = "synthetic-provider-key-" + "long-synthetic-value-".repeat(5)
  const state = await sessions()
  await state.enable("original", "alpha", { SECRET: secret, SHORT: "abcde" })
  await state.disable("original", "alpha")
  const fixture = adapter(new Sessions(state.directory, state.key), () => Effect.succeed({}))
  const bytes = Buffer.from(secret)
  const variants = [bytes.toString("hex"), bytes.toString("hex").toUpperCase()]
  for (const encoding of ["base64", "base64url"] as const) for (const padded of [false, true]) {
    let value = bytes.toString(encoding)
    value = padded ? value + "=".repeat((4 - value.length % 4) % 4) : value.replace(/=+$/, "")
    for (const width of [64, 76]) for (const separator of ["\n", "\r\n"]) variants.push(value.match(new RegExp(`.{1,${width}}`, "g"))!.join(separator))
  }
  const names = ["Authorization", "Proxy-Authorization", "X-API-Key", "Api-Key", "X-Goog-Api-Key"]
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    for (const value of variants) {
      for (const name of ["context", "title", "compaction", "generate"]) {
        const event = { sessionID: "fork-with-no-bundles", system: [], messages: [{ type: "text", text: value }], options: { short: "abcde" }, tools: {} }
        yield* fixture.hooks[name]!(event)
        expect(event.messages[0]!.text).toContain(marker)
        expect(event.options.short).toBe("abcde")
      }
      const event = { sessionID: "copy", request: new Request("https://model.invalid", { method: "POST", headers: { "content-type": "application/json", authorization: secret, "x-custom": secret }, body: JSON.stringify({ text: value, short: "abcde" }) }) }
      yield* fixture.hooks["http.request"]!(event)
      expect(event.request.headers.get("authorization")).toBe(secret)
      expect(event.request.headers.get("x-custom")).toBe(marker)
      const body = yield* Effect.promise(() => event.request.json())
      expect(body.text).toContain(marker)
      expect(body.short).toBe("abcde")
      const ws = { sessionID: "unrelated", frame: JSON.stringify({ text: value, short: "abcde" }) }
      yield* fixture.hooks["experimental.ws.send"]!(ws)
      expect(JSON.parse(ws.frame).text).toContain(marker)
      expect(JSON.parse(ws.frame).short).toBe("abcde")
    }
    for (const hook of ["model.request", "experimental.ws.handshake"]) {
      const event = { sessionID: "copy", url: "wss://model.invalid", baseURL: "https://model.invalid", headers: { ...Object.fromEntries(names.map((name) => [name, secret])), "X-Custom": secret } }
      yield* fixture.hooks[hook]!(event)
      for (const name of names) expect(event.headers[name as keyof typeof event.headers]).toBe(secret)
      expect(event.headers["X-Custom"]).toBe(marker)
    }
  })))
  const scrub = new Scrubber(["abcde", "Authorization"])
  expect(scrub.headers({ Authorization: "legitimate-provider-value" }).Authorization).toBe("legitimate-provider-value")
  expect(scrub.text(Buffer.from("abcde").toString("hex"))).toBe(Buffer.from("abcde").toString("hex"))
})

test("all valid environment names survive Bao, RPC enable, persisted overlays and outbound redaction", async () => {
  const keys = [
    "BAO_TOKEN", "VAULT_TOKEN", "BAO_ADDR", "VAULT_ADDR", "BAO_AGENT_ADDR", "VAULT_AGENT_ADDR",
    "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_REPL_EXTERNAL_MODULE",
    "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONBREAKPOINT", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB",
    "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXEC_PATH",
    "SHELLOPTS", "BASHOPTS", "PATH", "HOME", "SHELL", "ZDOTDIR", "FPATH", "PS1", "PS2", "PS4", "PROMPT_COMMAND", "IFS", "CDPATH", "ENV_SUPATH",
    "BUN_OPTIONS", "BUN_INSPECT", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "GCONV_PATH", "LOCPATH", "NLSPATH",
    "SSLKEYLOGFILE", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "AWS_CA_BUNDLE",
    "DOTNET_STARTUP_HOOKS", "DOTNET_ADDITIONAL_DEPS", "DOTNET_SHARED_STORE", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "OPENCODE_SESSION_ID",
    "CORECLR_ENABLE_PROFILING", "COR_ENABLE_PROFILING", "COMPlus_CUSTOM", "bao_custom", "vAuLt_custom", "ld_custom", "dyld_custom",
    "opencode_custom", "git_config_custom", "coreclr_custom", "cor_custom", "complus_custom", "node_options", "_", "A1",
    "__proto__", "constructor", "toString",
  ]
  const values: Record<string, string> = { ...Object.fromEntries(keys.map((key) => [key, `synthetic-${key}-value+/é`])), EMPTY: "", SHORT: "abcde" }
  const ambient = { ...process.env }
  const paths: string[] = []
  const http = (async (url: string, init: RequestInit) => {
    paths.push(new URL(url).pathname)
    const token = (init.headers as Record<string, string>)["X-Vault-Token"]
    if (url.endsWith("lookup-self")) return Response.json({ data: token === "parent" ? parentIdentity() : { path: "auth/token/create/opencode-env-read", orphan: false, renewable: false, explicit_max_ttl: 60 } })
    if (url.includes("create/")) return Response.json({ auth: { client_token: "child", lease_duration: 60, renewable: false, orphan: false, token_type: "service", policies: ["alpha-read"] } })
    if (url.includes("/data/")) return Response.json({ data: { data: values } })
    return Response.json({})
  }) as typeof fetch
  const bao = new Bao(settings, { get: async () => JSON.stringify({ token: "parent", expires: Date.now() + 10000 }), set: async () => {} }, http)
  const bundle = vi.spyOn(bao, "bundle")
  const state = await sessions()
  const fixture = adapter(state, () => Effect.gen(function* () {
    const event = invocation()
    const original = event.env
    yield* shellOverlay(event)
    expect(event.env).toEqual({ ...original, ...values })
    expect(event.env).not.toBe(original)
    expect(original).toEqual(invocation().env)
    return { content: "synthetic overlay only; no child process" }
  }), bao)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    const enabled = yield* fixture.methods().enable({ sessionID: "a", bundle: "alpha", version: 0 }, { error: () => new Error("unavailable") }) as Effect.Effect<import("../src/rpc").Status>
    expect(enabled.bundles[0]).toEqual({ name: "alpha", enabled: true, keys: Object.keys(values).length })
    expect(enabled.protectedValues).toBe(keys.length)
    expect(JSON.stringify(enabled)).not.toContain(values.VAULT_TOKEN!)
    expect(yield* fixture.tool.execute({}, context("a"))).toEqual({ content: "synthetic overlay only; no child process" })
    const variants = Object.values(values).flatMap((value) => [value, encodeURIComponent(value), Buffer.from(value).toString("base64")])
    const outbound = { sessionID: "a", frame: JSON.stringify({ text: variants.join(" "), short: values.SHORT }) }
    yield* fixture.hooks["experimental.ws.send"]!(outbound)
    for (const value of Object.values(values).filter((value) => value.length > 5)) {
      expect(outbound.frame).not.toContain(value)
      expect(outbound.frame).not.toContain(encodeURIComponent(value))
      expect(outbound.frame).not.toContain(Buffer.from(value).toString("base64"))
    }
    expect(JSON.parse(outbound.frame).short).toBe("abcde")
    expect(outbound.frame).toContain(marker)
  })))
  expect(bundle).toHaveBeenCalledExactlyOnceWith("alpha")
  expect(await bundle.mock.results[0]!.value).toEqual(values)
  expect(paths.filter((path) => path.includes("/data/"))).toEqual(["/v1/kv/data/env/alpha"])
  expect(paths.at(-1)).toBe("/v1/auth/token/revoke-self")
  const restarted = new Sessions(state.directory, state.key)
  expect((await restarted.read("a")).active.alpha).toEqual(values)
  const overlay = await restarted.overlay("a")
  expect(overlay).toEqual(values)
  expect(Object.isFrozen(overlay)).toBe(true)
  expect(await restarted.overlay("other-session")).toEqual({})
  expect(process.env).toEqual(ambient)
})

test.each([
  null, [], "not-an-object", { "": "synthetic-value" }, { "1BAD": "synthetic-value" }, { "BAD-NAME": "synthetic-value" },
  { "BAD=NAME": "synthetic-value" }, { "BAD NAME": "synthetic-value" }, { "BAD\nNAME": "synthetic-value" },
  { SECRET: 1 }, { SECRET: null }, { SECRET: {} }, { SECRET: [] },
  { SECRET: "synthetic\nvalue" }, { SECRET: "synthetic\rvalue" }, { SECRET: "synthetic\0value" },
])("malformed environment %# rejects at Bao, session enable and persisted read boundaries", async (values) => {
  const state = await sessions()
  await expect(state.enable("a", "alpha", values as unknown as Record<string, string>)).rejects.toThrow("Invalid")
  expect((await state.read("a")).version).toBe(0)
  expect((await state.read("a")).history).toEqual([])
  const paths: string[] = []
  const http = (async (url: string, init: RequestInit) => {
    paths.push(new URL(url).pathname)
    const token = (init.headers as Record<string, string>)["X-Vault-Token"]
    if (url.endsWith("lookup-self")) return Response.json({ data: token === "parent" ? parentIdentity() : { path: "auth/token/create/opencode-env-read", orphan: false, renewable: false, explicit_max_ttl: 60 } })
    if (url.includes("create/")) return Response.json({ auth: { client_token: "child", lease_duration: 60, renewable: false, orphan: false, token_type: "service", policies: ["alpha-read"] } })
    if (url.includes("/data/")) return Response.json({ data: { data: values } })
    return Response.json({})
  }) as typeof fetch
  const bao = new Bao(settings, { get: async () => JSON.stringify({ token: "parent", expires: Date.now() + 10000 }), set: async () => {} }, http)
  await expect(bao.bundle("alpha")).rejects.toEqual(new LocalSetupError("environment", "bundle"))
  expect(paths.at(-1)).toBe("/v1/auth/token/revoke-self")
  await state.enable("a", "alpha", { SECRET: "synthetic-valid-value" })
  await (state as any).encrypted(createHash("sha256").update("a").digest("hex"), { version: 1, active: { alpha: values } })
  await expect(new Sessions(state.directory, state.key).read("a")).rejects.toThrow("unavailable")
})

test("server deadlines constrain parent auth across skew, restart and revocation without policy gates", async () => {
  const created = Date.UTC(2026, 9, 17)
  setSystemTime(created + 2000)
  let identity: any = { ...parentIdentity(created), ttl: week - 2 }
  let saved = ""
  let revoked = false
  const credentials: Credentials = { get: async () => saved, set: async (_account, value) => { saved = value } }
  const http = (async () => revoked ? new Response("", { status: 403 }) : Response.json({ data: identity })) as unknown as typeof fetch
  const bao = new Bao(settings, credentials, http)
  await bao.acceptLogin(loginAuth)
  expect(JSON.parse(saved).expires).toBe(created + week * 1000)
  delete identity.identity_policies
  await bao.acceptLogin({ ...loginAuth, identity_policies: undefined })
  for (const patch of [{ ttl: 0 }]) {
    identity = { ...parentIdentity(created), ...patch }
    await expect(bao.acceptLogin(loginAuth)).rejects.toThrow("unavailable")
  }
  identity = { ...parentIdentity(created), ttl: week - 2 }
  await bao.acceptLogin({ ...loginAuth, identity_policies: ["admin"], policies: ["opencode-parent", "admin"] })
  setSystemTime(created + 10000)
  await bao.acceptLogin(loginAuth)
  expect(JSON.parse(saved).expires).toBe(created + week * 1000)
  setSystemTime(created - 10000)
  await bao.acceptLogin(loginAuth)
  setSystemTime(created + 10000)
  await bao.acceptLogin(loginAuth)
  setSystemTime(created + (week - 1) * 1000)
  identity.ttl = 1
  expect(await new Bao(settings, credentials, http).parent()).toBe("synthetic-parent")
  revoked = true
  await expect(new Bao(settings, credentials, http).parent()).rejects.toThrow("unavailable")
  revoked = false
  setSystemTime(created + week * 1000)
  await expect(new Bao(settings, credentials, http).parent()).rejects.toThrow("unavailable")
})

test("legacy parent policy fields remain accepted but optional", () => {
  expect(parseConfig(settings).parentTokenPolicies).toEqual(["opencode-parent"])
  for (const patch of [{ parentTokenPolicies: undefined }, { parentIdentityPolicies: undefined }, { parentTokenPolicies: ["default"] }, { parentIdentityPolicies: ["inherited-admin"] }, { parentTokenPolicies: ["opencode-parent", "opencode-parent"] }]) {
    expect(parseConfig({ ...settings, ...patch })).toMatchObject(patch)
  }
})

test("OpenBao 2.6.2 CLI login through native RPC and TUI succeeds only after server validation and auth read-back", async () => {
  const state = await sessions()
  const accounts = new Map([["initialized", "v1"], ["snapshot-key", (state.key as Buffer).toString("base64")]])
  let readable = true
  const credentials: Credentials = {
    set: vi.fn(async (account, value) => { accounts.set(account, value) }),
    get: vi.fn(async (account) => { if ((account === "auth" && !readable) || !accounts.has(account)) throw new MissingCredential(); return accounts.get(account)! }),
  }
  // OpenBao v2.6.2 SecretAuth omits token_type and serializes nil identity_policies as null.
  const cliAuth = { client_token: "synthetic-parent", accessor: "synthetic-accessor", policies: ["opencode-parent"], token_policies: ["opencode-parent"], identity_policies: null, metadata: { role: "opencode", email: "synthetic@example.invalid" }, orphan: true, entity_id: "synthetic-entity", lease_duration: week, renewable: true, mfa_requirement: null }
  const run = vi.fn<typeof runProcess>(async () => ({ stdout: JSON.stringify({ auth: cliAuth }), stderr: "", exitCode: 0 }))
  const http = vi.fn(async () => Response.json({ data: parentIdentity() }))
  const bao = new Bao({ ...settings, bao: process.execPath }, credentials, http as typeof fetch, run)
  const realLogin = bao.login.bind(bao)
  bao.login = (options) => realLogin({ ...options, directory: state.directory })
  const fixture = adapter(state, () => Effect.succeed({}), bao)
  const rpcContext = { error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
  const toast = vi.fn()
  let commands: any[] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    yield* Effect.promise(async () => {
      const login = vi.fn(() => Effect.runPromise(fixture.methods().login({}, rpcContext)))
      const cleanup = await tui.setup({
        client: { rpc: () => ({ login }) }, location: { directory: "/project" },
        keymap: { layer: (factory: Function) => { commands = factory().commands } },
        ui: { toast: { show: toast } },
      } as any)
      try {
        const command = commands.find((entry) => entry.id === "bao.login")
        await command.run()
        expect(await login.mock.results[0]!.value).toEqual({ authenticated: true })
        expect(vi.mocked(credentials.get).mock.calls.filter(([account]) => account === "auth")).toEqual([["auth"]])
        expect(run).toHaveBeenCalledTimes(1)
        expect(http).toHaveBeenCalledTimes(1)
        expect(http.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(credentials.set).mock.invocationCallOrder[0]!)
        expect(JSON.parse(accounts.get("auth")!).token).toBe(cliAuth.client_token)
        expect(toast.mock.lastCall![0].variant).toBe("success")
        toast.mockClear()
        readable = false
        await command.run()
        expect(toast.mock.calls.map(([value]) => value.variant)).toEqual(["info", "error"])
        expect(toast.mock.lastCall![0].message).toBe(diagnostics.credential_read_missing)
        expect(JSON.stringify(toast.mock.calls)).not.toContain(cliAuth.client_token)
        expect(credentials.set).toHaveBeenCalledTimes(2)
        expect(vi.mocked(credentials.get).mock.calls.filter(([account]) => account === "auth")).toEqual([["auth"], ["auth"]])
      } finally { await cleanup?.() }
    })
  })))
})

test("login RPC is explicit, metadata-only, cancellable, and never registers a model tool", async () => {
  const state = await sessions()
  const bao = new Bao(settings)
  const login = vi.fn(async (_options?: { signal?: AbortSignal }) => {})
  bao.login = login
  const fixture = adapter(state, () => Effect.succeed({}), bao)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    const errors: any[] = []
    const rpcContext = { error: (type: string, message: string, data: unknown) => { errors.push({ type, message, data }); return new Error(message) } }
    const call = () => fixture.methods().login({}, rpcContext) as Effect.Effect<unknown, unknown>
    yield* fixture.methods().status({ sessionID: "a" }, rpcContext) as Effect.Effect<unknown, unknown>
    yield* fixture.tool.execute({}, context("a"))
    expect(login).not.toHaveBeenCalled()
    const result = yield* call()
    expect(result).toEqual({ authenticated: true })
    expect(login).toHaveBeenCalledTimes(1)
    login.mockRejectedValueOnce(new Error("synthetic-token-oidc-code-url"))
    expect((yield* Effect.exit(call()))._tag).toBe("Failure")
    login.mockRejectedValueOnce(new LoginBusy())
    expect((yield* Effect.exit(call()))._tag).toBe("Failure")
    expect(errors.map((entry) => entry.type)).toEqual(["unavailable", "busy"])
    expect(errors.every((entry) => JSON.stringify(entry.data) === "{}")).toBe(true)
    expect(JSON.stringify(errors)).not.toContain("synthetic-token-oidc-code-url")
    for (const diagnostic of Object.keys(diagnostics) as (keyof typeof diagnostics)[]) {
      login.mockRejectedValueOnce(new LocalSetupError(diagnostic))
      expect((yield* Effect.exit(call()))._tag).toBe("Failure")
      expect(errors.at(-1)).toEqual({ type: "unavailable", message: diagnostics[diagnostic], data: { diagnostic } })
    }
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let aborted = false
    login.mockImplementationOnce(async (options) => { entered(); await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => { aborted = true; resolve() }, { once: true })) })
    const pending = yield* Effect.forkChild(call())
    yield* Effect.promise(() => started)
    yield* Fiber.interrupt(pending)
    expect(aborted).toBe(true)
  })))
  expect(fixture.additions()).toBe(0)
})

test("unsafe bundle names accepted by transport cannot read secrets or mutate session environment", async () => {
  const state = await sessions()
  const read = vi.spyOn(state, "read")
  const enable = vi.spyOn(state, "enable")
  const disable = vi.spyOn(state, "disable")
  const bao = new Bao(settings)
  const bundle = vi.spyOn(bao, "bundle").mockRejectedValue(new Error("Unexpected secret read"))
  const fixture = adapter(state, () => Effect.succeed({}), bao)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    for (const action of ["enable", "disable"] as const) {
      const codec = Schema.make<Schema.Codec<unknown>>(
        SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(BaoRpc.methods[action].input)).ast,
      )
      for (const name of ["", "../alpha", "alpha/beta", "alpha\\beta", ".alpha", "-alpha", "alpha?query", "alpha\n", "alpha\u0000"]) {
        const input = yield* Schema.decodeUnknownEffect(codec)({ sessionID: "a", bundle: name, version: 0 })
        const result = yield* Effect.exit(fixture.methods()[action](input, { error: () => new Error("unavailable") }) as Effect.Effect<unknown, unknown>)
        expect(result._tag).toBe("Failure")
      }
    }
    expect(read).not.toHaveBeenCalled()
    expect(enable).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
    expect(bundle).not.toHaveBeenCalled()
    expect(bao.catalog).not.toHaveBeenCalled()
    expect(yield* Effect.promise(() => state.overlay("a"))).toEqual({})
  })))
})

test("CAS rejects delayed enables after disable, duplicate enables do not fetch or refresh, overlapping commits cannot win together", async () => {
  const state = await sessions()
  let resolve!: (values: Record<string, string>) => void
  let entered!: () => void
  const started = new Promise<void>((done) => { entered = done })
  let calls = 0
  const bao = new Bao(settings)
  bao.bundle = async () => { calls++; entered(); return new Promise((done) => { resolve = done }) }
  const fixture = adapter(state, () => Effect.succeed({}), bao)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fixture.install
    const error = { error: () => new Error("unavailable") }
    const enable = fixture.methods().enable({ sessionID: "a", bundle: "alpha", version: 0 }, error) as Effect.Effect<unknown, unknown>
    const pending = yield* Effect.forkChild(enable)
    yield* Effect.promise(() => started)
    yield* fixture.methods().disable({ sessionID: "a", bundle: "alpha", version: 0 }, error) as Effect.Effect<unknown, unknown>
    resolve({ SECRET: "stale-remote-secret" })
    expect((yield* Fiber.await(pending))._tag).toBe("Failure")
    expect(yield* Effect.promise(() => state.overlay("a"))).toEqual({})
    bao.bundle = async () => { calls++; return { SECRET: calls === 2 ? "first-secret" : "changed-secret" } }
    yield* fixture.methods().enable({ sessionID: "a", bundle: "alpha", version: 1 }, error) as Effect.Effect<unknown, unknown>
    yield* fixture.methods().enable({ sessionID: "a", bundle: "alpha", version: 2 }, error) as Effect.Effect<unknown, unknown>
    expect(calls).toBe(2)
    expect((yield* Effect.promise(() => state.overlay("a"))).SECRET).toBe("first-secret")
    yield* fixture.methods().disable({ sessionID: "a", bundle: "alpha", version: 2 }, error) as Effect.Effect<unknown, unknown>
    const stale = fixture.methods().enable({ sessionID: "a", bundle: "alpha", version: 2 }, error) as Effect.Effect<unknown, unknown>
    expect((yield* Effect.exit(stale))._tag).toBe("Failure")
    expect(calls).toBe(2)
    yield* fixture.methods().enable({ sessionID: "a", bundle: "alpha", version: 3 }, error) as Effect.Effect<unknown, unknown>
    expect((yield* Effect.promise(() => state.overlay("a"))).SECRET).toBe("changed-secret")
  })))
  const other = new Sessions(state.directory, state.key)
  const outcomes = await Promise.allSettled([state.enable("b", "alpha", { SECRET: "alpha-secret" }, 0), other.enable("b", "beta", { SECRET: "beta-secret" }, 0)])
  expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect((await state.read("b")).version).toBe(1)
})
