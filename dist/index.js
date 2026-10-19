// src/index.ts
import { Context, Effect } from "effect";
import { Plugin } from "@opencode/plugin/effect";
import { Tool } from "@opencode/schema/tool";

// src/bao.ts
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";
import { lstat, readFile as readFile2, realpath, stat as stat2 } from "node:fs/promises";
import { randomBytes as randomBytes2 } from "node:crypto";

// src/state.ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, stat, readdir, open } from "node:fs/promises";
import { join as join2 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// src/environment.ts
function validateEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Bao environment");
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || /[\r\n\0]/.test(item)) throw new Error("Invalid Bao environment");
  }
}

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
var LocalSetupError = class extends Error {
  constructor(diagnostic, stage, httpStatus) {
    super(diagnosticText(diagnostic, stage, httpStatus));
    this.diagnostic = diagnostic;
    this.stage = stage;
    this.httpStatus = httpStatus;
  }
};
function failureData(error) {
  if (!(error instanceof LocalSetupError) || !Object.hasOwn(diagnostics, error.diagnostic)) return;
  return { diagnostic: error.diagnostic, ...error.stage && Object.hasOwn(stages, error.stage) ? { stage: error.stage } : {}, ...safeHttpStatus(error.httpStatus) ? { httpStatus: error.httpStatus } : {} };
}
function diagnosticText(id, stage, httpStatus) {
  return diagnostics[id] + (stage && Object.hasOwn(stages, stage) ? ` Stage: ${stages[stage]}.` : "") + (safeHttpStatus(httpStatus) ? ` HTTP ${httpStatus}.` : "");
}
function rpcDiagnostic(error) {
  if (!error || typeof error !== "object") return;
  const failure2 = error;
  const id = failure2.data?.diagnostic;
  if (failure2.type === "unavailable" && typeof id === "string" && Object.hasOwn(diagnostics, id)) return diagnosticText(id, typeof failure2.data?.stage === "string" && Object.hasOwn(stages, failure2.data.stage) ? failure2.data.stage : void 0, safeHttpStatus(failure2.data?.httpStatus) ? failure2.data.httpStatus : void 0);
}

// src/state.ts
var empty = () => ({ version: 0, active: {}, history: [] });
var failure = () => new LocalSetupError("state");
var Sessions = class {
  constructor(directory, key) {
    this.directory = directory;
    this.key = key;
  }
  async resolveKey() {
    const key = typeof this.key === "function" ? await this.key() : this.key;
    if (key.length !== 32) throw failure();
    return key;
  }
  id(session) {
    if (!session || session.length > 256) throw failure();
    return createHash("sha256").update(session).digest("hex");
  }
  async encrypted(name, value, exclusive = false) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.resolveKey(), nonce);
    cipher.setAAD(Buffer.from(name));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const destination = join2(this.directory, name);
    const temporary = `${destination}.${randomBytes(8).toString("hex")}`;
    try {
      const file = await open(exclusive ? destination : temporary, "wx", 384);
      try {
        await file.writeFile(Buffer.concat([nonce, cipher.getAuthTag(), encrypted]));
        await file.sync();
      } finally {
        await file.close();
      }
      if (!exclusive) await rename(temporary, destination);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async decoded(name) {
    const bytes = await readFile(join2(this.directory, name));
    const decipher = createDecipheriv("aes-256-gcm", await this.resolveKey(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
  }
  // Only the explicit first-use helper creates the ledger; runtime reads never recreate it.
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 448 });
    if ((await readdir(this.directory)).length) throw failure();
    await this.encrypted("ledger", { sessions: {}, history: [] }, true);
  }
  async locked(work) {
    const lock = join2(this.directory, ".lock");
    let acquired = false;
    try {
      const info = await stat(this.directory);
      if (info.uid !== process.getuid() || info.mode & 63) throw failure();
      for (let i = 0; i < 100; i++) {
        try {
          await mkdir(lock, { mode: 448 });
          acquired = true;
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw failure();
          await sleep(20);
        }
      }
      if (!acquired) throw failure();
      return await work();
    } catch (error) {
      throw error instanceof LocalSetupError ? error : failure();
    } finally {
      if (acquired) await rmdir(lock);
    }
  }
  async current(session) {
    const id = this.id(session);
    const ledger = await this.decoded("ledger");
    if (!ledger?.sessions || Array.isArray(ledger.sessions) || typeof ledger.sessions !== "object" || !Array.isArray(ledger.history) || !ledger.history.every((value) => typeof value === "string")) throw failure();
    let snapshot;
    if (Object.hasOwn(ledger.sessions, id)) {
      snapshot = await this.decoded(id);
      if (!Number.isSafeInteger(ledger.sessions[id]) || snapshot?.version !== ledger.sessions[id] || !snapshot.active || typeof snapshot.active !== "object" || Array.isArray(snapshot.active)) throw failure();
      for (const env of Object.values(snapshot.active)) validateEnvironment(env);
    } else {
      try {
        await stat(join2(this.directory, id));
        throw failure();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      snapshot = empty();
    }
    return { ledger, snapshot: { ...snapshot, history: ledger.history } };
  }
  async read(session) {
    return this.locked(async () => (await this.current(session)).snapshot);
  }
  async enable(session, bundle, values, expected) {
    validateEnvironment(values);
    const version = expected ?? (await this.read(session)).version;
    await this.locked(async () => {
      const { ledger, snapshot } = await this.current(session);
      if (snapshot.version !== version) throw new LocalSetupError("stale");
      if (Object.hasOwn(snapshot.active, bundle)) return;
      const occupied = new Set(Object.values(snapshot.active).flatMap(Object.keys));
      if (Object.keys(values).some((key) => occupied.has(key))) throw new LocalSetupError("conflict");
      Object.defineProperty(snapshot.active, bundle, { value: { ...values }, enumerable: true, configurable: true, writable: true });
      ledger.history = [.../* @__PURE__ */ new Set([...ledger.history, ...Object.values(values).filter((value) => [...value].length > 5)])];
      snapshot.version++;
      ledger.sessions[this.id(session)] = snapshot.version;
      await this.encrypted("ledger", ledger);
      await this.encrypted(this.id(session), { version: snapshot.version, active: snapshot.active });
    });
  }
  async disable(session, bundle, expected) {
    const version = expected ?? (await this.read(session)).version;
    await this.locked(async () => {
      const { ledger, snapshot } = await this.current(session);
      if (snapshot.version !== version) throw new LocalSetupError("stale");
      delete snapshot.active[bundle];
      snapshot.version++;
      ledger.sessions[this.id(session)] = snapshot.version;
      await this.encrypted("ledger", ledger);
      await this.encrypted(this.id(session), { version: snapshot.version, active: snapshot.active });
    });
  }
  async overlay(session) {
    return Object.freeze(Object.assign(/* @__PURE__ */ Object.create(null), ...Object.values((await this.read(session)).active)));
  }
};

// src/process.ts
import { spawn } from "node:child_process";
function runProcess(file, args, options) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new Error("Process unavailable"));
    const child = spawn(file, args, {
      env: options.env,
      shell: false,
      stdio: [options.input === void 0 ? options.stdin ?? "ignore" : "pipe", options.stdout ?? "pipe", options.stderr ?? "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let failure2;
    let settled = false;
    let bytes = 0;
    let kill;
    let deadline;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(kill);
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      if (failure2) reject(failure2);
      else resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), exitCode });
    };
    const stop = (error) => {
      if (failure2 || settled) return;
      failure2 = error;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), 500);
      deadline = setTimeout(() => {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 1e3);
    };
    const abort = () => stop(new Error("Process unavailable"));
    const timer = options.timeout === void 0 ? void 0 : setTimeout(abort, options.timeout);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (chunks) => (chunk) => {
      bytes += chunk.length;
      if (failure2) return;
      if (options.maxBytes !== void 0 && bytes > options.maxBytes) return abort();
      chunks.push(chunk);
    };
    child.on("error", stop);
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.stdout?.on("error", stop);
    child.stderr?.on("error", stop);
    child.stdin?.on("error", stop);
    child.on("close", finish);
    if (options.input !== void 0) child.stdin.end(options.input);
  });
}

// src/bao.ts
var root = join3(homedir2(), ".config", "opencode-bao");
var stateRoot = join3(homedir2(), ".local", "share", "opencode-bao", "sessions");
var safe = /^[a-zA-Z0-9_-]+$/;
var bundlePattern = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
var validBundle = (name) => typeof name === "string" && new RegExp(bundlePattern).test(name);
var denied = () => new Error("Bao unavailable; use /bao-login or check trusted configuration");
var loggingIn = false;
var LoginBusy = class extends Error {
};
async function config(directory = root) {
  try {
    const trusted = async (path) => {
      const link = await lstat(path);
      if (link.uid !== process.getuid()) throw new LocalSetupError("permissions");
      const resolved2 = await realpath(path);
      const info = await stat2(resolved2);
      if (info.uid !== process.getuid() || info.mode & 18) throw new LocalSetupError("permissions");
      return resolved2;
    };
    const resolved = await trusted(directory);
    const file = await trusted(join3(resolved, "config.json"));
    const raw = JSON.parse(await readFile2(file, "utf8"));
    return parseConfig(raw);
  } catch (error) {
    if (error instanceof LocalSetupError) throw error;
    if (error.code === "ENOENT") throw new LocalSetupError("missing");
    if (error instanceof SyntaxError) throw new LocalSetupError("json");
    throw new LocalSetupError("permissions");
  }
}
function parseConfig(raw) {
  try {
    const result = {
      address: raw.address ?? "https://openbao.holdenitdown.net",
      mount: raw.mount ?? "kv",
      prefix: raw.prefix ?? "env",
      oidc: raw.oidc ?? "oidc",
      bao: raw.bao ?? "/opt/homebrew/bin/bao",
      catalogRole: raw.catalogRole,
      readRole: raw.readRole,
      parentTokenPolicies: raw.parentTokenPolicies,
      parentIdentityPolicies: raw.parentIdentityPolicies,
      ...raw.oidcRole === void 0 ? {} : { oidcRole: raw.oidcRole }
    };
    const url = new URL(result.address);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw denied();
    if (![result.mount, result.prefix, result.oidc].every((part) => typeof part === "string" && safe.test(part))) throw denied();
    if (typeof result.bao !== "string" || !result.bao.startsWith("/") || /[\r\n\0]/.test(result.bao)) throw new LocalSetupError("executable");
    if (Object.hasOwn(raw, "bundles")) throw new LocalSetupError("schema");
    if (![result.catalogRole, result.readRole, result.oidcRole ?? "opencode"].every((role) => typeof role === "string" && safe.test(role))) throw denied();
    return result;
  } catch (error) {
    throw error instanceof LocalSetupError ? error : new LocalSetupError("schema");
  }
}
var MissingCredential = class extends Error {
};
var keychain = {
  async get(account) {
    const child = await runProcess("/usr/bin/security", ["find-generic-password", "-s", "opencode-bao", "-a", account, "-w"], { timeout: 15e3, maxBytes: 65536, stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: homedir2() } }).catch(() => {
      throw denied();
    });
    const value = child.stdout.trim();
    if (child.exitCode === 44) throw new MissingCredential();
    if (child.exitCode !== 0 || !value) throw denied();
    return value;
  },
  async set(account, value) {
    const child = await runProcess("/usr/bin/security", ["add-generic-password", ...account === "auth" ? ["-U"] : [], "-s", "opencode-bao", "-a", account, "-w", value], { timeout: 15e3, stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: homedir2() } }).catch(() => {
      throw denied();
    });
    if (child.exitCode !== 0) throw denied();
  }
};
var Bao = class {
  constructor(settings, credentials = keychain, http = fetch, run = runProcess) {
    this.settings = settings;
    this.credentials = credentials;
    this.http = http;
    this.run = run;
  }
  async api(path, token, body, signal, method2 = body === void 0 ? "GET" : "POST", stage = "parent") {
    try {
      const url = new URL(`${this.settings.address.replace(/\/$/, "")}/v1/${path}`);
      if (method2 === "LIST") url.searchParams.set("list", "true");
      const response = await this.http(url.toString(), {
        method: method2 === "LIST" ? "GET" : method2,
        headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
        body: body === void 0 ? void 0 : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(15e3), ...signal ? [signal] : []])
      });
      if (method2 === "LIST" && response.status === 404) return { data: { keys: [] } };
      if (!response.ok) throw new LocalSetupError("http", stage, response.status);
      try {
        return await response.json();
      } catch {
        throw new LocalSetupError("response_json", stage);
      }
    } catch (error) {
      throw error instanceof LocalSetupError ? error : new LocalSetupError("transport", stage);
    }
  }
  async parent() {
    let auth;
    try {
      auth = JSON.parse(await this.credentials.get("auth"));
    } catch {
      throw new LocalSetupError("stored_login");
    }
    if (typeof auth?.token !== "string" || !auth.token || auth.expires !== null && (typeof auth.expires !== "number" || !Number.isFinite(auth.expires) || auth.expires <= Date.now())) throw new LocalSetupError("stored_login");
    try {
      const expires = await this.identity(auth.token);
      if (expires !== null && expires <= Date.now()) throw new LocalSetupError("stored_login");
    } catch (error) {
      throw error instanceof LocalSetupError ? error : new LocalSetupError("lookup_request");
    }
    return auth.token;
  }
  async identity(token, signal) {
    const observed = Date.now();
    let response;
    try {
      response = await this.api("auth/token/lookup-self", token, void 0, signal);
    } catch (error) {
      throw error instanceof LocalSetupError ? error : new LocalSetupError("lookup_request");
    }
    signal?.throwIfAborted();
    const info = response?.data;
    if (!info || typeof info !== "object" || Array.isArray(info)) throw new LocalSetupError("lookup_response");
    if (info.ttl === 0 && (info.expire_time === void 0 || info.expire_time === null || info.expire_time === "")) return null;
    if (!Number.isFinite(info.ttl) || info.ttl <= 0) throw new LocalSetupError("lookup_ttl");
    const expiry = typeof info.expire_time === "string" ? Date.parse(info.expire_time) : NaN;
    if (!Number.isFinite(expiry)) throw new LocalSetupError("lookup_expire_time");
    const deadline = Math.min(expiry, observed + info.ttl * 1e3);
    if (deadline <= Date.now()) throw new LocalSetupError("lookup_deadline");
    return deadline;
  }
  async grant(role, work) {
    const parent = await this.parent();
    const grant = await this.api(`auth/token/create/${encodeURIComponent(role)}`, parent, {
      ttl: "60s",
      explicit_max_ttl: "60s",
      renewable: false,
      no_default_policy: true,
      display_name: "opencode-bao",
      type: "service"
    }, void 0, "POST", "grant");
    const token = grant?.auth?.client_token;
    if (typeof token !== "string" || !token) throw new LocalSetupError("grant_response", "grant");
    try {
      return await work(token);
    } finally {
      await this.api("auth/token/revoke-self", token, {}, void 0, "POST", "revoke").catch(() => {
      });
    }
  }
  async catalog() {
    return this.grant(this.settings.catalogRole, async (token) => {
      const value = await this.api(`${this.settings.mount}/metadata/${this.settings.prefix}`, token, void 0, void 0, "LIST", "catalog");
      const keys = value?.data?.keys;
      if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) throw new LocalSetupError("catalog_response", "catalog");
      const names = [];
      for (const key of keys) {
        if (key.endsWith("/")) continue;
        if (!validBundle(key)) throw new LocalSetupError("catalog_response", "catalog");
        names.push(key);
      }
      return [...new Set(names)].sort();
    });
  }
  async bundle(name) {
    if (!validBundle(name)) throw new Error("Unknown Bao bundle");
    return this.grant(this.settings.readRole, async (token) => {
      const value = await this.api(`${this.settings.mount}/data/${this.settings.prefix}/${encodeURIComponent(name)}`, token, void 0, void 0, "GET", "bundle");
      const data = value?.data?.data;
      try {
        validateEnvironment(data);
      } catch {
        throw new LocalSetupError("environment", "bundle");
      }
      const result = {};
      for (const [key, value2] of Object.entries(data)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value2 !== "string" || /[\r\n\0]/.test(value2)) throw new LocalSetupError("environment", "bundle");
        Object.defineProperty(result, key, { value: value2.replaceAll("${HOME}", homedir2()).replaceAll("$HOME", homedir2()), enumerable: true });
      }
      return result;
    });
  }
  async login(options = {}) {
    if (loggingIn) throw new LoginBusy("Bao login already in progress");
    loggingIn = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18e4);
    const signal = AbortSignal.any([controller.signal, ...options.signal ? [options.signal] : []]);
    let stage = "executable";
    try {
      signal.throwIfAborted();
      if (process.platform !== "darwin") throw denied();
      const path = await realpath(this.settings.bao);
      const executable = await stat2(path);
      if (!executable.isFile() || !(executable.mode & 73)) throw denied();
      stage = "storage";
      await initialize(this.credentials, options.directory ?? stateRoot);
      stage = "authentication";
      signal.throwIfAborted();
      const child = await this.run(path, ["login", "-non-interactive", "-no-store", "-format=json", "-method=oidc", `-path=${this.settings.oidc}`, `role=${this.settings.oidcRole ?? "opencode"}`, "skip_browser=false", "abort_on_error=true"], {
        stderr: "ignore",
        signal,
        timeout: 12e4,
        maxBytes: 1048576,
        env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: homedir2(), BAO_ADDR: this.settings.address }
      });
      signal.throwIfAborted();
      if (child.exitCode !== 0) throw denied();
      stage = "identity";
      let response;
      try {
        response = JSON.parse(child.stdout);
      } catch {
        throw new LocalSetupError("login_response");
      }
      await this.acceptLogin(response?.auth, signal);
      signal.throwIfAborted();
    } catch (error) {
      throw !signal.aborted && error instanceof LocalSetupError ? error : new LocalSetupError(stage);
    } finally {
      clearTimeout(timer);
      loggingIn = false;
    }
  }
  async acceptLogin(auth, signal) {
    signal?.throwIfAborted();
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new LocalSetupError("login_response");
    if (typeof auth.client_token !== "string" || !auth.client_token) throw new LocalSetupError("login_client_token");
    const expires = await this.identity(auth.client_token, signal);
    signal?.throwIfAborted();
    const payload = JSON.stringify({ token: auth.client_token, expires });
    try {
      await this.credentials.set("auth", payload);
    } catch {
      throw new LocalSetupError("credential_set");
    }
    signal?.throwIfAborted();
    let saved;
    try {
      saved = await this.credentials.get("auth");
    } catch (error) {
      throw new LocalSetupError(error instanceof MissingCredential ? "credential_read_missing" : "credential_read");
    }
    signal?.throwIfAborted();
    if (saved !== payload) throw new LocalSetupError("credential_mismatch");
  }
};
async function encryptionKey(credentials = keychain) {
  if (await credentials.get("initialized") !== "v1") throw denied();
  const value = await credentials.get("snapshot-key");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw denied();
  return key;
}
function readiness(credentials = keychain, directory = stateRoot) {
  let protectedState = false;
  const probe = async () => {
    if (protectedState) return true;
    try {
      await lstat(directory);
      protectedState = true;
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw denied();
    }
    const get = async (account) => {
      try {
        const value = await credentials.get(account);
        protectedState = true;
        return value;
      } catch (error) {
        if (error instanceof MissingCredential) return void 0;
        throw error;
      }
    };
    await Promise.all([get("initialized"), get("snapshot-key")]);
    return protectedState;
  };
  return probe;
}
async function initialize(credentials = keychain, directory = stateRoot) {
  const get = async (account) => {
    try {
      return await credentials.get(account);
    } catch (error) {
      if (error instanceof MissingCredential) return void 0;
      throw error;
    }
  };
  const marker2 = await get("initialized");
  const key = await get("snapshot-key");
  let exists = false;
  try {
    await stat2(directory);
    exists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw denied();
  }
  if (marker2 !== void 0 || key !== void 0 || exists) {
    if (marker2 !== "v1" || !key) throw denied();
    await new Sessions(directory, () => encryptionKey(credentials)).read("initialization-check");
    return;
  }
  await credentials.set("initialized", "v1");
  await credentials.set("snapshot-key", randomBytes2(32).toString("base64"));
  await new Sessions(directory, () => encryptionKey(credentials)).initialize();
}

// src/redact.ts
var marker = "[REDACTED]";
var credentialHeaders = /* @__PURE__ */ new Set(["authorization", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key"]);
var escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var pattern = (text) => new RegExp([...text.matchAll(/%[a-f0-9]{2}|\\u[a-f0-9]{4}|[\s\S]/gi)].map(([part]) => {
  if (part.length < 3) return escape(part);
  const prefix = part.startsWith("%") ? 1 : 2;
  return escape(part.slice(0, prefix)) + part.slice(prefix).replace(/[a-f]/gi, (hex) => `[${hex.toLowerCase()}${hex.toUpperCase()}]`);
}).join(""), "g");
var Scrubber = class {
  variants;
  constructor(values) {
    const variants = /* @__PURE__ */ new Set();
    for (const value of values) {
      if ([...value].length <= 5) continue;
      const bytes = Buffer.from(value);
      const initial = [value, bytes.toString("base64"), bytes.toString("base64url")];
      const base64 = [initial[1], initial[2], initial[1].replace(/=+$/, ""), initial[2] + "=".repeat((4 - initial[2].length % 4) % 4)];
      for (const encoded of base64) {
        for (const width of [64, 76]) for (const separator of ["\n", "\r\n"]) initial.push(encoded.match(new RegExp(`.{1,${width}}`, "g")).join(separator));
      }
      initial.push(bytes.toString("hex"), bytes.toString("hex").toUpperCase());
      initial.push(value.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
      initial.push(initial[1].replace(/=+$/, ""), initial[2] + "=".repeat((4 - initial[2].length % 4) % 4));
      for (const text of initial) {
        for (const encoded of [text, encodeURIComponent(text), encodeURIComponent(text).replaceAll("%20", "+"), encodeURI(text), JSON.stringify(text).slice(1, -1)]) {
          variants.add(encoded);
          variants.add(JSON.stringify(encoded).slice(1, -1));
          variants.add(encodeURIComponent(encoded));
          variants.add(encoded.replace(/%[A-F0-9]{2}/g, (match) => match.toLowerCase()));
        }
      }
    }
    this.variants = [...variants].sort((a, b) => b.length - a.length).map(pattern);
  }
  text(value) {
    for (const variant of this.variants) value = value.replaceAll(variant, marker);
    let previous;
    do {
      previous = value;
      for (const variant of this.variants) value = value.replaceAll(variant, "");
    } while (value !== previous);
    return value;
  }
  json(value, seen = /* @__PURE__ */ new WeakMap()) {
    if (typeof value === "string") return this.text(value);
    if (value === null || typeof value === "number" || typeof value === "boolean" || value === void 0) return value;
    if (typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) return value;
    const result = Array.isArray(value) ? [] : Object.create(prototype);
    seen.set(value, result);
    const properties = /* @__PURE__ */ new Map();
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if ("value" in descriptor) descriptor.value = this.json(descriptor.value, seen);
      const scrubbed = typeof key === "string" ? this.text(key) : key;
      properties.set(scrubbed, descriptor);
    }
    for (const [key, descriptor] of properties) Object.defineProperty(result, key, descriptor);
    return result;
  }
  headers(input2) {
    const result = {};
    for (const [key, value] of Object.entries(input2)) {
      const credential = credentialHeaders.has(key.toLowerCase());
      const name = credential ? key : this.text(key);
      if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name)) continue;
      Object.defineProperty(result, name, { value: credential ? value : this.text(value), enumerable: true, configurable: true });
    }
    return result;
  }
  frame(frame) {
    let value;
    try {
      value = JSON.parse(frame);
    } catch {
      return this.text(frame);
    }
    return JSON.stringify(this.json(value));
  }
  async request(request) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(this.headers(Object.fromEntries(request.headers)))) headers.set(key, value);
    let body;
    if (request.body) {
      const bytes = await request.clone().arrayBuffer();
      body = bytes;
      const type = request.headers.get("content-type") ?? "";
      const encoding = request.headers.get("content-encoding");
      if ((!encoding || encoding.toLowerCase() === "identity") && !/^(?:image|audio|video)\/|^application\/(?:octet-stream|pdf|zip)(?:;|$)/i.test(type)) {
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
        }
        if (text !== void 0 && !/[\x00-\x08\x0e-\x1f]/.test(text)) body = this.frame(text);
      }
      headers.delete("content-length");
    }
    return new Request(new Request(this.text(request.url), request), { headers, ...body === void 0 ? {} : { body }, referrer: this.text(request.referrer) });
  }
};

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
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

// src/index.ts
var Invocation = Context.Reference("opencode-bao/Invocation", { defaultValue: () => void 0 });
var privateIO = (work) => Effect.tryPromise({ try: work, catch: () => new Error("Bao operation unavailable") });
var shellOverlay = Effect.fnUntraced(function* (event) {
  const overlay = yield* Invocation;
  if (overlay) event.env = { ...event.env, ...overlay };
});
var install = Effect.fnUntraced(function* (ctx, sessions, bao, ready = async () => true, configurationError, loadBao) {
  const resolveBao = async () => {
    if (loadBao) {
      try {
        return await loadBao();
      } catch (error) {
        throw error instanceof LocalSetupError ? error : new LocalSetupError("schema");
      }
    }
    if (!bao) throw configurationError ?? new LocalSetupError("missing");
    return bao;
  };
  yield* ctx.tool.transform((editor) => {
    editor.update("shell", (tool) => {
      const native = tool.execute;
      tool.execute = (input2, context) => Effect.gen(function* () {
        const overlay = yield* privateIO(async () => await ready() ? sessions.overlay(context.sessionID) : void 0).pipe(
          Effect.mapError(() => new Tool.Error({ message: "Bao session environment unavailable" }))
        );
        return yield* native(input2, context).pipe(Effect.provideService(Invocation, overlay));
      });
    });
  });
  yield* ctx.shell.hook("create.before", shellOverlay);
  const scrubber = (session) => privateIO(async () => {
    if (!await ready()) return;
    const snapshot = await sessions.read(session);
    return snapshot.history.length || Object.keys(snapshot.active).length ? new Scrubber(snapshot.history) : void 0;
  }).pipe(Effect.orDie);
  for (const name of ["context", "title", "compaction", "generate"]) {
    yield* ctx.session.hook(name, (event) => Effect.gen(function* () {
      const scrub = yield* scrubber(event.sessionID);
      if (!scrub) return;
      yield* Effect.sync(() => {
        event.system = scrub.json(event.system);
        event.messages = scrub.json(event.messages);
        event.options = scrub.json(event.options);
        if ("tools" in event) event.tools = scrub.json(event.tools);
      });
    }));
  }
  yield* ctx.session.hook("http.request", (event) => Effect.gen(function* () {
    const scrub = yield* scrubber(event.sessionID);
    if (scrub) event.request = yield* privateIO(() => scrub.request(event.request)).pipe(Effect.orDie);
  }));
  yield* ctx.session.hook("experimental.ws.send", (event) => Effect.gen(function* () {
    const scrub = yield* scrubber(event.sessionID);
    if (scrub) yield* Effect.sync(() => {
      event.frame = scrub.frame(event.frame);
    });
  }));
  yield* ctx.session.hook("experimental.ws.handshake", (event) => Effect.gen(function* () {
    const scrub = yield* scrubber(event.sessionID);
    if (scrub) yield* Effect.sync(() => {
      event.url = scrub.text(event.url);
      event.headers = scrub.headers(event.headers);
    });
  }));
  yield* ctx.session.hook("model.request", (event) => Effect.gen(function* () {
    const scrub = yield* scrubber(event.sessionID);
    if (scrub) yield* Effect.sync(() => {
      event.headers = scrub.headers(event.headers);
      if (event.baseURL) event.baseURL = scrub.text(event.baseURL);
    });
  }));
  const status = async (sessionID, bao2, localOnly = false) => {
    const snapshot = await ready() ? await sessions.read(sessionID) : { version: 0, active: {}, history: [] };
    let names = [];
    let catalogUnavailable = localOnly;
    let catalogFailure;
    if (!localOnly) {
      try {
        names = await bao2.catalog();
      } catch (error) {
        if (!Object.keys(snapshot.active).length) throw error;
        catalogUnavailable = true;
        catalogFailure = failureData(error);
      }
    }
    return { sessionID, version: snapshot.version, bundles: [.../* @__PURE__ */ new Set([...names, ...Object.keys(snapshot.active)])].sort().map((name) => ({ name, enabled: Object.hasOwn(snapshot.active, name), keys: Object.keys(snapshot.active[name] ?? {}).length })), protectedValues: snapshot.history.length, ...catalogUnavailable ? { catalogUnavailable: true } : {}, ...catalogFailure ? { catalogFailure } : {} };
  };
  const handler = (action) => (input2, context) => Effect.gen(function* () {
    const { sessionID, bundle, version } = input2;
    const session = yield* ctx.session.get({ sessionID });
    if (session.location.directory !== ctx.location.directory) return yield* Effect.fail(new Error("Unknown session"));
    return yield* Effect.tryPromise({ try: async () => {
      const bao2 = await resolveBao();
      if (action !== "status") {
        if (!await ready()) throw new LocalSetupError("storage");
        if (!validBundle(bundle)) throw new Error("Unknown bundle");
        const snapshot = await sessions.read(sessionID);
        if (version !== snapshot.version) throw new LocalSetupError("stale");
        if (action === "enable") {
          if (!Object.hasOwn(snapshot.active, bundle)) await sessions.enable(sessionID, bundle, await bao2.bundle(bundle), version);
        } else await sessions.disable(sessionID, bundle, version);
      }
      return status(sessionID, bao2, action === "disable");
    }, catch: (error) => error });
  }).pipe(Effect.catch((error) => {
    const data = failureData(error) ?? {};
    return Effect.fail(context.error("unavailable", rpcDiagnostic({ type: "unavailable", data }) ?? "Bao operation unavailable; use /bao-login or check trusted configuration", data));
  }));
  const login2 = (_input, context) => Effect.tryPromise({
    try: async (signal) => {
      const bao2 = await resolveBao();
      await bao2.login({ signal });
      return { authenticated: true };
    },
    catch: (error) => {
      if (error instanceof LoginBusy) return context.error("busy", "Bao login already in progress; finish the existing browser sign-in", {});
      const data = failureData(error) ?? {};
      return context.error("unavailable", rpcDiagnostic({ type: "unavailable", data }) ?? "Bao login failed or timed out; retry /bao-login or check trusted configuration, local browser, Keychain and dedicated role; do not reset existing state", data);
    }
  });
  yield* ctx.rpc.register(BaoRpc, { status: handler("status"), enable: handler("enable"), disable: handler("disable"), login: login2 }).pipe(Effect.orDie);
});
var index_default = Plugin.define({
  id: "opencode.bao",
  effect: (ctx) => Effect.gen(function* () {
    if (process.platform !== "darwin") return;
    const sessions = new Sessions(stateRoot, encryptionKey);
    yield* install(ctx, sessions, void 0, readiness(), void 0, async () => new Bao(await config()));
  })
});
export {
  Invocation,
  index_default as default,
  install,
  shellOverlay
};
