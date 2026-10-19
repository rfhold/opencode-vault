import { afterEach, expect, test, vi } from "vitest"
import { mkdtemp, rm, realpath, writeFile, chmod } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { Bao, LoginBusy, MissingCredential, week, type Config, type Credentials } from "../src/bao"
import type { runProcess } from "../src/process"
import tui from "../src/tui"
import { diagnostics, LocalSetupError, type Diagnostic } from "../src/diagnostics"

const directories: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
const settings: Config = { address: "https://bao.invalid", mount: "kv", prefix: "env", oidc: "oidc", bao: process.execPath, catalogRole: "opencode-env-catalog", readRole: "opencode-env-read", parentTokenPolicies: ["opencode-parent"], parentIdentityPolicies: [] }
// OpenBao v2.6.2 api/secret.go SecretAuth JSON: no TokenType field; nil IdentityPolicies becomes null.
const auth = { client_token: "synthetic-parent", accessor: "synthetic-accessor", policies: ["opencode-parent"], token_policies: ["opencode-parent"], identity_policies: null, metadata: { role: "opencode", email: "synthetic@example.invalid" }, orphan: true, entity_id: "synthetic-entity", lease_duration: week, renewable: true, mfa_requirement: null }
const identity = () => ({ creation_time: Math.floor(Date.now() / 1000), creation_ttl: week, explicit_max_ttl: week, ttl: week - 1, expire_time: new Date(Math.floor(Date.now() / 1000) * 1000 + week * 1000).toISOString(), meta: { role: "opencode" }, policies: ["opencode-parent"], identity_policies: [], type: "service" })
async function fixture(run: typeof runProcess) {
  const directory = await mkdtemp(fileURLToPath(new URL("../.test-login-", import.meta.url)))
  directories.push(directory)
  const accounts = new Map<string, string>()
  const writes: string[] = []
  const credentials: Credentials = {
    get: async (account) => { if (!accounts.has(account)) throw new MissingCredential(); return accounts.get(account)! },
    set: async (account, value) => { writes.push(account); accounts.set(account, value) },
  }
  const http = vi.fn(async () => Response.json({ data: identity() }))
  return { bao: new Bao(settings, credentials, http as typeof fetch, run), accounts, writes, http, options: { directory: join(directory, "sessions") } }
}

test("explicit login initializes once, invokes noninteractive browser OIDC privately, and refuses lost state", async () => {
  const run = vi.fn<typeof runProcess>(async () => ({ stdout: JSON.stringify({ auth }), stderr: "synthetic-private-oidc-url", exitCode: 0 }))
  const f = await fixture(run)
  const get = vi.spyOn(f.bao.credentials, "get")
  expect(run).not.toHaveBeenCalled()
  expect(f.writes).toEqual([])
  expect(await f.bao.login(f.options)).toBeUndefined()
  expect(f.writes).toEqual(["initialized", "snapshot-key", "auth"])
  expect(Object.hasOwn(auth, "token_type")).toBe(false)
  expect(f.http).toHaveBeenCalledExactlyOnceWith("https://bao.invalid/v1/auth/token/lookup-self", expect.objectContaining({ headers: { "X-Vault-Token": auth.client_token, "Content-Type": "application/json" } }))
  expect(JSON.parse(f.accounts.get("auth")!).token).toBe(auth.client_token)
  expect(get.mock.calls.filter(([account]) => account === "auth")).toEqual([["auth"]])
  const [file, args, options] = run.mock.calls[0]!
  expect(file).toBe(await realpath(process.execPath))
  expect(args).toEqual(["login", "-non-interactive", "-no-store", "-format=json", "-method=oidc", "-path=oidc", "role=opencode", "skip_browser=false", "abort_on_error=true"])
  expect(options.stdin).toBeUndefined()
  expect(options.stderr).toBe("ignore")
  expect(options.timeout).toBe(120000)
  expect(options.maxBytes).toBe(1048576)
  expect(options.env).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: process.env.HOME, BAO_ADDR: "https://bao.invalid" })
  expect(options.signal).toBeInstanceOf(AbortSignal)
  const key = f.accounts.get("snapshot-key")
  await f.bao.login(f.options)
  expect(f.accounts.get("snapshot-key")).toBe(key)
  expect(f.writes).toEqual(["initialized", "snapshot-key", "auth", "auth"])
  await rm(join(f.options.directory, "ledger"))
  await expect(f.bao.login(f.options)).rejects.toThrow(diagnostics.state)
  expect(run).toHaveBeenCalledTimes(2)
  expect(f.writes).toHaveLength(4)
})

test("simultaneous login is rejected; CLI failures stay generic and release the guard", async () => {
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const run = vi.fn<typeof runProcess>(async () => { enter(); await new Promise<void>((resolve) => { release = resolve }); return { stdout: "synthetic-token-and-code", stderr: "private-url", exitCode: 1 } })
  const f = await fixture(run)
  const pending = f.bao.login(f.options)
  await entered
  await expect(f.bao.login(f.options)).rejects.toBeInstanceOf(LoginBusy)
  release()
  await expect(pending).rejects.toThrow("Bao unavailable")
  expect(f.accounts.has("auth")).toBe(false)
  run.mockResolvedValue({ stdout: JSON.stringify({ auth }), stderr: "", exitCode: 0 })
  await f.bao.login(f.options)
  expect(f.accounts.has("auth")).toBe(true)
})

test("unavailable executable reports safe local setup stage before initialization or browser invocation", async () => {
  const run = vi.fn<typeof runProcess>()
  const f = await fixture(run)
  const bao = new Bao({ ...settings, bao: join(f.options.directory, "absent-bao-private-value") }, f.bao.credentials, f.bao.http, run)
  await expect(bao.login(f.options)).rejects.toThrow(diagnostics.executable)
  expect(f.writes).toEqual([])
  expect(run).not.toHaveBeenCalled()
})

test("executable write modes do not impose plugin administrative policy", async () => {
  const run = vi.fn<typeof runProcess>(async () => ({ stdout: JSON.stringify({ auth }), stderr: "", exitCode: 0 }))
  const f = await fixture(run)
  const executable = join(f.options.directory, "..", "synthetic-bao")
  await writeFile(executable, "synthetic executable fixture")
  await chmod(executable, 0o777)
  await new Bao({ ...settings, bao: executable }, f.bao.credentials, f.bao.http, run).login(f.options)
  expect(run.mock.calls[0]![0]).toBe(await realpath(executable))
})

test("login deadline and caller interruption abort the child and do not save auth", async () => {
  let enter!: () => void
  let entered = new Promise<void>((resolve) => { enter = resolve })
  const run = vi.fn<typeof runProcess>(async (_file, _args, options) => { enter(); return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("private-url-and-code")), { once: true })) })
  const f = await fixture(run)
  vi.useFakeTimers()
  const pending = f.bao.login(f.options)
  const rejection = expect(pending).rejects.toThrow("Bao unavailable")
  await entered
  const controller = new AbortController()
  await vi.advanceTimersByTimeAsync(180000)
  await rejection
  expect(run.mock.calls[0]![2].signal!.aborted).toBe(true)
  entered = new Promise<void>((resolve) => { enter = resolve })
  const cancelled = f.bao.login({ ...f.options, signal: controller.signal })
  await entered
  controller.abort()
  await expect(cancelled).rejects.toThrow("Bao unavailable")
  expect(f.accounts.has("auth")).toBe(false)
})

test("login awaits exact credential read-back before completing and preserves the validated deadline", async () => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const now = Math.floor(Date.now() / 1000) * 1000
  vi.useFakeTimers({ now })
  const set = vi.spyOn(f.bao.credentials, "set")
  let release!: (value: string) => void
  const get = vi.spyOn(f.bao.credentials, "get").mockImplementation(() => new Promise((resolve) => { release = resolve }))
  let complete = false
  const pending = f.bao.acceptLogin(auth).then(() => { complete = true })
  await vi.waitFor(() => expect(get).toHaveBeenCalledWith("auth"))
  const payload = JSON.stringify({ token: auth.client_token, expires: now + (week - 1) * 1000 })
  expect(set).toHaveBeenCalledExactlyOnceWith("auth", payload)
  expect(set.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]!)
  expect(complete).toBe(false)
  release(payload)
  await pending
  expect(complete).toBe(true)
})

test.each(["set failure", "missing", "get failure", "empty", "malformed", "token mismatch", "deadline mismatch"])("login rejects credential persistence %s without retrying", async (kind) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const set = vi.spyOn(f.bao.credentials, "set")
  const get = vi.spyOn(f.bao.credentials, "get").mockImplementation(async () => {
    if (kind === "missing") throw new MissingCredential()
    if (kind === "get failure") throw new Error("synthetic-private-keychain-output")
    if (kind === "empty") return ""
    if (kind === "malformed") return "synthetic-malformed-private-value"
    const saved = JSON.parse(f.accounts.get("auth")!)
    return JSON.stringify(kind === "token mismatch" ? { ...saved, token: "synthetic-other-parent" } : { ...saved, expires: saved.expires - 1 })
  })
  if (kind === "set failure") set.mockRejectedValue(new Error("write failed"))
  const diagnostic = kind === "set failure" ? "credential_set" : kind === "missing" ? "credential_read_missing" : kind === "get failure" ? "credential_read" : "credential_mismatch"
  await expect(f.bao.acceptLogin(auth)).rejects.toEqual(new LocalSetupError(diagnostic))
  expect(set).toHaveBeenCalledTimes(1)
  expect(get).toHaveBeenCalledTimes(kind === "set failure" ? 0 : 1)
})

test.each<[Diagnostic, Record<string, unknown>]>([
  ["login_client_token", { client_token: "" }],
])("login preserves safe response diagnostic %s through its broad catch", async (diagnostic, patch) => {
  const f = await fixture(vi.fn<typeof runProcess>(async () => ({ stdout: JSON.stringify({ auth: { ...auth, ...patch } }), stderr: "synthetic-private-url", exitCode: 0 })))
  await expect(f.bao.login(f.options)).rejects.toEqual(new LocalSetupError(diagnostic))
  expect(diagnostics[diagnostic]).not.toContain("synthetic-")
  expect(f.http).not.toHaveBeenCalled()
  expect(f.accounts.has("auth")).toBe(false)
})

test.each(["synthetic-private-invalid-json", "null", "{}", JSON.stringify({ auth: null }), JSON.stringify({ auth: [] }), JSON.stringify({ auth: "synthetic-private-auth" })])("malformed login response fails cleanly: %s", async (stdout) => {
  const f = await fixture(vi.fn<typeof runProcess>(async () => ({ stdout, stderr: "", exitCode: 0 })))
  await expect(f.bao.login(f.options)).rejects.toEqual(new LocalSetupError("login_response"))
  expect(f.http).not.toHaveBeenCalled()
  expect(f.accounts.has("auth")).toBe(false)
})

test.each<[Diagnostic, Record<string, unknown>]>([
  ["lookup_ttl", { ttl: 0 }],
  ["lookup_ttl", { ttl: -1 }],
  ["lookup_ttl", { ttl: "synthetic-private-ttl" }],
  ["lookup_expire_time", { expire_time: "synthetic-private-expiry" }],
  ["lookup_expire_time", { expire_time: null }],
  ["lookup_expire_time", { expire_time: 1 }],
  ["lookup_expire_time", { expire_time: {} }],
  ["lookup_expire_time", { expire_time: [] }],
  ["lookup_expire_time", { expire_time: true }],
  ["lookup_deadline", { expire_time: new Date(1).toISOString() }],
])("login preserves safe self-lookup diagnostic %s through its broad catch", async (diagnostic, patch) => {
  const f = await fixture(vi.fn<typeof runProcess>(async () => ({ stdout: JSON.stringify({ auth }), stderr: "", exitCode: 0 })))
  f.http.mockResolvedValue(Response.json({ data: { ...identity(), ...patch } }))
  await expect(f.bao.login(f.options)).rejects.toEqual(new LocalSetupError(diagnostic))
  expect(diagnostics[diagnostic]).not.toContain("synthetic-")
  expect(f.accounts.has("auth")).toBe(false)
})

test("creation metadata does not enforce a local token policy", async () => {
  const f = await fixture(vi.fn<typeof runProcess>())
  vi.useFakeTimers({ now: Math.floor(Date.now() / 1000) * 1000 })
  f.http.mockResolvedValueOnce(Response.json({ data: { ...identity(), creation_time: Date.now() / 1000 + 2 } }))
  await f.bao.acceptLogin(auth)
  expect(f.writes).toEqual(["auth"])
})

test("server expiry and remaining TTL determine the stored deadline across restart", async () => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const created = Date.UTC(2026, 9, 17)
  const hard = created + week * 1000
  vi.useFakeTimers({ now: created + 11000 })
  f.http.mockImplementation(async () => Response.json({ data: { ...identity(), creation_time: created / 1000, expire_time: new Date(hard + 10000).toISOString() } }))
  await f.bao.acceptLogin(auth)
  const saved = f.accounts.get("auth")!
  expect(JSON.parse(saved)).toEqual({ token: auth.client_token, expires: hard + 10000 })
  expect(await new Bao(settings, f.bao.credentials, f.bao.http).parent()).toBe(auth.client_token)
  expect(f.accounts.get("auth")).toBe(saved)
  vi.setSystemTime(hard + 10000)
  const lookups = f.http.mock.calls.length
  await expect(new Bao(settings, f.bao.credentials, f.bao.http).parent()).rejects.toThrow("Bao unavailable")
  expect(f.http).toHaveBeenCalledTimes(lookups)
})

test("lookup delay cannot extend the before-request TTL deadline", async () => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const observed = Date.UTC(2026, 9, 17)
  vi.useFakeTimers({ now: observed })
  const data = { ...identity(), ttl: 60, expire_time: new Date(observed + 80000).toISOString() }
  f.http.mockImplementation(async () => { vi.setSystemTime(observed + 20000); return Response.json({ data }) })
  await f.bao.acceptLogin(auth)
  expect(JSON.parse(f.accounts.get("auth")!).expires).toBe(observed + 60000)
})

test.each([1600, 2100])("cross-clock expiry gap %i accepts without extending any independent deadline or refreshing persisted auth", async (gap) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const now = Date.UTC(2026, 9, 17)
  vi.useFakeTimers({ now })
  const data = { ...identity(), creation_time: now / 1000 + 0.648, ttl: 60, expire_time: new Date(now + 60000 + gap).toISOString() }
  f.http.mockImplementation(async () => { vi.setSystemTime(Date.now() + 30); return Response.json({ data }) })
  await f.bao.acceptLogin(auth)
  const saved = f.accounts.get("auth")!
  const expires = JSON.parse(saved).expires
  expect(expires).toBe(now + 60000)
  expect(expires).toBeLessThanOrEqual(data.creation_time * 1000 + week * 1000)
  expect(expires).toBeLessThanOrEqual(Date.parse(data.expire_time))
  expect(expires).toBeLessThanOrEqual(now + data.ttl * 1000)
  for (const ttl of [59, 60, 58]) {
    vi.setSystemTime(Date.now() + 500)
    data.ttl = ttl
    expect(await new Bao(settings, f.bao.credentials, f.bao.http).parent()).toBe(auth.client_token)
    expect(f.accounts.get("auth")).toBe(saved)
  }
  expect(f.writes).toEqual(["auth"])
  vi.setSystemTime(expires)
  const lookups = f.http.mock.calls.length
  await expect(f.bao.parent()).rejects.toThrow("Bao unavailable")
  expect(f.http).toHaveBeenCalledTimes(lookups)
})

test.each(["old creation", "current creation"])("far-future server expiry cannot extend observed TTL with %s", async (bound) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const now = Date.UTC(2026, 9, 17)
  vi.useFakeTimers({ now })
  const creation_time = bound === "old creation" ? now / 1000 - week + 30 : now / 1000
  f.http.mockResolvedValue(Response.json({ data: { ...identity(), creation_time, ttl: 60, expire_time: new Date(now + 2 * week * 1000).toISOString() } }))
  await f.bao.acceptLogin(auth)
  expect(JSON.parse(f.accounts.get("auth")!).expires).toBe(now + 60000)
})

test.each([0, -1000])("old creation metadata %i does not override a live server lease", async (offset) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const now = Date.UTC(2026, 9, 17)
  vi.useFakeTimers({ now })
  f.http.mockResolvedValue(Response.json({ data: { ...identity(), creation_time: (now - week * 1000 + offset) / 1000, ttl: 60, expire_time: new Date(now + 60000).toISOString() } }))
  await f.bao.acceptLogin(auth)
  expect(JSON.parse(f.accounts.get("auth")!).expires).toBe(now + 60000)
})

test("earlier server expiry remains the persisted deadline", async () => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const now = Date.UTC(2026, 9, 17)
  vi.useFakeTimers({ now })
  f.http.mockResolvedValue(Response.json({ data: { ...identity(), ttl: 60, expire_time: new Date(now + 30000).toISOString() } }))
  await f.bao.acceptLogin(auth)
  expect(JSON.parse(f.accounts.get("auth")!).expires).toBe(now + 30000)
})

test.each([null, {}, { data: null }, { data: [] }, { data: "synthetic-private-data" }])("malformed self-lookup response fails cleanly: %j", async (response) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  f.http.mockResolvedValue(Response.json(response))
  await expect(f.bao.acceptLogin(auth)).rejects.toEqual(new LocalSetupError("lookup_response"))
  expect(f.writes).toEqual([])
})

test.each(["http", "network", "json"])("self-lookup %s failure identifies the request, not a token field", async (kind) => {
  const f = await fixture(vi.fn<typeof runProcess>(async () => ({ stdout: JSON.stringify({ auth }), stderr: "", exitCode: 0 })))
  if (kind === "network") f.http.mockRejectedValue(new Error("synthetic-private-server-error"))
  else f.http.mockResolvedValue(new Response("synthetic-private-server-error", { status: kind === "http" ? 403 : 200 }))
  await expect(f.bao.login(f.options)).rejects.toEqual(new LocalSetupError(kind === "http" ? "http" : kind === "network" ? "transport" : "response_json", "parent", kind === "http" ? 403 : undefined))
  expect(f.accounts.has("auth")).toBe(false)
})

test.each(["credential_set", "credential_read_missing", "credential_read", "credential_mismatch"] as const)("login preserves %s without exposing credential output", async (diagnostic) => {
  const f = await fixture(vi.fn<typeof runProcess>(async () => ({ stdout: JSON.stringify({ auth }), stderr: "", exitCode: 0 })))
  const get = f.bao.credentials.get.bind(f.bao.credentials)
  const set = f.bao.credentials.set.bind(f.bao.credentials)
  vi.spyOn(f.bao.credentials, "set").mockImplementation(async (account, value) => {
    if (account === "auth" && diagnostic === "credential_set") throw new Error("synthetic-private-keychain-output")
    await set(account, value)
  })
  vi.spyOn(f.bao.credentials, "get").mockImplementation(async (account) => {
    if (account !== "auth") return get(account)
    if (diagnostic === "credential_read_missing") throw new MissingCredential()
    if (diagnostic === "credential_read") throw new Error("synthetic-private-keychain-output")
    return "synthetic-private-other-credential"
  })
  await expect(f.bao.login(f.options)).rejects.toEqual(new LocalSetupError(diagnostic))
})

test("unrecognized identity-stage exceptions remain generic and parent validation preserves known reasons", async () => {
  const f = await fixture(vi.fn<typeof runProcess>(async () => ({ stdout: JSON.stringify({ auth }), stderr: "", exitCode: 0 })))
  vi.spyOn(f.bao, "acceptLogin").mockRejectedValue(new Error("synthetic-private-exception"))
  await expect(f.bao.login(f.options)).rejects.toEqual(new LocalSetupError("identity"))
  f.accounts.set("auth", JSON.stringify({ token: auth.client_token, expires: Date.now() + week * 1000 }))
  f.http.mockResolvedValue(Response.json({ data: { ...identity(), ttl: 0 } }))
  await expect(f.bao.parent()).rejects.toEqual(new LocalSetupError("lookup_ttl"))
})

test.each(["lookup", "save", "read-back"])("cancellation during %s cannot complete login or continue credential operations", async (stage) => {
  const controller = new AbortController()
  const f = await fixture(vi.fn<typeof runProcess>(async () => ({ stdout: JSON.stringify({ auth }), stderr: "", exitCode: 0 })))
  if (stage === "lookup") f.http.mockImplementation(async () => { controller.abort(); return Response.json({ data: identity() }) })
  const set = vi.spyOn(f.bao.credentials, "set")
  const get = vi.spyOn(f.bao.credentials, "get")
  if (stage === "save") set.mockImplementation(async (account, value) => { f.writes.push(account); f.accounts.set(account, value); if (account === "auth") controller.abort() })
  if (stage === "read-back") get.mockImplementation(async (account) => { if (!f.accounts.has(account)) throw new MissingCredential(); if (account === "auth") controller.abort(); return f.accounts.get(account)! })
  await expect(f.bao.login({ ...f.options, signal: controller.signal })).rejects.toEqual(new LocalSetupError("identity"))
  expect(f.writes.filter((account) => account === "auth")).toHaveLength(stage === "lookup" ? 0 : 1)
  expect(get.mock.calls.filter(([account]) => account === "auth")).toHaveLength(stage === "read-back" ? 1 : 0)
})

test("invalid login auth and identity cannot write or read back credentials", async () => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const set = vi.spyOn(f.bao.credentials, "set")
  const get = vi.spyOn(f.bao.credentials, "get")
  await expect(f.bao.acceptLogin({ ...auth, client_token: "" })).rejects.toThrow("Bao unavailable")
  expect(f.http).not.toHaveBeenCalled()
  f.http.mockResolvedValue(Response.json({ data: { policies: ["root"] } }))
  await expect(f.bao.acceptLogin(auth)).rejects.toThrow("Bao unavailable")
  expect(set).not.toHaveBeenCalled()
  expect(get).not.toHaveBeenCalled()
})

test.each([null, "batch", "", 1, true, [], {}])("CLI token_type metadata %j does not gate usable credentials", async (token_type) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  await f.bao.acceptLogin({ ...auth, token_type })
  expect(f.http).toHaveBeenCalledTimes(1)
  expect(f.writes).toEqual(["auth"])
})

test.each([undefined, "batch", null])("server token type %j remains server policy", async (type) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  f.http.mockResolvedValue(Response.json({ data: { ...identity(), type } }))
  const get = vi.spyOn(f.bao.credentials, "get")
  await f.bao.acceptLogin(auth)
  expect(f.http).toHaveBeenCalledTimes(1)
  expect(f.writes).toEqual(["auth"])
  expect(get).toHaveBeenCalledWith("auth")
})

test.each([undefined, "service"])("CLI token_type %j and null identity policies accept a usable server lease", async (token_type) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  await f.bao.acceptLogin({ ...auth, token_type })
  expect(f.writes).toEqual(["auth"])
  expect(await f.bao.credentials.get("auth")).toBe(f.accounts.get("auth"))
})

test.each([60, week * 2])("actual server lease %i seconds sets expiry without a fixed parent lifetime", async (ttl) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const now = Date.UTC(2026, 9, 17)
  vi.useFakeTimers({ now })
  f.http.mockImplementation(async () => Response.json({ data: { ttl, expire_time: new Date(now + ttl * 1000).toISOString(), policies: ["root", "default"], type: "batch", meta: { role: "custom" } } }))
  await f.bao.acceptLogin({ ...auth, lease_duration: 1, token_policies: ["admin"] })
  expect(JSON.parse(f.accounts.get("auth")!).expires).toBe(now + ttl * 1000)
  await f.bao.parent()
  expect(f.writes).toEqual(["auth"])
})

test("configured OIDC role replaces the backwards-compatible login default", async () => {
  const run = vi.fn<typeof runProcess>(async () => ({ stdout: JSON.stringify({ auth }), stderr: "", exitCode: 0 }))
  const f = await fixture(run)
  await new Bao({ ...settings, oidcRole: "custom-login" }, f.bao.credentials, f.bao.http, run).login(f.options)
  expect(run.mock.calls[0]![1]).toContain("role=custom-login")
})

test.each([undefined, null, ""])("server-confirmed non-expiring parent with expiry %j persists across restart and still checks revocation", async (expire_time) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  f.http.mockImplementation(async () => Response.json({ data: { ttl: 0, expire_time, policies: ["root"] } }))
  await f.bao.acceptLogin({ client_token: auth.client_token, lease_duration: 0 })
  const saved = f.accounts.get("auth")!
  expect(JSON.parse(saved)).toEqual({ token: auth.client_token, expires: null })
  const restarted = new Bao(settings, f.bao.credentials, f.bao.http)
  expect(await restarted.parent()).toBe(auth.client_token)
  expect(f.accounts.get("auth")).toBe(saved)
  expect(f.writes).toEqual(["auth"])
  f.http.mockResolvedValue(new Response("denied", { status: 403 }))
  await expect(restarted.parent()).rejects.toThrow("Bao unavailable")
})

test("non-expiring self-lookup cannot extend a saved finite auth deadline", async () => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const now = Date.UTC(2026, 9, 17)
  vi.useFakeTimers({ now })
  f.http.mockResolvedValue(Response.json({ data: { ttl: 60, expire_time: new Date(now + 60000).toISOString() } }))
  await f.bao.acceptLogin(auth)
  const saved = f.accounts.get("auth")!
  f.http.mockResolvedValue(Response.json({ data: { ttl: 0, expire_time: null } }))
  expect(await f.bao.parent()).toBe(auth.client_token)
  expect(f.accounts.get("auth")).toBe(saved)
  vi.setSystemTime(now + 60000)
  const calls = f.http.mock.calls.length
  await expect(f.bao.parent()).rejects.toThrow("Bao unavailable")
  expect(f.http).toHaveBeenCalledTimes(calls)
})

test.each([null, undefined])("legacy expected identity policies do not gate CLI metadata %j", async (identity_policies) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const bao = new Bao({ ...settings, parentIdentityPolicies: ["opencode-identity"] }, f.bao.credentials, f.bao.http)
  await bao.acceptLogin({ ...auth, identity_policies })
  expect(f.http).toHaveBeenCalledTimes(1)
  expect(f.writes).toEqual(["auth"])
})

test.each([{}, "", false, 0, ["opencode-identity", "opencode-identity"], ["admin"], ["root"], ["default"]])("CLI identity policy metadata %j remains server policy", async (identity_policies) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  await f.bao.acceptLogin({ ...auth, identity_policies })
  expect(f.http).toHaveBeenCalledTimes(1)
  expect(f.writes).toEqual(["auth"])
})

test.each([null, ["opencode-identity"], ["admin"], ["root"], ["default"], ["opencode-identity", "opencode-identity"]])("server identity policy metadata %j does not gate login", async (identity_policies) => {
  const f = await fixture(vi.fn<typeof runProcess>())
  f.http.mockResolvedValue(Response.json({ data: { ...identity(), identity_policies } }))
  await f.bao.acceptLogin(auth)
  expect(f.writes).toEqual(["auth"])
})

test("legacy expected identity policies do not gate CLI or lookup metadata", async () => {
  const f = await fixture(vi.fn<typeof runProcess>())
  const identity_policies = ["opencode-identity"]
  const bao = new Bao({ ...settings, parentIdentityPolicies: identity_policies }, f.bao.credentials, f.bao.http)
  const cliAuth = { ...auth, identity_policies, policies: [...auth.policies, ...identity_policies] }
  await bao.acceptLogin(cliAuth)
  expect(f.writes).toEqual(["auth"])
  f.http.mockResolvedValue(Response.json({ data: { ...identity(), identity_policies } }))
  await bao.acceptLogin(cliAuth)
  expect(f.writes).toEqual(["auth", "auth"])
})

test.each([undefined, null, {}, [], true, "authenticated", { authenticated: false }, { authenticated: "true" }, { type: "unavailable", message: "synthetic-private-value" }, { authenticated: true, error: "synthetic-private-value" }, Object.assign(Object.create({ authenticated: true }), { other: true })])("TUI rejects malformed resolved login response %j without a success notification", async (result) => {
  const login = vi.fn(async () => result)
  const toast = vi.fn()
  let commands: any[] = []
  const cleanup = await tui.setup({
    client: { rpc: () => ({ login }) }, location: { directory: "/project" },
    keymap: { layer: (factory: Function) => { commands = factory().commands } },
    ui: { toast: { show: toast } },
  } as any)
  try {
    await commands.find((entry) => entry.id === "bao.login").run()
    expect(login).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls.map(([value]) => value.variant)).toEqual(["info", "error"])
    expect(toast.mock.lastCall![0].message).toContain("do not reset existing state")
    expect(JSON.stringify(toast.mock.calls)).not.toContain("synthetic-private-value")
  } finally { await cleanup?.() }
})

test("TUI login is a discoverable explicit action; other actions never sign in and errors reveal no raw output", async () => {
  const login = vi.fn(async () => ({ authenticated: true }))
  const status = vi.fn(async () => { throw new Error("synthetic-token-and-url") })
  const toast = vi.fn()
  let commands: any[] = []
  const cleanup = await tui.setup({
    client: { rpc: () => ({ login, status }) }, location: { directory: "/project" },
    keymap: { layer: (factory: Function) => { commands = factory().commands } },
    ui: { toast: { show: toast }, router: { current: () => ({ type: "session", sessionID: "a" }) } },
  } as any)
  expect(login).not.toHaveBeenCalled()
  const command = commands.find((entry) => entry.id === "bao.login")
  expect(command).toMatchObject({ title: "Bao login", palette: true, slash: { name: "bao-login" } })
  await commands.find((entry) => entry.id === "bao.bundles").run()
  expect(login).not.toHaveBeenCalled()
  expect(JSON.stringify(toast.mock.calls)).toContain("/bao-login")
  await command.run()
  expect(login).toHaveBeenCalledTimes(1)
  expect(login.mock.calls[0]).toMatchObject([{}, { location: { directory: "/project" } }])
  expect(JSON.stringify(toast.mock.calls)).toContain("Bao login complete")
  login.mockRejectedValue(new Error("synthetic-token-and-url"))
  await command.run()
  expect(JSON.stringify(toast.mock.calls)).not.toContain("synthetic-token-and-url")
  expect(JSON.stringify(toast.mock.calls)).toContain("do not reset existing state")
  for (const diagnostic of Object.keys(diagnostics) as (keyof typeof diagnostics)[]) {
    // Actual pinned promise RPC failure shape (Rpc.MethodError), not Error.message.
    login.mockRejectedValueOnce({ type: "unavailable", message: "synthetic-token-and-url", data: { diagnostic } })
    await command.run()
    expect(toast.mock.lastCall![0].message).toBe(diagnostics[diagnostic])
  }
  expect(JSON.stringify(toast.mock.calls)).not.toContain("synthetic-token-and-url")
  const count = login.mock.calls.length
  let release!: () => void
  login.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ authenticated: true }) }))
  const pending = command.run()
  await command.run()
  expect(login).toHaveBeenCalledTimes(count + 1)
  release()
  await pending
  await cleanup?.()
  expect((login.mock.calls[count] as any)[1].signal.aborted).toBe(true)
})
