import { expect, test, vi } from "vitest"
import { Bao, MissingCredential, type Config } from "../src/bao"
import { LocalSetupError, rpcDiagnostic, failureData } from "../src/diagnostics"

const settings: Config = { address: "https://bao.invalid", mount: "kv", prefix: "env", oidc: "oidc", bao: "/not-used", catalogRole: "catalog", readRole: "read" }
const privateText = "synthetic-private-token-secret-protectedkey-serverbody-stderr"

test.each(["parent", "grant", "catalog", "bundle"] as const)("%s identifies HTTP status, transport and unreadable JSON without leaking response data", async (stage) => {
  for (const kind of [403, 404, "transport", "timeout", "json", "document"] as const) {
    const paths: string[] = []
    const http = vi.fn(async (url: string) => {
      const path = new URL(url).pathname
      paths.push(path)
      const target = stage === "parent" ? "lookup-self" : stage === "grant" ? "create/" : stage === "catalog" ? "metadata/" : "data/"
      if (path.includes(target)) {
        if (kind === "transport") throw new Error(privateText)
        if (kind === "timeout") throw new DOMException(privateText, "TimeoutError")
        if (typeof kind === "number") return new Response(privateText, { status: kind })
        if (kind === "json") return new Response(privateText)
        return Response.json({ data: { data: { [privateText]: [privateText] } } })
      }
      if (path.endsWith("lookup-self")) return Response.json({ data: { ttl: 0, expire_time: null } })
      if (path.includes("create/")) return Response.json({ auth: { client_token: privateText } })
      return Response.json({})
    })
    const bao = new Bao(settings, { get: async () => JSON.stringify({ token: privateText, expires: null }), set: async () => {} }, http as typeof fetch)
    // Metadata 404 remains the established empty-catalog success case.
    if (stage === "catalog" && kind === 404) {
      expect(await bao.catalog()).toEqual([])
    } else {
      let error: unknown
      try { await (stage === "catalog" ? bao.catalog() : bao.bundle("selected")) } catch (caught) { error = caught }
      const diagnostic = typeof kind === "number" ? "http" : kind === "transport" || kind === "timeout" ? "transport" : kind === "json" ? "response_json" : stage === "parent" ? "lookup_ttl" : stage === "grant" ? "grant_response" : stage === "catalog" ? "catalog_response" : "environment"
      expect(error).toBeInstanceOf(LocalSetupError)
      expect(failureData(error)).toMatchObject({ diagnostic, ...(kind === "document" && stage === "parent" ? {} : { stage }) })
      if (typeof kind === "number") expect(failureData(error)?.httpStatus).toBe(kind)
      const rpc = { type: "unavailable", message: privateText, data: failureData(error) }
      expect(rpcDiagnostic(rpc)).toBeTruthy()
      expect(rpcDiagnostic(rpc)).not.toContain(privateText)
      expect(JSON.stringify(failureData(error))).not.toContain(privateText)
    }
    if (stage === "catalog" || stage === "bundle") expect(paths.at(-1)).toBe("/v1/auth/token/revoke-self")
    else expect(paths.some((path) => path.endsWith("revoke-self"))).toBe(false)
  }
})

test.each(["missing", "expired", "malformed", "locked"])("stored login %s reports a fixed credential reason without HTTP", async (kind) => {
  const http = vi.fn()
  const bao = new Bao(settings, { get: async () => {
    if (kind === "missing") throw new MissingCredential()
    if (kind === "locked") throw new Error(privateText)
    return kind === "malformed" ? privateText : JSON.stringify({ token: privateText, expires: 1 })
  }, set: async () => {} }, http)
  await expect(bao.parent()).rejects.toEqual(new LocalSetupError("stored_login"))
  expect(http).not.toHaveBeenCalled()
})

test("diagnostic decoding ignores raw error messages and unvalidated fields", () => {
  expect(rpcDiagnostic(new Error(privateText))).toBeUndefined()
  expect(rpcDiagnostic({ type: "unavailable", message: privateText, data: { diagnostic: privateText } })).toBeUndefined()
  for (const httpStatus of [privateText, 99, 600, 403.5, null]) {
    expect(rpcDiagnostic({ type: "unavailable", message: privateText, data: { diagnostic: "http", stage: privateText, httpStatus } })).toBe("Bao unavailable: server rejected the request.")
  }
})
