#!/usr/bin/env node
import { Bao, config, initialize } from "./bao"

try {
  const command = process.argv[2]
  if (command === "init") await initialize()
  else if (command === "login") await new Bao(await config()).login()
  else throw new Error()
  console.log("Bao ready")
} catch {
  console.error("Bao unavailable. Use /bao-login in OpenCode or retry opencode-bao login; check trusted configuration and dedicated role. Do not reset existing state.")
  process.exitCode = 1
}
