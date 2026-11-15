/** Printers without a cutter: `all` joins back-to-back jobs with tear lines and feeds once idle; */
/** `parts` prints the first job of a burst and queues the rest until the operator asks for each. */

export type NoCutterMode = 'all' | 'parts';
export type PrintPartKind = 'kot' | 'bill' | 'other';

export interface PrintPartLabel {
  readonly kind: PrintPartKind;
  readonly station?: string;
}

export interface PrintPartsState {
  readonly printed: number;
  readonly total: number;
  readonly pending: ReadonlyArray<PrintPartLabel & { readonly id: number }>;
}

export interface NoCutterSendResult {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface NoCutterJob {
  readonly printer: { readonly id?: unknown; readonly name?: unknown };
  readonly data: Buffer;
  readonly label: PrintPartLabel;
  readonly mode: NoCutterMode;
  /** Tear line bytes for this printer's width and language. */
  readonly tearLine: Buffer;
  /** Feed bytes sent after the last part so it clears the tear bar. */
  readonly tailFeed: Buffer;
}

export type NoCutterSend<R extends NoCutterSendResult> = (
  printer: NoCutterJob['printer'],
  data: Buffer,
) => Promise<R>;

export const JOIN_WINDOW_MS = 3_000;
export const PARTS_WINDOW_MS = 8_000;

interface QueuedPart<R extends NoCutterSendResult> {
  readonly id: number;
  readonly job: NoCutterJob;
  readonly send: NoCutterSend<R>;
}

const chains = new Map<string, Promise<unknown>>();
const pendingFeeds = new Map<string, ReturnType<typeof setTimeout>>();
const queue: Array<QueuedPart<NoCutterSendResult>> = [];
let nextPartId = 1;
let printed = 0;
let total = 0;
let sequenceOpen = false;
let lastActivity = 0;

function printerKey(printer: NoCutterJob['printer']): string {
  return String(printer?.id ?? printer?.name ?? '');
}

/** Runs one printer's sends in order, so a joined job never overtakes the one before it. */
function onPrinter<T>(printer: NoCutterJob['printer'], task: () => Promise<T>): Promise<T> {
  const key = printerKey(printer);
  const run = (chains.get(key) ?? Promise.resolve()).then(task, task);
  chains.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

function scheduleTailFeed<R extends NoCutterSendResult>(job: NoCutterJob, send: NoCutterSend<R>) {
  const key = printerKey(job.printer);
  const timer = setTimeout(() => {
    pendingFeeds.delete(key);
    void onPrinter(job.printer, () => send(job.printer, job.tailFeed)).catch(() => undefined);
  }, JOIN_WINDOW_MS);
  timer.unref?.();
  pendingFeeds.set(key, timer);
}

function sendJoined<R extends NoCutterSendResult>(job: NoCutterJob, send: NoCutterSend<R>): Promise<R> {
  return onPrinter(job.printer, async () => {
    const key = printerKey(job.printer);
    const pendingFeed = pendingFeeds.get(key);
    if (pendingFeed) {
      clearTimeout(pendingFeed);
      pendingFeeds.delete(key);
    }
    const result = await send(
      job.printer,
      pendingFeed ? Buffer.concat([job.tearLine, job.data]) : job.data,
    );
    if (result.ok) scheduleTailFeed(job, send);
    else if (pendingFeed) void send(job.printer, job.tailFeed).catch(() => undefined);
    return result;
  });
}

function sendPart<R extends NoCutterSendResult>(job: NoCutterJob, send: NoCutterSend<R>): Promise<R> {
  return onPrinter(job.printer, () =>
    send(job.printer, Buffer.concat([job.data, job.tailFeed])),
  );
}

/** Prints, joins, or queues one job for a printer without a cutter. */
export async function routeNoCutterJob<R extends NoCutterSendResult>(
  job: NoCutterJob,
  send: NoCutterSend<R>,
): Promise<R | (NoCutterSendResult & { queued: true })> {
  if (job.mode === 'all') return sendJoined(job, send);
  const now = Date.now();
  if (sequenceOpen && (queue.length > 0 || now - lastActivity < PARTS_WINDOW_MS)) {
    queue.push({ id: nextPartId++, job, send });
    total += 1;
    lastActivity = now;
    return { ok: true, queued: true };
  }
  const result = await sendPart(job, send);
  sequenceOpen = result.ok;
  printed = result.ok ? 1 : 0;
  total = result.ok ? 1 : 0;
  lastActivity = Date.now();
  return result;
}

export function printPartsState(): PrintPartsState {
  return {
    printed,
    total,
    pending: queue.map((part) => ({ id: part.id, ...part.job.label })),
  };
}

/** Prints the oldest waiting part; it stays queued when the printer fails. */
export async function printNextPart(): Promise<{
  result: NoCutterSendResult | null;
  state: PrintPartsState;
}> {
  const part = queue[0];
  if (!part) {
    sequenceOpen = false;
    return { result: null, state: printPartsState() };
  }
  const result = await sendPart(part.job, part.send);
  if (result.ok && queue[0] === part) {
    queue.shift();
    printed += 1;
    lastActivity = Date.now();
    if (queue.length === 0) sequenceOpen = false;
  }
  return { result, state: printPartsState() };
}

export function discardPrintParts(): PrintPartsState {
  queue.length = 0;
  sequenceOpen = false;
  printed = 0;
  total = 0;
  return printPartsState();
}

/** Test seam: forget queued parts and pending feeds. */
export function resetNoCutterJobs(): void {
  for (const timer of pendingFeeds.values()) clearTimeout(timer);
  pendingFeeds.clear();
  chains.clear();
  discardPrintParts();
  lastActivity = 0;
}
