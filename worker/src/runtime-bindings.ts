export interface KeyValueBinding {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export interface QueueBatchBinding<T> {
  sendBatch(messages: Array<{ body: T }>): Promise<void>;
}
