import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export const workContext = new AsyncLocalStorage<{ judging: boolean; signal: AbortSignal; expiresAt: number; release(): Promise<void> }>();
