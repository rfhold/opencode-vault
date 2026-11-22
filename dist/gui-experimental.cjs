"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/gui.ts
var gui_exports = {};
__export(gui_exports, {
  default: () => gui_default
});
module.exports = __toCommonJS(gui_exports);
var import_gui = require("@opencode/plugin/gui");

// src/rpc.ts
var import_rpc = require("@opencode/plugin/rpc");

// src/diagnostics.ts
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var configPath = (0, import_node_path.join)((0, import_node_os.homedir)(), ".config", "opencode-bao", "config.json");
var diagnostics = {
  stored_login: "Bao unavailable: stored login is missing, expired or unreadable. Unlock the OS credential store or use /bao-login.",
  http: "Bao unavailable: server rejected the request.",
  transport: "Bao unavailable: network request failed or timed out; check connectivity before reopening /bao.",
  response_json: "Bao unavailable: server response was not readable JSON.",
  grant_response: "Bao unavailable: token creation response did not contain a usable token.",
  catalog_response: "Bao unavailable: catalog response contains malformed bundle names.",
  environment: "Bao unavailable: bundle KV document must be an object of valid environment names and single-line string values.",
  conflict: "Bao bundle key conflict: selected bundle duplicates environment keys in an active bundle; inspect active bundles before changing the selection.",
  stale: "Stale Bao operation: session version changed; reopen /bao and inspect current state before selecting changes.",
  state: "Bao session state unavailable: local state is unreadable or locked; check storage access without resetting existing state.",
  missing: `Bao configuration unavailable: create ${configPath} from examples/config.json, then configure Bao roles before /bao-login.`,
  permissions: "Bao configuration unavailable: you must own the config file, directory targets, and symlinks. Targets must not allow group or world writes.",
  json: `Bao configuration unavailable: fix invalid JSON in ${configPath}.`,
  schema: `Bao configuration unavailable: check HTTPS address, mount, prefix, oidc, optional oidcRole, catalogRole, readRole and absolute bao executable in ${configPath}; replace the old bundles map with role names.`,
  executable: `Bao unavailable: check the absolute bao executable location in ${configPath}; it must exist and be executable.`,
  storage: "Bao unavailable: local storage initialization failed. Check the OS credential store and current protection state. Do not reset existing state.",
  authentication: "Bao unavailable: browser OIDC sign-in failed or timed out; check browser, network and Bao role, then retry /bao-login. Do not reset existing state.",
  identity: "Bao unavailable: token expiry validation or credential save failed. Check Bao access and the OS credential store. Do not reset existing state.",
  login_response: "Bao unavailable: login-response JSON/auth object is missing or malformed. Do not reset existing state.",
  login_client_token: "Bao unavailable: login-response client_token must be a nonempty string. Do not reset existing state.",
  lookup_request: "Bao unavailable: token self-lookup request failed or returned unreadable JSON. Do not reset existing state.",
  lookup_response: "Bao unavailable: token self-lookup data object is missing or malformed. Do not reset existing state.",
  lookup_ttl: "Bao unavailable: token self-lookup ttl must describe a usable lease; zero requires no server expiry. Do not reset existing state.",
  lookup_expire_time: "Bao unavailable: token self-lookup expire_time must be a valid timestamp string. Do not reset existing state.",
  lookup_deadline: "Bao unavailable: token self-lookup expiry/ttl deadline has already passed. Do not reset existing state.",
  credential_bindings: "Bao unavailable: Linux system Python or the Secret Service bindings are unavailable. Check the Python GI and libsecret packages.",
  credential_service: "Bao unavailable: Linux Secret Service is unavailable. Check that the OpenCode server uses your graphical session bus.",
  credential_collection: "Bao unavailable: GNOME Keyring does not use the login collection as its default. Do not reset existing state.",
  credential_provider: "Bao unavailable: the local GNOME Keyring daemon or its data directory could not be verified. Do not reset existing state.",
  credential_unprotected: "Bao unavailable: GNOME Keyring's login file could not be verified as encrypted. Use a password-protected login keyring. Do not reset existing state.",
  credential_collection_locked: "Bao unavailable: the default Linux keyring is locked. Unlock it in your desktop session.",
  credential_item_locked: "Bao unavailable: the Linux keyring credential is locked. Unlock it in your desktop session.",
  credential_duplicates: "Bao unavailable: Linux Secret Service returned duplicate credentials. Inspect the keyring without deleting protection anchors.",
  credential_invalid: "Bao unavailable: the Linux keyring credential has an unexpected location, identity, or format. Do not reset existing state.",
  credential_anchor_exists: "Bao unavailable: Linux Secret Service already holds this protection anchor. Do not reset existing state.",
  credential_set: "Bao unavailable: the OS credential store could not save a credential. Do not reset existing state.",
  credential_read_missing: "Bao unavailable: the OS credential store reports a missing auth credential after save. Do not reset existing state.",
  credential_read: "Bao unavailable: the OS credential store could not read back the auth credential. Do not reset existing state.",
  credential_mismatch: "Bao unavailable: the auth credential does not exactly match the saved token and deadline. Do not reset existing state."
};
var stages = { parent: "parent token lookup", grant: "child token creation", catalog: "catalog lookup", bundle: "bundle read", revoke: "child token revocation" };

// src/rpc.ts
var input = {
  type: "object",
  properties: { sessionID: { type: "string", minLength: 1, maxLength: 256 }, bundle: { type: "string" }, version: { type: "integer", minimum: 0 } },
  required: ["sessionID"],
  additionalProperties: false
};
var unavailable = { type: "object", properties: { diagnostic: { type: "string", enum: Object.keys(diagnostics) }, stage: { type: "string", enum: Object.keys(stages) }, httpStatus: { type: "integer", minimum: 100, maximum: 599 } }, additionalProperties: false };
var method = { input, output: { type: "object" }, errors: { unavailable } };
var mutation = { ...method, input: { ...input, required: ["sessionID", "bundle", "version"] } };
var login = {
  input: { type: "object", additionalProperties: false },
  output: { type: "object", properties: { authenticated: { const: true } }, required: ["authenticated"], additionalProperties: false },
  errors: { unavailable, busy: { type: "object", additionalProperties: false } }
};
var BaoRpc = import_rpc.Rpc.define({ id: "opencode.bao", methods: { status: method, enable: mutation, disable: mutation, login }, events: {} });

// src/gui.ts
var gui_default = import_gui.Plugin.define({
  setup(ctx) {
    const { signal } = ctx;
    let loggingIn = false;
    let picking = false;
    const supported = () => {
      if (signal.aborted) return false;
      if (ctx.desktop?.os === "macos" || ctx.desktop?.os === "linux") return true;
      ctx.toast.show({ title: "Bao requires a local macOS or Linux server with access to its OS credential store" });
      return false;
    };
    const localSession = (session) => {
      if (!session || session.server.builtin) return true;
      ctx.toast.show({ title: "Bao is not available for remote sessions", description: "Switch to the Desktop app's own server to use Bao." });
      return false;
    };
    ctx.add(import_gui.Command, {
      id: "login",
      title: "Bao login",
      group: "Bao",
      slash: { name: "bao-login" },
      async run() {
        if (!supported()) return;
        const session = ctx.sessions.current();
        if (!localSession(session)) return;
        if (loggingIn) {
          ctx.toast.show({ title: "Bao login already in progress" });
          return;
        }
        loggingIn = true;
        ctx.toast.show({ title: "Bao login", description: "Finish sign-in in your browser within two minutes.", duration: 1e4 });
        try {
          const result = await ctx.client.rpc(BaoRpc).login({}, { location: session?.location, signal: AbortSignal.any([signal, AbortSignal.timeout(2e5)]) });
          if (signal.aborted) return;
          if (typeof result !== "object" || result === null || Array.isArray(result) || !("authenticated" in result) || result.authenticated !== true || Object.keys(result).length !== 1 || !Object.hasOwn(result, "authenticated")) throw new Error("Invalid login result");
          ctx.toast.show({ title: "Bao login complete", description: "Open /bao to select a bundle.", variant: "success" });
        } catch {
          if (!signal.aborted) ctx.toast.show({ title: "Bao login did not complete", description: "Finish any open browser sign-in, then retry /bao-login. Check the local browser, OS credential store, and trusted configuration. Do not reset existing state.", variant: "error", duration: 1e4 });
        } finally {
          loggingIn = false;
        }
      }
    });
    ctx.add(import_gui.Command, {
      id: "bundles",
      title: "Bao environment bundles",
      group: "Bao",
      slash: { name: "bao" },
      async run() {
        if (!supported() || picking) return;
        const session = ctx.sessions.current();
        if (!localSession(session)) return;
        if (!session?.location || session.pending) {
          ctx.toast.show({ title: "Open a local session first" });
          return;
        }
        const { id: sessionID, location } = session;
        const request = { location, signal };
        picking = true;
        let changing = false;
        try {
          const client = ctx.client;
          const status = await client.rpc(BaoRpc).status({ sessionID }, request);
          if (signal.aborted) return;
          if (status.sessionID !== sessionID || !Number.isSafeInteger(status.version) || status.version < 0) throw new Error("Invalid bundle status");
          if (status.catalogUnavailable) ctx.toast.show({ title: "Bao catalog unavailable", description: "You can still disable loaded bundles." });
          const bundles = status.bundles.filter((item2) => typeof item2.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item2.name) && typeof item2.enabled === "boolean");
          if (!bundles.length) {
            ctx.toast.show({ title: "No Bao bundles found", description: "Check the configured bundle catalog, then reopen /bao." });
            return;
          }
          const choice = await ctx.dialogs.select({
            title: "Toggle a Bao bundle",
            options: bundles.map((item2) => ({ value: item2.name, title: item2.name, description: item2.enabled ? "Enabled; select to disable" : "Disabled; select to enable" }))
          });
          if (signal.aborted || choice === void 0) return;
          const item = bundles.find(({ name }) => choice === name);
          if (!item) return;
          const activeClient = ctx.client;
          if (activeClient !== client) {
            ctx.toast.show({ title: "OpenCode server changed", description: "Reopen /bao to refresh the bundle list." });
            return;
          }
          changing = true;
          await activeClient.rpc(BaoRpc)[item.enabled ? "disable" : "enable"]({ sessionID, bundle: item.name, version: status.version }, request);
          if (!signal.aborted) ctx.toast.show({ title: item.enabled ? "Bao bundle disabled" : "Bao bundle enabled", variant: "success" });
        } catch {
          if (!signal.aborted) ctx.toast.show({
            title: changing ? "Bao bundle change not confirmed" : "Bao bundles unavailable",
            description: changing ? "Reopen /bao to check the current state." : "Use /bao-login or check trusted configuration.",
            variant: "error"
          });
        } finally {
          picking = false;
        }
      }
    });
  }
});
