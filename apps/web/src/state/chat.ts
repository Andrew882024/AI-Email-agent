import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
} from '../api/chat';
import { deleteMemory, listMemory, updateMemory } from '../api/memory';

export function useChatSessions() {
  return useQuery({ queryKey: ['chat', 'sessions'], queryFn: listChatSessions });
}

export function useChatSession(id: string | undefined) {
  return useQuery({
    queryKey: ['chat', 'session', id],
    queryFn: () => getChatSession(id!),
    enabled: !!id,
  });
}

export function useCreateChatSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createChatSession,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chat', 'sessions'] }),
  });
}

export function useDeleteChatSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteChatSession,
    onSettled: () => void qc.invalidateQueries({ queryKey: ['chat', 'sessions'] }),
  });
}

/** After an assistant turn: it may have changed the conversation, mail, labels and todos. */
export function useRefreshAfterTurn() {
  const qc = useQueryClient();
  return async () => {
    await qc.invalidateQueries({ queryKey: ['chat'] });
    void qc.invalidateQueries({ queryKey: ['threads'] });
    void qc.invalidateQueries({ queryKey: ['labels'] });
    void qc.invalidateQueries({ queryKey: ['todos'] });
  };
}

export function useMemory(enabled: boolean) {
  return useQuery({ queryKey: ['chat', 'memory'], queryFn: listMemory, enabled });
}

export function useUpdateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => updateMemory(id, content),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['chat', 'memory'] }),
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteMemory,
    onSettled: () => void qc.invalidateQueries({ queryKey: ['chat', 'memory'] }),
  });
}
