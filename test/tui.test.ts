import { expect, test, vi } from "vitest"
import tui from "../src/tui"
import type { DialogSelectOptions } from "@opencode/plugin/tui/context"
import type { Status } from "../src/rpc"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const status = (bundles = [{ name: "alpha", enabled: false, keys: 0 }, { name: "beta", enabled: false, keys: 0 }], version = 7): Status => ({ sessionID: "a", version, bundles, protectedValues: 3 })

async function fixture(initial = status()) {
  const catalog = deferred<Status>()
  const dialog = deferred<string | undefined>()
  const opened = deferred<void>()
  const toast = vi.fn()
  type Request = { location: { directory: string }; signal: AbortSignal }
  type Mutation = { sessionID: string; bundle: string; version: number }
  const rpc = {
    status: vi.fn((_input: { sessionID: string }, _request: Request) => catalog.promise),
    enable: vi.fn(async (_input: Mutation, _request: Request) => status([], 8)),
    disable: vi.fn(async (_input: Mutation, _request: Request) => status([], 8)),
    login: vi.fn(async () => ({ authenticated: true })),
  }
  let options!: DialogSelectOptions<string>
  let commands: any[] = []
  const memory = vi.fn((_key, { initial }) => [initial, (mutate: Function) => mutate(initial)])
  const clear = vi.fn(() => dialog.resolve(undefined))
  const select = vi.fn((value: DialogSelectOptions<string>) => { options = value; opened.resolve(); return dialog.promise })
  const cleanup = await tui.setup({
    client: { rpc: () => rpc }, location: { directory: "/project" },
    storage: { memory },
    keymap: { layer: (factory: Function) => { commands = factory().commands } },
    ui: { toast: { show: toast }, dialog: { select, clear }, router: { current: () => ({ type: "session", sessionID: "a" }) } },
  } as any)
  const run = () => commands.find((entry) => entry.id === "bao.bundles").run() as Promise<void>
  const login = () => commands.find((entry) => entry.id === "bao.login").run() as Promise<void>
  const open = async () => { const pending = run(); catalog.resolve(initial); await opened.promise; return { pending } }
  const mark = (name: string) => {
    const action = options.actions![0]!
    expect(action.bind).toBe("space")
    if (action.selection !== "none") action.onTrigger(name)
  }
  return { rpc, toast, catalog, dialog, select, clear, cleanup, run, login, open, mark, options: () => options }
}

test("catalog feedback precedes a pending RPC; Space only changes visible marks", async () => {
  const f = await fixture()
  const pending = f.run()
  expect(f.rpc.status).toHaveBeenCalledTimes(1)
  expect(f.toast.mock.calls[0]![0]).toMatchObject({ variant: "info", message: expect.stringContaining("loading bundle catalog") })
  expect(f.toast.mock.invocationCallOrder[0]).toBeLessThan(f.rpc.status.mock.invocationCallOrder[0]!)
  expect(f.select).not.toHaveBeenCalled()
  f.catalog.resolve(status())
  await vi.waitFor(() => expect(f.select).toHaveBeenCalledTimes(1))
  f.mark("alpha")
  f.mark("beta")
  expect(f.options().title).toContain("2 marked; 0 enabled; 3 protected")
  expect(f.options().options.map((item) => item.title)).toEqual(["[x] alpha", "[x] beta"])
  f.mark("alpha")
  expect(f.options().options[0]!.title).toBe("[ ] alpha")
  expect(f.options().title).toContain("1 marked")
  expect(f.options().placeholder).toContain("Enter apply marked")
  expect(f.options().options[1]!.description).toContain("Disabled; enable")
  expect(f.options().search!("ALP", f.options().options).map((item) => item.value)).toEqual(["alpha"])
  expect(f.rpc.enable).not.toHaveBeenCalled()
  expect(f.rpc.disable).not.toHaveBeenCalled()
  f.dialog.resolve(undefined)
  await pending
  f.cleanup?.()
})

test("Enter applies multiple marks serially with returned versions and immediate feedback", async () => {
  const f = await fixture()
  const first = deferred<Status>()
  const second = deferred<Status>()
  f.rpc.enable.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  const { pending } = await f.open()
  f.mark("alpha")
  f.mark("beta")
  f.dialog.resolve("alpha")
  await vi.waitFor(() => expect(f.rpc.enable).toHaveBeenCalledTimes(1))
  expect(f.toast.mock.lastCall![0]).toMatchObject({ variant: "info", message: expect.stringContaining("applying 2") })
  expect(f.toast.mock.invocationCallOrder.at(-1)).toBeLessThan(f.rpc.enable.mock.invocationCallOrder[0]!)
  expect(f.rpc.enable.mock.calls[0]![0]).toEqual({ sessionID: "a", bundle: "alpha", version: 7 })
  first.resolve(status([], 15))
  await vi.waitFor(() => expect(f.rpc.enable).toHaveBeenCalledTimes(2))
  expect(f.rpc.enable.mock.calls[1]![0]).toEqual({ sessionID: "a", bundle: "beta", version: 15 })
  expect(f.toast.mock.calls.some(([value]) => value.variant === "success")).toBe(false)
  second.resolve(status([], 16))
  await pending
  expect(f.toast.mock.lastCall![0]).toEqual({ message: "Bao: 2 bundle changes applied", variant: "success" })
  f.cleanup?.()
})

test("mixed marks disable first and retain initial choices after local-only status", async () => {
  const f = await fixture(status([{ name: "alpha", enabled: false, keys: 0 }, { name: "beta", enabled: true, keys: 2 }]))
  const disabled = deferred<Status>()
  f.rpc.disable.mockImplementationOnce(() => disabled.promise)
  const { pending } = await f.open()
  f.mark("alpha")
  f.mark("beta")
  expect(f.options().options[1]!.description).toContain("Enabled (2 keys); disable")
  f.dialog.resolve("alpha")
  await vi.waitFor(() => expect(f.rpc.disable).toHaveBeenCalledTimes(1))
  expect(f.rpc.enable).not.toHaveBeenCalled()
  expect(f.rpc.disable.mock.calls[0]![0]).toEqual({ sessionID: "a", bundle: "beta", version: 7 })
  disabled.resolve({ ...status([], 20), catalogUnavailable: true })
  await pending
  expect(f.rpc.enable.mock.calls[0]![0]).toEqual({ sessionID: "a", bundle: "alpha", version: 20 })
  expect(f.toast.mock.lastCall![0].variant).toBe("success")
  f.cleanup?.()
})

test.each([undefined, "alpha"])("cancel or Enter without marks performs no mutation (%s)", async (value) => {
  const f = await fixture()
  const { pending } = await f.open()
  if (value === undefined) f.mark("alpha")
  f.dialog.resolve(value)
  await pending
  expect(f.rpc.enable).not.toHaveBeenCalled()
  expect(f.rpc.disable).not.toHaveBeenCalled()
  if (value) expect(f.toast.mock.lastCall![0].message).toContain("No Bao bundles marked")
  expect(f.toast.mock.calls.some(([item]) => item.variant === "success")).toBe(false)
  f.cleanup?.()
})

test("Enter never implicitly toggles the focused unmarked bundle", async () => {
  const f = await fixture()
  const { pending } = await f.open()
  f.mark("beta")
  f.dialog.resolve("alpha")
  await pending
  expect(f.rpc.enable).toHaveBeenCalledTimes(1)
  expect(f.rpc.enable.mock.calls[0]![0]).toMatchObject({ bundle: "beta" })
  f.cleanup?.()
})

test.each([0, 1])("failure stops the batch and reports %i confirmed changes without raw errors", async (completed) => {
  const f = await fixture(status(["alpha", "beta", "gamma"].map((name) => ({ name, enabled: false, keys: 0 }))))
  if (completed) f.rpc.enable.mockResolvedValueOnce(status([], 9))
  f.rpc.enable.mockRejectedValueOnce(new Error("synthetic-private-error"))
  const { pending } = await f.open()
  for (const name of ["alpha", "beta", "gamma"]) f.mark(name)
  f.dialog.resolve("gamma")
  await pending
  expect(f.rpc.enable).toHaveBeenCalledTimes(completed + 1)
  expect(f.toast.mock.lastCall![0]).toMatchObject({ variant: "error", message: expect.stringContaining(`${completed} of 3 changes confirmed`) })
  expect(JSON.stringify(f.toast.mock.calls)).not.toContain("synthetic-private-error")
  expect(f.toast.mock.calls.some(([item]) => item.variant === "success")).toBe(false)
  f.cleanup?.()
})

test("catalog-unavailable active entries remain markable for disable", async () => {
  const f = await fixture({ ...status([{ name: "loaded", enabled: true, keys: 4 }]), catalogUnavailable: true })
  const { pending } = await f.open()
  expect(f.toast.mock.calls.some(([item]) => item.message.includes("catalog unavailable"))).toBe(true)
  f.mark("loaded")
  f.dialog.resolve("loaded")
  await pending
  expect(f.rpc.disable.mock.calls[0]![0]).toMatchObject({ bundle: "loaded", version: 7 })
  expect(f.rpc.enable).not.toHaveBeenCalled()
  f.cleanup?.()
})

test("degraded catalog uses only the allowlisted reason while loaded entries remain usable", async () => {
  const f = await fixture({ ...status([{ name: "loaded", enabled: true, keys: 4 }]), catalogUnavailable: true, catalogFailure: { diagnostic: "http", stage: "catalog", httpStatus: 403 } })
  const { pending } = await f.open()
  expect(f.toast.mock.calls.some(([item]) => item.message.includes("Stage: catalog lookup. HTTP 403."))).toBe(true)
  f.mark("loaded")
  f.dialog.resolve("loaded")
  await pending
  expect(f.rpc.disable).toHaveBeenCalledTimes(1)
  f.cleanup?.()
})

test("failed disable is named from marked metadata rather than focused selection", async () => {
  const f = await fixture(status([{ name: "alpha", enabled: false, keys: 0 }, { name: "loaded", enabled: true, keys: 1 }]))
  f.rpc.disable.mockRejectedValueOnce({ type: "unavailable", message: "synthetic-private", data: { diagnostic: "state" } })
  const { pending } = await f.open()
  f.mark("loaded")
  f.mark("alpha")
  f.dialog.resolve("alpha")
  await pending
  expect(f.toast.mock.lastCall![0].message).toContain("0 of 2 changes confirmed; disable loaded failed")
  expect(f.toast.mock.lastCall![0].message).toContain("Remaining 1 changes NOT attempted")
  expect(f.toast.mock.lastCall![0].message).toContain("state is unreadable or locked")
  expect(JSON.stringify(f.toast.mock.calls)).not.toContain("synthetic-private")
  expect(f.rpc.enable).not.toHaveBeenCalled()
  f.cleanup?.()
})

test("duplicate invocations never open a second picker or start another batch", async () => {
  const f = await fixture()
  const { pending } = await f.open()
  await f.run()
  f.mark("alpha")
  const mutation = deferred<Status>()
  f.rpc.enable.mockImplementationOnce(() => mutation.promise)
  f.dialog.resolve("alpha")
  await vi.waitFor(() => expect(f.rpc.enable).toHaveBeenCalledTimes(1))
  await f.run()
  expect(f.rpc.status).toHaveBeenCalledTimes(1)
  expect(f.select).toHaveBeenCalledTimes(1)
  mutation.resolve(status([], 8))
  await pending
  f.cleanup?.()
})

test.each(["catalog", "picker", "mutation"])("unload during %s prevents stale UI and subsequent mutations", async (phase) => {
  const f = await fixture()
  let pending: Promise<void>
  const mutation = deferred<Status>()
  if (phase === "catalog") pending = f.run()
  else {
    pending = (await f.open()).pending
    f.mark("alpha")
    f.mark("beta")
    if (phase === "mutation") {
      f.rpc.enable.mockImplementationOnce(() => mutation.promise)
      f.dialog.resolve("alpha")
      await vi.waitFor(() => expect(f.rpc.enable).toHaveBeenCalledTimes(1))
    }
  }
  const count = f.toast.mock.calls.length
  f.cleanup?.()
  f.catalog.resolve(status())
  mutation.resolve(status([], 8))
  await pending
  await f.run()
  await f.login()
  expect(f.toast).toHaveBeenCalledTimes(count)
  expect(f.rpc.enable).toHaveBeenCalledTimes(phase === "mutation" ? 1 : 0)
  expect(f.rpc.status.mock.calls[0]![1].signal.aborted).toBe(true)
  if (phase === "catalog") expect(f.select).not.toHaveBeenCalled()
  if (phase === "picker") expect(f.clear).toHaveBeenCalledTimes(1)
})

test("login feedback precedes pending authentication; unload suppresses its completion", async () => {
  const f = await fixture()
  const authentication = deferred<{ authenticated: boolean }>()
  f.rpc.login.mockImplementationOnce(() => authentication.promise)
  const pending = f.login()
  expect(f.toast.mock.lastCall![0]).toMatchObject({ variant: "info", message: expect.stringContaining("opening the browser") })
  expect(f.toast.mock.invocationCallOrder[0]).toBeLessThan(f.rpc.login.mock.invocationCallOrder[0]!)
  f.cleanup?.()
  authentication.resolve({ authenticated: true })
  await pending
  expect(f.toast).toHaveBeenCalledTimes(1)
})
