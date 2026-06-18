// Generic bidirectional IPC transport for ShojiWM.
//
// The TS configuration runtime is a long-lived Node.js process, so it can host
// a Unix-domain socket that external clients (a bar, a launcher, ...) connect
// to. The wire format is newline-delimited JSON:
//
//   client -> server   { "id"?: number, "method": string, "params"?: unknown }
//   server -> client   { "id": number, "result": unknown }          (response)
//                      { "id": number, "error": string }            (error)
//                      { "event": string, "payload": unknown }      (broadcast)
//
// A request with an `id` receives exactly one matching response; requests
// without an `id` are fire-and-forget commands. `broadcast` pushes an event to
// every connected client and is how reactive state (e.g. the active workspace)
// is propagated.
//
// This module is intentionally feature-agnostic: workspace/window specifics are
// wired up by the configuration package on top of this transport.
//
// The reference below pulls the minimal node:net/node:fs ambient declarations
// (the monorepo has no @types/node) into every program that imports this file.
/// <reference path="./node-compat.d.ts" />

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

// SHOJI_RUNTIME_WAKE_PID: PID of the parent Rust compositor process. After an
// IPC handler mutates state, we send `SIGUSR1` to that PID so the compositor's
// signalfd source picks up the wake and runs an immediate scheduler tick.
// Signal-based wakes are used (instead of an inherited fd) because `tsx`
// internally re-spawns `node` and does not propagate arbitrary inherited fds,
// so any pipe/socketpair end becomes unusable in the child runtime.
const wakePid: number | null = (() => {
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ?? {};
  const raw = env.SHOJI_RUNTIME_WAKE_PID;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

const procRef = globalThis as {
  process?: {
    kill?: (pid: number, signal: string) => boolean;
  };
};

export function wakeRust(): void {
  if (wakePid === null) return;
  const kill = procRef.process?.kill;
  if (!kill) return;
  try {
    kill(wakePid, "SIGUSR1");
  } catch {
    // The compositor process has gone away; nothing to wake.
  }
}

/**
 * Handle to a single connected IPC client. Passed to every `IpcHandler` so
 * the handler can push unsolicited events back to the caller.
 * 接続中の単一 IPC クライアントへのハンドル。`IpcHandler` に渡されるため、
 * ハンドラーから呼び出し元へ非同期イベントを送信できます。
 */
export interface IpcClient {
  /**
   * Send an unsolicited event to this single client only (not a broadcast).
   * このクライアントのみに非同期イベントを送信します（ブロードキャストではありません）。
   */
  send(event: string, payload: unknown): void;
}

/**
 * A method handler registered via `IpcServer.handle`. Receives the decoded
 * `params` from the request and the calling `client` handle. May return a
 * value (sent back as the response `result`) or throw (sent back as `error`).
 * `IpcServer.handle` で登録するメソッドハンドラー。リクエストのデコード済み `params` と
 * 呼び出し元 `client` ハンドルを受け取ります。値を返すと `result` として、
 * throw すると `error` としてレスポンスが送られます。
 */
export type IpcHandler = (
  params: unknown,
  client: IpcClient,
) => unknown | Promise<unknown>;

/** Wire-format of an incoming IPC request message. / 受信 IPC リクエストメッセージのワイヤーフォーマット。 */
export interface IpcRequestMessage {
  /** If present, the server sends a matching response (`id`, `result`/`error`). / 存在する場合、サーバーは対応するレスポンスを送ります。 */
  id?: number;
  /** Method name to dispatch. / ディスパッチするメソッド名。 */
  method: string;
  /** Arbitrary JSON-serializable params forwarded to the handler. / ハンドラーに転送される任意の JSON シリアライズ可能なパラメーター。 */
  params?: unknown;
}

/**
 * A running Unix-domain-socket IPC server. Methods map to wire-protocol
 * operations described in the module header.
 * 実行中の Unix ドメインソケット IPC サーバー。各メソッドはモジュールヘッダーで
 * 説明されているワイヤープロトコル操作に対応します。
 */
export interface IpcServer {
  /**
   * Register a handler for a named request/command method. Calling `handle`
   * with the same method name again overwrites the previous handler.
   * 名前付きリクエスト/コマンドメソッドのハンドラーを登録します。同じメソッド名で
   * 再度呼ぶと前のハンドラーを上書きします。
   */
  handle(method: string, handler: IpcHandler): void;
  /**
   * Push an event to every currently connected client.
   * 現在接続中のすべてのクライアントにイベントをプッシュします。
   */
  broadcast(event: string, payload: unknown): void;
  /** Number of currently connected clients. / 現在接続中のクライアント数。 */
  clientCount(): number;
  /**
   * Stop listening and destroy all client connections. Call this inside
   * `COMPOSITOR.onDisable` so the socket is cleaned up on config reload.
   * リスニングを停止し、すべてのクライアント接続を破棄します。設定リロード時に
   * ソケットがクリーンアップされるよう `COMPOSITOR.onDisable` 内で呼び出します。
   */
  close(): void;
}

/**
 * Default socket path, namespaced by the Wayland display so multiple ShojiWM
 * instances do not collide. External clients should derive the same path.
 * Wayland ディスプレイでネームスペース化されたデフォルトのソケットパス。
 * 複数の ShojiWM インスタンスが衝突しないよう設計されています。
 * 外部クライアントも同じパスを使用します。
 */
export function defaultSocketPath(): string {
  const env =
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ?? {};
  const runtimeDir = env.XDG_RUNTIME_DIR ?? "/tmp";
  const display = env.WAYLAND_DISPLAY ?? "wayland-0";
  return `${runtimeDir}/shojiwm-${display}.sock`;
}

/**
 * Create a Unix-domain-socket IPC server that external processes (a status
 * bar, a launcher, a keybinding daemon, …) can connect to over the wire
 * protocol described in this module.
 *
 * The wire format is newline-delimited JSON:
 * - **request** (client → server): `{ "id"?: number, "method": string, "params"?: unknown }`
 * - **response** (server → client): `{ "id": number, "result": unknown }` or `{ "id": number, "error": string }`
 * - **broadcast** (server → all clients): `{ "event": string, "payload": unknown }`
 *
 * Requests that include an `id` get exactly one matching response. Requests
 * without `id` are fire-and-forget. After each handler runs, the compositor
 * runtime is woken via `SIGUSR1` so reactive state changes are applied
 * immediately rather than waiting for the next idle tick.
 *
 * Unix ドメインソケット IPC サーバーを作成します。外部プロセス（ステータスバー・
 * ランチャー・キーバインドデーモンなど）がこのモジュールで定義されたワイヤープロトコル
 * 経由で接続できます。ソケットパスを省略すると `defaultSocketPath()` が使われます。
 * ハンドラー実行後はコンポジターランタイムが `SIGUSR1` で起こされ、リアクティブな
 * 状態変化が次のアイドルティックを待たずに即時反映されます。
 *
 * @param socketPath Unix socket path. Defaults to `defaultSocketPath()`.
 *
 * @example Workspace IPC server / ワークスペース IPC サーバー
 * ```ts
 * // config/index.tsx
 * import { createIpcServer } from "shoji_wm/ipc";
 *
 * const ipc = createIpcServer(); // uses defaultSocketPath()
 *
 * ipc.handle("workspace/switch", (params) => {
 *   const { name } = params as { name: string };
 *   HYBRID_WINDOW_MANAGER.switchWorkspace(name);
 * });
 *
 * ipc.handle("workspace/list", () =>
 *   HYBRID_WINDOW_MANAGER.workspaces.map((ws) => ws.name),
 * );
 *
 * // Broadcast active workspace whenever it changes
 * effect(() => {
 *   ipc.broadcast("workspace/active", HYBRID_WINDOW_MANAGER.activeWorkspace.value);
 * });
 *
 * COMPOSITOR.onDisable = () => ipc.close();
 * ```
 *
 * @example Targeted response vs broadcast / 単一クライアントへの応答とブロードキャスト
 * ```ts
 * ipc.handle("ping", (_params, client) => {
 *   // Respond only to the requesting client
 *   return "pong";
 * });
 *
 * // Push to all connected clients (e.g. from an event handler)
 * COMPOSITOR.event.onFocus((window) => {
 *   ipc.broadcast("window/focused", { id: window.id, title: window.title.peek() });
 * });
 * ```
 */
export function createIpcServer(
  socketPath: string = defaultSocketPath(),
): IpcServer {
  // Clear a stale socket left behind by a previous run so `listen` succeeds.
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // best effort
    }
  }

  const handlers = new Map<string, IpcHandler>();
  const sockets = new Set<Socket>();

  const writeFrame = (socket: Socket, message: unknown): void => {
    try {
      socket.write(`${JSON.stringify(message)}\n`);
    } catch {
      sockets.delete(socket);
    }
  };

  const dispatch = async (socket: Socket, line: string): Promise<void> => {
    let request: IpcRequestMessage;
    try {
      request = JSON.parse(line) as IpcRequestMessage;
    } catch {
      return;
    }

    const handler = handlers.get(request.method);
    const client: IpcClient = {
      send: (event, payload) => writeFrame(socket, { event, payload }),
    };

    if (!handler) {
      if (request.id != null) {
        writeFrame(socket, {
          id: request.id,
          error: `unknown method: ${request.method}`,
        });
      }
      return;
    }

    try {
      const result = await handler(request.params, client);
      if (request.id != null) {
        writeFrame(socket, { id: request.id, result });
      }
    } catch (error) {
      if (request.id != null) {
        writeFrame(socket, { id: request.id, error: String(error) });
      }
    } finally {
      // Most handlers mutate config-side state (HYBRID_WINDOW_MANAGER, etc.)
      // that the compositor only picks up on the next scheduler tick. Wake the
      // Rust side so the change is visible without the 250 ms idle delay.
      wakeRust();
    }
  };

  const server: Server = createServer((socket) => {
    socket.setEncoding("utf8");
    sockets.add(socket);

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (line.length > 0) {
          void dispatch(socket, line);
        }
      }
    });
    socket.on("error", () => sockets.delete(socket));
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("error", (error) => {
    console.error("[shoji-ipc] server error:", String(error));
  });
  server.listen(socketPath);

  return {
    handle(method, handler) {
      handlers.set(method, handler);
    },
    broadcast(event, payload) {
      const frame = `${JSON.stringify({ event, payload })}\n`;
      for (const socket of [...sockets]) {
        try {
          socket.write(frame);
        } catch {
          sockets.delete(socket);
        }
      }
    },
    clientCount() {
      return sockets.size;
    },
    close() {
      for (const socket of [...sockets]) {
        try {
          socket.destroy();
        } catch {
          // best effort
        }
      }
      sockets.clear();
      server.close();
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          // best effort
        }
      }
    },
  };
}
