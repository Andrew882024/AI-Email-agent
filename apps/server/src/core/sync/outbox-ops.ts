/** Payload of each outbox op type: a local change waiting to be pushed to Google. */
export interface OutboxPayloads {
  modify_labels: { messageIds: string[]; add: string[]; remove: string[] };
  /** `raw` is the complete RFC 5322 message. */
  send_message: { raw: string; threadId?: string };
  create_task: { todoId: string; title: string; notes?: string; due?: string };
  delete_task: { googleTaskId: string; tasklistId: string };
}

export type OutboxOpName = keyof OutboxPayloads;
