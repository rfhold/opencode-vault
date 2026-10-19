import { Context, Effect } from "effect"
import { Plugin } from "@opencode/plugin/effect"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Tool } from "@opencode/schema/tool"
import { Bao, LoginBusy, config, encryptionKey, readiness, stateRoot, validBundle } from "./bao"
import { LocalSetupError, failureData, rpcDiagnostic } from "./diagnostics"
import { Sessions } from "./state"
import { Scrubber } from "./redact"
import { BaoRpc, type Status } from "./rpc"

export const Invocation = Context.Reference<Readonly<Record<string, string>> | undefined>("opencode-bao/Invocation", { defaultValue: () => undefined })
const privateIO = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: () => new Error("Bao operation unavailable") })

export const shellOverlay = Effect.fnUntraced(function* (event: ShellCreateBefore) {
  const overlay = yield* Invocation
  if (overlay) event.env = { ...event.env, ...overlay }
})

export const install = Effect.fnUntraced(function* (ctx: PluginContext, sessions: Sessions, bao?: Bao, ready: () => Promise<boolean> = async () => true, configurationError?: LocalSetupError, loadBao?: () => Promise<Bao>) {
  const resolveBao = async () => {
    if (loadBao) {
      try { return await loadBao() }
      catch (error) { throw error instanceof LocalSetupError ? error : new LocalSetupError("schema") }
    }
    if (!bao) throw configurationError ?? new LocalSetupError("missing")
    return bao
  }
  yield* ctx.tool.transform((editor) => {
    editor.update("shell", (tool) => {
      const native = tool.execute
      tool.execute = (input, context) => Effect.gen(function* () {
        const overlay = yield* privateIO(async () => await ready() ? sessions.overlay(context.sessionID) : undefined).pipe(
          Effect.mapError(() => new Tool.Error({ message: "Bao session environment unavailable" })),
        )
        return yield* native(input, context).pipe(Effect.provideService(Invocation, overlay))
      })
    })
  })
  yield* ctx.shell.hook("create.before", shellOverlay)

  const scrubber = (session: string) => privateIO(async () => {
    if (!await ready()) return
    const snapshot = await sessions.read(session)
    return snapshot.history.length || Object.keys(snapshot.active).length ? new Scrubber(snapshot.history) : undefined
  }).pipe(Effect.orDie)

  for (const name of ["context", "title", "compaction", "generate"] as const) {
    yield* ctx.session.hook(name, (event) => Effect.gen(function* () {
      const scrub = yield* scrubber(event.sessionID)
      if (!scrub) return
      yield* Effect.sync(() => {
        event.system = scrub.json(event.system)
        event.messages = scrub.json(event.messages)
        event.options = scrub.json(event.options)
        if ("tools" in event) event.tools = scrub.json(event.tools)
      })
    }))
  }
  yield* ctx.session.hook("http.request", (event) => Effect.gen(function* () {
    const scrub = yield* scrubber(event.sessionID)
    if (scrub) event.request = yield* privateIO(() => scrub.request(event.request)).pipe(Effect.orDie)
  }))
  yield* ctx.session.hook("experimental.ws.send", (event) => Effect.gen(function* () {
    const scrub = yield* scrubber(event.sessionID)
    if (scrub) yield* Effect.sync(() => { event.frame = scrub.frame(event.frame) })
  }))
  yield* ctx.session.hook("experimental.ws.handshake", (event) => Effect.gen(function* () {
    const scrub = yield* scrubber(event.sessionID)
    if (scrub) yield* Effect.sync(() => { event.url = scrub.text(event.url); event.headers = scrub.headers(event.headers) })
  }))
  yield* ctx.session.hook("model.request", (event) => Effect.gen(function* () {
    const scrub = yield* scrubber(event.sessionID)
    if (scrub) yield* Effect.sync(() => {
      event.headers = scrub.headers(event.headers)
      if (event.baseURL) event.baseURL = scrub.text(event.baseURL)
    })
  }))

  const status = async (sessionID: string, bao: Bao, localOnly = false): Promise<Status> => {
    const snapshot = await ready() ? await sessions.read(sessionID) : { version: 0, active: {}, history: [] } as import("./state").Snapshot
    let names: string[] = []
    let catalogUnavailable = localOnly
    let catalogFailure
    if (!localOnly) {
      try { names = await bao.catalog() }
      catch (error) { if (!Object.keys(snapshot.active).length) throw error; catalogUnavailable = true; catalogFailure = failureData(error) }
    }
    return { sessionID, version: snapshot.version, bundles: [...new Set([...names, ...Object.keys(snapshot.active)])].sort().map((name) => ({ name, enabled: Object.hasOwn(snapshot.active, name), keys: Object.keys(snapshot.active[name] ?? {}).length })), protectedValues: snapshot.history.length, ...(catalogUnavailable ? { catalogUnavailable: true } : {}), ...(catalogFailure ? { catalogFailure } : {}) }
  }
  const handler = (action: "status" | "enable" | "disable"): RpcHandlers<typeof BaoRpc>["status"] => (input, context) =>
    Effect.gen(function* () {
      const { sessionID, bundle, version } = input as { sessionID: string; bundle?: string; version?: number }
      const session = yield* ctx.session.get({ sessionID: sessionID as never })
      if (session.location.directory !== ctx.location.directory) return yield* Effect.fail(new Error("Unknown session"))
      return yield* Effect.tryPromise({ try: async () => {
        const bao = await resolveBao()
        if (action !== "status") {
          if (!await ready()) throw new LocalSetupError("storage")
          if (!validBundle(bundle)) throw new Error("Unknown bundle")
          const snapshot = await sessions.read(sessionID)
          if (version !== snapshot.version) throw new LocalSetupError("stale")
          if (action === "enable") {
            if (!Object.hasOwn(snapshot.active, bundle)) await sessions.enable(sessionID, bundle, await bao.bundle(bundle), version)
          } else await sessions.disable(sessionID, bundle, version)
        }
        return status(sessionID, bao, action === "disable")
      }, catch: (error) => error })
    }).pipe(Effect.catch((error) => {
      const data = failureData(error) ?? {}
      return Effect.fail(context.error("unavailable", rpcDiagnostic({ type: "unavailable", data }) ?? "Bao operation unavailable; use /bao-login or check trusted configuration", data))
    }))
  const login: RpcHandlers<typeof BaoRpc>["login"] = (_input, context) => Effect.tryPromise({
    try: async (signal) => {
      const bao = await resolveBao()
      await bao.login({ signal })
      return { authenticated: true }
    },
    catch: (error) => {
      if (error instanceof LoginBusy) return context.error("busy", "Bao login already in progress; finish the existing browser sign-in", {})
      const data = failureData(error) ?? {}
      return context.error("unavailable", rpcDiagnostic({ type: "unavailable", data }) ?? "Bao login failed or timed out; retry /bao-login or check trusted configuration, local browser, Keychain and dedicated role; do not reset existing state", data)
    },
  })
  yield* ctx.rpc.register(BaoRpc, { status: handler("status"), enable: handler("enable"), disable: handler("disable"), login }).pipe(Effect.orDie)
})

export default Plugin.define({
  id: "opencode.bao",
  effect: (ctx) => Effect.gen(function* () {
    if (process.platform !== "darwin") return
    const sessions = new Sessions(stateRoot, encryptionKey)
    yield* install(ctx, sessions, undefined, readiness(), undefined, async () => new Bao(await config()))
  }),
})
