import { expect, test } from "vitest"
import { runProcess } from "../src/process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

test("subprocesses receive only the explicit environment and literal arguments", async () => {
  const literal = "$(printf injected); echo not-a-command"
  const child = await runProcess(process.execPath, ["-e", 'process.stdout.write(JSON.stringify({ env: process.env, argument: process.argv[1] }))', literal], { env: { SYNTHETIC: "only-explicit-value" } })
  expect(child.exitCode).toBe(0)
  expect(child.stderr).toBe("")
  const output = JSON.parse(child.stdout)
  // CoreFoundation may add this variable during Node startup on macOS.
  if (process.platform === "darwin") delete output.env.__CF_USER_TEXT_ENCODING
  expect(output).toEqual({ env: { SYNTHETIC: "only-explicit-value" }, argument: literal })
})

test("subprocess completion drains piped input, stdout and stderr before returning failures", async () => {
  const input = "synthetic-secret-🙂".repeat(10000)
  const child = await runProcess(process.execPath, ["-e", 'process.stdin.pipe(process.stdout); process.stdin.on("end", () => { process.stderr.write("synthetic failure"); process.exitCode = 7 })'], { env: {}, input })
  expect(child.stdout).toBe(input)
  expect(child.stderr).toBe("synthetic failure")
  expect(child.exitCode).toBe(7)
  const ignored = await runProcess(process.execPath, ["-e", 'process.stdout.write("synthetic-secret"); process.stderr.write("synthetic-secret")'], { env: {}, stdout: "ignore", stderr: "ignore" })
  expect(ignored).toEqual({ stdout: "", stderr: "", exitCode: 0 })
})

test("subprocess spawn errors reject and signals cannot be mistaken for successful exit", async () => {
  await expect(runProcess("/nonexistent-opencode-bao-synthetic-executable", [], { env: {} })).rejects.toMatchObject({ code: "ENOENT" })
  const child = await runProcess(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")'], { env: {} })
  expect(child.exitCode).toBeNull()
})

test("timeout and cancellation kill a blocked child, including one ignoring SIGTERM", async () => {
  const controller = new AbortController()
  const directory = await mkdtemp(fileURLToPath(new URL("../.test-process-", import.meta.url)))
  try {
    const file = join(directory, "pid")
    const pending = runProcess(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)', file], { env: {}, timeout: 300, signal: controller.signal })
    await expect(pending).rejects.toThrow("Process unavailable")
    const pid = Number(await readFile(file, "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally { await rm(directory, { recursive: true, force: true }) }
  const cancelled = runProcess(process.execPath, ["-e", 'setInterval(() => {}, 1000)'], { env: {}, signal: controller.signal })
  controller.abort()
  await expect(cancelled).rejects.toThrow("Process unavailable")
  await expect(runProcess(process.execPath, [], { env: {}, signal: controller.signal })).rejects.toThrow("Process unavailable")
  await expect(runProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(10000)); setInterval(() => {}, 1000)'], { env: {}, maxBytes: 10, timeout: 1000 })).rejects.toThrow("Process unavailable")
})
