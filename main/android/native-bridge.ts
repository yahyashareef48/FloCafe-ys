/**
 * Newline-delimited JSON channel to the Android shell over an abstract Unix
 * socket. The shell accepts only this app's UID and the per-launch token.
 */
import * as net from 'net';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type RequestHandler = (params: unknown) => unknown | Promise<unknown>;

const CALL_TIMEOUT_MS = 120_000;

let socket: net.Socket | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const handlers = new Map<string, RequestHandler>();

function send(message: Record<string, unknown>): void {
  if (!socket || socket.destroyed) throw new Error('Android bridge is not connected');
  socket.write(`${JSON.stringify(message)}\n`);
}

async function handleRequest(id: unknown, method: string, params: unknown): Promise<void> {
  const handler = handlers.get(method);
  try {
    if (!handler) throw new Error(`Unknown bridge method ${method}`);
    send({ id, result: (await handler(params)) ?? null });
  } catch (error) {
    send({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

function onLine(line: string): void {
  if (!line.trim()) return;
  let message: {
    id?: unknown;
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.method === 'string') {
    void handleRequest(message.id, message.method, message.params);
    return;
  }
  const entry = typeof message.id === 'number' ? pending.get(message.id) : undefined;
  if (!entry) return;
  pending.delete(message.id as number);
  if (message.error !== undefined && message.error !== null)
    entry.reject(new Error(String(message.error)));
  else entry.resolve(message.result);
}

export function connectNativeBridge(abstractName: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: `\0${abstractName}` });
    let buffered = '';
    client.setEncoding('utf8');
    client.once('error', reject);
    client.on('connect', () => {
      socket = client;
      client.write(`${JSON.stringify({ type: 'hello', token })}\n`);
      resolve();
    });
    client.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        onLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    });
    client.on('close', () => {
      socket = null;
      for (const entry of pending.values()) entry.reject(new Error('Android bridge closed'));
      pending.clear();
    });
  });
}

export function onNativeRequest(method: string, handler: RequestHandler): void {
  handlers.set(method, handler);
}

export function notifyNative(event: string, data: unknown): void {
  send({ type: 'event', event, data });
}

/** Calls the shell; `timeoutMs: 0` waits indefinitely, for calls that wait on the operator. */
export function callNative<T = unknown>(
  method: string,
  params: unknown,
  { timeoutMs = CALL_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Android bridge call ${method} timed out`));
          }, timeoutMs)
        : undefined;
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value as T);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    try {
      send({ id, method, params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error as Error);
    }
  });
}
