import { expect, test, vi } from "vitest"

test("CLI login fallback calls the same explicit login flow and keeps output generic", async () => {
  const login = vi.fn(async () => {})
  const initialize = vi.fn()
  const settings = { address: "https://bao.invalid" }
  vi.doMock("../src/bao", () => ({ Bao: class { login = login }, config: async () => settings, initialize }))
  const argv = process.argv
  const exitCode = process.exitCode
  const output = vi.spyOn(console, "log").mockImplementation(() => {})
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    process.argv = [process.execPath, "cli.js", "login"]
    await import("../src/cli")
    expect(login).toHaveBeenCalledTimes(1)
    expect(initialize).not.toHaveBeenCalled()
    expect(output).toHaveBeenCalledWith("Bao ready")
    vi.resetModules()
    login.mockRejectedValueOnce(new Error("synthetic-token-private-url"))
    await import("../src/cli")
    expect(process.exitCode).toBe(1)
    expect(JSON.stringify(error.mock.calls)).not.toContain("synthetic-token-private-url")
    expect(JSON.stringify(error.mock.calls)).toContain("/bao-login")
  } finally {
    process.argv = argv
    process.exitCode = exitCode
    output.mockRestore()
    error.mockRestore()
    vi.doUnmock("../src/bao")
    vi.resetModules()
  }
})
