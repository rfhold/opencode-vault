import { expect, test, vi } from "vitest"
import { build } from "esbuild"
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initialize, readiness } from "../src/bao"
import { MissingCredential, secretService } from "../src/credentials"
import { LocalSetupError, type Diagnostic } from "../src/diagnostics"
import { runProcess } from "../src/process"

const address = "unix:path=/synthetic/bus"
const clean = { DBUS_SESSION_BUS_ADDRESS: address }
const result = (exitCode: number | null, stdout = "") => ({ exitCode, stdout, stderr: "synthetic-private-error" })

test("the Linux backend sends exact private bytes over pipes with a fixed helper and clean environment", async () => {
  const value = " synthetic-credential-π "
  const run = vi.fn<typeof runProcess>().mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(0, value))
  const store = secretService(run, {
    ...clean, PATH: "/synthetic/path", HOME: "/synthetic/home", XDG_RUNTIME_DIR: "synthetic-runtime", BAO_TOKEN: "synthetic-token",
    LD_PRELOAD: "synthetic-library", PYTHONPATH: "synthetic-import", GI_TYPELIB_PATH: "synthetic-typelib",
  })
  await store.set("auth", value)
  expect(await store.get("auth")).toBe(value)
  for (const [i, [file, args, options]] of run.mock.calls.entries()) {
    expect(file).toBe("/usr/bin/python3")
    expect(args.slice(0, 2)).toEqual(["-I", "-c"])
    expect(args.slice(3)).toEqual([i === 0 ? "set" : "get", "auth"])
    expect(JSON.stringify(args)).not.toContain(value)
    expect(options).toEqual({
      env: { PATH: "/usr/bin:/bin", ...clean }, input: i === 0 ? value : undefined,
      timeout: 15000, maxBytes: 65536, stderr: "ignore",
    })
  }
})

const failureCases: [number | null, string, Diagnostic][] = [
  [10, "unexpected private bytes", "credential_service"],
  [11, "", "credential_bindings"],
  [12, "", "credential_collection"],
  [13, "", "credential_collection_locked"],
  [14, "", "credential_item_locked"],
  [15, "", "credential_duplicates"],
  [16, "", "credential_invalid"],
  [17, "", "credential_set"],
  [18, "", "credential_anchor_exists"],
  [19, "", "credential_service"],
  [20, "", "credential_provider"],
  [21, "", "credential_unprotected"],
  [null, "", "credential_service"],
  [0, "", "credential_invalid"],
  [0, "private\0value", "credential_invalid"],
  [0, "x".repeat(65537), "credential_invalid"],
]
test.each(failureCases.map(([exitCode, stdout, diagnostic]) => ({ exitCode, stdout, diagnostic })))("Linux credential read fails safely with code $exitCode and $diagnostic", async ({ exitCode, stdout, diagnostic }) => {
  const store = secretService(async () => result(exitCode, stdout), clean)
  await expect(store.get("auth")).rejects.toEqual(new LocalSetupError(diagnostic))
})

test("Linux recognizes only an empty missing result as absence, never for a write", async () => {
  const store = secretService(async () => result(10), clean)
  await expect(store.get("auth")).rejects.toBeInstanceOf(MissingCredential)
  await expect(store.set("auth", "synthetic-value")).rejects.toEqual(new LocalSetupError("credential_service"))
  await expect(secretService(async () => result(0, "unexpected output"), clean).set("auth", "synthetic-value")).rejects.toEqual(new LocalSetupError("credential_invalid"))
})

test.each([undefined, "autolaunch:", "unix:runtime=yes", "tcp:host=synthetic", "unix:path=/synthetic/bus;autolaunch:"])("Linux rejects an absent or indirect bus before spawn: %s", async (DBUS_SESSION_BUS_ADDRESS) => {
  const run = vi.fn<typeof runProcess>()
  const store = secretService(run, { DBUS_SESSION_BUS_ADDRESS })
  await expect(store.get("auth")).rejects.toEqual(new LocalSetupError("credential_service"))
  expect(run).not.toHaveBeenCalled()
})

test("Linux rejects invalid input and conceals failure details from the subprocess", async () => {
  const run = vi.fn<typeof runProcess>()
  const store = secretService(run, clean)
  for (const value of ["", " ", "\0synthetic-value", "x".repeat(65537)]) {
    await expect(store.set("auth", value)).rejects.toEqual(new LocalSetupError("credential_invalid"))
  }
  expect(run).not.toHaveBeenCalled()
  run.mockRejectedValueOnce(Object.assign(new Error("synthetic-private-path"), { code: "ENOENT" }))
  await expect(store.get("auth")).rejects.toEqual(new LocalSetupError("credential_bindings"))
  run.mockRejectedValueOnce(new Error("synthetic-private-stderr"))
  await expect(store.get("auth")).rejects.toEqual(new LocalSetupError("credential_service"))
})

async function isolatedDirectory(prefix: string) {
  const parent = process.env.OPENCODE_TEST_TMP ?? join(tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  return mkdtemp(join(parent, prefix))
}

test("a keyring failure cannot look pristine or permit initialization", async () => {
  const base = await isolatedDirectory("vault-store-error-")
  const directory = join(base, "sessions")
  const run = vi.fn<typeof runProcess>().mockResolvedValue(result(13))
  const store = secretService(run, clean)
  try {
    await expect(readiness(store, directory)()).rejects.toEqual(new LocalSetupError("credential_collection_locked"))
    await expect(initialize(store, directory)).rejects.toEqual(new LocalSetupError("credential_collection_locked"))
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" })
    expect(run.mock.calls.every(([, args]) => args[3] === "get")).toBe(true)
  } finally { await rm(base, { recursive: true, force: true }) }
})

test.skipIf(process.platform !== "linux")("the Linux directory reservation permits only one initializer to write anchors", async () => {
  const base = await isolatedDirectory("vault-first-use-")
  const directory = join(base, "nested", "sessions")
  const values = new Map<string, string>()
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const set = vi.fn(async (account: string, value: string) => {
    if (account === "initialized") {
      enter()
      await new Promise<void>((resolve) => { release = resolve })
    }
    values.set(account, value)
  })
  const credentials = { get: async (account: string) => {
    if (!values.has(account)) throw new MissingCredential()
    return values.get(account)!
  }, set }
  const first = initialize(credentials, directory)
  try {
    await Promise.race([entered, first])
    expect(await readiness(credentials, directory)()).toBe(true)
    await expect(initialize(credentials, directory)).rejects.toThrow("unavailable")
    expect(set.mock.calls.map(([account]) => account)).toEqual(["initialized"])
  } finally {
    release?.()
    try { await first }
    finally { await rm(base, { recursive: true, force: true }) }
  }
  expect(set.mock.calls.map(([account]) => account)).toEqual(["initialized", "snapshot-key"])
})

test.skipIf(process.platform !== "linux" || process.env.OPENCODE_TEST_SECRET_SERVICE !== "1")("isolated GNOME Keyring separates absence, valid credentials, locks, and unavailable service", async () => {
  const base = await isolatedDirectory("vault-keyring-")
  const dirs = Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "XDG_DATA_HOME"].map((name) => [name, join(base, name)]))
  try {
    await Promise.all(Object.values(dirs).map((path) => mkdir(path, { mode: 0o700 })))
    const plaintext = join(base, "passwordless")
    await mkdir(plaintext, { mode: 0o700 })
    await build({ entryPoints: ["src/credentials.ts"], outfile: join(base, "credentials.mjs"), bundle: true, platform: "node", format: "esm" })
    await writeFile(join(base, "check.mjs"), `
      import assert from "node:assert/strict"
      import { spawnSync } from "node:child_process"
      import { MissingCredential, secretService } from "./credentials.mjs"
      const credentials = secretService()
      const diagnostic = (name) => (error) => error.diagnostic === name
      const check = process.argv[2]
      if (check === "unavailable") {
        await assert.rejects(credentials.get("auth"), diagnostic("credential_service"))
      } else if (check === "foreign-provider") {
        await assert.rejects(credentials.get("auth"), diagnostic("credential_provider"))
        await assert.rejects(credentials.set("auth", "synthetic-refused-provider"), diagnostic("credential_provider"))
      } else if (check === "no-default") {
        await assert.rejects(credentials.get("auth"), diagnostic("credential_collection"))
      } else if (check === "locked") {
        await assert.rejects(credentials.get("auth"), diagnostic("credential_collection_locked"))
        await assert.rejects(credentials.set("auth", "synthetic-value"), diagnostic("credential_collection_locked"))
      } else if (check === "duplicate") {
        await assert.rejects(credentials.get("auth"), diagnostic("credential_duplicates"))
        await assert.rejects(credentials.set("auth", "synthetic-value"), diagnostic("credential_duplicates"))
      } else if (check === "unprotected") {
        await assert.rejects(credentials.get("auth"), diagnostic("credential_unprotected"))
        await assert.rejects(credentials.set("auth", "synthetic-refused-passwordless"), diagnostic("credential_unprotected"))
      } else if (["prompt", "malformed-lock", "invalid"].includes(check)) {
        const injected = secretService(async (python, args, options) => {
          const point = "        return bus.call_sync(destination"
          const fakeReply = check === "prompt"
            ? '        if method == "Prompt" or (method == "CreateItem" and args[2]): sys.exit(99)\\n        if method == "CreateItem": return GLib.Variant("(oo)", ("/", "/synthetic/prompt"))'
            : check === "malformed-lock"
              ? '        if method == "Get" and args[1] == "Locked": return GLib.Variant("(v)", (GLib.Variant("s", ""),))'
              : '        if method == "GetSecret": sys.exit(99)'
          assert(args[2].includes(point))
          const helper = args[2].replace(point, fakeReply + "\\n" + point)
          const child = spawnSync(python, [...args.slice(0, 2), helper, ...args.slice(3)], {
            encoding: "utf8", env: options.env, input: options.input, stdio: ["pipe", "pipe", "ignore"], timeout: 10000,
          })
          return { stdout: child.stdout, stderr: "", exitCode: child.status }
        })
        if (check === "prompt") {
          await assert.rejects(injected.set("auth", "synthetic-would-prompt"), diagnostic("credential_set"))
          await assert.rejects(credentials.get("auth"), MissingCredential)
        } else {
          await assert.rejects(injected.get("auth"), diagnostic("credential_invalid"))
          if (check === "invalid") await assert.rejects(injected.set("auth", "synthetic-value"), diagnostic("credential_invalid"))
        }
      } else {
        await assert.rejects(credentials.get("auth"), MissingCredential)
        await credentials.set("initialized", "v1")
        const syntheticKey = Buffer.alloc(32, 3).toString("base64")
        await credentials.set("snapshot-key", syntheticKey)
        await assert.rejects(credentials.set("initialized", "v2"), diagnostic("credential_anchor_exists"))
        await assert.rejects(credentials.set("snapshot-key", Buffer.alloc(32, 7).toString("base64")), diagnostic("credential_anchor_exists"))
        assert(await credentials.get("initialized") === "v1")
        assert(await credentials.get("snapshot-key") === syntheticKey)
        await credentials.set("auth", " synthetic-tékén ")
        assert(await credentials.get("auth") === " synthetic-tékén ")
        await credentials.set("auth", "synthetic-updated")
        assert(await credentials.get("auth") === "synthetic-updated")
      }
    `)
    await writeFile(join(base, "fixture.py"), `
import sys
import gi
gi.require_version("Secret", "1")
from gi.repository import Gio, GLib, Secret

mode = sys.argv[1]
if mode == "foreign-provider":
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    dbus = "org.freedesktop.DBus"
    bus.call_sync(dbus, "/org/freedesktop/DBus", dbus, "RequestName",
        GLib.Variant("(su)", ("org.freedesktop.secrets", 0)), GLib.VariantType.new("(u)"), Gio.DBusCallFlags.NONE, 3000, None)
    GLib.MainLoop().run()
    sys.exit()
service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION, None)
attrs = {"service": "opencode-bao", "account": "auth"}
if mode == "passwordless":
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    internal = "org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface"
    pw = service.encode_dbus_secret(Secret.Value.new("", 0, "text/plain")).unpack()
    label = GLib.Variant("s", "login")
    arguments = GLib.Variant("(a{sv}(oayays))", ({"org.freedesktop.Secret.Collection.Label": label}, pw))
    path, = bus.call_sync("org.freedesktop.secrets", "/org/freedesktop/secrets", internal,
        "CreateWithMasterPassword", arguments, GLib.VariantType.new("(o)"), Gio.DBusCallFlags.NONE, 3000, None).unpack()
    assert path == "/org/freedesktop/secrets/collection/login"
elif mode in ("wrong-location", "duplicate"):
    session = Secret.Collection.for_alias_sync(service, "session", Secret.CollectionFlags.NONE, None)
    schema = Secret.Schema.new("org.opencode.Bao", Secret.SchemaFlags.NONE,
        {"service": Secret.SchemaAttributeType.STRING, "account": Secret.SchemaAttributeType.STRING})
    assert Secret.Item.create_sync(session, schema, attrs, "Synthetic unexpected item",
        Secret.Value.new("not-a-real-secret", -1, "text/plain"), Secret.ItemCreateFlags.NONE, None)
else:
    item, = service.search_sync(None, attrs, Secret.SearchFlags.ALL, None)
    if mode == "remove-wrong":
        assert item.get_object_path().startswith("/org/freedesktop/secrets/collection/session/")
        assert item.delete_sync(None)
    else:
        assert item.set_attributes_sync(None, dict(attrs, synthetic="unexpected"), None)
`)
    const shell = `
      owner() { gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets; }
      ready() {
        for n in {1..50}; do
          if [[ $(owner) == "(true,)" ]]; then return; fi
          sleep 0.1
        done
        return 1
      }
      stop() { kill "$daemon" 2>/dev/null || :; wait "$daemon" 2>/dev/null || :; }
      check() { "$1" "$2/check.mjs" "$3"; }
      trap 'if [[ -n \${daemon:-} ]]; then stop; fi' EXIT
      check "$1" "$2" unavailable
      [[ $(owner) == "(false,)" ]]
      /usr/bin/python3 -I "$2/fixture.py" foreign-provider &
      daemon=$!
      ready
      check "$1" "$2" foreign-provider
      stop
      gnome-keyring-daemon --foreground --components=secrets >/dev/null 2>&1 &
      daemon=$!
      ready
      check "$1" "$2" no-default
      gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.SetAlias default /org/freedesktop/secrets/collection/session >/dev/null
      check "$1" "$2" no-default
      gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.SetAlias default / >/dev/null
      stop
      gnome-keyring-daemon --foreground --unlock --components=secrets >/dev/null 2>&1 <<< synthetic-keyring-password &
      daemon=$!
      ready
      check "$1" "$2" malformed-lock
      check "$1" "$2" prompt
      /usr/bin/python3 -I "$2/fixture.py" wrong-location
      check "$1" "$2" invalid
      /usr/bin/python3 -I "$2/fixture.py" remove-wrong
      check "$1" "$2" round-trip
      keyring="$XDG_DATA_HOME/keyrings/login.keyring"
      ln -s "$keyring" "\${keyring%.keyring}_1.keyring"
      check "$1" "$2" unprotected
      rm "\${keyring%.keyring}_1.keyring"
      /usr/bin/python3 -I "$2/fixture.py" invalid
      check "$1" "$2" invalid
      /usr/bin/python3 -I "$2/fixture.py" duplicate
      check "$1" "$2" duplicate
      gdbus call --session --dest org.freedesktop.secrets --object-path /org/freedesktop/secrets --method org.freedesktop.Secret.Service.Lock "['/org/freedesktop/secrets/collection/login']" >/dev/null
      check "$1" "$2" locked
      stop
      XDG_DATA_HOME="$2/passwordless" gnome-keyring-daemon --foreground --components=secrets >/dev/null 2>&1 &
      daemon=$!
      ready
      /usr/bin/python3 -I "$2/fixture.py" passwordless
      cp "$2/passwordless/keyrings/login.keyring" "$2/passwordless-before"
      check "$1" "$2" unprotected
      cmp "$2/passwordless-before" "$2/passwordless/keyrings/login.keyring"
    `
    const child = await runProcess("/usr/bin/dbus-run-session", ["--", "/usr/bin/bash", "-euc", shell, "--", process.execPath, base], {
      env: { PATH: "/usr/bin:/bin", ...dirs }, timeout: 20000, maxBytes: 65536,
    })
    expect(child.stderr).toBe("")
    expect(child.exitCode).toBe(0)
    expect((await readFile(join(dirs.XDG_DATA_HOME!, "keyrings", "login.keyring"))).includes("synthetic-updated")).toBe(false)
    const passwordless = await readFile(join(plaintext, "keyrings", "login.keyring"))
    expect(passwordless.subarray(0, 9).toString()).toBe("[keyring]")
    expect(passwordless.includes("synthetic-refused-passwordless")).toBe(false)
  } finally { await rm(base, { recursive: true, force: true }) }
}, 25000)
