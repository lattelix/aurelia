"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { z } from "zod";
import {
  useParticipationSession,
  requestJSON,
  feedbackSchema,
  feedbackPageSchema,
  ownershipError,
  errorText,
  type Feature,
  type Feedback,
  type Access,
} from "./participation-session";
import { SessionState } from "./participation-status";
import styles from "./participation.module.css";

export function PrivateFeedback({ features }: { features: Feature[] }) {
  const access = useParticipationSession();
  const { session } = access;
  const heading = useId();
  return (
    <section className={styles.section} aria-labelledby={heading}>
      <div className={styles.heading}>
        <span className={styles.eyebrow}>Обратная связь</span>
        <h2 id={heading}>Расскажите о своём опыте</h2>
        <p>
          Сообщите об ошибке, предложите идею или уточните возможность.
          Обращения видны только вашему аккаунту; это не публичное обсуждение.
        </p>
      </div>
      {session.notice && (
        <p role="status" className={styles.notice}>
          {session.notice}
        </p>
      )}
      {session.phase !== "ready" ? (
        <SessionState phase={session.phase} refresh={() => access.refresh()} />
      ) : (
        <FeedbackWorkspace
          key={session.epoch}
          features={features}
          access={access}
        />
      )}
    </section>
  );
}
const kindNames = {
  bug: "Ошибка",
  idea: "Идея",
  feature: "Возможность",
} as const;
interface Draft {
  kind: Feedback["kind"];
  title: string;
  body: string;
  featureId: string;
}
const emptyDraft: Draft = { kind: "idea", title: "", body: "", featureId: "" };
function FeedbackWorkspace({
  features,
  access,
}: {
  features: Feature[];
  access: Access;
}) {
  const formId = useId();
  const [items, setItems] = useState<Feedback[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<Feedback | null>(null);
  const [deleting, setDeleting] = useState<Feedback | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const writing = useRef(false);
  const reading = useRef(false);
  const requestKey = useRef<string | null>(null);
  const load = useCallback(
    (next: string | null = null) => {
      if (reading.current || writing.current) return;
      const ticket = access.begin();
      if (!ticket) return;
      reading.current = true;
      setLoading(true);
      setError("");
      const query = new URLSearchParams({
        limit: "20",
        ...(next ? { cursor: next } : {}),
      });
      void requestJSON(ticket, `feedback?${query}`, feedbackPageSchema)
        .then((data) => {
          ticket.check();
          setItems((prior) => {
            const result = new Map(
              (next ? prior : []).map((item) => [item.id, item]),
            );
            for (const item of data.feedback) {
              const existing = result.get(item.id);
              if (!existing || item.revision >= existing.revision)
                result.set(item.id, item);
            }
            return [...result.values()];
          });
          setCursor(data.nextCursor);
        })
        .catch((failure: unknown) => {
          if (ticket.current() && !ownershipError(failure, access))
            setError(errorText(failure));
        })
        .finally(() => {
          if (ticket.current()) {
            reading.current = false;
            setLoading(false);
          }
          ticket.close();
        });
      return () => {
        ticket.abort();
        reading.current = false;
      };
    },
    [access],
  );
  useEffect(() => load(), [load]);
  function change(value: Partial<Draft>) {
    requestKey.current = null;
    setDraft((prior) => ({ ...prior, ...value }));
    setNotice("");
  }
  function reset() {
    requestKey.current = null;
    setEditing(null);
    setDraft(emptyDraft);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writing.current || reading.current) return;
    const title = draft.title.trim(),
      body = draft.body.trim();
    if (
      title.length < 3 ||
      title.length > 160 ||
      body.length < 10 ||
      body.length > 4000
    ) {
      setError(
        "Укажите заголовок от 3 до 160 символов и текст от 10 до 4000 символов.",
      );
      return;
    }
    const ticket = access.begin();
    if (!ticket) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const payload = {
      kind: draft.kind,
      title,
      body,
      featureId: draft.featureId || null,
    };
    if (!editing && !requestKey.current)
      requestKey.current = crypto.randomUUID();
    try {
      const result = await requestJSON(
        ticket,
        editing ? `feedback/${editing.id}` : "feedback",
        z.object({ feedback: feedbackSchema }),
        editing ? "PATCH" : "POST",
        editing
          ? { ...payload, expectedRevision: editing.revision }
          : { ...payload, requestId: requestKey.current },
      );
      ticket.check();
      setItems((prior) => [
        result.feedback,
        ...prior.filter((item) => item.id !== result.feedback.id),
      ]);
      reset();
      setNotice(editing ? "Изменения сохранены." : "Обращение сохранено.");
    } catch (failure) {
      if (ticket.current() && !ownershipError(failure, access))
        setError(errorText(failure));
    } finally {
      if (ticket.current()) {
        writing.current = false;
        setBusy(false);
      }
      ticket.close();
    }
  }
  async function remove() {
    if (!deleting || writing.current) return;
    const item = deleting;
    const ticket = access.begin();
    if (!ticket) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await requestJSON(
        ticket,
        `feedback/${item.id}`,
        z.object({ ok: z.literal(true) }),
        "DELETE",
        { expectedRevision: item.revision },
      );
      ticket.check();
      setItems((prior) => prior.filter((entry) => entry.id !== item.id));
      if (editing?.id === item.id) reset();
      setDeleting(null);
      setNotice("Обращение удалено.");
    } catch (failure) {
      if (ticket.current() && !ownershipError(failure, access)) {
        setError(errorText(failure));
        setDeleting(null);
      }
    } finally {
      if (ticket.current()) {
        writing.current = false;
        setBusy(false);
      }
      ticket.close();
    }
  }
  return (
    <>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <h3>{editing ? "Изменить обращение" : "Новое обращение"}</h3>
        <fieldset disabled={busy || loading} className={styles.fields}>
          <div className={styles.formRow}>
            <label htmlFor={`${formId}-kind`}>
              Тип
              <select
                id={`${formId}-kind`}
                value={draft.kind}
                onChange={(event) =>
                  change({ kind: event.target.value as Draft["kind"] })
                }
              >
                {Object.entries(kindNames).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${formId}-feature`}>
              Возможность <span className={styles.hint}>(необязательно)</span>
              <select
                id={`${formId}-feature`}
                value={draft.featureId}
                onChange={(event) => change({ featureId: event.target.value })}
              >
                <option value="">Без привязки</option>
                {features.map((feature) => (
                  <option key={feature.id} value={feature.id}>
                    {feature.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label htmlFor={`${formId}-title`}>
            Заголовок
            <input
              id={`${formId}-title`}
              value={draft.title}
              required
              minLength={3}
              maxLength={160}
              onChange={(event) => change({ title: event.target.value })}
              autoComplete="off"
            />
          </label>
          <div className={styles.field}>
            <label htmlFor={`${formId}-body`}>Описание</label>
            <textarea
              id={`${formId}-body`}
              value={draft.body}
              required
              minLength={10}
              maxLength={4000}
              rows={6}
              onChange={(event) => change({ body: event.target.value })}
              aria-describedby={`${formId}-hint`}
            />
          </div>
          <p id={`${formId}-hint`} className={styles.hint}>
            {draft.body.length}/4000 символов. Не указывайте пароли, коды входа
            или другую чувствительную информацию. Лимит запроса — 8 КиБ в UTF-8.
          </p>
          <div className={styles.actions}>
            <button className={styles.primary} type="submit">
              {busy
                ? "Сохраняем…"
                : editing
                  ? "Сохранить изменения"
                  : "Отправить обращение"}
            </button>
            {editing && (
              <button
                className={styles.secondary}
                type="button"
                onClick={reset}
              >
                Отменить редактирование
              </button>
            )}
          </div>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      <div className={styles.listHeading}>
        <h3>Ваши обращения</h3>
        <button
          type="button"
          className={styles.secondary}
          disabled={busy || loading}
          onClick={() => load()}
        >
          Обновить список
        </button>
      </div>
      {loading && (
        <p role="status" className={styles.muted}>
          Загружаем обращения…
        </p>
      )}
      {!loading && !items.length && !error && (
        <p className={styles.empty}>
          Обращений пока нет. Первое можно оставить в форме выше.
        </p>
      )}
      <ul className={styles.feedbackList}>
        {items.map((item) => (
          <li key={item.id} className={styles.feedbackCard}>
            <div className={styles.itemMeta}>
              <span>{kindNames[item.kind]}</span>
              <time dateTime={item.updatedAt}>
                {new Intl.DateTimeFormat("ru-RU", {
                  dateStyle: "medium",
                  timeZone: "UTC",
                }).format(new Date(item.updatedAt))}
              </time>
            </div>
            <h4>{item.title}</h4>
            {item.featureId && (
              <p className={styles.hint}>
                {features.find((feature) => feature.id === item.featureId)
                  ?.title ?? "Возможность из каталога"}
              </p>
            )}
            <p className={styles.message}>{item.body}</p>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy || loading}
                onClick={() => {
                  setEditing(item);
                  setDraft({
                    kind: item.kind,
                    title: item.title,
                    body: item.body,
                    featureId: item.featureId ?? "",
                  });
                  requestKey.current = null;
                  setError("");
                  setNotice("");
                  document.getElementById(`${formId}-title`)?.focus();
                }}
              >
                Изменить
              </button>
              <button
                type="button"
                className={styles.danger}
                disabled={busy || loading}
                onClick={() => setDeleting(item)}
              >
                Удалить
              </button>
            </div>
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          type="button"
          className={styles.secondary}
          disabled={busy || loading}
          onClick={() => load(cursor)}
        >
          Показать ещё
        </button>
      )}
      {deleting && (
        <DeleteConfirmation
          title={deleting.title}
          busy={busy}
          onClose={() => setDeleting(null)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
function DeleteConfirmation({
  title,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const description = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={styles.confirmation}
      aria-labelledby={heading}
      aria-describedby={description}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h3 id={heading}>Удалить обращение?</h3>
      <p id={description}>
        «{title}» будет удалено без возможности восстановления.
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          onClick={onClose}
          disabled={busy}
          autoFocus
        >
          Отмена
        </button>
        <button
          type="button"
          className={styles.danger}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Удаляем…" : "Удалить навсегда"}
        </button>
      </div>
    </dialog>
  );
}
