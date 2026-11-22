import { homedir } from "node:os"
import type { runProcess } from "./process"

export const supportedHost = (platform: NodeJS.Platform = process.platform) => platform === "darwin" || platform === "linux"
export const defaultBao = () => process.platform === "linux" ? "/usr/bin/bao" : "/opt/homebrew/bin/bao"

const displayEnvironment = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_CURRENT_DESKTOP"] as const
const desktopEnvironment = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", ...displayEnvironment] as const

export async function loginEnvironment(address: string, run: typeof runProcess, signal: AbortSignal): Promise<NodeJS.ProcessEnv> {
  const linux = process.platform === "linux"
  const env: NodeJS.ProcessEnv = { PATH: linux ? "/usr/bin:/bin" : "/opt/homebrew/bin:/usr/bin:/bin", HOME: homedir(), BAO_ADDR: address }
  if (!linux) return env
  for (const name of desktopEnvironment) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  const absent = displayEnvironment.filter((name) => process.env[name] === undefined)
  const bus = env.DBUS_SESSION_BUS_ADDRESS
  if (!absent.includes("DISPLAY") || !absent.includes("WAYLAND_DISPLAY") || !bus || !/^unix:(?:path|abstract)=[^,;\s\0]+(?:,guid=[a-f0-9]{32})?$/i.test(bus)) return env

  try {
    const child = await run("/usr/bin/busctl", ["--user", "--json=short", "get-property", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "Environment"], {
      env: { PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: bus },
      stderr: "ignore", signal, timeout: 1000, maxBytes: 65536,
    })
    if (child.exitCode !== 0) return env
    const reply = JSON.parse(child.stdout) as { type?: unknown; data?: unknown } | null
    if (reply?.type !== "as" || !Array.isArray(reply.data) || !reply.data.every((entry) => typeof entry === "string")) return env
    for (const name of absent) {
      const value = reply.data.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1)
      if (value && !/[\r\n\0]/.test(value)) env[name] = value
    }
  } catch {
    // The user manager is optional; keep the inherited environment on lookup failure.
  }
  return env
}
