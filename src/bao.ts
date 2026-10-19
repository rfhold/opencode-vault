import { homedir } from "node:os"
import { join } from "node:path"
import { lstat, readFile, realpath, stat } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { Sessions } from "./state"
import { validateEnvironment } from "./environment"
import { runProcess } from "./process"
import { LocalSetupError, type Stage } from "./diagnostics"

export const root = join(homedir(), ".config", "opencode-bao")
export const stateRoot = join(homedir(), ".local", "share", "opencode-bao", "sessions")
export const week = 604800
export type Config = { address: string; mount: string; prefix: string; oidc: string; oidcRole?: string; bao: string; catalogRole: string; readRole: string; parentTokenPolicies?: string[]; parentIdentityPolicies?: string[] }
const safe = /^[a-zA-Z0-9_-]+$/
export const bundlePattern = "^[A-Za-z0-9][A-Za-z0-9._-]*$"
export const validBundle = (name: unknown): name is string => typeof name === "string" && new RegExp(bundlePattern).test(name)
const denied = () => new Error("Bao unavailable; use /bao-login or check trusted configuration")
let loggingIn = false
export class LoginBusy extends Error {}

export async function config(directory = root): Promise<Config> {
  try {
    const trusted = async (path: string) => {
      const link = await lstat(path)
      if (link.uid !== process.getuid!()) throw new LocalSetupError("permissions")
      const resolved = await realpath(path)
      const info = await stat(resolved)
      if (info.uid !== process.getuid!() || (info.mode & 0o022)) throw new LocalSetupError("permissions")
      return resolved
    }
    const resolved = await trusted(directory)
    const file = await trusted(join(resolved, "config.json"))
    const raw = JSON.parse(await readFile(file, "utf8"))
    return parseConfig(raw)
  } catch (error) {
    if (error instanceof LocalSetupError) throw error
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LocalSetupError("missing")
    if (error instanceof SyntaxError) throw new LocalSetupError("json")
    throw new LocalSetupError("permissions")
  }
}

export function parseConfig(raw: any): Config {
  try {
    const result: Config = {
      address: raw.address ?? "https://openbao.holdenitdown.net", mount: raw.mount ?? "kv",
      prefix: raw.prefix ?? "env", oidc: raw.oidc ?? "oidc", bao: raw.bao ?? "/opt/homebrew/bin/bao", catalogRole: raw.catalogRole, readRole: raw.readRole,
      parentTokenPolicies: raw.parentTokenPolicies, parentIdentityPolicies: raw.parentIdentityPolicies,
      ...(raw.oidcRole === undefined ? {} : { oidcRole: raw.oidcRole }),
    }
    const url = new URL(result.address)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw denied()
    if (![result.mount, result.prefix, result.oidc].every((part) => typeof part === "string" && safe.test(part))) throw denied()
    if (typeof result.bao !== "string" || !result.bao.startsWith("/") || /[\r\n\0]/.test(result.bao)) throw new LocalSetupError("executable")
    if (Object.hasOwn(raw, "bundles")) throw new LocalSetupError("schema")
    if (![result.catalogRole, result.readRole, result.oidcRole ?? "opencode"].every((role) => typeof role === "string" && safe.test(role))) throw denied()
    return result
  } catch (error) { throw error instanceof LocalSetupError ? error : new LocalSetupError("schema") }
}

export interface Credentials { get(account: string): Promise<string>; set(account: string, value: string): Promise<void> }
export class MissingCredential extends Error {}
export const keychain: Credentials = {
  async get(account) {
    const child = await runProcess("/usr/bin/security", ["find-generic-password", "-s", "opencode-bao", "-a", account, "-w"], { timeout: 15000, maxBytes: 65536, stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: homedir() } }).catch(() => { throw denied() })
    const value = child.stdout.trim()
    if (child.exitCode === 44) throw new MissingCredential()
    if (child.exitCode !== 0 || !value) throw denied()
    return value
  },
  async set(account, value) {
    const child = await runProcess("/usr/bin/security", ["add-generic-password", ...(account === "auth" ? ["-U"] : []), "-s", "opencode-bao", "-a", account, "-w", value], { timeout: 15000, stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: homedir() } }).catch(() => { throw denied() })
    if (child.exitCode !== 0) throw denied()
  },
}

type Auth = { token: string; expires: number | null }
export class Bao {
  constructor(readonly settings: Config, readonly credentials: Credentials = keychain, readonly http: typeof fetch = fetch, readonly run = runProcess) {}

  private async api(path: string, token: string, body?: unknown, signal?: AbortSignal, method = body === undefined ? "GET" : "POST", stage: Stage = "parent") {
    try {
      const url = new URL(`${this.settings.address.replace(/\/$/, "")}/v1/${path}`)
      if (method === "LIST") url.searchParams.set("list", "true")
      const response = await this.http(url.toString(), {
        method: method === "LIST" ? "GET" : method, headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      })
      if (method === "LIST" && response.status === 404) return { data: { keys: [] } }
      if (!response.ok) throw new LocalSetupError("http", stage, response.status)
      try { return await response.json() as any }
      catch { throw new LocalSetupError("response_json", stage) }
    } catch (error) { throw error instanceof LocalSetupError ? error : new LocalSetupError("transport", stage) }
  }

  async parent() {
    let auth: Auth
    try { auth = JSON.parse(await this.credentials.get("auth")) } catch { throw new LocalSetupError("stored_login") }
    if (typeof auth?.token !== "string" || !auth.token || (auth.expires !== null && (typeof auth.expires !== "number" || !Number.isFinite(auth.expires) || auth.expires <= Date.now()))) throw new LocalSetupError("stored_login")
    try {
      const expires = await this.identity(auth.token)
      if (expires !== null && expires <= Date.now()) throw new LocalSetupError("stored_login")
    } catch (error) { throw error instanceof LocalSetupError ? error : new LocalSetupError("lookup_request") }
    return auth.token
  }

  private async identity(token: string, signal?: AbortSignal) {
    const observed = Date.now()
    let response
    try { response = await this.api("auth/token/lookup-self", token, undefined, signal) } catch (error) { throw error instanceof LocalSetupError ? error : new LocalSetupError("lookup_request") }
    signal?.throwIfAborted()
    const info = response?.data
    if (!info || typeof info !== "object" || Array.isArray(info)) throw new LocalSetupError("lookup_response")
    if (info.ttl === 0 && (info.expire_time === undefined || info.expire_time === null || info.expire_time === "")) return null
    if (!Number.isFinite(info.ttl) || info.ttl <= 0) throw new LocalSetupError("lookup_ttl")
    const expiry = typeof info.expire_time === "string" ? Date.parse(info.expire_time) : NaN
    if (!Number.isFinite(expiry)) throw new LocalSetupError("lookup_expire_time")
    const deadline = Math.min(expiry, observed + info.ttl * 1000)
    if (deadline <= Date.now()) throw new LocalSetupError("lookup_deadline")
    return deadline
  }

  private async grant<T>(role: string, work: (token: string) => Promise<T>): Promise<T> {
    const parent = await this.parent()
    const grant = await this.api(`auth/token/create/${encodeURIComponent(role)}`, parent, {
      ttl: "60s", explicit_max_ttl: "60s", renewable: false, no_default_policy: true,
      display_name: "opencode-bao", type: "service",
    }, undefined, "POST", "grant")
    const token = grant?.auth?.client_token
    if (typeof token !== "string" || !token) throw new LocalSetupError("grant_response", "grant")
    try {
      return await work(token)
    } finally {
      await this.api("auth/token/revoke-self", token, {}, undefined, "POST", "revoke").catch(() => {})
    }
  }

  async catalog(): Promise<string[]> {
    return this.grant(this.settings.catalogRole, async (token) => {
      const value = await this.api(`${this.settings.mount}/metadata/${this.settings.prefix}`, token, undefined, undefined, "LIST", "catalog")
      const keys = value?.data?.keys
      if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) throw new LocalSetupError("catalog_response", "catalog")
      const names: string[] = []
      for (const key of keys) {
        if (key.endsWith("/")) continue
        if (!validBundle(key)) throw new LocalSetupError("catalog_response", "catalog")
        names.push(key)
      }
      return [...new Set(names)].sort()
    })
  }

  async bundle(name: string) {
    if (!validBundle(name)) throw new Error("Unknown Bao bundle")
    return this.grant(this.settings.readRole, async (token) => {
      const value = await this.api(`${this.settings.mount}/data/${this.settings.prefix}/${encodeURIComponent(name)}`, token, undefined, undefined, "GET", "bundle")
      const data = value?.data?.data
      try { validateEnvironment(data) } catch { throw new LocalSetupError("environment", "bundle") }
      const result: Record<string, string> = {}
      for (const [key, value] of Object.entries(data)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || /[\r\n\0]/.test(value)) throw new LocalSetupError("environment", "bundle")
        Object.defineProperty(result, key, { value: value.replaceAll("${HOME}", homedir()).replaceAll("$HOME", homedir()), enumerable: true })
      }
      return result
    })
  }

  async login(options: { signal?: AbortSignal; directory?: string } = {}) {
    if (loggingIn) throw new LoginBusy("Bao login already in progress")
    loggingIn = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 180000)
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])])
    let stage: "executable" | "storage" | "authentication" | "identity" = "executable"
    try {
      signal.throwIfAborted()
      if (process.platform !== "darwin") throw denied()
      const path = await realpath(this.settings.bao)
      const executable = await stat(path)
      if (!executable.isFile() || !(executable.mode & 0o111)) throw denied()
      stage = "storage"
      await initialize(this.credentials, options.directory ?? stateRoot)
      stage = "authentication"
      signal.throwIfAborted()
      const child = await this.run(path, ["login", "-non-interactive", "-no-store", "-format=json", "-method=oidc", `-path=${this.settings.oidc}`, `role=${this.settings.oidcRole ?? "opencode"}`, "skip_browser=false", "abort_on_error=true"], {
        stderr: "ignore", signal, timeout: 120000, maxBytes: 1048576,
        env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: homedir(), BAO_ADDR: this.settings.address },
      })
      signal.throwIfAborted()
      if (child.exitCode !== 0) throw denied()
      stage = "identity"
      let response
      try { response = JSON.parse(child.stdout) } catch { throw new LocalSetupError("login_response") }
      await this.acceptLogin(response?.auth, signal)
      signal.throwIfAborted()
    } catch (error) { throw !signal.aborted && error instanceof LocalSetupError ? error : new LocalSetupError(stage) } finally {
      clearTimeout(timer)
      loggingIn = false
    }
  }

  async acceptLogin(auth: { client_token?: unknown; lease_duration?: unknown; token_type?: unknown; token_policies?: unknown; identity_policies?: unknown; policies?: unknown }, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new LocalSetupError("login_response")
    if (typeof auth.client_token !== "string" || !auth.client_token) throw new LocalSetupError("login_client_token")
    const expires = await this.identity(auth.client_token, signal)
    signal?.throwIfAborted()
    const payload = JSON.stringify({ token: auth.client_token, expires })
    try { await this.credentials.set("auth", payload) } catch { throw new LocalSetupError("credential_set") }
    signal?.throwIfAborted()
    let saved
    try { saved = await this.credentials.get("auth") } catch (error) { throw new LocalSetupError(error instanceof MissingCredential ? "credential_read_missing" : "credential_read") }
    signal?.throwIfAborted()
    if (saved !== payload) throw new LocalSetupError("credential_mismatch")
  }
}

export async function encryptionKey(credentials = keychain) {
  if (await credentials.get("initialized") !== "v1") throw denied()
  const value = await credentials.get("snapshot-key")
  const key = Buffer.from(value, "base64")
  if (key.length !== 32) throw denied()
  return key
}

export function readiness(credentials = keychain, directory = stateRoot) {
  let protectedState = false
  const probe = async () => {
    if (protectedState) return true
    try { await lstat(directory); protectedState = true; return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw denied() }
    const get = async (account: string) => {
      try {
        const value = await credentials.get(account)
        protectedState = true
        return value
      }
      catch (error) { if (error instanceof MissingCredential) return undefined; throw error }
    }
    await Promise.all([get("initialized"), get("snapshot-key")])
    // Once any anchor is observed, normal reads must validate every anchor forever.
    return protectedState
  }
  return probe
}

export async function initialize(credentials = keychain, directory = stateRoot) {
  const get = async (account: string) => {
    try { return await credentials.get(account) } catch (error) { if (error instanceof MissingCredential) return undefined; throw error }
  }
  const marker = await get("initialized")
  const key = await get("snapshot-key")
  let exists = false
  try { await stat(directory); exists = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw denied() }
  if (marker !== undefined || key !== undefined || exists) {
    if (marker !== "v1" || !key) throw denied()
    await new Sessions(directory, () => encryptionKey(credentials)).read("initialization-check")
    return
  }
  await credentials.set("initialized", "v1")
  await credentials.set("snapshot-key", randomBytes(32).toString("base64"))
  await new Sessions(directory, () => encryptionKey(credentials)).initialize()
}
