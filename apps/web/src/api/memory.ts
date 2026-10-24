import { z } from 'zod';
import { IsoDate, Ok, request } from './client';

export const MemoryItem = z.object({
  id: z.string(),
  content: z.string(),
  category: z.string(),
  updatedAt: IsoDate,
});
export type MemoryItem = z.output<typeof MemoryItem>;

export const listMemory = () => request(z.array(MemoryItem), '/api/memory');

export const updateMemory = (id: string, content: string) =>
  request(MemoryItem, `/api/memory/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { content },
  });

export const deleteMemory = (id: string) =>
  request(Ok, `/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
