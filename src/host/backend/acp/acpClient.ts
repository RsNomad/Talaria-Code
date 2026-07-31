import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
// AUDIT-5 advisory: ACP protocol v2 REMOVES `session/load` (replaced by
// `session/resume` + replayFrom, mcpServers still required on resume —
// Context7 /agentclientprotocol/agent-client-protocol, migration.mdx). Both
// sides are deliberately pinned to v1 (sdk 0.17.1 exact / Hermes
// agent-client-protocol==0.9.0). Treat ANY sdk bump as a MIGRATION
// (load→resume, replay contract, mcpServers), never a routine upgrade.
import type { Logger } from '../../transport/JsonRpcStdio';
import type { SpawnSpec } from '../../runtime/resolveHermes';
import type {
  AcpOutboundContentBlock,
  AcpRequestPermissionRequest,
  AcpRequestPermissionResponse,
  AcpSessionUpdate,
} from './types';
import type { AcpMcpServerHttp } from '../../../shared/acpMcpServerHttp';

/**
 * Thin seam around the ACP TypeScript SDK (`@agentclientprotocol/sdk`,
 * pinned exactly at `0.17.1` — the release whose method map matches the
 * Python `agent-client-protocol==0.9.0` Hermes pins. Audit C-1: the
 * predecessor package, `@zed-industries/agent-client-protocol`, is frozen at
 * 0.4.5 and is no longer installed; see `acpWireNames.test.ts` for the
 * byte-level proof this migration actually changed what goes on the wire).
 *
 * Deliberately NOT `JsonRpcStdio`: the ACP SDK's `ClientSideConnection` is
 * itself a full JSON-RPC-over-stdio implementation (id correlation, request
 * dispatch, the `Agent`-shaped RPC proxy) built on `ndJsonStream(output,
 * input)` over raw byte streams — it is not designed to sit on top of an
 * already-parsed request/response abstraction like `JsonRpcStdio`. Two
 * JSON-RPC layers cannot both own the same child's stdout pipe. So this seam
 * spawns `hermes acp` directly (still via {@link resolveHermes}'s login-shell
 * wrapped {@link SpawnSpec}) and hands the SDK the raw stdio streams; the
 * *transport framing* (newline-delimited JSON) is identical between the two,
 * only the object that owns the pipe differs. `JsonRpcStdio` remains
 * exclusively `ControlChannel`'s (`tui_gateway`) transport.
 *
 * Everything worth unit-testing (the `session/update` / permission MAPPING)
 * lives in the pure `acp/*` modules this class merely feeds — this file is
 * intentionally thin and untested.
 */

export interface AcpClientCallbacks {
  onSessionUpdate(sessionId: string, update: AcpSessionUpdate): void;
  onRequestPermission(req: AcpRequestPermissionRequest): Promise<AcpRequestPermissionResponse>;
  onReadTextFile(path: string, line: number | null | undefined, limit: number | null | undefined): Promise<string>;
}

export interface AcpClientOptions {
  spawn: SpawnSpec;
  cwd: string;
  logger?: Logger;
  callbacks: AcpClientCallbacks;
}

export interface AcpNewSessionResult {
  sessionId: string;
  currentModeId: string;
  /**
   * A7 (Tier-2 remediation architecture §12.1, task T-13):
   * `NewSessionResponse.models.currentModelId` (SDK schema
   * `SessionModelState.currentModelId`, `types.gen.d.ts:2991`) — the model
   * the harness ALREADY bound this session to at `session/new`. `undefined`
   * when the response carried no `models` (tolerated, not an error — mirrors
   * `currentModeId`'s own `?? 'default'` tolerance for an absent field,
   * except there is no honest default for a model id to fall back to). The
   * id-namespace contract question (whether this id always matches what the
   * Models panel's own list uses) stays DEFERRED — this only surfaces what
   * the wire already carries.
   */
  currentModelId?: string;
}

/**
 * Result of `session/load`. Mirrors {@link AcpNewSessionResult}'s
 * `currentModeId` field (both come from `LoadSessionResponse.modes`/
 * `NewSessionResponse.modes`'s `currentModeId`, confirmed structurally
 * identical in the installed SDK's `schema.d.ts`) — no `sessionId` here since
 * loading doesn't mint a new one, the caller already knows it.
 *
 * Audit A-3. Hermes answers an UNKNOWN session id with `None`
 * (`acp_adapter/server.py:1141-1143`: `if state is None: ... return None`),
 * and the installed SDK's `loadSession()` turns that into `{}` before handing
 * it back (`?? {}`, `dist/acp.js:484` — identical in the predecessor 0.4.5
 * SDK too, so Task 5's SDK bump did not fix this). A `{}` used to become
 * `{ currentModeId: 'default' }` here — indistinguishable from a genuine
 * successful load of an empty conversation, including on the crash-recovery
 * path (`ConnectionSupervisor.recoverOneSession` re-`session/load`s every
 * session that was live at crash time). A real `LoadSessionResponse` always
 * carries `modes`; its absence is the discriminator. Every caller MUST
 * surface `found: false` as a failure, never as an empty transcript.
 *
 * ARCH-3/E2: a discriminated union on the `found` literal, not a flat
 * `{found: boolean; currentModeId: string}` — the flat shape let `{found:
 * false}` still carry a `currentModeId` value indistinguishable from a real
 * mode, an illegal state any future consumer could read without narrowing.
 * TypeScript narrows unions on a common literal-typed discriminant property
 * (https://www.typescriptlang.org/docs/handbook/2/narrowing.html, fetched
 * live for this task): checking `found` now makes `currentModeId` a compile
 * error on the `found: false` branch, so the illegal state is unrepresentable
 * rather than merely undocumented.
 */
export type AcpLoadSessionResult =
  | { found: true; currentModeId: string; currentModelId?: string }
  | { found: false };

/**
 * Raw ACP `session/list` result — left untyped here even though Audit C-1's
 * migration to `@agentclientprotocol/sdk@0.17.1` gave `listSessions()` a real,
 * typed `ListSessionsResponse` (`schema.d.ts`: `{sessions: SessionInfo[],
 * nextCursor?}`, `SessionInfo: {sessionId, cwd, title?, updatedAt?}` —
 * confirmed camelCase directly from the TS schema, unlike the 0.4.5 SDK this
 * type predates, which shipped no `listSessions` method at all and forced
 * this call through the generic `extMethod` escape hatch). Retyping the
 * return value end-to-end is deliberately left to the task that owns
 * `reshapeSessionsList` (`host/panels/reshapePanelData.ts`) rather than done
 * incidentally here.
 *
 * Wire-JSON key casing is camelCase — confirmed directly from the Python
 * `agent-client-protocol==0.9.0` SDK Hermes pins (the package this codebase
 * cannot vendor, but was read directly for this check): `acp/schema.py`
 * declares `SessionInfo.session_id` with `Field(alias="sessionId")` and
 * `.updated_at` with `alias="updatedAt"`, and `ListSessionsResponse.next_cursor`
 * with `alias="nextCursor"` — and, decisively, `acp/connection.py`'s
 * `_run_request` serializes every `BaseModel` JSON-RPC result with
 * `result.model_dump(mode="json", by_alias=True, exclude_none=True,
 * exclude_unset=True)`, so `session/list` responses go out using those
 * aliases, not the Python attribute names. (`populate_by_name=True` on the
 * SDK's own `BaseModel` base only widens what pydantic accepts on
 * deserialization; it says nothing about what gets serialized onto the
 * wire — the `by_alias=True` at the `_run_request` call site is the fact
 * that actually settles this.) Left untyped here regardless;
 * `reshapeSessionsList` (`host/panels/reshapePanelData.ts`) is the layer that
 * defensively tolerates BOTH `session_id`/`sessionId`,
 * `next_cursor`/`nextCursor`, and `updated_at`/`updatedAt` — belt-and-braces
 * on a wire boundary, kept even though the camelCase casing above is now
 * confirmed rather than gambled on.
 */
export type AcpListSessionsRawResult = Record<string, unknown>;

export interface AcpPromptResult {
  stopReason: string;
  usage?: unknown;
}

/**
 * An environment variable to set when launching an MCP server — ACP's
 * `EnvVariable`. Re-verified (audit-3 CA-12) against the INSTALLED
 * `@agentclientprotocol/sdk@0.17.1` (`package.json`'s pinned version;
 * `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`,
 * `EnvVariable`): still exactly `{name: string, value: string}` (plus an
 * optional `_meta`, unused here) — the shape below is current, not a stale
 * carryover from the predecessor `@zed-industries/agent-client-protocol`
 * package Audit C-1 replaced. Deliberately a LIST item, not a dict entry:
 * Node's own `child_process` env convention is `Record<string,string>`,
 * which is NOT what goes over the wire here (pinned contract: "ACP
 * McpServerStdio: {name, command, args[], env:[{name,value}]}").
 */
export interface AcpEnvVariable {
  name: string;
  value: string;
}

/**
 * ACP `McpServer`'s stdio-transport variant — the SDK's `McpServerStdio`
 * type. Re-verified (audit-3 CA-12) against the INSTALLED
 * `@agentclientprotocol/sdk@0.17.1`
 * (`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`,
 * `McpServerStdio`): still `{name, command, args: string[], env:
 * Array<EnvVariable>}` with no `type` discriminant field, unlike the
 * `http`/`sse` variants which require `type: "http"`/`"sse"` — the shape
 * below is current, not a stale carryover from the predecessor
 * `@zed-industries/agent-client-protocol` package Audit C-1 replaced. The
 * only transport Zone RG's `codebase_search` server needs — a bare stdio
 * child process (`dist/mcp/codebase-server.js`).
 */
export interface AcpMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: AcpEnvVariable[];
}

/**
 * T-19 (C1+C2, boundary move): `AcpHttpHeader`/`AcpMcpServerHttp` used to be
 * defined HERE (T2, then reconciled to this single canonical home by T3 —
 * see `mcp/lsp/libServerHost.ts`'s own historical note). This task moved
 * them again, to `src/shared/acpMcpServerHttp.ts`: `mcp/lsp/libServerHost.ts`
 * importing them from a file under `host/backend/acp/` — while
 * `host/lib/*` separately imports FROM `mcp/lsp/*` — is exactly the
 * `host` ⇄ `mcp/lsp` directory cycle the architecture audit flagged.
 * `AcpMcpServer` below imports `AcpMcpServerHttp` from `shared/` like any
 * other consumer; only its OWN definition (a discriminated union of a stdio
 * and an http variant) stays here, next to {@link AcpMcpServerStdio}.
 */

/**
 * The union of every MCP server transport this client advertises to Hermes.
 * Discriminated by the presence/absence of `type` — stdio has none, http
 * requires `type: 'http'` (the SDK's `sse` variant is not produced by this
 * codebase and is deliberately not modeled here).
 */
export type AcpMcpServer = AcpMcpServerStdio | AcpMcpServerHttp;

/**
 * The subset of {@link AcpClient} that {@link AcpBackend} depends on, kept as
 * a thin interface — the same "keep dep-touching code behind a thin
 * interface so logic is testable" pattern `ControlChannel` uses for its
 * `ControlTransport` — so `AcpBackend.start()`'s `mcpServers` wiring
 * (Zone RAG) is unit-testable without spawning a real `hermes acp` child.
 */
export interface AcpClientLike {
  connect(): Promise<void>;
  initialize(): Promise<void>;
  newSession(cwd: string, mcpServers?: AcpMcpServer[]): Promise<AcpNewSessionResult>;
  prompt(sessionId: string, content: AcpOutboundContentBlock[]): Promise<AcpPromptResult>;
  cancel(sessionId: string): Promise<void>;
  setSessionMode(sessionId: string, modeId: string): Promise<void>;
  setSessionModel(sessionId: string, modelId: string): Promise<void>;
  /** Zone HIST: ACP `session/list` (named SDK method — see {@link AcpListSessionsRawResult}). */
  listSessions(cwd?: string, cursor?: string): Promise<AcpListSessionsRawResult>;
  /**
   * Zone HIST: ACP `session/load`. `mcpServers` MUST be re-sent (RAG's pinned
   * cross-zone contract: "Re-send `mcpServers`
   * on every `session/new` AND `resume`/`load`/`fork`" — the agent does not
   * retain them across a load, exactly like `newSession`).
   */
  loadSession(cwd: string, sessionId: string, mcpServers?: AcpMcpServer[]): Promise<AcpLoadSessionResult>;
  /**
   * W4-T5b (P-W4-3 / Q-3): best-effort ACP `session/close` (named SDK method
   * `unstable_closeSession`, see {@link AcpClient.closeSession}). OPTIONAL:
   * this is fire-and-forget dispose-time cleanup, and Hermes advertises no
   * `close` session capability at all (`acp_adapter/server.py:890-894`) — the
   * call is expected to be refused. A client that doesn't implement this
   * member at all (an older test double, a future non-ACP backend) is a safe
   * no-op via the caller's own `?.` chain (`SessionController.dispose()`); an
   * implementation MUST itself never reject — see {@link AcpClient.closeSession}.
   */
  closeSession?(sessionId: string): Promise<void>;
  /**
   * R-A6: subscribe to the child's UNEXPECTED death. Never fired for a
   * dispose()-initiated kill (dispose clears the child reference before
   * signalling, so the exit callback's identity guard suppresses it) — the
   * same intentional-stop vs crash split ControlChannel gets from its
   * 'disposed' state check (ControlChannel.ts:272).
   */
  onExit(handler: (code: number | null) => void): { dispose(): void };
  dispose(): void;
}

/** Builds an {@link AcpClientLike} for a resolved spawn spec. */
export type AcpClientFactory = (options: AcpClientOptions) => AcpClientLike;

export class AcpClient implements AcpClientLike {
  private child: ChildProcess | undefined;
  private connection: ClientSideConnection | undefined;
  private readonly exitHandlers = new Set<(code: number | null) => void>();

  /**
   * W1-T1 (CF-01/A-2): the central terminate-race primitive. The pinned ACP
   * SDK never rejects an in-flight request when the child's stdio stream
   * closes (child death) — an unraced `await this.requireConnection().foo()`
   * hangs forever if the child dies mid-request. Every OTHER un-jam
   * mechanism in this codebase (`SessionController.runControlUtterance`'s
   * wall-clock `Promise.race`, `ConnectionSupervisor.raceAgainstChildExit`'s
   * `onExit`-based race) is bolted on at a CALLER, ad hoc, per call site —
   * this pair + {@link raceTermination} instead fixes it ONCE, at the seam
   * every request method already funnels through, so a future request
   * method (or an existing one a future caller reaches un-raced) is
   * protected for free.
   *
   * Created fresh in {@link connect} (one pair per live child — a reconnect
   * gets a NEW pair, never reuses a dead connection's), and rejected inside
   * `terminate()` (the single death choke `child.on('exit'|'error')` both
   * funnel through, `connect()`'s own `terminate` closure, ~:360 below) —
   * the SAME event that already fires {@link exitHandlers}.
   */
  private terminationReject: ((e: unknown) => void) | undefined;
  private terminationPromise: Promise<never> | undefined;

  constructor(private readonly options: AcpClientOptions) {}

  /**
   * Races `op()` against this connection's termination promise — resolves/
   * rejects with `op()`'s own outcome on the happy path (the race's OTHER
   * side never settles until the child dies), rejects with the "terminated"
   * error the instant the child dies first. A no-op passthrough
   * (`return op()`) before the first {@link connect} — `requireConnection()`
   * already throws synchronously in that state for every request method, so
   * this never masks "not connected" as a hang. Also a no-op passthrough
   * after `terminate()` has cleared the pair on THIS (now-dead, single-
   * lifecycle) instance — CF-01/A fix wave: no longer a residual hang risk,
   * because `terminate()` ALSO clears `this.connection` in that same
   * synchronous block, so `op()`'s own `requireConnection()` call throws
   * fast instead of reaching a dead `ClientSideConnection` — see
   * `terminate`'s own doc.
   */
  private raceTermination<T>(op: () => Promise<T>): Promise<T> {
    const term = this.terminationPromise;
    return term ? Promise.race([op(), term]) : op();
  }

  onExit(handler: (code: number | null) => void): { dispose(): void } {
    this.exitHandlers.add(handler);
    return { dispose: () => void this.exitHandlers.delete(handler) };
  }

  /**
   * Spawn `hermes acp` and construct the ACP client-side connection over it.
   *
   * [Minor] hardening (both review lenses, CF-01/A fix wave): self-enforces
   * the single-lifecycle invariant `ConnectionSupervisor.createClient`
   * currently guarantees only by CONVENTION (a fresh `AcpClient` instance
   * per connect/respawn — `connect()` is never meant to run twice on the
   * same object). Throwing here turns a hypothetical future violation of
   * that convention into an honest, immediate failure instead of silently
   * orphaning the FIRST child/connection pair (overwritten below with no
   * cleanup) while leaving the first termination pair's promise dangling.
   */
  async connect(): Promise<void> {
    if (this.child) throw new Error('AcpClient.connect: already connected');
    const { command, args } = this.options.spawn;
    this.log(`spawn: ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    // W1-T1: a fresh termination pair for THIS child — a reconnect after a
    // prior death gets its own new pair, never inherits the dead one's
    // (already-settled) promise. The `.catch(() => {})` below is load-
    // bearing, not decorative: if no request happens to be in flight when
    // `terminate()` later rejects this promise, {@link raceTermination} has
    // never attached a `Promise.race` handler to it, and an unhandled
    // rejection on ANY promise — even one nobody is awaiting — crashes a
    // Node process under `--unhandled-rejections=strict` (the extension
    // host's default) or logs a scary warning otherwise. Attaching this
    // no-op handler here marks the promise "handled" for Node's own
    // bookkeeping while leaving it fully live for `Promise.race` to consume
    // later — multiple `.then`/`.catch` reactions on one promise are
    // ordinary, independent subscribers, not a single consumed value.
    const terminationPromise = new Promise<never>((_resolve, reject) => {
      this.terminationReject = reject;
    });
    terminationPromise.catch(() => {});
    this.terminationPromise = terminationPromise;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.log(`[stderr] ${chunk.replace(/\n$/, '')}`));
    // T-B1 (closes V-8): 'exit' and a spawn/runtime 'error' both terminate
    // this child and must fan out the SAME `exitHandlers` — Node's own docs
    // warn 'error' may fire WITHOUT a following 'exit' at all (e.g. an ENOENT
    // hermes binary), which previously left every `onExit` subscriber
    // (`ConnectionSupervisor`'s crash handler, and — as of this task — its
    // connect-phase race) silently unnotified: no banner, no respawn, no
    // un-jammed `start()` tail. Shared `terminate` fn + the SAME identity
    // guard the old exit-only handler used — that guard is also the existing
    // double-fire protection (whichever of 'error'/'exit' fires FIRST nulls
    // `this.child`, so a later notification for the SAME child is a no-op).
    // Residual accepted: a kill-failure 'error' on an otherwise-live child
    // now also reads as terminal — fail-toward-respawn, strictly stricter
    // than before, and `dispose()` already nulls `this.child` BEFORE killing
    // (see below), so an intentional teardown's kill failure can never
    // misfire through here.
    const terminate = (code: number | null): void => {
      if (this.child !== child) return;
      this.child = undefined;
      // CF-01/A fix wave (arch Important, post-3cdd78e review): clear
      // `this.connection` in this SAME synchronous block, not just
      // `this.child` — makes the residual post-terminate window
      // SELF-sufficient. Before this, a request issued on a STALE captured
      // `client` reference (e.g. `SessionController.runTurn`'s `client`
      // local, read once and reused across an `await`) fell through
      // `raceTermination`'s `op()`-only passthrough (no live
      // `terminationPromise` left to race) straight into
      // `requireConnection()`, which still found `this.connection` set and
      // handed back a dead `ClientSideConnection` — hanging again exactly
      // like every request did before W1-T1's original fix, UNLESS some
      // external `dispose()` (e.g. `ConnectionSupervisor.handleAcpCrash`'s
      // `client.dispose()`, itself sitting behind a per-controller
      // `endOnCrash()` loop) happened to run first and clear it instead.
      // Clearing it HERE removes that dependency: `requireConnection()` now
      // throws synchronously (surfacing as a fast rejection) for any
      // post-terminate call on this instance, self-sufficiently, regardless
      // of what any external cleanup does or when. Verified safe: every
      // `client.onExit(...)` registrant against THIS interface
      // (`ConnectionSupervisor`'s crash handler, its connect-phase race, and
      // its `raceAgainstChildExit` recovery race — the only three
      // registrants, all in `connection/ConnectionSupervisor.ts`) is a bare
      // resolve/reject/state-bookkeeping callback that never itself calls
      // back into this client, so clearing `this.connection` here cannot
      // break the `exitHandlers` fan-out below.
      this.connection = undefined;
      // W1-T1 (CF-01/A-2): reject before the exitHandlers fan-out, for
      // readability — NOT what guarantees observation. `reject()` only
      // SCHEDULES a microtask reaction; it never runs synchronously, so
      // ordering it before-vs-after the fan-out changes nothing about WHEN a
      // caller's raced `await` actually wakes. What DOES guarantee it: this
      // whole `terminate` function (this reject call, the pair-clear below,
      // and the fan-out loop) runs SYNCHRONOUSLY, while every reaction to
      // the termination promise is a DEFERRED microtask — so the fan-out
      // (including a handler that throws, already tolerated by the
      // try/catch below) always finishes before any caller can observe the
      // rejection, true regardless of reject-before-or-after placement here.
      // Message carries status/reason only (the exit/error code) — never
      // body/key/path content, per this task's own constraint.
      //
      // Clear the pair right after: this exact `AcpClient` instance is
      // single-lifecycle (`ConnectionSupervisor.createClient` mints a BRAND
      // NEW instance for every connect/respawn — `connect()` is never called
      // twice on the same object, now self-enforced by `connect()`'s own
      // guard too), so clearing has no effect on any future reconnect; it
      // only affects a call issued to THIS now-dead instance after this
      // point — self-sufficiently fast-failing per the `this.connection`
      // clear above, not merely "residual and accepted" as this comment used
      // to claim. The request THAT WAS IN FLIGHT AT THE MOMENT OF DEATH —
      // the case W1-T1 exists to fix — is caught above, before the pair is
      // cleared, regardless.
      this.terminationReject?.(new Error(`AcpClient: child terminated (code ${code})`));
      this.terminationReject = undefined;
      this.terminationPromise = undefined;
      for (const handler of [...this.exitHandlers]) {
        try {
          handler(code);
        } catch (err) {
          this.log(`onExit handler threw: ${String(err)}`);
        }
      }
    };
    child.on('exit', (code) => {
      this.log(`hermes acp exited (code ${code})`);
      terminate(code);
    });
    child.on('error', (err) => {
      this.log(`hermes acp spawn error: ${String(err)}`);
      terminate(null);
    });

    if (!child.stdin || !child.stdout) {
      throw new Error('hermes acp: missing stdio pipes');
    }
    // `Writable.toWeb`/`Readable.toWeb` (node:stream, stable since Node 18)
    // type as generic Web Streams; cast to the byte-stream shape `ndJsonStream`
    // declares (Context7: `ndJsonStream(output: WritableStream<Uint8Array>,
    // input: ReadableStream<Uint8Array>): Stream`).
    const output = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);

    const callbacks = this.options.callbacks;
    this.connection = new ClientSideConnection(
      () => ({
        // Audit C-1 fallout: `@agentclientprotocol/sdk@0.17.1`'s `ToolCall`/
        // `ToolCallUpdate` type `rawInput`/`rawOutput` as `unknown` (accurately —
        // any JSON value, not just an object), which is WIDER than our own
        // pinned `AcpToolCallFields.rawInput: Record<string, unknown> | null`.
        // The 0.4.5 SDK typed it narrowly enough that this boundary needed no
        // cast; 0.17.1's more honest typing means the `Client` interface's
        // `sessionUpdate`/`requestPermission` no longer structurally satisfy our
        // narrower local mirror types, so — same "thin seam" pattern this file
        // already uses for `newSession`/`prompt`/`loadSession`'s SDK responses —
        // narrow explicitly at the boundary instead of loosening the local types
        // (which downstream pure mappers like `SessionController.ts` and
        // `contentBlocks.ts` rely on staying `Record<string, unknown> | null`).
        async sessionUpdate(params: { sessionId: string; update: unknown }): Promise<void> {
          callbacks.onSessionUpdate(params.sessionId, params.update as AcpSessionUpdate);
        },
        async requestPermission(params: unknown): Promise<AcpRequestPermissionResponse> {
          return callbacks.onRequestPermission(params as AcpRequestPermissionRequest);
        },
        // dead vs hermes-agent ≤2026.7.7.2 — harness never calls client fs
        // (reads go direct to disk); kept for ACP-spec correctness. See
        // audit-3 CA-16.
        async readTextFile(params: {
          path: string;
          line?: number | null;
          limit?: number | null;
        }): Promise<{ content: string }> {
          const content = await callbacks.onReadTextFile(params.path, params.line, params.limit);
          return { content };
        },
        async writeTextFile(): Promise<never> {
          // Advertised capability is `fs.writeTextFile: false` (spec §"Build") —
          // Hermes owns file mutations itself and should never call this; fail
          // loudly rather than silently accepting an unsanctioned write.
          throw new Error(
            'writeTextFile is not supported by this client (fs.writeTextFile=false): Hermes writes files itself.',
          );
        },
      }),
      stream,
    );
  }

  /** `initialize` advertising the client capabilities pinned by the assignment brief. */
  async initialize(): Promise<void> {
    await this.requireConnection().initialize({
      // `PROTOCOL_VERSION` is exported by the SDK (`schema/index.js:31`) and
      // equals `1`, the same value Hermes' Python SDK carries in
      // `acp/meta.py:29`. The previous hard-coded `1` plus its "no exported
      // constant was confirmed" comment was fabrication-adjacent: the
      // constant exists.
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        // Audit (🟡): we advertised `terminal: true` while registering ZERO
        // terminal handlers. THIS Hermes discards `client_capabilities` and
        // never calls `terminal/*`, so nothing broke — but a future Hermes
        // that believed us would get a hard failure on a capability we told
        // it we had. Advertise what we implement.
        terminal: false,
      },
    });
  }

  /**
   * `mcpServers` defaults to `[]` (no MCP servers) — `AcpBackend` hands in
   * `[...this.mcpServers.values()]`, its insertion-ordered
   * `Map<string, AcpMcpServer>` (stdio `codebase_search` from Zone RAG when
   * active AND the workspace is trusted, http `vscode_lsp` from W3 LIB when
   * bound — see `AcpBackend.start`/`setMcpServer`); ACP does not retain this
   * across calls, so it must be passed on every `session/new`.
   */
  async newSession(cwd: string, mcpServers: AcpMcpServer[] = []): Promise<AcpNewSessionResult> {
    // W1-T1 (CF-01/A-2): raced against child termination — see
    // {@link raceTermination}'s own doc. `ConnectionSupervisor
    // .establishInitialSession`'s `raceAgainstChildExit` around THIS whole
    // call (an independent, pre-existing `onExit`-based race) stays exactly
    // as-is; this is belt-and-braces redundancy for that one caller, and the
    // ONLY protection for every other `newSession` caller (e.g.
    // `OneShotRunner`'s own wall-clock-deadline race around its whole body).
    const response = (await this.raceTermination(() =>
      this.requireConnection().newSession({ cwd, mcpServers }),
    )) as {
      sessionId: string;
      modes?: { currentModeId?: string };
      models?: { currentModelId?: string };
    };
    return {
      sessionId: response.sessionId,
      currentModeId: response.modes?.currentModeId ?? 'default',
      // A7: surface the harness-bound model at session start — kills the
      // generic "Model" placeholder (`webview/src/App.tsx`) until the
      // user's first manual switch.
      currentModelId: response.models?.currentModelId,
    };
  }

  async prompt(sessionId: string, content: AcpOutboundContentBlock[]): Promise<AcpPromptResult> {
    // W1-T1 (CF-01/A-2): raced against child termination. CF-01/A review
    // correction: this is NOT the primary site the task exists for — a
    // child death mid-turn was ALREADY not user-visible before this fix,
    // because `ConnectionSupervisor.handleAcpCrash`'s per-controller
    // `endOnCrash()` fan-out (synchronous, on the SAME crash event) already
    // ends the live turn honestly (`turn.end{status:'error'}`) regardless of
    // whether this `prompt()` await itself ever settles. The genuine
    // net-new benefit here is narrower but real: without this race,
    // `SessionController.runTurn`'s `:961` await (the live turn's own
    // `prompt` call) LEAKS a permanently-unsettled continuation on child
    // death — the awaited promise itself never resolves/rejects, so
    // `runTurn`'s try/catch and everything after that await never run for
    // that invocation, a dangling promise/closure that outlives the turn it
    // belongs to (never user-visible, but a real leak this closes). The
    // LOAD-BEARING new-fix sites — callers with NO crash backstop of their
    // own and no pre-existing manual race — are `listSessions` (below;
    // `SessionsPanelSource.fetchPage` had nothing else un-jamming it, so the
    // Sessions panel fetch genuinely hung forever) and `setSessionModel`
    // (below; its caller's UI rollback could not fire at all without this).
    // `runControlUtterance`'s own wall-clock `Promise.race` and
    // `OneShotRunner`'s body-vs-deadline race, both around OTHER `prompt`
    // call sites, stay exactly as-is — redundant with this, not replaced by
    // it.
    const response = (await this.raceTermination(() =>
      this.requireConnection().prompt({ sessionId, prompt: content }),
    )) as AcpPromptResult;
    return response;
  }

  async cancel(sessionId: string): Promise<void> {
    // W1-T1 (CF-01/A-2): raced against child termination. Every existing
    // caller already treats a `cancel` rejection as fire-and-forget
    // (`void client.cancel(...).catch(err => log(...))`) — this only turns
    // an eternal dangling promise into one that settles honestly and fast.
    await this.raceTermination(() => this.requireConnection().cancel({ sessionId }));
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    // W1-T1 (CF-01/A-2): raced against child termination. Both callers
    // (`SessionController.pinWireModeDefault`'s degrade-on-catch and
    // `runTurn`'s own re-pin, the LATTER sharing `runTurn`'s try/catch with
    // the `prompt` call above) already `await` this inside a `try` — before
    // this fix that `catch` could never fire on child death because the
    // await itself never settled; this is what makes it reachable.
    await this.raceTermination(() => this.requireConnection().setSessionMode({ sessionId, modeId }));
  }

  /**
   * `session/set_model` — a named method on the SDK's client connection since
   * `@agentclientprotocol/sdk@0.17.1` (`dist/acp.js:576-578`:
   * `sendRequest(AGENT_METHODS.session_set_model, params)`), matching the
   * `session_set_model: "session/set_model"` entry in the Python SDK's own
   * `acp/meta.py` that Hermes is pinned to (0.9.0). Hermes' handler is
   * `acp_adapter/server.py:1995 set_session_model`, gated behind
   * `use_unstable_protocol=True` (`acp_adapter/entry.py:262`) — hence the
   * `unstable_` prefix on the SDK method, which names the SPEC's stability,
   * not the call's reliability.
   *
   * Audit C-1: this used to go through `extMethod`, which in
   * `@zed-industries/agent-client-protocol@0.4.5` sent
   * `_session/set_model` — a name Hermes has no dispatcher for
   * (`ext_method` appears zero times in `acp_adapter/`), so every model
   * switch failed with -32601. Locked byte-for-byte by
   * `acpClient.wire.test.ts`, which drives THIS method (not just the SDK)
   * over a mocked child process and asserts the exact frame written to its
   * stdin — `acpWireNames.test.ts` separately locks the SDK's own
   * `unstable_setSessionModel`, but never calls this method, so it alone
   * cannot catch a regression introduced here (Task 5 review finding F-1).
   */
  /**
   * A8 (Tier-2 remediation architecture §12.1, task T-13) — INVESTIGATED,
   * NOT CLOSEABLE at this layer; documented rather than silently dropped.
   * The brief: Hermes answers `set_session_model` for a MISSING session
   * with a JSON-RPC null result, not an error (`acp_adapter/
   * server.py:2026-2036`) — the same "answer unknown-session with None"
   * shape Audit A-3 already found for `session/load`, so callers should
   * treat a null result as a refusal (no optimistic `model.state` confirm).
   *
   * Traced end to end: the installed SDK's OWN wrapper unconditionally
   * coerces that away before we ever see it —
   * `unstable_setSessionModel(params) { return (await
   * this.#connection.sendRequest(...)) ?? {}; }`
   * (`@agentclientprotocol/sdk/dist/acp.js:576-578`) — `#connection` is a
   * true JS private field, unreachable from here. Unlike `session/load`
   * (Audit A-3's fix), there is no surviving discriminator either:
   * `SetSessionModelResponse`'s schema has ZERO required fields (`schema/
   * schema.json:4410-4422` — only an optional `_meta`), so a genuine empty
   * success and a coerced null-refusal both collapse to the exact same
   * `{}` by the time this method's caller could inspect it. (`setSessionMode`
   * has the identical `?? {}` wrapper and an equally field-less response
   * schema, `dist/acp.js:564-566` / `schema.json:4367-4379` — same blocker,
   * not specific to the model RPC.)
   *
   * Closing this for real needs either an upstream SDK fix (stop coercing
   * `null` before the caller can inspect it) or a raw-frame JSON-RPC
   * interception layer bypassing `ClientSideConnection` for this one call —
   * both well beyond a T-13-sized fix, and the latter risks the whole
   * connection's message correlation for a single low-frequency edge case.
   * Flagging this back to the architect rather than shipping a dead
   * `=== null` check that can never fire against the pinned SDK.
   */
  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    // W1-T1 (CF-01/A-2): raced against child termination. The sole caller
    // (`SessionController.setModel`) already attaches an explicit rejection
    // handler (`.then(resolve, reject)`, a seq-guarded UI rollback) — this
    // turns an eternal dangling promise (today: the UI stays optimistically
    // "switching…" forever on a child death mid-request) into an honest,
    // fast failure through that SAME existing handler.
    await this.raceTermination(() => this.requireConnection().unstable_setSessionModel({ sessionId, modelId }));
  }

  /**
   * `session/list` — a named SDK method (`dist/acp.js:512-514`), advertised by
   * Hermes as `SessionListCapabilities()` in its `session_capabilities`
   * (`acp_adapter/server.py:890-894`) and handled at `server.py:1249`.
   * Both params are optional on the wire (server page size 50); omitted
   * rather than sent as `undefined`, so an unfiltered first-page call sends
   * `{}`. Audit C-1: previously routed through `extMethod`, which sent
   * `_session/list` and made the Sessions panel permanently unloadable.
   */
  async listSessions(cwd?: string, cursor?: string): Promise<AcpListSessionsRawResult> {
    const params: Record<string, unknown> = {};
    if (cwd !== undefined) params.cwd = cwd;
    if (cursor !== undefined) params.cursor = cursor;
    // W1-T1 (CF-01/A-2): raced against child termination — the SECOND
    // primary site this task exists for. The sole caller
    // (`SessionsPanelSource.fetchPage`, `host/panels/panelSources.ts`) had NO
    // race of its own before this fix: a child death mid-request hung the
    // Sessions panel's fetch forever (a real hang, not merely an eventual
    // 30s webview-side RPC timeout — that timeout only starts the clock, it
    // never un-jams THIS await). The rejection now propagates through
    // `SessionsPanelSource.fetch`'s un-caught `try/finally` (finally only
    // clears the in-flight coalescing map, it never swallows) to
    // `ControlDispatcher.fetchPanelData`/`invokeControl` (also uncaught by
    // design — the correlated `control.request` path is where errors are
    // meant to be turned into a wire response), and both of ITS callers
    // already handle a rejection honestly:
    // `TalariaViewProvider`'s `switchPanel` branch (`void
    // this.backend.invokeControl(...).catch(err => log(...))`) and its
    // `control.request` branch (`handleControlRequest`'s `try/catch`, which
    // always posts a `control.response{ok:false}` back — the webview's
    // `RpcClient` then rejects the caller's pending promise immediately
    // instead of only via its own 30s timeout fallback).
    return (await this.raceTermination(() =>
      this.requireConnection().listSessions(params as Parameters<ClientSideConnection['listSessions']>[0]),
    )) as AcpListSessionsRawResult;
  }

  /**
   * `session/load` — a real, stable method on the SDK's connection (confirmed
   * present in `schema.d.ts`/`acp.d.ts`: `LoadSessionRequest{cwd, mcpServers,
   * sessionId}` -> `LoadSessionResponse`), unlike `session/list`/
   * `session/set_model`. Per the ACP spec, the agent streams the prior
   * transcript back via `session/update` notifications (routed through the
   * SAME `onSessionUpdate` callback as live streaming — see `AcpBackend`)
   * BEFORE this call resolves; `mcpServers` defaults to `[]` here purely for
   * type-symmetry with `newSession` — `AcpBackend` always passes
   * `[...this.mcpServers.values()]` explicitly (its insertion-ordered
   * `Map<string, AcpMcpServer>`, re-read fresh on every call), per the
   * re-send contract on {@link AcpClientLike.loadSession}'s doc.
   */
  async loadSession(
    cwd: string,
    sessionId: string,
    mcpServers: AcpMcpServer[] = [],
  ): Promise<AcpLoadSessionResult> {
    // W1-T1 (CF-01/A-2): raced against child termination.
    // `ConnectionSupervisor.recoverOneSession`'s crash-recovery caller
    // already races this same call via `raceRecoveryAgainstChildExit`
    // (`onExit`-based, pre-existing) — redundant with this, unchanged.
    // `SessionController.loadReplay`'s History-panel caller (`:1141`) had NO
    // race of its own: its `try/catch` (already correct — emits an honest
    // `error` + terminal `turn.end`) could never fire on a child death
    // mid-load before this fix, for the identical "the await itself never
    // settles" reason `runTurn`'s `prompt` catch couldn't.
    const response = (await this.raceTermination(() =>
      this.requireConnection().loadSession({ cwd, sessionId, mcpServers }),
    )) as {
      modes?: { currentModeId?: string };
      models?: { currentModelId?: string };
    };
    // Audit A-3: `{}` here means Hermes returned `None` for this session id
    // (see AcpLoadSessionResult's doc) — the session is gone, not empty. Do
    // NOT paper over it with a default mode; the caller must be able to tell
    // "loaded an empty conversation" from "this session no longer exists".
    //
    // Task-7 fix-wave (Minor-1): `modes` alone is the discriminator — a
    // `response.models !== undefined` disjunct here would be dead code. A
    // genuine `session/load` response always carries `modes`: the handler's
    // `_session_modes` is typed `-> SessionModeState` (non-Optional) and
    // unconditionally constructed (`acp_adapter/server.py:534-564`,
    // `load_session` itself at `:1172-1176` — read directly against the
    // read-only Hermes checkout, `hermes-agent-2026.7.7.2`). So no real
    // payload can ever carry `models` while omitting `modes`; a `|| models
    // !== undefined` disjunct would be untestable-by-construction against
    // this Hermes, not defensive.
    return response.modes !== undefined
      ? {
          found: true,
          currentModeId: response.modes.currentModeId ?? 'default',
          // A7: same capture as `newSession` — a History-panel load or
          // crash-recovery replay (`SessionController.loadReplay`) restores
          // the harness-bound model too, not just the mode.
          currentModelId: response.models?.currentModelId,
        }
      : { found: false };
  }

  /**
   * `session/close` — best-effort dispose-time cleanup. Named SDK method
   * (`dist/acp.js:546-548`).
   *
   * Fabrication G-15, struck: this was documented as "an open Fedora probe".
   * It is not open — it is ANSWERED by the source. Hermes advertises
   * `session_capabilities` with fork/list/resume and **no `close`**
   * (`acp_adapter/server.py:890-894`), and `acp_adapter/` contains no
   * `close_session` handler. This call is therefore expected to be refused,
   * which is exactly why it stays fire-and-forget: a rejection must never
   * block or throw out of `SessionController.dispose()`.
   */
  async closeSession(sessionId: string): Promise<void> {
    try {
      await this.requireConnection().unstable_closeSession({ sessionId });
    } catch (err) {
      this.log(`session/close failed (best-effort, ignored): ${String(err)}`);
    }
  }

  dispose(): void {
    this.connection = undefined;
    const child = this.child;
    this.child = undefined;
    // AUDIT-5 ARCH-4: settle the W1-T1 termination pair on INTENTIONAL
    // teardown too. terminate()'s identity guard (`this.child !== child`)
    // deliberately suppresses the exitHandlers fan-out when the killed child
    // later exits — but that also suppressed the pair rejection, leaving an
    // in-flight raceTermination()'d RPC (e.g. the Sessions panel's
    // listSessions) dangling until the webview's 30s RPC timeout. Reject it
    // here, same message shape as terminate() with code null. Safe with no
    // racer attached: connect() marked the promise handled (`.catch(() => {})`).
    this.terminationReject?.(new Error('AcpClient: child terminated (code null)'));
    this.terminationReject = undefined;
    this.terminationPromise = undefined;
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5000);
      killTimer.unref?.();
    }
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) throw new Error('AcpClient: not connected (call connect() first)');
    return this.connection;
  }

  private log(message: string): void {
    this.options.logger?.append(`[AcpClient] ${message}`);
  }
}
