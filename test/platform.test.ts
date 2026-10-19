import { afterEach, expect, test, vi } from "vitest"
import { Effect } from "effect"
import server, { install } from "../src/index"
import tui from "../src/tui"
import { Sessions } from "../src/state"
import { readiness, config, encryptionKey } from "../src/bao"

vi.mock("../src/state", async (original) => ({
  ...await original<typeof import("../src/state")>(),
  Sessions: vi.fn(class {}),
}))
vi.mock("../src/bao", async (original) => ({
  ...await original<typeof import("../src/bao")>(),
  readiness: vi.fn(() => async () => { throw new Error("Unexpected state access") }),
  config: vi.fn(() => { throw new Error("Unexpected config access") }),
  encryptionKey: vi.fn(() => { throw new Error("Unexpected Keychain access") }),
}))

const nativePlatform = process.platform
afterEach(() => { Object.defineProperty(process, "platform", { value: nativePlatform }); vi.clearAllMocks() })

test.each(["linux", "win32", "freebsd"])("%s entrypoints return before context, state, or credentials", async (platform) => {
  Object.defineProperty(process, "platform", { value: platform })
  const ctx = new Proxy({}, { get() { throw new Error("Unexpected context access") } })
  await Effect.runPromise(Effect.scoped(server.effect(ctx as never)))
  expect(await tui.setup(ctx as never)).toBeUndefined()
  expect(Sessions).not.toHaveBeenCalled()
  expect(readiness).not.toHaveBeenCalled()
  expect(config).not.toHaveBeenCalled()
  expect(encryptionKey).not.toHaveBeenCalled()
})

test("macOS entrypoints retain server hooks, RPC, and TUI commands without credential access", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" })
  const transform = vi.fn(() => Effect.void)
  const shellHook = vi.fn(() => Effect.void)
  const sessionHook = vi.fn((_name: string, _handler: unknown) => Effect.void)
  const register = vi.fn(() => Effect.void)
  await Effect.runPromise(Effect.scoped(server.effect({
    tool: { transform }, shell: { hook: shellHook }, session: { hook: sessionHook }, rpc: { register },
  } as never)))
  expect(Sessions).toHaveBeenCalledTimes(1)
  expect(readiness).toHaveBeenCalledTimes(1)
  expect(transform).toHaveBeenCalledTimes(1)
  expect(shellHook).toHaveBeenCalledWith("create.before", expect.any(Function))
  expect(sessionHook.mock.calls.map((args) => args[0])).toEqual([
    "context", "title", "compaction", "generate", "http.request", "experimental.ws.send", "experimental.ws.handshake", "model.request",
  ])
  expect(register).toHaveBeenCalledTimes(1)
  const rpc = vi.fn(() => ({}))
  const layer = vi.fn()
  const cleanup = await tui.setup({ client: { rpc }, keymap: { layer } } as never)
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(layer.mock.calls[0]![0]().commands.map((command: { id: string }) => command.id)).toEqual(["bao.login", "bao.bundles"])
  cleanup?.()
  expect(config).not.toHaveBeenCalled()
  expect(encryptionKey).not.toHaveBeenCalled()
})

test("the native-shaped install helper remains platform-independent", async () => {
  Object.defineProperty(process, "platform", { value: "linux" })
  const transform = vi.fn(() => Effect.void)
  const register = vi.fn(() => Effect.void)
  await Effect.runPromise(Effect.scoped(install({
    tool: { transform }, shell: { hook: () => Effect.void }, session: { hook: () => Effect.void }, rpc: { register },
  } as never, new Sessions("/not-used", Buffer.alloc(32)))))
  expect(transform).toHaveBeenCalledTimes(1)
  expect(register).toHaveBeenCalledTimes(1)
  expect(readiness).not.toHaveBeenCalled()
  expect(config).not.toHaveBeenCalled()
  expect(encryptionKey).not.toHaveBeenCalled()
})
