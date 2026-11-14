import { z } from 'zod';
import { request } from './client';

/** The conversation an email belongs to (Gmail ids). */
export const getMessageThreadId = async (messageId: string) =>
  (
    await request(
      z.object({ threadId: z.string() }),
      `/api/messages/${encodeURIComponent(messageId)}`,
    )
  ).threadId;
