import { Command, Plugin } from "@opencode/plugin/gui"
import { BaoRpc, type Status } from "./rpc"

export default Plugin.define({
  setup(ctx) {
    const { signal } = ctx
    let loggingIn = false
    let picking = false
    const supported = () => {
      if (signal.aborted) return false
      if (ctx.desktop?.os === "macos" || ctx.desktop?.os === "linux") return true
      ctx.toast.show({ title: "Bao requires a local macOS or Linux server with access to its OS credential store" })
      return false
    }
    const localSession = (session: ReturnType<typeof ctx.sessions.current>) => {
      if (!session || session.server.builtin) return true
      ctx.toast.show({ title: "Bao is not available for remote sessions", description: "Switch to the Desktop app's own server to use Bao." })
      return false
    }

    ctx.add(Command, {
      id: "login", title: "Bao login", group: "Bao", slash: { name: "bao-login" },
      async run() {
        if (!supported()) return
        const session = ctx.sessions.current()
        if (!localSession(session)) return
        if (loggingIn) {
          ctx.toast.show({ title: "Bao login already in progress" })
          return
        }
        loggingIn = true
        ctx.toast.show({ title: "Bao login", description: "Finish sign-in in your browser within two minutes.", duration: 10000 })
        try {
          const result = await ctx.client.rpc(BaoRpc).login({}, { location: session?.location, signal: AbortSignal.any([signal, AbortSignal.timeout(200000)]) })
          if (signal.aborted) return
          if (typeof result !== "object" || result === null || Array.isArray(result) || !("authenticated" in result) || result.authenticated !== true || Object.keys(result).length !== 1 || !Object.hasOwn(result, "authenticated")) throw new Error("Invalid login result")
          ctx.toast.show({ title: "Bao login complete", description: "Open /bao to select a bundle.", variant: "success" })
        } catch {
          if (!signal.aborted) ctx.toast.show({ title: "Bao login did not complete", description: "Finish any open browser sign-in, then retry /bao-login. Check the local browser, OS credential store, and trusted configuration. Do not reset existing state.", variant: "error", duration: 10000 })
        } finally { loggingIn = false }
      },
    })

    ctx.add(Command, {
      id: "bundles", title: "Bao environment bundles", group: "Bao", slash: { name: "bao" },
      async run() {
        if (!supported() || picking) return
        const session = ctx.sessions.current()
        if (!localSession(session)) return
        if (!session?.location || session.pending) {
          ctx.toast.show({ title: "Open a local session first" })
          return
        }
        const { id: sessionID, location } = session
        const request = { location, signal }
        picking = true
        let changing = false
        try {
          const client = ctx.client
          const status = await client.rpc(BaoRpc).status({ sessionID }, request) as Status
          if (signal.aborted) return
          if (status.sessionID !== sessionID || !Number.isSafeInteger(status.version) || status.version < 0) throw new Error("Invalid bundle status")
          if (status.catalogUnavailable) ctx.toast.show({ title: "Bao catalog unavailable", description: "You can still disable loaded bundles." })
          const bundles = status.bundles.filter((item) => typeof item.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name) && typeof item.enabled === "boolean")
          if (!bundles.length) {
            ctx.toast.show({ title: "No Bao bundles found", description: "Check the configured bundle catalog, then reopen /bao." })
            return
          }
          const choice = await ctx.dialogs.select({
            title: "Toggle a Bao bundle",
            options: bundles.map((item) => ({ value: item.name, title: item.name, description: item.enabled ? "Enabled; select to disable" : "Disabled; select to enable" })),
          })
          if (signal.aborted || choice === undefined) return
          const item = bundles.find(({ name }) => choice === name)
          if (!item) return
          const activeClient = ctx.client
          if (activeClient !== client) {
            ctx.toast.show({ title: "OpenCode server changed", description: "Reopen /bao to refresh the bundle list." })
            return
          }
          changing = true
          await activeClient.rpc(BaoRpc)[item.enabled ? "disable" : "enable"]({ sessionID, bundle: item.name, version: status.version }, request)
          if (!signal.aborted) ctx.toast.show({ title: item.enabled ? "Bao bundle disabled" : "Bao bundle enabled", variant: "success" })
        } catch {
          if (!signal.aborted) ctx.toast.show({
            title: changing ? "Bao bundle change not confirmed" : "Bao bundles unavailable",
            description: changing ? "Reopen /bao to check the current state." : "Use /bao-login or check trusted configuration.",
            variant: "error",
          })
        } finally { picking = false }
      },
    })
  },
})
