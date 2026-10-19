import { expect, test, vi } from "vitest"
import { Bao, parseConfig, week, validBundle, type Config } from "../src/bao"
import tui from "../src/tui"

const settings: Config = { address: "https://bao.invalid", mount: "kv", prefix: "env", oidc: "oidc", bao: "/not-used", catalogRole: "opencode-env-catalog", readRole: "opencode-env-read", parentTokenPolicies: ["opencode-parent"], parentIdentityPolicies: [] }
function fixture() {
  let keys: unknown = ["zeta", "new.bundle-1", "alpha", "alpha", "nested/"]
  let role = ""
  let failed = false
  let wrongPath = false
  let absent = false
  let grantMetadata: Record<string, unknown> = {}
  const calls: { path: string; query: string; method: string; token: string; body: any }[] = []
  const http = (async (url: string, init: RequestInit) => {
    const parsed = new URL(url)
    const path = parsed.pathname.replace("/v1/", "")
    const token = (init.headers as Record<string, string>)["X-Vault-Token"]!
    calls.push({ path, query: parsed.search, token, method: init.method!, body: init.body ? JSON.parse(init.body as string) : undefined })
    if (path === "auth/token/lookup-self" && token === "parent") return Response.json({ data: { creation_time: Math.floor(Date.now() / 1000), creation_ttl: week, explicit_max_ttl: week, ttl: week - 1, expire_time: new Date(Math.floor(Date.now() / 1000) * 1000 + week * 1000).toISOString(), meta: { role: "opencode" }, policies: ["opencode-parent"], identity_policies: [], type: "service" } })
    if (path.startsWith("auth/token/create/")) {
      role = path.split("/").at(-1)!
      return Response.json({ auth: { client_token: `child-${role}`, lease_duration: 60, renewable: false, orphan: false, token_type: "service", policies: [role], ...grantMetadata } })
    }
    if (path === "auth/token/lookup-self") return Response.json({ data: { path: `auth/token/create/${wrongPath ? "other" : role}`, orphan: false, renewable: false, explicit_max_ttl: 60 } })
    if (path === "auth/token/revoke-self") return Response.json({})
    if (failed) return Response.json({ errors: ["synthetic-private-server-error"] }, { status: 403 })
    if (path === "kv/metadata/env" && init.method === "GET" && parsed.search === "?list=true") return absent ? Response.json({}, { status: 404 }) : Response.json({ data: { keys } })
    if (path === "kv/data/env/new.bundle-1") return Response.json({ data: { data: { SECRET: "synthetic-selected-secret" } } })
    return Response.json({}, { status: 404 })
  }) as typeof fetch
  const bao = new Bao(settings, { get: async () => JSON.stringify({ token: "parent", expires: Date.now() + 10000 }), set: async () => {} }, http)
  return { bao, calls, keys: (value: unknown) => { keys = value }, grant: (value: Record<string, unknown>) => { grantMetadata = value }, fail: () => { failed = true }, wrongPath: () => { wrongPath = true }, absent: () => { absent = true } }
}

test("catalog dynamically lists only names with a separate exact LIST grant, then reads only an explicitly selected document", async () => {
  const f = fixture()
  expect(await f.bao.catalog()).toEqual(["alpha", "new.bundle-1", "zeta"])
  expect(f.calls.filter((call) => call.path.includes("/data/"))).toEqual([])
  expect(f.calls.filter((call) => call.path.includes("/metadata/"))).toEqual([expect.objectContaining({ path: "kv/metadata/env", query: "?list=true", method: "GET", token: "child-opencode-env-catalog", body: undefined })])
  expect(f.calls.find((call) => call.path.includes("/create/"))).toMatchObject({ path: "auth/token/create/opencode-env-catalog", body: { ttl: "60s", explicit_max_ttl: "60s", renewable: false, no_default_policy: true, type: "service" } })
  expect(f.calls.at(-1)).toMatchObject({ path: "auth/token/revoke-self", token: "child-opencode-env-catalog" })
  f.keys(["added_now", "new.bundle-1"])
  expect(await f.bao.catalog()).toEqual(["added_now", "new.bundle-1"])
  expect(await f.bao.bundle("new.bundle-1")).toEqual({ SECRET: "synthetic-selected-secret" })
  expect(f.calls.filter((call) => call.path.includes("/data/"))).toEqual([expect.objectContaining({ path: "kv/data/env/new.bundle-1", query: "", method: "GET", token: "child-opencode-env-read" })])
  expect(f.calls.filter((call) => call.path.startsWith("auth/"))).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "auth/token/lookup-self", query: "", method: "GET", token: "parent" }),
    expect.objectContaining({ path: "auth/token/create/opencode-env-catalog", query: "", method: "POST", token: "parent" }),
    expect.objectContaining({ path: "auth/token/revoke-self", query: "", method: "POST", token: "child-opencode-env-catalog" }),
  ]))
  expect(f.calls.filter((call) => call.query)).toEqual(f.calls.filter((call) => call.path === "kv/metadata/env"))
  expect(f.calls.at(-1)).toMatchObject({ path: "auth/token/revoke-self", token: "child-opencode-env-read" })
})

test("malformed catalog and denied reads revoke without leaking server data", async () => {
  for (const keys of [null, {}, "private-value", [1], [".."], ["../escape"], ["x*y"], ["a/b"]]) {
    const f = fixture()
    f.keys(keys)
    await expect(f.bao.catalog()).rejects.toThrow("Bao unavailable")
    expect(f.calls.at(-1)?.path).toBe("auth/token/revoke-self")
    expect(f.calls.some((call) => call.path.includes("/data/"))).toBe(false)
  }
  for (const operation of ["catalog", "bundle"] as const) {
    const f = fixture()
    f.fail()
    await expect(operation === "catalog" ? f.bao.catalog() : f.bao.bundle("new.bundle-1")).rejects.toMatchObject({ diagnostic: "http", stage: operation === "catalog" ? "catalog" : "bundle", httpStatus: 403 })
    expect(f.calls.at(-1)?.path).toBe("auth/token/revoke-self")
    if (operation === "catalog") {
      expect(f.calls.filter((call) => call.path.includes("/metadata/"))).toEqual([expect.objectContaining({ method: "GET", query: "?list=true" })])
      expect(f.calls.some((call) => call.path.includes("/data/"))).toBe(false)
    }
  }
  const f = fixture()
  f.wrongPath()
  expect(await f.bao.catalog()).toEqual(["alpha", "new.bundle-1", "zeta"])
  expect(f.calls.some((call) => call.token.startsWith("child-") && call.path === "auth/token/lookup-self")).toBe(false)
  expect(f.calls.at(-1)?.path).toBe("auth/token/revoke-self")
})

test("empty and absent KV prefixes return an empty catalog and revoke the catalog grant", async () => {
  const f = fixture()
  f.keys([])
  expect(await f.bao.catalog()).toEqual([])
  f.absent()
  expect(await f.bao.catalog()).toEqual([])
  expect(f.calls.filter((call) => call.path.includes("/metadata/"))).toHaveLength(2)
  expect(f.calls.filter((call) => call.path.includes("/metadata/")).every((call) => call.method === "GET" && call.query === "?list=true")).toBe(true)
  expect(f.calls.filter((call) => call.path === "auth/token/revoke-self")).toHaveLength(2)
  await expect(f.bao.bundle("missing")).rejects.toThrow("Bao unavailable")
  expect(f.calls.at(-2)).toMatchObject({ path: "kv/data/env/missing", method: "GET", query: "" })
  expect(f.calls.at(-1)).toMatchObject({ path: "auth/token/revoke-self", token: "child-opencode-env-read" })
})

test.each([undefined, null, "server-metadata", -1, 0, 1800])("server-issued child metadata and lifetime %j do not enforce plugin authorization policy", async (lease_duration) => {
  const f = fixture()
  f.grant({ lease_duration, renewable: true, orphan: true, token_type: "batch", policies: ["root", "default", "admin"] })
  expect(await f.bao.catalog()).toEqual(["alpha", "new.bundle-1", "zeta"])
  expect(await f.bao.bundle("new.bundle-1")).toEqual({ SECRET: "synthetic-selected-secret" })
  expect(f.calls.filter((call) => call.path === "auth/token/revoke-self")).toHaveLength(2)
  expect(f.calls.filter((call) => call.path === "auth/token/lookup-self").every((call) => call.token === "parent")).toBe(true)
})

test("legacy maps and invalid endpoint role syntax fail; role names and policy belong to Bao", () => {
  expect(() => parseConfig({ ...settings, bundles: {} })).toThrow("replace the old bundles map")
  for (const role of [undefined, "", "../read", "with/slash", "a*b"]) {
    expect(() => parseConfig({ ...settings, readRole: role })).toThrow("Bao configuration unavailable")
  }
  expect(parseConfig(settings)).toEqual(settings)
  for (const role of ["admin", "default", "root", settings.catalogRole]) expect(parseConfig({ ...settings, readRole: role }).readRole).toBe(role)
  expect(parseConfig({ ...settings, parentTokenPolicies: undefined, parentIdentityPolicies: undefined }).catalogRole).toBe(settings.catalogRole)
  expect(parseConfig({ ...settings, oidcRole: "custom-login" }).oidcRole).toBe("custom-login")
  for (const name of [".", "..", "../x", "a/b", "a*", "a%2fb", "", "_hidden"]) expect(validBundle(name)).toBe(false)
  for (const name of ["a", "new.bundle-1", "a_b"]) expect(validBundle(name)).toBe(true)
})

test("empty catalog has an actionable TUI message instead of an empty select", async () => {
  let commands: any[] = []
  const select = vi.fn()
  const toast = vi.fn()
  await tui.setup({ client: { rpc: () => ({ status: async () => ({ sessionID: "a", version: 0, bundles: [], protectedValues: 0 }) }) }, location: { directory: "/project" }, keymap: { layer: (factory: Function) => { commands = factory().commands } }, ui: { toast: { show: toast }, dialog: { select }, router: { current: () => ({ type: "session", sessionID: "a" }) } } } as any)
  await commands.find((command) => command.id === "bao.bundles").run()
  expect(select).not.toHaveBeenCalled()
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("No Bao bundles found") }))
})
