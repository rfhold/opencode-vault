// src/tui.ts
import * as Plugin from "@opencode/plugin/tui/plugin";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";

// src/diagnostics.ts
import { homedir } from "node:os";
import { join } from "node:path";
var configPath = join(homedir(), ".config", "opencode-bao", "config.json");
var diagnostics = {
  stored_login: "Bao unavailable: stored login is missing, expired or unreadable; unlock Keychain or use /bao-login.",
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
  storage: "Bao unavailable: local Keychain/storage initialization failed; unlock Keychain and check existing protection state. Do not reset existing state.",
  authentication: "Bao unavailable: browser OIDC sign-in failed or timed out; check browser, network and Bao role, then retry /bao-login. Do not reset existing state.",
  identity: "Bao unavailable: token expiry validation or Keychain save failed; check Bao access and Keychain. Do not reset existing state.",
  login_response: "Bao unavailable: login-response JSON/auth object is missing or malformed. Do not reset existing state.",
  login_client_token: "Bao unavailable: login-response client_token must be a nonempty string. Do not reset existing state.",
  lookup_request: "Bao unavailable: token self-lookup request failed or returned unreadable JSON. Do not reset existing state.",
  lookup_response: "Bao unavailable: token self-lookup data object is missing or malformed. Do not reset existing state.",
  lookup_ttl: "Bao unavailable: token self-lookup ttl must describe a usable lease; zero requires no server expiry. Do not reset existing state.",
  lookup_expire_time: "Bao unavailable: token self-lookup expire_time must be a valid timestamp string. Do not reset existing state.",
  lookup_deadline: "Bao unavailable: token self-lookup expiry/ttl deadline has already passed. Do not reset existing state.",
  credential_set: "Bao unavailable: Keychain auth credential save failed. Do not reset existing state.",
  credential_read_missing: "Bao unavailable: Keychain auth credential read-back is missing after save. Do not reset existing state.",
  credential_read: "Bao unavailable: Keychain auth credential read-back failed after save. Do not reset existing state.",
  credential_mismatch: "Bao unavailable: Keychain auth credential read-back does not exactly match the saved token and deadline. Do not reset existing state."
};
var stages = { parent: "parent token lookup", grant: "child token creation", catalog: "catalog lookup", bundle: "bundle read", revoke: "child token revocation" };
var safeHttpStatus = (value) => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
function diagnosticText(id, stage, httpStatus) {
  return diagnostics[id] + (stage && Object.hasOwn(stages, stage) ? ` Stage: ${stages[stage]}.` : "") + (safeHttpStatus(httpStatus) ? ` HTTP ${httpStatus}.` : "");
}
function rpcDiagnostic(error) {
  if (!error || typeof error !== "object") return;
  const failure = error;
  const id = failure.data?.diagnostic;
  if (failure.type === "unavailable" && typeof id === "string" && Object.hasOwn(diagnostics, id)) return diagnosticText(id, typeof failure.data?.stage === "string" && Object.hasOwn(stages, failure.data.stage) ? failure.data.stage : void 0, safeHttpStatus(failure.data?.httpStatus) ? failure.data.httpStatus : void 0);
}

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
var BaoRpc = Rpc.define({ id: "opencode.bao", methods: { status: method, enable: mutation, disable: mutation, login }, events: {} });

// src/tui.ts
var tui_default = Plugin.define({
  id: "opencode.bao.tui",
  setup(ctx) {
    if (process.platform !== "darwin") return;
    const rpc = ctx.client.rpc(BaoRpc);
    let loggingIn = false;
    let picking = false;
    let pickerOpen = false;
    const lifetime = new AbortController();
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "bao.login",
      title: "Bao login",
      group: "Bao",
      palette: true,
      slash: { name: "bao-login" },
      run: async () => {
        if (lifetime.signal.aborted) return;
        if (loggingIn) return ctx.ui.toast.show({ message: "Bao login already in progress; finish the browser sign-in", variant: "info" });
        loggingIn = true;
        ctx.ui.toast.show({ message: "Bao login: preparing local storage and opening the browser on the OpenCode server host; finish sign-in within two minutes", variant: "info", duration: 1e4 });
        try {
          const result = await rpc.login({}, { location: ctx.location ?? ctx.data.location.default(), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(2e5)]) });
          if (lifetime.signal.aborted) return;
          if (typeof result !== "object" || result === null || Array.isArray(result) || !("authenticated" in result) || result.authenticated !== true || Object.keys(result).length !== 1 || !Object.hasOwn(result, "authenticated")) throw new Error("Bao login failed");
          ctx.ui.toast.show({ message: "Bao login complete; use /bao to select environment bundles", variant: "success" });
        } catch (error) {
          if (lifetime.signal.aborted) return;
          ctx.ui.toast.show({ message: rpcDiagnostic(error) ?? "Bao login failed, timed out, or is already in progress. Finish any existing browser sign-in, then retry /bao-login. Check local browser, Keychain, trusted configuration and dedicated role; do not reset existing state.", variant: "error", duration: 1e4 });
        } finally {
          loggingIn = false;
        }
      }
    }, {
      id: "bao.bundles",
      title: "Bao environment bundles",
      group: "Bao",
      palette: true,
      slash: { name: "bao" },
      run: async () => {
        if (lifetime.signal.aborted) return;
        if (picking) return ctx.ui.toast.show({ message: "Bao bundle selection or update already in progress", variant: "info" });
        const route = ctx.ui.router.current();
        if (route.type !== "session") return ctx.ui.toast.show({ message: "Open a session first", variant: "info" });
        const sessionID = route.sessionID;
        picking = true;
        let completed = 0;
        let total = 0;
        let failed;
        ctx.ui.toast.show({ message: "Bao: loading bundle catalog and checking authentication", variant: "info" });
        try {
          const request = { location: ctx.location ?? ctx.data.location.default(), signal: lifetime.signal };
          const status = await rpc.status({ sessionID }, request);
          if (lifetime.signal.aborted) return;
          if (status.catalogUnavailable) ctx.ui.toast.show({ message: `Bao catalog unavailable. ${rpcDiagnostic({ type: "unavailable", data: status.catalogFailure }) ?? "Use /bao-login or check trusted configuration."} Loaded bundles remain active and can be disabled.`, variant: "info", duration: 1e4 });
          if (!status.bundles.length) return ctx.ui.toast.show({ message: "No Bao bundles found. Add a flat KV v2 document under the configured prefix, then reopen /bao.", variant: "info", duration: 1e4 });
          const [selection, updateSelection] = ctx.storage.memory("bundle-picker", { initial: { marked: [] } });
          updateSelection((draft) => {
            draft.marked = [];
          });
          pickerOpen = true;
          let submitted;
          try {
            submitted = await ctx.ui.dialog.select({
              get title() {
                return `Bao: ${selection.marked.length} marked; ${status.bundles.filter((item) => item.enabled).length} enabled; ${status.protectedValues} protected values`;
              },
              placeholder: "Search bundles; Space mark/unmark, Enter apply marked, Esc cancel",
              get options() {
                return status.bundles.map((item) => ({ value: item.name, title: `[${selection.marked.includes(item.name) ? "x" : " "}] ${item.name}`, description: item.enabled ? `Enabled (${item.keys} keys); disable` : "Disabled; enable" }));
              },
              search: (query, options) => options.filter((item) => item.value.toLowerCase().includes(query.toLowerCase())),
              actions: [{ bind: "space", title: "Mark/unmark", onTrigger: (value) => {
                if (lifetime.signal.aborted) return;
                updateSelection((draft) => {
                  draft.marked = draft.marked.includes(value) ? draft.marked.filter((name) => name !== value) : [...draft.marked, value];
                });
              } }]
            });
          } finally {
            pickerOpen = false;
          }
          if (lifetime.signal.aborted || submitted === void 0) return;
          const changes = status.bundles.filter((item) => typeof item.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.name) && typeof item.enabled === "boolean" && selection.marked.includes(item.name)).sort((a, b) => Number(b.enabled) - Number(a.enabled));
          total = changes.length;
          if (!total) return ctx.ui.toast.show({ message: "No Bao bundles marked; use Space to mark bundles, then Enter to apply", variant: "info" });
          ctx.ui.toast.show({ message: `Bao: applying ${total} marked bundle changes; disabling before enabling and fetching selected values`, variant: "info", duration: 1e4 });
          let version = status.version;
          for (const item of changes) {
            if (lifetime.signal.aborted) return;
            failed = { name: item.name, action: item.enabled ? "disable" : "enable" };
            const result = await rpc[item.enabled ? "disable" : "enable"]({ sessionID, bundle: item.name, version }, request);
            if (lifetime.signal.aborted) return;
            version = result.version;
            completed++;
          }
          ctx.ui.toast.show({ message: `Bao: ${completed} bundle changes applied`, variant: "success" });
        } catch (error) {
          if (lifetime.signal.aborted) return;
          const message = rpcDiagnostic(error) ?? "Bao unavailable; use /bao-login or check trusted configuration";
          ctx.ui.toast.show({ message: total && failed ? `Bao: ${completed} of ${total} changes confirmed; ${failed.action} ${failed.name} failed. Remaining ${total - completed - 1} changes NOT attempted; stopped without retry or rollback. The failed change may already have applied; inspect current state by reopening /bao before selecting more changes. ${message}` : message, variant: "error", duration: 1e4 });
        } finally {
          picking = false;
        }
      }
    }] }));
    return () => {
      lifetime.abort();
      if (pickerOpen) ctx.ui.dialog.clear();
    };
  }
});
export {
  tui_default as default
};
