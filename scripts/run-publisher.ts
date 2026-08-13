#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getRepositoryBranchHeadSha,
  runHarness,
  type GithubRepositoryEnv,
  type PublisherCommitFile,
  type PublisherCommitSink,
  type PublisherEnv,
} from "../worker/src/index.ts";
import type {
  KeyValueBinding,
  QueueBatchBinding,
} from "../worker/src/runtime-bindings.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";
import {
  PUBLISHER_DATA_PATH_RE,
  planPublisherImpactFromRepository,
  type PublisherImpactPlan,
} from "./publisher-impact.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BRIDGE_URL =
  "https://tech-dashboard-harness.himiyosh.workers.dev";
const DEFAULT_OIDC_AUDIENCE = "tech-dashboard-publisher";
type PublisherMode = "apply" | "dry-run" | "check" | "preflight" | "flush";

interface PreparedPublisherOutput {
  changed: boolean;
  files: string[];
  message: string;
  expectedParentSha: string;
  impact: PublisherImpactPlan | null;
}

interface PublisherActionOutput extends PreparedPublisherOutput {
  effectsCount: number;
  effectsPath: string;
  impactPath: string;
}

interface OidcTokenState {
  value: string;
  expiresAtMs: number;
}

interface PublisherRunnerDependencies {
  runHarness?: typeof runHarness;
  verifyBridgeContract?: typeof verifyBridgePublisherContract;
}

interface DeferredKvPut {
  key: "og.v1";
  value: string;
  expirationTtl?: number;
}

interface DeferredQueueSend {
  queue: "summary" | "body";
  messages: unknown[];
}

interface DeferredEffectsBundle {
  version: 1;
  publisherContractFingerprint: string;
  kvPuts: DeferredKvPut[];
  queueSends: DeferredQueueSend[];
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

export function parsePublisherArgs(
  args: string[],
):
  | { ok: true; mode: Exclude<PublisherMode, "flush"> }
  | { ok: true; mode: "flush"; effectsPath: string }
  | { ok: false; message: string } {
  if (args.length === 1) {
    if (args[0] === "--apply") return { ok: true, mode: "apply" };
    if (args[0] === "--dry-run") return { ok: true, mode: "dry-run" };
    if (args[0] === "--check") return { ok: true, mode: "check" };
    if (args[0] === "--preflight") return { ok: true, mode: "preflight" };
  }
  if (args.length === 2 && args[0] === "--flush" && args[1]) {
    return { ok: true, mode: "flush", effectsPath: args[1] };
  }
  return {
    ok: false,
    message:
      "use exactly one of --apply, --dry-run, --check, --preflight, or --flush <effects-file>",
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("GitHub OIDC endpoint returned a malformed token");
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("GitHub OIDC endpoint returned an invalid token payload");
  }
}

export class GithubActionsOidcProvider {
  private token: OidcTokenState | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly audience = DEFAULT_OIDC_AUDIENCE,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getToken(forceRefresh = false): Promise<string> {
    if (
      !forceRefresh &&
      this.token &&
      this.token.expiresAtMs - Date.now() > 60_000
    ) {
      return this.token.value;
    }

    const requestUrl = new URL(
      requiredEnv(this.env, "ACTIONS_ID_TOKEN_REQUEST_URL"),
    );
    requestUrl.searchParams.set("audience", this.audience);
    const response = await this.fetchImpl(requestUrl, {
      headers: {
        authorization: `Bearer ${requiredEnv(
          this.env,
          "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        )}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub OIDC token request failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== "string" || !body.value) {
      throw new Error("GitHub OIDC token response is missing value");
    }
    const payload = decodeJwtPayload(body.value);
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      throw new Error("GitHub OIDC token is missing exp");
    }
    this.token = {
      value: body.value,
      expiresAtMs: payload.exp * 1000,
    };
    return body.value;
  }
}

export class PublisherBridgeClient {
  private readonly baseUrl: string;

  constructor(
    bridgeUrl: string,
    private readonly oidc: GithubActionsOidcProvider,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = bridgeUrl.replace(/\/+$/, "");
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.oidc.getToken(attempt > 0);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
      if (response.status !== 401 || attempt === 1) return response;
    }
    throw new Error("unreachable bridge retry state");
  }
}

export async function verifyBridgePublisherContract(
  bridgeUrl: string,
  expectedFingerprint = DEPLOYED_PUBLISHER_FINGERPRINT,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${bridgeUrl.replace(/\/+$/, "")}/health`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `publisher bridge preflight failed with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as {
    ok?: unknown;
    status?: unknown;
    publisherContractFingerprint?: unknown;
  };
  if (body.ok !== true || body.status !== "bridge") {
    throw new Error(
      `publisher bridge preflight is not healthy: ${String(body.status ?? "unknown")}`,
    );
  }
  if (body.publisherContractFingerprint !== expectedFingerprint) {
    throw new Error(
      `publisher bridge fingerprint mismatch: deployed ${String(body.publisherContractFingerprint ?? "missing")}, expected ${expectedFingerprint}`,
    );
  }
}

export class RemoteKeyValueBinding implements KeyValueBinding {
  constructor(
    private readonly client: PublisherBridgeClient,
    private readonly readOnly = false,
  ) {}

  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  async get<T>(
    key: string,
    type?: "json",
  ): Promise<string | T | null> {
    const encodedKey = Buffer.from(key, "utf8").toString("base64url");
    const response = await this.client.request(`/v1/kv/${encodedKey}`);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`publisher bridge KV get failed with HTTP ${response.status}`);
    }
    const value = await response.text();
    if (type !== "json") return value;
    try {
      return JSON.parse(value) as T;
    } catch {
      throw new Error(`publisher bridge returned invalid JSON for KV key ${key}`);
    }
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    if (this.readOnly) return;
    const encodedKey = Buffer.from(key, "utf8").toString("base64url");
    const path = new URL(`/v1/kv/${encodedKey}`, "https://bridge.invalid");
    if (options?.expirationTtl !== undefined) {
      path.searchParams.set("expirationTtl", String(options.expirationTtl));
    }
    const response = await this.client.request(
      `${path.pathname}${path.search}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(Buffer.byteLength(value)),
        },
        body: value,
      },
    );
    if (!response.ok) {
      throw new Error(`publisher bridge KV put failed with HTTP ${response.status}`);
    }
  }
}

export class RemoteQueueBatchBinding<T> implements QueueBatchBinding<T> {
  constructor(
    private readonly client: PublisherBridgeClient,
    private readonly queue: "summary" | "body",
    private readonly readOnly = false,
  ) {}

  async sendBatch(messages: Array<{ body: T }>): Promise<void> {
    if (this.readOnly || messages.length === 0) return;
    const body = JSON.stringify({ messages: messages.map(({ body }) => body) });
    const response = await this.client.request(`/v1/queues/${this.queue}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    if (!response.ok) {
      throw new Error(
        `publisher bridge ${this.queue} queue failed with HTTP ${response.status}`,
      );
    }
  }
}

class DeferredKeyValueBinding implements KeyValueBinding {
    constructor(
      private readonly source: KeyValueBinding,
      private readonly bundle: DeferredEffectsBundle,
    ) {}

    get(key: string): Promise<string | null>;
    get<T>(key: string, type: "json"): Promise<T | null>;
    get<T>(key: string, type?: "json"): Promise<string | T | null> {
      return type === "json" ? this.source.get<T>(key, type) : this.source.get(key);
    }

    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ): Promise<void> {
      // Publisher telemetry is committed in data/index.json.health. The Free
      // bridge intentionally permits only og.v1 writes (R-026), so heartbeat
      // KV writes from the former Worker runtime are discarded here.
      if (key === "heartbeat.v1") return;
      if (key !== "og.v1") {
        throw new Error(`publisher refused deferred KV write for key ${key}`);
      }
      this.bundle.kvPuts.push({
        key,
        value,
        ...(options?.expirationTtl === undefined
          ? {}
          : { expirationTtl: options.expirationTtl }),
      });
    }
  }

class DeferredQueueBatchBinding<T> implements QueueBatchBinding<T> {
    constructor(
      private readonly queue: "summary" | "body",
      private readonly bundle: DeferredEffectsBundle,
    ) {}

    async sendBatch(messages: Array<{ body: T }>): Promise<void> {
      if (messages.length === 0) return;
      this.bundle.queueSends.push({
        queue: this.queue,
        messages: messages.map(({ body }) => body),
      });
  }
}

function gitHead(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function writeAtomic(root: string, file: PublisherCommitFile): void {
  if (!PUBLISHER_DATA_PATH_RE.test(file.path)) {
    throw new Error(`publisher refused unexpected output path: ${file.path}`);
  }
  const target = resolve(root, file.path);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`publisher output escapes repository root: ${file.path}`);
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`publisher output must not replace a symlink: ${file.path}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.publisher-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, file.content, "utf8");
    renameSync(temp, target);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function writeAtomicFile(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, content, "utf8");
    renameSync(temp, target);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function createEffectsBundle(): DeferredEffectsBundle {
  return {
    version: 1,
    publisherContractFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
    kvPuts: [],
    queueSends: [],
  };
}

function effectCount(bundle: DeferredEffectsBundle): number {
  return (
    bundle.kvPuts.length +
    bundle.queueSends.reduce((total, send) => total + send.messages.length, 0)
  );
}

function effectsFilePath(env: NodeJS.ProcessEnv): string {
  const runnerTemp = requiredEnv(env, "RUNNER_TEMP");
  return resolve(runnerTemp, "tech-dashboard-publisher-effects.json");
}

function impactFilePath(env: NodeJS.ProcessEnv): string {
  const runnerTemp = requiredEnv(env, "RUNNER_TEMP");
  return resolve(runnerTemp, "tech-dashboard-publisher-impact.json");
}

function readEffectsBundle(
  effectsPath: string,
  env: NodeJS.ProcessEnv,
): DeferredEffectsBundle {
  const runnerTemp = resolve(requiredEnv(env, "RUNNER_TEMP"));
  const resolvedPath = resolve(effectsPath);
  if (!resolvedPath.startsWith(`${runnerTemp}${sep}`)) {
    throw new Error("publisher effects file must be inside RUNNER_TEMP");
  }
  if (!existsSync(resolvedPath) || !lstatSync(resolvedPath).isFile()) {
    throw new Error("publisher effects file is missing or not a regular file");
  }
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("publisher effects bundle must be an object");
  }
  const candidate = parsed as Partial<DeferredEffectsBundle>;
  if (
    candidate.version !== 1 ||
    candidate.publisherContractFingerprint !== DEPLOYED_PUBLISHER_FINGERPRINT ||
    !Array.isArray(candidate.kvPuts) ||
    !Array.isArray(candidate.queueSends)
  ) {
    throw new Error("publisher effects bundle contract mismatch");
  }
  for (const put of candidate.kvPuts) {
    if (
      !put ||
      put.key !== "og.v1" ||
      typeof put.value !== "string" ||
      (put.expirationTtl !== undefined &&
        (!Number.isInteger(put.expirationTtl) ||
          put.expirationTtl < 60 ||
          put.expirationTtl > 31_536_000))
    ) {
      throw new Error("publisher effects bundle contains an invalid KV write");
    }
  }
  for (const send of candidate.queueSends) {
    if (
      !send ||
      (send.queue !== "summary" && send.queue !== "body") ||
      !Array.isArray(send.messages) ||
      send.messages.length < 1 ||
      send.messages.length > 100
    ) {
      throw new Error("publisher effects bundle contains an invalid queue send");
    }
  }
  return candidate as DeferredEffectsBundle;
}

export function createLocalCommitSink(options: {
  root: string;
  dryRun: boolean;
  getLocalHead?: () => string;
  getRemoteHead?: (env: GithubRepositoryEnv) => Promise<string>;
  planImpact?: typeof planPublisherImpactFromRepository;
  onPrepared: (output: PreparedPublisherOutput) => void;
}): PublisherCommitSink {
  return async (env, message, files, expectedParentSha) => {
    const localHead = (options.getLocalHead ?? (() => gitHead(options.root)))();
    const remoteHead = await (
      options.getRemoteHead ??
      ((repositoryEnv) => getRepositoryBranchHeadSha(repositoryEnv))
    )(env);
    if (localHead !== expectedParentSha || remoteHead !== expectedParentSha) {
      throw new Error(
        `publisher snapshot changed before prepare: expected ${expectedParentSha}, local ${localHead}, remote ${remoteHead}`,
      );
    }
    if (files.length === 0) {
      options.onPrepared({
        changed: false,
        files: [],
        message,
        expectedParentSha,
        impact: null,
      });
      return null;
    }
    const uniquePaths = new Set(files.map(({ path }) => path));
    if (uniquePaths.size !== files.length) {
      throw new Error("publisher commit sink requires unique output files");
    }
    const impact = (options.planImpact ?? planPublisherImpactFromRepository)({
      root: options.root,
      baseRef: expectedParentSha,
      changedFiles: files,
    });
    if (!options.dryRun) {
      for (const file of files) writeAtomic(options.root, file);
    } else {
      for (const file of files) {
        if (!PUBLISHER_DATA_PATH_RE.test(file.path)) {
          throw new Error(`publisher refused unexpected output path: ${file.path}`);
        }
      }
    }
    options.onPrepared({
      changed: true,
      files: files.map(({ path }) => path),
      message,
      expectedParentSha,
      impact,
    });
    return `prepared:${expectedParentSha}`;
  };
}

function writeActionOutputs(output: PublisherActionOutput): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `changed=${String(output.changed)}\n`, "utf8");
  appendFileSync(
    outputPath,
    `files_json=${JSON.stringify(output.files)}\n`,
    "utf8",
  );
  appendFileSync(
    outputPath,
    `expected_parent=${output.expectedParentSha}\n`,
    "utf8",
  );
  appendFileSync(
    outputPath,
    `message_base64=${Buffer.from(output.message, "utf8").toString("base64")}\n`,
    "utf8",
  );
  appendFileSync(outputPath, `effects_count=${output.effectsCount}\n`, "utf8");
  appendFileSync(outputPath, `effects_path=${output.effectsPath}\n`, "utf8");
  appendFileSync(outputPath, `impact_path=${output.impactPath}\n`, "utf8");
}

function assertActionsContext(env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_ACTIONS !== "true") {
    throw new Error("publisher apply/dry-run is restricted to GitHub Actions");
  }
  if (env.GITHUB_REF !== "refs/heads/main") {
    throw new Error(`publisher requires refs/heads/main, received ${env.GITHUB_REF ?? "missing"}`);
  }
  if (env.GITHUB_REPOSITORY !== "himiyosh/tech-dashboard") {
    throw new Error(
      `publisher requires himiyosh/tech-dashboard, received ${env.GITHUB_REPOSITORY ?? "missing"}`,
    );
  }
}

export async function runPublisherCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: PublisherRunnerDependencies = {},
): Promise<number> {
  const parsed = parsePublisherArgs(args);
  if (!parsed.ok) {
    console.error(`ERR: ${parsed.message}`);
    return 1;
  }
  if (parsed.mode === "check") {
    console.log("OK: publisher runner CLI and output path policy are valid");
    return 0;
  }

  assertActionsContext(env);
  const bridgeUrl = env.PUBLISHER_BRIDGE_URL ?? DEFAULT_BRIDGE_URL;
  const verifyBridge =
    dependencies.verifyBridgeContract ??
    verifyBridgePublisherContract;
  if (parsed.mode === "preflight") {
    await verifyBridge(bridgeUrl);
    console.log(
      `OK: publisher bridge fingerprint ${DEPLOYED_PUBLISHER_FINGERPRINT}`,
    );
    return 0;
  }
  if (parsed.mode === "flush") {
    const bundle = readEffectsBundle(parsed.effectsPath, env);
    await verifyBridge(bridgeUrl);
    const oidc = new GithubActionsOidcProvider(
      env,
      env.PUBLISHER_OIDC_AUDIENCE ?? DEFAULT_OIDC_AUDIENCE,
    );
    const bridge = new PublisherBridgeClient(
      bridgeUrl,
      oidc,
    );
    const remoteKv = new RemoteKeyValueBinding(bridge);
    for (const put of bundle.kvPuts) {
      await remoteKv.put(
        put.key,
        put.value,
        put.expirationTtl === undefined
          ? undefined
          : { expirationTtl: put.expirationTtl },
      );
    }
    for (const send of bundle.queueSends) {
      const queue = new RemoteQueueBatchBinding(
        bridge,
        send.queue,
      );
      await queue.sendBatch(send.messages.map((body) => ({ body })));
    }
    unlinkSync(resolve(parsed.effectsPath));
    console.log(`OK: flushed ${effectCount(bundle)} deferred publisher effects`);
    return 0;
  }

  const dryRun = parsed.mode === "dry-run";
  await verifyBridge(bridgeUrl);
  const oidc = new GithubActionsOidcProvider(
    env,
    env.PUBLISHER_OIDC_AUDIENCE ?? DEFAULT_OIDC_AUDIENCE,
  );
  const bridge = new PublisherBridgeClient(
    bridgeUrl,
    oidc,
  );
  const remoteCache = new RemoteKeyValueBinding(bridge, true);
  const effects = createEffectsBundle();
  const summaryCache = new DeferredKeyValueBinding(remoteCache, effects);
  const prepared: PublisherActionOutput = {
    changed: false,
    files: [],
    message: "",
    expectedParentSha: gitHead(ROOT),
    impact: null,
    effectsCount: 0,
    effectsPath: "",
    impactPath: "",
  };
  const commitFiles = createLocalCommitSink({
    root: ROOT,
    dryRun,
    onPrepared: (output) => Object.assign(prepared, output),
  });
  const publisherEnv: PublisherEnv = {
    GH_TOKEN: requiredEnv(env, "GITHUB_TOKEN"),
    GITHUB_OWNER: "himiyosh",
    GITHUB_REPO: "tech-dashboard",
    GITHUB_BRANCH: "main",
    SUMMARY_CACHE: summaryCache,
    COPILOT_PAT: "",
    SUMMARIZE_MODEL: "claude-sonnet-4.6",
    SUMMARIZE_MAX_NEW: "0",
    SUMMARIZE_TIMEOUT_MS: "25000",
    SUMMARIZE_CONCURRENCY: "2",
    SUMMARY_QUEUE: new DeferredQueueBatchBinding("summary", effects),
    ENABLE_SUMMARY_QUEUE: "1",
    ENQUEUE_MAX_NEW: "35",
    KV_LOOKUP_CAP: "35",
    OG_BUDGET_PER_RUN: "1",
    BODY_QUEUE: new DeferredQueueBatchBinding("body", effects),
    ENABLE_BODY_QUEUE: "1",
    ENRICHMENT_ENQUEUE_MAX_TOTAL: "35",
    BODY_ENQUEUE_MAX_NEW: "35",
    BODY_LOOKUP_CAP: "35",
    BODY_RETENTION_DAYS: "30",
  };
  const result = await (dependencies.runHarness ?? runHarness)(publisherEnv, {
    commitFiles,
  });
  if (!result.changed) {
    prepared.changed = false;
    prepared.files = [];
  }
  prepared.effectsCount = effectCount(effects);
  if (prepared.changed && prepared.impact) {
    prepared.impactPath = impactFilePath(env);
    writeAtomicFile(
      prepared.impactPath,
      `${JSON.stringify(prepared.impact, null, 2)}\n`,
    );
  }
  if (!dryRun && prepared.effectsCount > 0) {
    prepared.effectsPath = effectsFilePath(env);
    writeAtomicFile(
      prepared.effectsPath,
      `${JSON.stringify(effects)}\n`,
    );
  }
  writeActionOutputs(prepared);
  console.log(
    `OK: publisher ${dryRun ? "dry-run" : "prepare"} changed=${prepared.changed} files=${prepared.files.length}`,
  );
  return 0;
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectInvocation) {
  runPublisherCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(`ERR: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
