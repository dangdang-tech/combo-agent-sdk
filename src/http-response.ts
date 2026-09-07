export type JsonResponseFailureKind =
  | 'content_type'
  | 'body_read'
  | 'body_too_large'
  | 'body_encoding'
  | 'body_empty'
  | 'body_json';

/** Internal bounded-response failure. It intentionally never retains the original error object. */
export class JsonResponseBodyError extends Error {
  readonly #kind: JsonResponseFailureKind;
  readonly #status: number;

  constructor(kind: JsonResponseFailureKind, status: number, message: string) {
    super(message);
    Object.defineProperty(this, 'name', {
      value: 'JsonResponseBodyError',
      configurable: true,
      enumerable: false,
    });
    this.#kind = kind;
    this.#status = status;
  }

  get kind(): JsonResponseFailureKind {
    return this.#kind;
  }

  get status(): number {
    return this.#status;
  }
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const cancelBody = () => {
    void response.body?.cancel().catch(() => undefined);
  };
  const contentType = response.headers.get('content-type');
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    cancelBody();
    throw new JsonResponseBodyError(
      'content_type',
      response.status,
      'response Content-Type must be application/json',
    );
  }

  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) {
      cancelBody();
      throw new JsonResponseBodyError(
        'body_too_large',
        response.status,
        `response body exceeds ${maximumBytes} bytes`,
      );
    }
  }

  const body = response.body;
  if (!body) {
    throw new JsonResponseBodyError('body_empty', response.status, 'response body is empty');
  }

  const reader = body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const bytes = new Uint8Array(maximumBytes);
  let totalBytes = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        onAbort();
        throw new JsonResponseBodyError('body_read', response.status, 'response read aborted');
      }
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch {
        throw new JsonResponseBodyError(
          'body_read',
          response.status,
          'response body could not be read',
        );
      }
      if (signal?.aborted)
        throw new JsonResponseBodyError('body_read', response.status, 'response read aborted');
      if (result.done) break;
      if (totalBytes + result.value.byteLength > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new JsonResponseBodyError(
          'body_too_large',
          response.status,
          `response body exceeds ${maximumBytes} bytes`,
        );
      }
      bytes.set(result.value, totalBytes);
      totalBytes += result.value.byteLength;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw new JsonResponseBodyError('body_empty', response.status, 'response body is empty');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, totalBytes));
  } catch {
    throw new JsonResponseBodyError(
      'body_encoding',
      response.status,
      'response body is not valid UTF-8',
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JsonResponseBodyError(
      'body_json',
      response.status,
      'response body is not valid JSON',
    );
  }
}
