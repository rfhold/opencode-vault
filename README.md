# opencode-vault

Per-session OpenBao environment bundles for OpenCode **2.0.31** and macOS.
Development and the helper CLI require **Node.js 22.19 or newer** and **pnpm 10.10.0**.
The built plugin also runs in OpenCode's Bun host; Bun is not required for development.
The server and TUI plugins do nothing outside macOS, before context, Keychain, or state access.
The plugin changes only model tool shell calls. Direct user shell calls remain outside its scope.

## Setup

This package requires operator setup. It does not install services, change OpenCode configuration, or create Bao roles.

Create `~/.config/opencode-bao/config.json` from [examples/config.json](examples/config.json).
Use an owner-controlled directory and file with no group or world write permission.
The directory and file can be symlinks, such as normal dot-managed links with mode `0777`.
The plugin checks ownership of the config directory/file entries and their final resolved targets.
Targets must not allow group or world writes; the plugin does not inspect every intermediate symlink.
This support applies only to configuration; encrypted state retains its separate trust checks.
The file contains endpoint settings and catalog/read token-role names.
Legacy `parentTokenPolicies` and `parentIdentityPolicies` fields remain accepted but do not enforce policy expectations.
The old `bundles` map is rejected; migrate it to `catalogRole` and `readRole` after configuring the new server roles.
The default endpoint is `https://openbao.holdenitdown.net`; that default does not create local configuration or dedicated server roles.
Keep the home-directory ancestors owner-controlled too.

Add this Git package to `~/.config/opencode/opencode.json` on the OpenCode server host:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-vault@git+ssh://git@git.holdenitdown.net/rfhold/opencode-vault.git#opencode/v0.1.2"]
}
```

Git access to this private repository requires an authorized SSH key.
No npm publication or separate CLI installation is necessary.
The server plugin entry automatically loads the package's TUI export; no separate TUI configuration is necessary.
Place this plugin after other plugins that alter model requests or the native shell tool.
The Git release contains generated `dist` entrypoints because OpenCode disables install lifecycle scripts.
The package uses `bundle`, not `build`, so pacote skips Git dependency preparation even with install scripts disabled.
The dot updater checks `opencode/vX.Y.Z` tags hourly and advances the shared pin.
Each host receives that pin through its normal dot refresh, not an automatic macOS scheduler.

Select **Bao login** from the OpenCode command palette, or use `/bao-login`.
This explicit action prepares local storage and starts browser OIDC sign-in on the OpenCode server host.
Use a local macOS OpenCode server with access to your default browser and Keychain.
The command works before you open a session.
Complete browser sign-in within two minutes.
The TUI reports safe local configuration/setup diagnostics and generic authentication-stage errors.
It never displays auth URLs, codes, tokens, or raw stderr.
Login never starts automatically from model tools, shell calls, bundle controls, or errors.

On first use, login creates an immutable Keychain initialization marker, one random snapshot key, and an empty encrypted host ledger.
It never replaces a current key or recreates lost state.
Partial initialization, absent keys, absent markers, and absent ledgers fail closed; login does not repair them.
Recovery requires an explicit operator review that preserves all protection history.
A pristine installation has no initialization marker, snapshot key, or state directory.
In that state, normal shell calls and outbound requests pass unchanged; hooks create no keys or state files.
Explicit login remains available before initialization.
Any initialization anchor activates strict state validation; partial initialization or later protection loss fails closed.
Each request checks readiness independently; no request reuses an earlier probe that could predate cross-process initialization.
Login starts the Bao executable's OIDC flow with `-non-interactive`, `-no-store`, and JSON output.
The optional `oidcRole` setting defaults to `opencode`; Bao decides which roles the identity can use.
Bao opens the default browser and listens on localhost port 8250 for its callback.
The OIDC role must allow `http://localhost:8250/oidc/callback`.
The plugin ignores terminal stdin and discards Bao stderr, which includes the private authorization URL.
It bounds the Bao child to two minutes and the overall login deadline to three minutes.
Timeout or Effect interruption sends SIGTERM, then SIGKILL after 500 ms if necessary.
The subprocess wrapper stops its wait after one further 500 ms and discards output on failure.
Concurrent login requests in one server process fail with a generic busy status; no second browser flow starts.
The TUI aborts its request on plugin unload or after 200 seconds.
Cancellation cannot undo initialization or a Keychain write that already started.
Keychain subprocesses have individual 15-second limits.
The helper stores the dedicated parent token in Keychain, not `~/.vault-token`.
It does not pass ambient `BAO_TOKEN` or `VAULT_TOKEN` to Bao.
It emits only a generic status message; it never prints the token or bundle values.

The CLI remains an operator fallback: `node dist/cli.js login` uses the same private browser flow and first-use initialization.
`node dist/cli.js init` remains available but is not a prerequisite for TUI login.

Open a session and select **Bao environment bundles** from the command palette, or use `/bao`.
The picker lists flat bundle names discovered through KV v2 metadata LIST, enabled key counts, and the host historical protection count. Listing never reads bundle values.
Press Space to mark or unmark bundles for that session. Marks differ from each bundle's enabled state.
Press Enter to toggle only marked bundles. Enter without marks changes nothing; Escape cancels all marks.
The picker preserves search and focus as marks change, and shows a marked count plus each bundle's intended action.
The TUI shows progress notifications before catalog, login, and batch operations start.
Batch updates run serially, with disables first. A failure reports the failed bundle, action, safe cause, confirmed count, and unattempted count.
The failed change's state can remain uncertain. Reopen `/bao` to inspect state before another selection. The plugin does not retry or roll back the batch.
New sessions start with no active bundles.
Each explicit RPC reloads trusted configuration once. New flat KV documents appear on the next picker open without a configuration or role change.
An empty catalog shows a setup hint. If catalog access fails, the picker reports a safe reason and still offers loaded bundles for disable. Loaded values remain unchanged.

## Bao prerequisites

Bao owns authorization policy, role permissions, token types, and token lifetimes.
The plugin does not require exact policy names, role metadata, or a seven-day parent lifetime.
Role names must use letters, digits, underscores, or hyphens for endpoint selection; names such as `admin`, `root`, and `default` are not banned.
An operator configures the OIDC role and catalog/read token roles on the server.
Separate least-privilege roles remain recommended: catalog LIST access, selected-prefix data READ access, and child self-revocation.
The parent needs access to its configured child-create endpoints and self-lookup.

Login requires a nonempty token and a usable server self-lookup response.
The local deadline uses the earlier server expiry or observed remaining TTL deadline, with no arbitrary lifetime cap.
Server-confirmed non-expiring credentials use a null local deadline: self-lookup reports zero TTL and no expiry.
Each catalog or bundle fetch repeats parent self-lookup and preserves the saved deadline.
Server errors and expired credentials still fail; the plugin does not renew the parent token.
After expiry, use `/bao-login` again.

The catalog policy needs these paths:

```hcl
path "kv/metadata/env" {
  capabilities = ["list"]
}
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/revoke-self" {
  capabilities = ["update"]
}
```

For the read policy, replace the metadata stanza with `path "kv/data/env/*" { capabilities = ["read"] }`; retain the self-service stanzas.
These examples describe least-privilege operator policy, not plugin-enforced token metadata checks.
Bao enforces the actual ACLs and child-role restrictions.

The read credential can read every secret under the configured prefix. The picker controls session injection selection, not per-bundle authorization. This is an intentional tradeoff: no role or policy change is needed for a new bundle. Do not store secrets outside the intended OpenCode trust boundary under this prefix.

Bundles use KV v2 documents at `kv/env/<group>`, whose API path is `kv/data/env/<group>`.
Each document maps shell-identifier keys to single-line strings without NUL characters.
The helper expands literal `$HOME` and `${HOME}` against the local user's home directory.
It does not evaluate shell expressions or expand other variables.
Bundle names must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`; dot-only names, traversal, slashes and wildcards are rejected. Nested directory entries are omitted, names are deduplicated and sorted, and malformed catalog responses fail safely.
Unknown safe names can reach the selected read path and fail with a safe HTTP status and request stage. Overlapping keys across active bundles fail with a key-conflict diagnostic.

The helper and session boundary accept every shell-identifier name; no variable-name denylist applies.
[src/environment.ts](src/environment.ts) rejects non-object documents, arrays, invalid names, non-string values, and CR, LF, or NUL characters.
Bundle authors control the native shell environment, including credentials, command paths, runtime options, and loader controls.
Only enable bundles whose contents you trust. The helper's own subprocess environment remains separate.

The picker requests a separate short-lived catalog grant.
An inactive bundle's explicit enable requests a fresh grant through the read role and reads only that selected document.
Both requests ask for a 60-second, nonrenewable, parent-linked service token without the default policy.
Bao determines the actual grant; the plugin requires only a nonempty token, not lifetime metadata.
It attempts self-revocation after every catalog or data operation, including failed validation and reads.
The active environment persists until explicit disable, independent of either token's expiry.
Enable on an active bundle does not fetch or refresh values.
Disable followed by enable explicitly refreshes a bundle.
RPC mutations require the current session state version; stale operations fail.
Disable advances that version even when the bundle has no active values, so it invalidates an earlier enable fetch.
Disable uses only local snapshots and needs no Bao authentication or read. Loaded bundles remain selectable even if their remote document was deleted or omitted from the catalog.

## Runtime and protection boundary

The Effect plugin wraps the native `shell` executor through `ctx.tool.transform`.
It captures an immutable environment overlay before each invocation.
An Effect `Context.Reference` carries that overlay into `shell.create.before` within the same fiber.
The hook copies the shell environment and adds the overlay.
The plugin preserves the native executor, input, tool metadata, and command text.
It never changes `process.env` or registers model-visible tools.
Native shell variables, such as `OPENCODE_SESSION_ID`, remain subject to OpenCode's own later assignments.

A shared encrypted host ledger retains every previously enabled value longer than five Unicode code points.
The plugin applies that union to every session's outbound requests, across processes and restarts.
Forks, copies, imports, and unrelated sessions receive protection without environment inheritance.
Values with five or fewer code points pass unchanged.
The scrubber replaces whole matches with `[REDACTED]`, including standard and URL-safe base64 forms, with or without padding.
If the replacement itself contains a protected value, the scrubber removes that value too.
It also covers canonical JSON escapes, full Unicode escapes, URL encoding, and form-style spaces.
UTF-8 hex protection covers lowercase and uppercase forms.
Bounded MIME protection covers 64- and 76-character base64 lines, with LF or CRLF separators.
The plugin scrubs outbound context, title, compaction, and generate payloads.
It also scrubs final native HTTP readable-text bodies, URLs, headers, WebSocket handshakes, and outbound text frames.
Valid JSON receives recursive text redaction without provider-specific type or field restrictions.
Non-JSON text receives direct text redaction, including malformed textual WebSocket frames.
The exact credential header allowlist preserves names and values: `Authorization`, `Proxy-Authorization`, `X-API-Key`, `Api-Key`, `X-Goog-Api-Key`.
Header name checks ignore case; this exception applies only to model requests, HTTP requests, and WebSocket handshakes.
Other surfaces still redact the same credential bytes if a bundle contains them.
Disable removes environment injection but retains historical redaction.

Redaction is best effort for readable text, not an attachment inspection or content-policy gate.
Opaque image, audio, video, and binary bodies pass unchanged, without secret protection.
Compressed or unsupported encodings also pass unchanged when the scrubber cannot safely read them.
Class instances, functions, and SDK objects retain their identity; final native text hooks still inspect their serialized request bodies.
Generic metadata, tool schemas, encrypted-content fields, and arbitrary JSON `type` values do not block dispatch.
No format-based or 16 MiB body-size rejection applies.
If redacted object keys collide, the last entry wins; both keys and values receive text redaction.
If redaction makes an HTTP header name invalid, the plugin omits that header and continues dispatch.
Corrupt or unavailable encrypted state also fails closed for shell injection and outbound hooks.
Missing trusted configuration disables bundle controls, but the plugin still installs protection hooks.

## Storage and limitations

- Keychain service `opencode-bao` holds accounts `auth`, `snapshot-key`, and immutable initialization marker `initialized`.
- `~/.local/share/opencode-bao/sessions` holds AES-256-GCM session snapshots and an independent encrypted `ledger`.
- The ledger holds protected session identifiers, mutation versions, and the shared known-value union.
- The plugin commits and syncs the ledger before it exposes a new snapshot or environment.
- An absent registered snapshot or snapshot version mismatch blocks shell injection and outbound requests for that session.
- An absent ledger blocks shell injection and outbound requests for every session.
- Atomic file replacement and one host directory lock coordinate separate OpenCode processes.
- A crash during a write can leave `sessions/.lock`. After all writers stop, remove only that stale lock directory.
- Snapshots retain active values across restarts; the host ledger retains historical protection. Neither expires automatically.
- RPC and TUI responses contain metadata, login confirmation, safe local setup diagnostics, and generic authentication-stage errors.
- The host must load this plugin for protection. Plugin removal, later hooks, or an overriding tool transform bypass its boundary.
- Raw native shell output and persisted OpenCode history can contain plaintext locally. This package does not scrub core disk storage.
- This package does not promise isolation from a hostile process under the same OS user, including a model shell.
- Complete deletion or malicious rollback of every independent initialization anchor falls outside that OS-user trust boundary.
- Keychain access uses `/usr/bin/security`; its write arguments contain credential bytes visible within that OS-user trust boundary.
- Arbitrary transformations, encryption, chunked exfiltration, external command network traffic, and non-native provider transports remain outside protection.
- Direct user shell calls receive no plugin overlay. Existing background processes retain their original environment after disable.

## Development and evidence

Install dependencies and build this checkout:

```sh
pnpm install --frozen-lockfile
pnpm run bundle
```

For local development, opt in with an ignored `opencode.json` at the repository root:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./dist"]
}
```

Use this local entry instead of the global Git entry during development to avoid duplicate activation.
The pinned host requires the physical `dist` directory for local directory plugins, not the package root.
Rebuild and include all four generated `dist/*.js` files before each future release tag.
Git installs must work without `prepare` or other install lifecycle scripts.

```sh
pnpm test
pnpm run typecheck
pnpm run bundle
git diff --check
```

[test/plugin.test.ts](test/plugin.test.ts) uses real Effect fibers and a synthetic native-shaped adapter.
It executes concurrent `/bin/sh` children with synthetic values and checks session separation, Effect fiber inheritance, interruption, and immutable invocation snapshots.
Other tests cover the shared ledger, absent-state failures, request credentials, environment validation, mutation races, encoding variants, and server-bound login deadlines.
Provider-shaped payload tests cover arbitrary schemas, encrypted content, opaque attachments, SDK options, and text redaction after disable across unrelated sessions.
Synthetic login tests cover explicit TUI dispatch, private RPC results, first-use initialization, lost-state refusal, duplicate requests, cancellation, subprocess timeout, and noninteractive arguments.
Platform tests verify macOS activation and inert non-macOS entrypoints without real Keychain access.
Package tests compare generated bytes with fresh builds and inspect a tarball's exact file list.
They install that tarball in a temporary fixture with lifecycle scripts disabled, then load every export and the CLI.
The fixture uses public registry downloads; it does not verify SSH access or OpenCode's Git installer.
The adapter does not execute the installed OpenCode native executor.
Installed OpenCode end-to-end behavior, Keychain access, OIDC login, Bao policies, and live provider transports need separate verification.

API references: [V2 plugins](https://opencode.ai/v2/docs/build/plugins), [CLI plugins](https://opencode.ai/v2/docs/build/plugins/cli), [RPC](https://opencode.ai/v2/docs/build/plugins/rpc).
The implementation pins `@opencode/plugin` and `@opencode/schema` to `2.0.31`, with Effect `4.0.1`.
