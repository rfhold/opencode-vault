import { expect, test, vi } from "vitest"
import { Command } from "@opencode/plugin/gui"
import gui from "../src/gui"
import { BaoRpc } from "../src/rpc"

vi.mock("@opencode/plugin/gui", () => ({
  Command: Symbol("Command"),
  Plugin: { define: (value: unknown) => value },
}))

const location = { directory: "/synthetic-worktree" }
const session = { id: "synthetic-session", location, server: { builtin: true }, pending: false, local: false }
const bundles = [{ name: "alpha", enabled: false, keys: 0 }, { name: "beta", enabled: true, keys: 2 }]

function desktop(os = "macos") {
  const commands = new Map<string, Command>()
  const operations = {
    status: vi.fn(async () => ({ sessionID: session.id, version: 7, bundles })),
    login: vi.fn(async (): Promise<unknown> => ({ authenticated: true })),
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
  }
  const client = { rpc: vi.fn(() => operations) }
  const current = vi.fn<() => typeof session | undefined>(() => session)
  const select = vi.fn<() => Promise<string | undefined>>()
  const show = vi.fn()
  const lifetime = new AbortController()
  const readClient = vi.fn(() => client)
  gui.setup!({
    add(registry: unknown, command: Command) {
      expect(registry).toBe(Command)
      commands.set(command.slash!.name, command)
    },
    signal: lifetime.signal, desktop: { os }, sessions: { current }, dialogs: { select }, toast: { show },
    get client() { return readClient() },
  } as never)
  return { commands, client, current, readClient, select, show, operations, lifetime, run: (name: string) => commands.get(name)!.run() }
}

test("Desktop Windows offers both slash commands and explains the backend limit without RPC", async () => {
  const host = desktop("windows")
  expect(gui.os).toBeUndefined()
  expect([...host.commands.keys()]).toEqual(["bao-login", "bao"])
  await host.run("bao-login")
  await host.run("bao")
  expect(host.show).toHaveBeenCalledTimes(2)
  expect(host.show).toHaveBeenCalledWith({ title: expect.stringContaining("local macOS or Linux server") })
  expect(host.readClient).not.toHaveBeenCalled()
  expect(host.select).not.toHaveBeenCalled()
})

test.each(["macos", "linux"])("Desktop %s login calls the app server only on request and works before a session exists", async (os) => {
  const host = desktop(os)
  host.current.mockReturnValue(undefined)
  expect(host.client.rpc).not.toHaveBeenCalled()
  await host.run("bao-login")
  expect(host.client.rpc).toHaveBeenCalledWith(BaoRpc)
  expect(host.operations.login).toHaveBeenCalledWith({}, { location: undefined, signal: expect.any(AbortSignal) })
  expect(host.operations.status).not.toHaveBeenCalled()
  expect(host.show).toHaveBeenLastCalledWith(expect.objectContaining({ variant: "success" }))
  host.operations.login.mockRejectedValueOnce({ message: "synthetic-private-value" })
  await host.run("bao-login")
  expect(host.show).toHaveBeenLastCalledWith(expect.objectContaining({ variant: "error" }))
  expect(JSON.stringify(host.show.mock.calls)).not.toContain("synthetic-private-value")
})

test.each([["alpha", "enable"], ["beta", "disable"]] as const)("Desktop /bao selects %s and calls %s for the captured session", async (bundle, action) => {
  const host = desktop("linux")
  host.select.mockImplementation(async () => {
    host.current.mockReturnValue({ ...session, id: "other-session", location: { directory: "/other-worktree" } })
    return bundle
  })
  await host.run("bao")
  const request = { location, signal: host.lifetime.signal }
  expect(host.operations.status).toHaveBeenCalledWith({ sessionID: session.id }, request)
  expect(host.select).toHaveBeenCalledWith({
    title: "Toggle a Bao bundle",
    options: [
      { value: "alpha", title: "alpha", description: "Disabled; select to enable" },
      { value: "beta", title: "beta", description: "Enabled; select to disable" },
    ],
  })
  expect(host.operations[action]).toHaveBeenCalledExactlyOnceWith({ sessionID: session.id, bundle, version: 7 }, request)
  expect(host.operations[action === "enable" ? "disable" : "enable"]).not.toHaveBeenCalled()
  expect(host.operations.login).not.toHaveBeenCalled()
})

test.each([undefined, "unknown-bundle"])("Desktop /bao selection %s does not change state", async (choice) => {
  const host = desktop()
  host.select.mockResolvedValue(choice)
  await host.run("bao")
  expect(host.operations.status).toHaveBeenCalledTimes(1)
  expect(host.operations.enable).not.toHaveBeenCalled()
  expect(host.operations.disable).not.toHaveBeenCalled()
})

test.each(["macos", "linux"])("Desktop %s commands do not dispatch from a remote session", async (os) => {
  const host = desktop(os)
  host.current.mockReturnValue({ ...session, server: { builtin: false }, local: true })
  await host.run("bao-login")
  await host.run("bao")
  expect(host.readClient).not.toHaveBeenCalled()
  expect(host.show).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("remote sessions") }))
})

test.each(["server change", "plugin unload"])("Desktop /bao does not mutate after %s", async (reason) => {
  const host = desktop()
  const next = { rpc: vi.fn(() => host.operations) }
  host.select.mockImplementation(async () => {
    if (reason === "server change") host.readClient.mockReturnValue(next)
    else host.lifetime.abort()
    return "alpha"
  })
  await host.run("bao")
  expect(host.operations.status).toHaveBeenCalledTimes(1)
  expect(host.operations.enable).not.toHaveBeenCalled()
  expect(next.rpc).not.toHaveBeenCalled()
})
