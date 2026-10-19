import * as Plugin from "@opencode/plugin/tui/plugin"
import { BaoRpc, type Status } from "./rpc"
import { rpcDiagnostic } from "./diagnostics"

export default Plugin.define({
  id: "opencode.bao.tui",
  setup(ctx) {
    if (process.platform !== "darwin") return
    const rpc = ctx.client.rpc(BaoRpc)
    let loggingIn = false
    let picking = false
    let pickerOpen = false
    const lifetime = new AbortController()
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "bao.login", title: "Bao login", group: "Bao", palette: true,
      slash: { name: "bao-login" },
      run: async () => {
        if (lifetime.signal.aborted) return
        if (loggingIn) return ctx.ui.toast.show({ message: "Bao login already in progress; finish the browser sign-in", variant: "info" })
        loggingIn = true
        ctx.ui.toast.show({ message: "Bao login: preparing local storage and opening the browser on the OpenCode server host; finish sign-in within two minutes", variant: "info", duration: 10000 })
        try {
          const result = await rpc.login({}, { location: ctx.location ?? ctx.data.location.default(), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(200000)]) })
          if (lifetime.signal.aborted) return
          if (typeof result !== "object" || result === null || Array.isArray(result) || !("authenticated" in result) || result.authenticated !== true || Object.keys(result).length !== 1 || !Object.hasOwn(result, "authenticated")) throw new Error("Bao login failed")
          ctx.ui.toast.show({ message: "Bao login complete; use /bao to select environment bundles", variant: "success" })
        } catch (error) {
          if (lifetime.signal.aborted) return
          ctx.ui.toast.show({ message: rpcDiagnostic(error) ?? "Bao login failed, timed out, or is already in progress. Finish any existing browser sign-in, then retry /bao-login. Check local browser, Keychain, trusted configuration and dedicated role; do not reset existing state.", variant: "error", duration: 10000 })
        } finally { loggingIn = false }
      },
    }, {
      id: "bao.bundles", title: "Bao environment bundles", group: "Bao", palette: true,
      slash: { name: "bao" },
      run: async () => {
        if (lifetime.signal.aborted) return
        if (picking) return ctx.ui.toast.show({ message: "Bao bundle selection or update already in progress", variant: "info" })
        const route = ctx.ui.router.current()
        if (route.type !== "session") return ctx.ui.toast.show({ message: "Open a session first", variant: "info" })
        const sessionID = route.sessionID
        picking = true
        let completed = 0
        let total = 0
        let failed: { name: string; action: "enable" | "disable" } | undefined
        ctx.ui.toast.show({ message: "Bao: loading bundle catalog and checking authentication", variant: "info" })
        try {
          const request = { location: ctx.location ?? ctx.data.location.default(), signal: lifetime.signal }
          const status = await rpc.status({ sessionID }, request) as Status
          if (lifetime.signal.aborted) return
          if (status.catalogUnavailable) ctx.ui.toast.show({ message: `Bao catalog unavailable. ${rpcDiagnostic({ type: "unavailable", data: status.catalogFailure }) ?? "Use /bao-login or check trusted configuration."} Loaded bundles remain active and can be disabled.`, variant: "info", duration: 10000 })
          if (!status.bundles.length) return ctx.ui.toast.show({ message: "No Bao bundles found. Add a flat KV v2 document under the configured prefix, then reopen /bao.", variant: "info", duration: 10000 })
          const [selection, updateSelection] = ctx.storage.memory("bundle-picker", { initial: { marked: [] as string[] } })
          updateSelection((draft) => { draft.marked = [] })
          pickerOpen = true
          let submitted: string | undefined
          try {
            submitted = await ctx.ui.dialog.select({
              get title() { return `Bao: ${selection.marked.length} marked; ${status.bundles.filter((item) => item.enabled).length} enabled; ${status.protectedValues} protected values` },
              placeholder: "Search bundles; Space mark/unmark, Enter apply marked, Esc cancel",
              get options() { return status.bundles.map((item) => ({ value: item.name, title: `[${selection.marked.includes(item.name) ? "x" : " "}] ${item.name}`, description: item.enabled ? `Enabled (${item.keys} keys); disable` : "Disabled; enable" })) },
              search: (query, options) => options.filter((item) => item.value.toLowerCase().includes(query.toLowerCase())),
              actions: [{ bind: "space", title: "Mark/unmark", onTrigger: (value) => {
                if (lifetime.signal.aborted) return
                updateSelection((draft) => { draft.marked = draft.marked.includes(value) ? draft.marked.filter((name) => name !== value) : [...draft.marked, value] })
              } }],
            })
          } finally { pickerOpen = false }
          if (lifetime.signal.aborted || submitted === undefined) return
          const changes = status.bundles.filter((item) => typeof item.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name) && typeof item.enabled === "boolean" && selection.marked.includes(item.name)).sort((a, b) => Number(b.enabled) - Number(a.enabled))
          total = changes.length
          if (!total) return ctx.ui.toast.show({ message: "No Bao bundles marked; use Space to mark bundles, then Enter to apply", variant: "info" })
          ctx.ui.toast.show({ message: `Bao: applying ${total} marked bundle changes; disabling before enabling and fetching selected values`, variant: "info", duration: 10000 })
          let version = status.version
          for (const item of changes) {
            if (lifetime.signal.aborted) return
            failed = { name: item.name, action: item.enabled ? "disable" : "enable" }
            const result = await rpc[item.enabled ? "disable" : "enable"]({ sessionID, bundle: item.name, version }, request) as Status
            if (lifetime.signal.aborted) return
            version = result.version
            completed++
          }
          ctx.ui.toast.show({ message: `Bao: ${completed} bundle changes applied`, variant: "success" })
        } catch (error) {
          if (lifetime.signal.aborted) return
          const message = rpcDiagnostic(error) ?? "Bao unavailable; use /bao-login or check trusted configuration"
          ctx.ui.toast.show({ message: total && failed ? `Bao: ${completed} of ${total} changes confirmed; ${failed.action} ${failed.name} failed. Remaining ${total - completed - 1} changes NOT attempted; stopped without retry or rollback. The failed change may already have applied; inspect current state by reopening /bao before selecting more changes. ${message}` : message, variant: "error", duration: 10000 })
        } finally { picking = false }
      },
    }] }))
    return () => {
      lifetime.abort()
      if (pickerOpen) ctx.ui.dialog.clear()
    }
  },
})
