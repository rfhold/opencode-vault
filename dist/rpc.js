// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";

// src/diagnostics.ts
import { homedir } from "node:os";
import { join } from "node:path";
var configPath = join(homedir(), ".config", "opencode-bao", "config.json");
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
var BaoRpc = Rpc.define({ id: "opencode.bao", methods: { status: method, enable: mutation, disable: mutation, login }, events: {} });
export {
  BaoRpc
};
