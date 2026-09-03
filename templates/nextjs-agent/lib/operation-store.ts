import { createHash, randomUUID } from 'node:crypto';
import type { ChatMessage } from 'combo-agent-sdk';

export type OperationStatus = 'ready' | 'waiting_for_payment' | 'completed';

export interface OperationRecord {
  operationId: string;
  userId: string;
  /** 一次收费调用的稳定编号。重试和支付后继续都必须复用。 */
  callId: string;
  requestDigest: string;
  messages: ChatMessage[];
  status: OperationStatus;
  paymentRequestId?: string;
  result?: unknown;
  updatedAt: string;
}

export interface NewOperation {
  operationId: string;
  userId: string;
  messages: ChatMessage[];
}

/**
 * 业务持久化边界。生产 Agent 应用自己的数据库实现它，并为 runExclusive 提供跨实例锁。
 * Payment SDK 不实现、持有或读取这份数据。
 */
export interface OperationStore {
  runExclusive<T>(userId: string, operationId: string, work: () => Promise<T>): Promise<T>;
  get(userId: string, operationId: string): Promise<OperationRecord | null>;
  getOrCreate(input: NewOperation): Promise<OperationRecord>;
  save(record: OperationRecord): Promise<void>;
}

export class OperationConflictError extends Error {
  constructor() {
    super('operationId is already bound to different business input');
    this.name = 'OperationConflictError';
  }
}

/** 仅让模板开箱运行；进程重启会清空，不能直接用于生产。 */
class MemoryOperationStore implements OperationStore {
  private readonly records = new Map<string, OperationRecord>();
  private readonly locks = new Map<string, Promise<void>>();

  async runExclusive<T>(
    userId: string,
    operationId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const key = recordKey(userId, operationId);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async get(userId: string, operationId: string): Promise<OperationRecord | null> {
    const record = this.records.get(recordKey(userId, operationId));
    return record ? structuredClone(record) : null;
  }

  async getOrCreate(input: NewOperation): Promise<OperationRecord> {
    const key = recordKey(input.userId, input.operationId);
    const requestDigest = digestMessages(input.messages);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new OperationConflictError();
      return structuredClone(existing);
    }
    const record: OperationRecord = {
      operationId: input.operationId,
      userId: input.userId,
      callId: randomUUID(),
      requestDigest,
      messages: structuredClone(input.messages),
      status: 'ready',
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key, structuredClone(record));
    return record;
  }

  async save(record: OperationRecord): Promise<void> {
    this.records.set(
      recordKey(record.userId, record.operationId),
      structuredClone({ ...record, updatedAt: new Date().toISOString() }),
    );
  }
}

function recordKey(userId: string, operationId: string): string {
  return JSON.stringify([userId, operationId]);
}

function digestMessages(messages: ChatMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

const shared = globalThis as typeof globalThis & {
  comboReferenceOperationStore?: OperationStore;
};

export const operationStore =
  shared.comboReferenceOperationStore ?? (shared.comboReferenceOperationStore = new MemoryOperationStore());
