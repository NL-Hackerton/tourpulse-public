"use client";

import { z } from "zod";
import { planEventSchema, type PlanEvent } from "./contracts";

export class ClientError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function requestJson<T>(url: string, schema: z.ZodType<T>, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  let body: unknown;
  try { body = await response.json(); } catch { throw new ClientError(`Request failed (${response.status}). Try again.`, response.status); }
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new ClientError(error.success ? error.data.error : `Request failed (${response.status}).`, response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ClientError("The server returned an unsupported result. No incomplete data was applied.", 502);
  return parsed.data;
}

export async function streamRun(url: string, body: unknown, signal: AbortSignal, onEvent: (event: PlanEvent) => void): Promise<void> {
  const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    const error = z.object({ error: z.string() }).safeParse(value);
    throw new ClientError(error.success ? error.data.error : `Planning request failed (${response.status}).`, response.status);
  }
  if (!response.body) throw new ClientError("The planning connection did not open. Reconnect to check the saved run.", 502);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "", terminal = false;
  const consume = (line: string) => {
    if (!line.trim() || signal.aborted) return;
    const raw: unknown = JSON.parse(line);
    const event = planEventSchema.parse(raw);
    if (event.type === "result" || event.type === "error") terminal = true;
    onEvent(event);
  };
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      pending += decoder.decode(part.value, { stream: true });
      if (pending.length > 4_000_000) throw new ClientError("The planning response exceeded the supported size.", 502);
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      lines.forEach(consume);
    }
    consume(pending + decoder.decode());
    if (!terminal && !signal.aborted) throw new ClientError("Connection interrupted. Reconnect to inspect the saved run before retrying.", 502);
  } finally { reader.releaseLock(); }
}

export function downloadText(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
