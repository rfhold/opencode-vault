import { spawn } from "node:child_process"

export function runProcess(file: string, args: string[], options: {
  env: NodeJS.ProcessEnv
  stdin?: "inherit"
  stdout?: "ignore"
  stderr?: "inherit" | "ignore"
  input?: string
  timeout?: number
  signal?: AbortSignal
  maxBytes?: number
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error("Process unavailable"))
    const child = spawn(file, args, {
      env: options.env, shell: false,
      stdio: [options.input === undefined ? options.stdin ?? "ignore" : "pipe", options.stdout ?? "pipe", options.stderr ?? "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let failure: Error | undefined
    let settled = false
    let bytes = 0
    let kill: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(kill)
      clearTimeout(deadline)
      options.signal?.removeEventListener("abort", abort)
      if (failure) reject(failure)
      else resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), exitCode })
    }
    const stop = (error: Error) => {
      if (failure || settled) return
      failure = error
      child.kill("SIGTERM")
      kill = setTimeout(() => child.kill("SIGKILL"), 500)
      deadline = setTimeout(() => {
        child.stdin?.destroy()
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(null)
      }, 1000)
    }
    const abort = () => stop(new Error("Process unavailable"))
    const timer = options.timeout === undefined ? undefined : setTimeout(abort, options.timeout)
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length
      if (failure) return
      if (options.maxBytes !== undefined && bytes > options.maxBytes) return abort()
      chunks.push(chunk)
    }
    child.on("error", stop)
    child.stdout?.on("data", collect(stdout))
    child.stderr?.on("data", collect(stderr))
    child.stdout?.on("error", stop)
    child.stderr?.on("error", stop)
    child.stdin?.on("error", stop)
    child.on("close", finish)
    if (options.input !== undefined) child.stdin!.end(options.input)
  })
}
