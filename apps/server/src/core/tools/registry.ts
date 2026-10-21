import { z } from 'zod';
import { ReauthRequiredError } from '../auth/errors.js';
import type { Actor } from '../domain/types.js';
import type { ActionLogger } from '../logging/action-logger.js';
import { NotFoundError } from '../sync/mailbox.js';

/** read: no side effects. write: changes the mailbox. outbound: sends something to other people. */
export type SideEffect = 'read' | 'write' | 'outbound';

export interface ToolContext {
  accountId: string;
  actor: Actor;
}

export interface Tool<S extends z.ZodType = z.ZodType, O = unknown> {
  /** snake_case; also the action name in the action log. */
  name: string;
  /** Written for an LLM deciding when and how to call it. */
  description: string;
  input: S;
  sideEffect: SideEffect;
  /** Ids the call acts on, for the action log. */
  targets?: (input: z.output<S>) => string[];
  /** What the action log records as params (default: the whole input). Use to drop bodies/files. */
  logParams?: (input: z.output<S>) => unknown;
  /** 'always': an assistant must get the user's approval before every call. */
  approval?: 'always';
  /** How an approval request reads ("apply workflow X to 12 emails"). */
  approvalText?: (ctx: ToolContext, input: z.output<S>) => Promise<string>;
  handler: (ctx: ToolContext, input: z.output<S>) => Promise<O>;
}

/** Identity helper that keeps the input type flowing into handler/targets/logParams. */
export function defineTool<S extends z.ZodType, O>(tool: Tool<S, O>): Tool<S, O> {
  return tool;
}

export type ToolErrorCode =
  'unknown_tool' | 'invalid_input' | 'not_found' | 'reauth_required' | 'internal';

export class ToolError extends Error {
  override name = 'ToolError';
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ToolInfo {
  name: string;
  description: string;
  sideEffect: SideEffect;
  approval?: 'always';
  /** JSON Schema of the input (usable as an LLM function declaration). */
  inputSchema: unknown;
}

function normalize(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof NotFoundError) return new ToolError('not_found', err.message);
  if (err instanceof ReauthRequiredError) return new ToolError('reauth_required', err.message);
  return new ToolError('internal', err instanceof Error ? err.message : String(err), err);
}

// Tools have different input types; the registry only handles them uniformly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<z.ZodType, any>;

/**
 * The one entry point for mailbox operations, shared by the UI (via HTTP), the agent and
 * workflows. Validates input, normalizes errors, and records every write/outbound call in the
 * action log with its actor, targets, params, outcome and duration.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  constructor(private readonly actions: ActionLogger) {}

  register(...tools: AnyTool[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Tool ${tool.name} is already registered`);
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  describe(): ToolInfo[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      sideEffect: t.sideEffect,
      ...(t.approval && { approval: t.approval }),
      inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
    }));
  }

  /** The tool's own wording for an approval request, if it has one and the input is valid. */
  async approvalText(
    name: string,
    ctx: ToolContext,
    rawInput: unknown,
  ): Promise<string | undefined> {
    const tool = this.tools.get(name);
    if (!tool?.approvalText) return undefined;
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) return undefined;
    return tool.approvalText(ctx, parsed.data).catch(() => undefined);
  }

  async invoke(name: string, ctx: ToolContext, rawInput: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError('unknown_tool', `Unknown tool "${name}"`);
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new ToolError('invalid_input', z.prettifyError(parsed.error), parsed.error.issues);
    }
    const input = parsed.data;
    const run = () =>
      tool.handler(ctx, input).catch((err: unknown) => {
        throw normalize(err);
      });
    if (tool.sideEffect === 'read') return run();
    return this.actions.track(
      {
        accountId: ctx.accountId,
        actor: ctx.actor,
        action: tool.name,
        targetIds: tool.targets?.(input) ?? [],
        params: tool.logParams ? tool.logParams(input) : input,
      },
      run,
    );
  }
}
