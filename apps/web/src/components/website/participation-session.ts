"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

export interface Feature {
  id: string;
  title: string;
}
export interface VoteFeature extends Feature {
  eligible: boolean;
}
const featureID = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);
export const votesSchema = z.object({
  counts: z.record(
    featureID,
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ),
  votedFeatureIds: z.array(featureID).max(1000),
});
export const feedbackSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["bug", "idea", "feature"]),
  featureId: featureID.nullable(),
  title: z.string().min(3).max(160),
  body: z.string().min(10).max(4000),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const feedbackPageSchema = z.object({
  feedback: z.array(feedbackSchema).max(50),
  nextCursor: z.string().max(512).nullable(),
});
export type Feedback = z.infer<typeof feedbackSchema>;
export type VoteSnapshot = z.infer<typeof votesSchema>;
export type Phase = "loading" | "ready" | "guest" | "error";
export interface Ticket {
  owner: string | null;
  signal: AbortSignal;
  current: () => boolean;
  check: () => void;
  close: () => void;
  abort: () => void;
}
class RequestFailure extends Error {
  constructor(readonly status: number) {
    super("Product request failed");
  }
}
const aborted = () =>
  new DOMException("The account scope changed", "AbortError");

/** A small independent session boundary: no player context, bootstrap or native bridge. */
export function useParticipationSession() {
  const scope = useRef({
    mounted: false,
    epoch: 0,
    owner: null as string | null,
    phase: "loading" as Phase,
  });
  const requests = useRef(new Set<AbortController>());
  const [session, setSession] = useState({
    phase: "loading" as Phase,
    owner: null as string | null,
    epoch: 0,
    notice: "",
  });
  const invalidate = useCallback(() => {
    for (const request of requests.current) request.abort();
    requests.current.clear();
    scope.current.epoch++;
    scope.current.owner = null;
    scope.current.phase = "loading";
    return scope.current.epoch;
  }, []);
  const refresh = useCallback(
    (notice = "") => {
      const epoch = invalidate();
      setSession({ phase: "loading", owner: null, epoch, notice });
      if (document.visibilityState === "hidden") return;
      const controller = new AbortController();
      requests.current.add(controller);
      const current = () =>
        scope.current.mounted &&
        scope.current.epoch === epoch &&
        !controller.signal.aborted &&
        document.visibilityState !== "hidden";
      void (async () => {
        try {
          const response = await fetch("/api/auth/me", {
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
          });
          if (!current()) return;
          if (response.status === 401) {
            scope.current.phase = "guest";
            setSession({ phase: "guest", owner: null, epoch, notice });
            return;
          }
          if (!response.ok) throw new RequestFailure(response.status);
          const data: unknown = await response.json();
          if (!current()) return;
          const { user } = z
            .object({ user: z.object({ id: z.uuid() }) })
            .parse(data);
          scope.current.owner = user.id;
          scope.current.phase = "ready";
          setSession({ phase: "ready", owner: user.id, epoch, notice });
        } catch {
          if (current()) {
            scope.current.phase = "error";
            setSession({ phase: "error", owner: null, epoch, notice });
          }
        } finally {
          requests.current.delete(controller);
        }
      })();
    },
    [invalidate],
  );
  const begin = useCallback((requiresOwner = true): Ticket | null => {
    const captured = { ...scope.current };
    if (
      !captured.mounted ||
      document.visibilityState === "hidden" ||
      (captured.phase !== "ready" && captured.phase !== "guest") ||
      (requiresOwner && !captured.owner)
    )
      return null;
    const controller = new AbortController();
    requests.current.add(controller);
    const current = () =>
      scope.current.mounted &&
      scope.current.epoch === captured.epoch &&
      scope.current.owner === captured.owner &&
      !controller.signal.aborted &&
      document.visibilityState !== "hidden";
    return {
      owner: captured.owner,
      signal: controller.signal,
      current,
      check: () => {
        if (!current()) throw aborted();
      },
      close: () => {
        requests.current.delete(controller);
      },
      abort: () => {
        controller.abort();
        requests.current.delete(controller);
      },
    };
  }, []);
  useEffect(() => {
    const currentScope = scope.current;
    currentScope.mounted = true;
    refresh();
    const focus = () => refresh();
    const visibility = () => refresh();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      currentScope.mounted = false;
      invalidate();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refresh, invalidate]);
  return { session, begin, refresh };
}
export type Access = Pick<
  ReturnType<typeof useParticipationSession>,
  "begin" | "refresh"
>;

export async function requestJSON<T>(
  ticket: Ticket,
  path: string,
  schema: z.ZodType<T>,
  method = "GET",
  payload?: unknown,
): Promise<T> {
  ticket.check();
  const headers = new Headers();
  if (ticket.owner) headers.set("X-Aurelia-Account", ticket.owner);
  if (payload !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`/api/product/${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers,
    signal: ticket.signal,
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  ticket.check();
  if (!response.ok) throw new RequestFailure(response.status);
  const data: unknown = await response.json();
  ticket.check();
  return schema.parse(data);
}
export function errorText(error: unknown) {
  if (error instanceof RequestFailure) {
    if (error.status === 413)
      return "Запрос превышает 8 КиБ. Сократите текст и повторите отправку; текст не был обрезан.";
    if (error.status === 429)
      return "Слишком много запросов. Подождите немного и попробуйте снова.";
    if (error.status === 404)
      return "Обращение больше недоступно. Обновите список.";
  }
  return "Не удалось получить подтверждение сервера. Проверьте соединение и попробуйте снова.";
}
export function ownershipError(error: unknown, access: Access) {
  if (
    error instanceof RequestFailure &&
    (error.status === 401 || error.status === 409)
  ) {
    access.refresh(
      error.status === 401
        ? "Сеанс завершился. Войдите снова."
        : "Аккаунт или данные изменились. Проверьте обновлённый список и повторите действие.",
    );
    return true;
  }
  return false;
}
