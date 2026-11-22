import { homedir } from "node:os"
import { LocalSetupError } from "./diagnostics"
import { runProcess } from "./process"

export interface Credentials { get(account: string): Promise<string>; set(account: string, value: string): Promise<void> }
export class MissingCredential extends Error {}

const keychainUnavailable = () => new Error("Bao unavailable; use /bao-login or check trusted configuration")
const keychain: Credentials = {
  async get(account) {
    const child = await runProcess("/usr/bin/security", ["find-generic-password", "-s", "opencode-bao", "-a", account, "-w"], { timeout: 15000, maxBytes: 65536, stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: homedir() } }).catch(() => { throw keychainUnavailable() })
    const value = child.stdout.trim()
    if (child.exitCode === 44) throw new MissingCredential()
    if (child.exitCode !== 0 || !value) throw keychainUnavailable()
    return value
  },
  async set(account, value) {
    const child = await runProcess("/usr/bin/security", ["add-generic-password", ...(account === "auth" ? ["-U"] : []), "-s", "opencode-bao", "-a", account, "-w", value], { timeout: 15000, stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: homedir() } }).catch(() => { throw keychainUnavailable() })
    if (child.exitCode !== 0) throw keychainUnavailable()
  },
}

const limit = 65536
const secretServiceHelper = `
import os
import pwd
import re
import stat
import sys

try:
    import gi
    gi.require_version("Secret", "1")
    from gi.repository import Gio, GLib, Secret
except Exception:
    sys.exit(11)

DAEMON = "/usr/bin/gnome-keyring-daemon"
BUS = "org.freedesktop.DBus"
BUS_PATH = "/org/freedesktop/DBus"
SERVICE = "org.freedesktop.Secret.Service"
SERVICE_PATH = "/org/freedesktop/secrets"
COLLECTION = "org.freedesktop.Secret.Collection"
LOGIN = SERVICE_PATH + "/collection/login"
ITEM = "org.freedesktop.Secret.Item"
DIR_FLAGS = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW

def trusted_daemon(pid):
    uid = os.getuid()
    executable = os.stat(DAEMON, follow_symlinks=False)
    if not stat.S_ISREG(executable.st_mode) or executable.st_uid != 0 or executable.st_mode & 0o022:
        raise ValueError()
    proc = os.open(f"/proc/{pid}", DIR_FLAGS)
    try:
        if os.fstat(proc).st_uid != uid or not os.path.samestat(executable, os.stat("exe", dir_fd=proc)):
            raise ValueError()
        for name in ("root", "ns/mnt", "ns/pid"):
            if not os.path.samestat(os.stat(f"/proc/self/{name}"), os.stat(name, dir_fd=proc)):
                raise ValueError()
        env_fd = os.open("environ", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=proc)
        with os.fdopen(env_fd, "rb") as source:
            raw = source.read(262145)
        if len(raw) > 262144 or not raw.endswith(b"\\0"):
            raise ValueError()
        paths = {}
        # procfs exposes the initial environment as one stream; retain only path settings.
        for entry in raw.split(b"\\0"):
            name, _, value = entry.partition(b"=")
            if name in (b"HOME", b"XDG_DATA_HOME", b"GNOME_KEYRING_TEST_PATH"):
                if name in paths:
                    raise ValueError()
                paths[name] = os.fsdecode(value)
        if paths.get(b"GNOME_KEYRING_TEST_PATH"):
            raise ValueError()
        home = clean_path(paths[b"HOME"] if b"HOME" in paths else pwd.getpwuid(uid).pw_dir)
        data = clean_path(paths.get(b"XDG_DATA_HOME") or home + "/.local/share")
        # GNOME can retain the legacy directory selected at startup. Do not guess.
        try:
            os.lstat(home + "/.gnome2")
        except FileNotFoundError:
            pass
        else:
            raise ValueError()
        return data + "/keyrings"
    finally:
        os.close(proc)

def clean_path(path):
    path = path.rstrip("/")
    if not path.startswith("/") or any(part in ("", ".", "..") for part in path[1:].split("/")):
        raise ValueError()
    return path

def verify_encrypted(directory):
    # GNOME 51.1 maps the login ID to login.keyring, with collision suffixes.
    # Its binary writer emits a 16-byte magic and four zero version/algorithm bytes.
    uid = os.getuid()
    parent = os.open("/", DIR_FLAGS)
    try:
        for part in directory[1:].split("/"):
            child = os.open(part, DIR_FLAGS, dir_fd=parent)
            os.close(parent)
            parent = child
            entry = os.fstat(parent)
            sticky_root = entry.st_uid == 0 and entry.st_mode & stat.S_ISVTX
            if entry.st_uid not in (0, uid) or (entry.st_mode & 0o022 and not sticky_root):
                raise ValueError()
        if entry.st_uid != uid or entry.st_mode & 0o077:
            raise ValueError()
        scan = os.open(".", os.O_RDONLY | os.O_DIRECTORY, dir_fd=parent)
        try:
            with os.scandir(scan) as names:
                if any(re.fullmatch(r"login_[0-9]+\\.keyring", entry.name) for entry in names):
                    raise ValueError()
        finally:
            os.close(scan)
        fd = os.open("login.keyring", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            keyring = os.fstat(fd)
            if (not stat.S_ISREG(keyring.st_mode) or keyring.st_uid != uid or keyring.st_mode & 0o077
                    or keyring.st_nlink != 1 or keyring.st_size < 100):
                raise ValueError()
            if os.read(fd, 20) != b"GnomeKeyring\\n\\r\\0\\n" + b"\\0" * 4:
                raise ValueError()
        finally:
            os.close(fd)
    except (OSError, ValueError):
        sys.exit(21)
    finally:
        os.close(parent)

def main():
    action, account = sys.argv[1:]
    if action not in ("get", "set") or account not in ("auth", "initialized", "snapshot-key"):
        sys.exit(16)
    if action == "set":
        raw = sys.stdin.buffer.read(${limit + 1})
        if not raw.strip() or b"\\x00" in raw or len(raw) > ${limit}:
            sys.exit(16)
        text = raw.decode("utf-8")

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    if bus.get_stream().get_socket().get_credentials().get_unix_user() != os.getuid():
        sys.exit(19)

    def call(destination, path, interface, method, signature, args, reply):
        return bus.call_sync(destination, path, interface, method, GLib.Variant(signature, args),
            GLib.VariantType.new(reply), Gio.DBusCallFlags.NO_AUTO_START, 3000, None)

    def bus_query(method, name, reply):
        return call(BUS, BUS_PATH, BUS, method, "(s)", (name,), reply).unpack()[0]

    owner = bus_query("GetNameOwner", "org.freedesktop.secrets", "(s)")
    try:
        if not Gio.dbus_is_unique_name(owner) or bus_query("GetConnectionUnixUser", owner, "(u)") != os.getuid():
            raise ValueError()
        directory = trusted_daemon(bus_query("GetConnectionUnixProcessID", owner, "(u)"))
    except (OSError, ValueError, KeyError, GLib.Error):
        sys.exit(20)

    def query(path, interface, method, signature, args, reply):
        return call(owner, path, interface, method, signature, args, reply)

    def prop(path, interface, name, signature):
        value = query(path, BUS + ".Properties", "Get", "(ss)", (interface, name), "(v)").get_child_value(0).get_variant()
        if value.get_type_string() != signature:
            sys.exit(16)
        return value.unpack()

    def check_collection():
        if query(SERVICE_PATH, SERVICE, "ReadAlias", "(s)", ("default",), "(o)").unpack()[0] != LOGIN:
            sys.exit(12)
        if prop(LOGIN, COLLECTION, "Locked", "b"):
            sys.exit(13)
        verify_encrypted(directory)

    check_collection()
    attrs = {"service": "opencode-bao", "account": account}
    identity = {**attrs, "xdg:schema": "org.opencode.Bao"}
    unlocked, locked = query(SERVICE_PATH, SERVICE, "SearchItems", "(a{ss})", (attrs,), "(aoao)").unpack()
    if len(unlocked) + len(locked) > 1:
        sys.exit(15)
    if locked:
        sys.exit(14)
    check_collection()
    path = unlocked[0] if unlocked else None

    def login_item(path):
        return re.fullmatch(LOGIN + r"/[0-9]+", path) is not None

    def check_item():
        if not login_item(path) or prop(path, ITEM, "Attributes", "a{ss}") != identity:
            sys.exit(16)
        if prop(path, ITEM, "Locked", "b"):
            sys.exit(14)

    if path is not None:
        check_item()
    elif action == "get":
        sys.exit(10)

    service = Secret.Service.open_sync(Secret.Service.__gtype__, owner, Secret.ServiceFlags.OPEN_SESSION, None)
    if service.get_session_algorithms() != "dh-ietf1024-sha256-aes128-cbc-pkcs7":
        sys.exit(19)
    if path is not None:
        session = service.get_session_dbus_path()
        value = query(path, ITEM, "GetSecret", "(o)", (session,), "((oayays))").get_child_value(0)
        if (value.get_child_value(0).get_string() != session or value.get_child_value(1).n_children() != 16
                or not 16 <= value.get_child_value(2).n_children() <= ${limit + 16}
                or value.get_child_value(2).n_children() % 16
                or value.get_child_value(3).get_string() != "text/plain"):
            sys.exit(16)
        secret = service.decode_dbus_secret(value)
        if secret is None or secret.get_content_type() != "text/plain":
            sys.exit(16)
        saved = bytes(secret.get())
        if not saved.strip() or b"\\x00" in saved or len(saved) > ${limit}:
            sys.exit(16)
        try:
            saved.decode("utf-8")
        except UnicodeError:
            sys.exit(16)

    check_collection()
    if path is not None:
        check_item()
    if action == "get":
        sys.stdout.buffer.write(saved)
        return

    try:
        encoded = service.encode_dbus_secret(Secret.Value.new(text, len(raw), "text/plain")).unpack()
        if path is not None:
            if account != "auth":
                sys.exit(18)
            query(path, ITEM, "SetSecret", "((oayays))", (encoded,), "()")
        else:
            fields = {ITEM + ".Attributes": GLib.Variant("a{ss}", identity),
                      ITEM + ".Label": GLib.Variant("s", "OpenCode Bao: " + account)}
            created, prompt = query(LOGIN, COLLECTION, "CreateItem", "(a{sv}(oayays)b)",
                (fields, encoded, False), "(oo)").unpack()
            if prompt != "/" or not login_item(created):
                sys.exit(17)
    except Exception:
        sys.exit(17)
    check_collection()

try:
    main()
except Exception:
    sys.exit(19)
`

const failures = {
  11: "credential_bindings",
  12: "credential_collection",
  13: "credential_collection_locked",
  14: "credential_item_locked",
  15: "credential_duplicates",
  16: "credential_invalid",
  17: "credential_set",
  18: "credential_anchor_exists",
  19: "credential_service",
  20: "credential_provider",
  21: "credential_unprotected",
} as const

export function secretService(run = runProcess, env: NodeJS.ProcessEnv = process.env): Credentials {
  const call = async (account: string, value?: string) => {
    if (!["auth", "initialized", "snapshot-key"].includes(account) || (value !== undefined && (!value.trim() || value.includes("\0") || Buffer.byteLength(value) > limit))) {
      throw new LocalSetupError("credential_invalid")
    }
    const address = env.DBUS_SESSION_BUS_ADDRESS
    if (!address || !/^unix:(?:path|abstract)=[^,;\s\0]+(?:,guid=[a-f0-9]{32})?$/i.test(address)) throw new LocalSetupError("credential_service")
    const child = await run("/usr/bin/python3", ["-I", "-c", secretServiceHelper, value === undefined ? "get" : "set", account], {
      input: value, env: { PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: address },
      timeout: 15000, maxBytes: limit, stderr: "ignore",
    }).catch((error: NodeJS.ErrnoException) => { throw new LocalSetupError(error?.code === "ENOENT" ? "credential_bindings" : "credential_service") })
    if (value === undefined && child.exitCode === 10 && child.stdout === "") throw new MissingCredential()
    if (child.exitCode !== 0) throw new LocalSetupError(failures[child.exitCode as keyof typeof failures] ?? "credential_service")
    if (value === undefined ? !child.stdout.trim() || child.stdout.includes("\0") || Buffer.byteLength(child.stdout) > limit : child.stdout !== "") {
      throw new LocalSetupError("credential_invalid")
    }
    return child.stdout
  }
  return { get: (account) => call(account), async set(account, value) { await call(account, value) } }
}

export function hostCredentials(platform = process.platform): Credentials {
  if (platform === "darwin") return keychain
  if (platform === "linux") return secretService()
  throw new LocalSetupError("storage")
}
