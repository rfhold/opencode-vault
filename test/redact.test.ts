import { expect, test } from "vitest"
import { gzipSync } from "node:zlib"
import { Scrubber, marker } from "../src/redact"

const secret = "synthetic-readable-secret"
const scrub = new Scrubber([secret])

test("arbitrary JSON metadata scrubs recursively and key collisions use the last entry", () => {
  const value = { type: "custom", encrypted_content: secret, mime_type: "image/png", [secret]: secret, [marker]: "last-public-value" }
  expect(scrub.json(value)).toEqual({ type: "custom", encrypted_content: marker, mime_type: "image/png", [marker]: "last-public-value" })
  expect(scrub.headers({ [secret]: secret, [marker]: "last-public-value", Authorization: secret })).toEqual({ Authorization: secret })
  expect(JSON.stringify(scrub.json({ [secret]: "first", [marker]: secret }))).not.toContain(secret)
})

test("valid redacted header-name collisions use the last entry", () => {
  const redactor = new Scrubber([marker, secret])
  expect(redactor.headers({ [`x${secret}y`]: secret, xy: "last-public-value" })).toEqual({ xy: "last-public-value" })
  expect(() => new Headers(redactor.headers({ [`x${secret}y`]: secret, xy: "last-public-value" }))).not.toThrow()
})

test("classes, functions, binary objects and cyclic plain objects do not block or coerce", () => {
  class Options { method() { return "public" } }
  const options = new Options()
  const callback = () => "public"
  const bytes = Buffer.from(secret)
  const value: any = { options, callback, bytes, text: secret }
  value.self = value
  const result = scrub.json(value)
  expect(result.options).toBe(options)
  expect(result.callback).toBe(callback)
  expect(result.bytes).toBe(bytes)
  expect(result.self).toBe(result)
  expect(result.text).toBe(marker)
})

test("plain object symbols and accessors preserve public shape without getter execution", () => {
  const symbol = Symbol("public")
  const value = Object.create(null)
  Object.defineProperty(value, "text", { value: "public", enumerable: true })
  Object.defineProperty(value, "getter", { get() { throw new Error("do not invoke") }, enumerable: true })
  value[symbol] = secret
  const result = scrub.json(value)
  expect(Object.getPrototypeOf(result)).toBe(null)
  expect(Object.getOwnPropertyDescriptor(result, "text")).toEqual(Object.getOwnPropertyDescriptor(value, "text"))
  expect(Object.getOwnPropertyDescriptor(result, "getter")).toEqual(Object.getOwnPropertyDescriptor(value, "getter"))
  expect(result[symbol]).toBe(marker)
})

test("sparse arrays retain holes and own metadata", () => {
  const value = ["public", , secret]
  Object.defineProperty(value, "metadata", { value: secret })
  const result = scrub.json(value)
  expect(result).toEqual(["public", , marker])
  expect(Object.hasOwn(result, 1)).toBe(false)
  expect(Object.getOwnPropertyDescriptor(result, "metadata")).toEqual({ value: marker, enumerable: false, configurable: false, writable: false })
})

test("a redacted HTTP header name does not block dispatch or expose its value", async () => {
  const result = await scrub.request(new Request("https://model.invalid", { headers: { [secret]: secret, Authorization: secret } }))
  expect([...result.headers]).toEqual([["authorization", secret]])
})

test.each(["text/plain", "application/xml", "application/x-www-form-urlencoded", "application/json", "application/provider+json", "unknown/custom"])("readable HTTP %s bodies redact without format enforcement", async (type) => {
  const request = new Request("https://model.invalid", { method: "PUT", headers: { "content-type": type }, body: `not JSON: ${secret}` })
  const result = await scrub.request(request)
  expect(result.method).toBe("PUT")
  expect(await result.text()).toBe(`not JSON: ${marker}`)
})

test.each(["image/png", "audio/wav", "application/octet-stream"])("opaque %s bytes pass unchanged", async (type) => {
  const bytes = Buffer.from(secret)
  const request = new Request("https://model.invalid", { method: "POST", headers: { "content-type": type }, body: bytes })
  const result = await scrub.request(request)
  expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes)
})

test("compressed and invalid UTF-8 bodies pass unchanged with a usable replacement request", async () => {
  for (const [bytes, headers] of [
    [gzipSync(JSON.stringify({ text: secret })), { "content-type": "application/json", "content-encoding": "gzip" }],
    [Buffer.from([255, 254, 0, 1]), { "content-type": "unknown/custom" }],
  ] as const) {
    const request = new Request("https://model.invalid", { method: "POST", headers, body: bytes })
    const result = await scrub.request(request)
    expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes)
    expect(result.headers.get("content-encoding")).toBe(request.headers.get("content-encoding"))
  }
})

test("bodies above the old 16 MiB cap dispatch and still scrub readable text", async () => {
  const text = "x".repeat(16 * 1024 * 1024 + 1) + secret
  const result = await scrub.request(new Request("https://model.invalid", { method: "POST", body: JSON.stringify({ type: "arbitrary", text }) }))
  expect(await result.json()).toEqual({ type: "arbitrary", text: "x".repeat(16 * 1024 * 1024 + 1) + marker })
})
