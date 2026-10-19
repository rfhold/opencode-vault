export const marker = "[REDACTED]"
export const credentialHeaders = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key"])
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const pattern = (text: string) => new RegExp([...text.matchAll(/%[a-f0-9]{2}|\\u[a-f0-9]{4}|[\s\S]/gi)].map(([part]) => {
  if (part.length < 3) return escape(part)
  const prefix = part.startsWith("%") ? 1 : 2
  return escape(part.slice(0, prefix)) + part.slice(prefix).replace(/[a-f]/gi, (hex) => `[${hex.toLowerCase()}${hex.toUpperCase()}]`)
}).join(""), "g")

export class Scrubber {
  readonly variants: RegExp[]
  constructor(values: readonly string[]) {
    const variants = new Set<string>()
    for (const value of values) {
      if ([...value].length <= 5) continue
      const bytes = Buffer.from(value)
      const initial = [value, bytes.toString("base64"), bytes.toString("base64url")]
      const base64 = [initial[1]!, initial[2]!, initial[1]!.replace(/=+$/, ""), initial[2]! + "=".repeat((4 - initial[2]!.length % 4) % 4)]
      for (const encoded of base64) {
        for (const width of [64, 76]) for (const separator of ["\n", "\r\n"]) initial.push(encoded.match(new RegExp(`.{1,${width}}`, "g"))!.join(separator))
      }
      initial.push(bytes.toString("hex"), bytes.toString("hex").toUpperCase())
      initial.push(value.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""))
      initial.push(initial[1]!.replace(/=+$/, ""), initial[2]! + "=".repeat((4 - initial[2]!.length % 4) % 4))
      for (const text of initial) {
        for (const encoded of [text, encodeURIComponent(text), encodeURIComponent(text).replaceAll("%20", "+"), encodeURI(text), JSON.stringify(text).slice(1, -1)]) {
          variants.add(encoded)
          variants.add(JSON.stringify(encoded).slice(1, -1))
          variants.add(encodeURIComponent(encoded))
          variants.add(encoded.replace(/%[A-F0-9]{2}/g, (match) => match.toLowerCase()))
        }
      }
    }
    this.variants = [...variants].sort((a, b) => b.length - a.length).map(pattern)
  }
  text(value: string) {
    for (const variant of this.variants) value = value.replaceAll(variant, marker)
    let previous: string
    do {
      previous = value
      for (const variant of this.variants) value = value.replaceAll(variant, "")
    } while (value !== previous)
    return value
  }
  json(value: unknown, seen = new WeakMap<object, unknown>()): any {
    if (typeof value === "string") return this.text(value)
    if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value
    if (typeof value !== "object") return value
    if (seen.has(value)) return seen.get(value)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) return value
    const result = Array.isArray(value) ? [] : Object.create(prototype)
    seen.set(value, result)
    const properties = new Map<PropertyKey, PropertyDescriptor>()
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if ("value" in descriptor) descriptor.value = this.json(descriptor.value, seen)
      const scrubbed = typeof key === "string" ? this.text(key) : key
      // Last entry wins when redacted names collide.
      properties.set(scrubbed, descriptor)
    }
    for (const [key, descriptor] of properties) Object.defineProperty(result, key, descriptor)
    return result
  }
  headers(input: Record<string, string>) {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(input)) {
      const credential = credentialHeaders.has(key.toLowerCase())
      const name = credential ? key : this.text(key)
      // A redacted name can cease to be a valid HTTP token.
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name)) continue
      Object.defineProperty(result, name, { value: credential ? value : this.text(value), enumerable: true, configurable: true })
    }
    return result
  }
  frame(frame: string) {
    let value: unknown
    try { value = JSON.parse(frame) } catch { return this.text(frame) }
    return JSON.stringify(this.json(value))
  }
  async request(request: Request) {
    const headers = new Headers()
    for (const [key, value] of Object.entries(this.headers(Object.fromEntries(request.headers)))) headers.set(key, value)
    let body: BodyInit | undefined
    if (request.body) {
      const bytes = await request.clone().arrayBuffer()
      body = bytes
      const type = request.headers.get("content-type") ?? ""
      const encoding = request.headers.get("content-encoding")
      if ((!encoding || encoding.toLowerCase() === "identity") && !/^(?:image|audio|video)\/|^application\/(?:octet-stream|pdf|zip)(?:;|$)/i.test(type)) {
        let text: string | undefined
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch {}
        if (text !== undefined && !/[\x00-\x08\x0e-\x1f]/.test(text)) body = this.frame(text)
      }
      headers.delete("content-length")
    }
    return new Request(new Request(this.text(request.url), request), { headers, ...(body === undefined ? {} : { body }), referrer: this.text(request.referrer) })
  }
}
