import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import type { MemoryCategory, MemoryItem } from '../domain/types.js';
import { generateObject } from '../llm/structured.js';
import type { EmbeddingProvider, LLMProvider } from '../llm/types.js';
import type { ActionLogger } from '../logging/action-logger.js';
import type { Logger } from '../logging/system-logger.js';

const CATEGORIES = ['preference', 'identity', 'relationship', 'rule', 'other'] as const;

/** The judge's rules: what belongs in memory shared by every session, and what doesn't. */
export const MEMORY_RULES = `You maintain the long-term memory of an email assistant about its user. The memory is shared by
all of the user's chat sessions. Decide whether the latest exchange should change it.

Save ONLY:
- stable preferences (language, tone, formatting, how they like things done)
- facts about who the user is (role, school, employer, time zone) and who people are to them
- standing rules for future work ("always cc my manager on invoices", "never archive mail from my advisor")
- anything the user explicitly asks you to remember

Do NOT save:
- one-off questions, tasks or their results; temporary context ("today I'm busy")
- the content of emails, search results, summaries
- guesses the assistant made that the user did not confirm
- secrets (passwords, verification codes, card numbers)

If new information refines or contradicts an existing memory, UPDATE that memory (by id) instead of adding
a duplicate. DELETE a memory when the user says it no longer holds or asks you to forget it.
Write each memory as one short third-person sentence, e.g. "Prefers replies in Chinese."
Most exchanges change nothing: then return an empty list. Rate each change's confidence from 0 to 1.`;

const Decision = z.object({
  operations: z
    .array(
      z.object({
        op: z.enum(['add', 'update', 'delete']),
        id: z.string().nullable().describe('Existing memory id, for update and delete'),
        content: z.string().nullable().describe('The memory sentence, for add and update'),
        category: z.enum(CATEGORIES).nullable().describe('For add'),
        confidence: z.number().min(0).max(1),
        reason: z.string(),
      }),
    )
    .max(5),
});

export interface MemoryChange {
  op: 'add' | 'update' | 'delete';
  item: MemoryItem;
  reason: string;
}

export interface MemoryServiceOptions {
  repos: Repositories;
  llm: LLMProvider;
  embeddings?: EmbeddingProvider;
  actions: ActionLogger;
  logger: Logger;
  /** Changes the judge is less sure about are dropped. */
  minConfidence?: number;
}

/** Account-wide memory: retrieval for prompts, user edits, and the post-turn memory judge. */
export class MemoryService {
  constructor(private readonly options: MemoryServiceOptions) {}

  /** What the assistant should know for this message: everything when small, else the most relevant. */
  async relevant(accountId: string, text: string, limit = 20): Promise<MemoryItem[]> {
    const { repos, embeddings } = this.options;
    const all = await repos.memory.list(accountId);
    if (all.length <= limit || !embeddings || !text.trim()) return all.slice(0, limit);
    try {
      const [vector] = await embeddings.embed([text], 'query');
      return await repos.memory.search(accountId, vector!, limit);
    } catch (err) {
      this.options.logger.warn({ err }, 'memory retrieval failed; using most recent');
      return all.slice(0, limit);
    }
  }

  list(accountId: string): Promise<MemoryItem[]> {
    return this.options.repos.memory.list(accountId);
  }

  /** User edit from the memory screen. */
  async update(accountId: string, id: string, content: string): Promise<MemoryItem | undefined> {
    const existing = await this.options.repos.memory.get(id);
    if (!existing || existing.accountId !== accountId) return undefined;
    const item = await this.options.repos.memory.update(id, {
      content,
      embedding: await this.embed(content),
    });
    await this.options.actions.log({
      accountId,
      actor: 'user',
      action: 'memory.update',
      targetIds: [id],
      params: { content },
      status: 'success',
    });
    return item;
  }

  async remove(accountId: string, id: string): Promise<boolean> {
    const existing = await this.options.repos.memory.get(id);
    if (!existing || existing.accountId !== accountId) return false;
    await this.options.repos.memory.delete(id);
    await this.options.actions.log({
      accountId,
      actor: 'user',
      action: 'memory.delete',
      targetIds: [id],
      params: { content: existing.content },
      status: 'success',
    });
    return true;
  }

  /** The memory judge: after a turn, apply whatever changes the rules call for. */
  async review(
    accountId: string,
    sessionId: string,
    exchange: { user: string; assistant: string },
  ): Promise<MemoryChange[]> {
    const { repos, llm, actions, minConfidence = 0.7 } = this.options;
    const existing = await repos.memory.list(accountId);
    const decision = await generateObject(
      llm,
      {
        system: MEMORY_RULES,
        temperature: 0,
        messages: [
          {
            role: 'user',
            parts: [
              {
                type: 'text',
                text:
                  `Current memories:\n${existing.map((m) => `- [${m.id}] (${m.category}) ${m.content}`).join('\n') || '(none)'}\n\n` +
                  `Latest exchange:\nUSER: ${exchange.user}\nASSISTANT: ${exchange.assistant.slice(0, 4000)}`,
              },
            ],
          },
        ],
      },
      Decision,
    );

    const byId = new Map(existing.map((m) => [m.id, m]));
    const changes: MemoryChange[] = [];
    for (const op of decision.operations) {
      if (op.confidence < minConfidence) continue;
      const actor = `agent:${sessionId}` as const;
      if (op.op === 'add' && op.content?.trim()) {
        const item = await repos.memory.add(accountId, {
          content: op.content.trim(),
          category: (op.category ?? 'other') as MemoryCategory,
          sourceSessionId: sessionId,
          embedding: await this.embed(op.content),
        });
        changes.push({ op: 'add', item, reason: op.reason });
      } else if (op.op === 'update' && op.id && byId.has(op.id) && op.content?.trim()) {
        const item = await repos.memory.update(op.id, {
          content: op.content.trim(),
          embedding: await this.embed(op.content),
        });
        if (item) changes.push({ op: 'update', item, reason: op.reason });
      } else if (op.op === 'delete' && op.id && byId.has(op.id)) {
        await repos.memory.delete(op.id);
        changes.push({ op: 'delete', item: byId.get(op.id)!, reason: op.reason });
      } else {
        continue;
      }
      const change = changes.at(-1)!;
      await actions.log({
        accountId,
        actor,
        action: `memory.${change.op}`,
        targetIds: [change.item.id],
        params: { content: change.item.content, reason: change.reason },
        status: 'success',
      });
    }
    return changes;
  }

  private async embed(text: string): Promise<number[] | undefined> {
    if (!this.options.embeddings) return undefined;
    try {
      const [vector] = await this.options.embeddings.embed([text], 'document');
      return vector;
    } catch (err) {
      this.options.logger.warn({ err }, 'memory embedding failed; stored without one');
      return undefined;
    }
  }
}
