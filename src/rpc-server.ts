/**
 * Unix-socket RPC server for ai-web-fetcher. Newline-delimited JSON
 * envelopes in, newline-delimited JSON responses out.
 *
 * Wire format:
 *   request line  = JSON object matching either `contracts/web.search.v1.json`
 *                   or `contracts/web.fetch.v1.json` (the `contract_id` field
 *                   selects the schema).
 *   response line = JSON object — either the handler's success payload
 *                   (`{ ok: true, ... }`) or an error envelope
 *                   (`{ ok: false, code, message, trace_id? }`).
 *
 * Per-task budget guard (sub-item 4a):
 *   In-memory `Map<source_ref, { ops, started_at }>` counts ops per upstream
 *   `source_ref` — the contract-spec'd identifier for the caller context
 *   (task UUID, Runs row id, Slack thread ts). The 6th request for the
 *   same source_ref (i.e. ops_count >= WEB_OPS_PER_TASK) returns
 *   `{ ok: false, code: 'budget_exhausted' }`. The counter resets per-
 *   server-lifecycle; production traffic is bounded by the 8000ms timeout
 *   + the daily ceiling enforced elsewhere (sub-item 4b's review timer).
 *
 * Discipline per backlog row 4a (mirrors ai-calendar-adviser/src/rpc-server.ts):
 *   - Socket path is bound at mode 0600 (chmod after listen).
 *   - Stale socket files are cleaned up on listen.
 *   - Each connection is handled independently; per-connection line buffer
 *     bounded to 1 MiB.
 *   - Handler exceptions never crash the process (AP-2) — caught and
 *     surfaced as `internal_error` response envelopes.
 *
 * Authentication: same as calendar-adviser — SO_PEERCRED-based identity is
 * described in the contracts but not enforced at v1. The server runs as its
 * own dedicated uid behind systemd, and the socket's 0600 mode limits
 * writers to that uid + root.
 */

import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { Allowlist } from './lib/allowlist.js';
import type { WebFetcherCache } from './cache.js';
import type { ContractEnvelope, ContractValidator } from './contracts.js';
import type { HttpFetchDeps } from './adapters/http-fetch.js';
import { handleWebSearch } from './handlers/web-search.js';
import { handleWebFetch } from './handlers/web-fetch.js';
import { WEB_OPS_PER_TASK } from './lib/web-config.js';

export interface RpcServerDeps {
  readonly socketPath: string;
  readonly cache: WebFetcherCache;
  readonly allowlist: Allowlist;
  readonly validator: ContractValidator;
  readonly braveApiKey: string;
  readonly fetch: typeof fetch;
  readonly httpFetchDeps: HttpFetchDeps;
  /** Inject for deterministic tests. */
  readonly nowMs?: () => number;
  /** Inject a test logger; production callers omit. */
  readonly logger?: { info(o: object): void; warn(o: object): void; error(o: object): void };
}

const MAX_LINE_BYTES = 1024 * 1024;

function defaultLogger(): NonNullable<RpcServerDeps['logger']> {
  return {
    info: (o) => console.log(JSON.stringify({ level: 'info', service: 'ai-web-fetcher', ...o })),
    warn: (o) => console.warn(JSON.stringify({ level: 'warn', service: 'ai-web-fetcher', ...o })),
    error: (o) => console.error(JSON.stringify({ level: 'error', service: 'ai-web-fetcher', ...o })),
  };
}

export interface RunningRpcServer {
  readonly server: Server;
  close(): Promise<void>;
}

// Per-task budget counter. In-memory per-server-lifecycle; production
// daily caps live in the review timer.
function makeBudgetTable(): {
  consume(sourceRef: string | null): { ok: true } | { ok: false; ops: number };
  state(): ReadonlyMap<string, number>;
} {
  const ops = new Map<string, number>();
  return {
    consume(sourceRef) {
      if (sourceRef === null) return { ok: true };
      const current = ops.get(sourceRef) ?? 0;
      if (current >= WEB_OPS_PER_TASK) {
        return { ok: false, ops: current };
      }
      ops.set(sourceRef, current + 1);
      return { ok: true };
    },
    state() {
      return ops;
    },
  };
}

function sourceRefOf(envelope: ContractEnvelope): string | null {
  return typeof envelope.source_ref === 'string' ? envelope.source_ref : null;
}

export function createRpcServer(deps: RpcServerDeps): Server {
  const logger = deps.logger ?? defaultLogger();
  const budget = makeBudgetTable();

  return createServer((socket: Socket) => {
    let buffer = '';
    let droppedOversize = false;

    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      if (droppedOversize) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        droppedOversize = true;
        logger.warn({ phase: 'rpc', msg: 'oversize_line_dropped' });
        try {
          socket.end(
            JSON.stringify({ ok: false, code: 'bad_query', message: 'request line exceeds 1 MiB' }) + '\n',
          );
        } catch {
          // socket already closed
        }
        return;
      }
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length > 0) {
          void dispatchLine(line, socket, deps, logger, budget);
        }
        nl = buffer.indexOf('\n');
      }
    });

    socket.on('error', (err) => {
      logger.warn({ phase: 'rpc', msg: 'socket_error', error: err.message });
    });
  });
}

async function dispatchLine(
  line: string,
  socket: Socket,
  deps: RpcServerDeps,
  logger: NonNullable<RpcServerDeps['logger']>,
  budget: ReturnType<typeof makeBudgetTable>,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    writeResponse(socket, {
      ok: false,
      code: 'bad_query',
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const result = deps.validator.validate(parsed);
  if (!result.ok) {
    writeResponse(socket, {
      ok: false,
      code: 'validation_failed',
      message: result.errors,
    });
    return;
  }
  const envelope = result.value;

  // Per-task budget check — pre-handler so a runaway loop is bounded before
  // any expensive work. `source_ref` is the contract-spec'd identifier
  // (task UUID / Runs row id / Slack thread ts) — every contract requires
  // it, so this gate fires for every envelope.
  const sourceRef = sourceRefOf(envelope);
  const budgetResult = budget.consume(sourceRef);
  if (!budgetResult.ok) {
    logger.warn({
      phase: 'rpc',
      msg: 'budget_exhausted',
      contract_id: envelope.contract_id,
      source_ref: sourceRef,
      ops: budgetResult.ops,
    });
    writeResponse(socket, {
      ok: false,
      code: 'budget_exhausted',
      message: `source_ref ${sourceRef} exceeded WEB_OPS_PER_TASK (${WEB_OPS_PER_TASK})`,
      trace_id: envelope.trace_id,
    });
    return;
  }

  try {
    let response: object;
    if (envelope.contract_id === 'web.search.v1') {
      response = await handleWebSearch(envelope, {
        cache: deps.cache,
        allowlist: deps.allowlist,
        fetch: deps.fetch,
        braveApiKey: deps.braveApiKey,
        nowMs: deps.nowMs,
      });
    } else if (envelope.contract_id === 'web.fetch.v1') {
      response = await handleWebFetch(envelope, {
        cache: deps.cache,
        allowlist: deps.allowlist,
        pipelineDeps: { httpFetchDeps: deps.httpFetchDeps, nowMs: deps.nowMs },
      });
    } else {
      response = {
        ok: false,
        code: 'bad_query',
        message: `unsupported contract_id: ${envelope.contract_id}`,
        trace_id: envelope.trace_id,
      };
    }
    writeResponse(socket, response);
  } catch (err) {
    // AP-2: handler exception → typed error envelope, NEVER crash the process.
    logger.error({
      phase: 'rpc',
      msg: 'handler_exception',
      contract_id: envelope.contract_id,
      trace_id: envelope.trace_id,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    writeResponse(socket, {
      ok: false,
      code: 'handler_error',
      message: 'handler exception (logged)',
      trace_id: envelope.trace_id,
    });
  }
}

function writeResponse(socket: Socket, payload: object): void {
  try {
    socket.write(JSON.stringify(payload) + '\n');
  } catch {
    // Caller likely disconnected mid-write; nothing we can do.
  }
}

export function startRpcServer(deps: RpcServerDeps): Promise<RunningRpcServer> {
  const logger = deps.logger ?? defaultLogger();
  const server = createRpcServer(deps);

  return new Promise((resolve, reject) => {
    if (existsSync(deps.socketPath)) {
      try {
        unlinkSync(deps.socketPath);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(deps.socketPath, () => {
      try {
        chmodSync(deps.socketPath, 0o600);
      } catch (err) {
        logger.warn({
          phase: 'rpc',
          msg: 'chmod_failed',
          path: deps.socketPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      logger.info({
        phase: 'rpc',
        msg: 'listening',
        socket_path: deps.socketPath,
      });
      resolve({
        server,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              if (existsSync(deps.socketPath)) {
                try {
                  unlinkSync(deps.socketPath);
                } catch {
                  // Best-effort.
                }
              }
              res();
            });
          }),
      });
    });
  });
}
