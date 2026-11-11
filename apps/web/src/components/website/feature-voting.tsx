"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  useParticipationSession,
  requestJSON,
  votesSchema,
  ownershipError,
  errorText,
  type VoteFeature,
  type VoteSnapshot,
  type Access,
} from "./participation-session";
import { SessionState } from "./participation-status";
import styles from "./participation.module.css";

export function FeatureVoting({ features }: { features: VoteFeature[] }) {
  const access = useParticipationSession();
  const { session } = access;
  const heading = useId();
  return (
    <section className={styles.section} aria-labelledby={heading}>
      <div className={styles.heading}>
        <span className={styles.eyebrow}>Ваш приоритет</span>
        <h2 id={heading}>Голос за возможность</h2>
        <p>
          Один голос аккаунта на каждую возможность. Голос можно отозвать; он не
          назначает срок реализации.
        </p>
      </div>
      {session.notice && (
        <p role="status" className={styles.notice}>
          {session.notice}
        </p>
      )}
      {session.phase === "loading" || session.phase === "error" ? (
        <SessionState phase={session.phase} refresh={() => access.refresh()} />
      ) : (
        <VotingWorkspace
          key={session.epoch}
          features={features}
          access={access}
          guest={session.phase === "guest"}
        />
      )}
    </section>
  );
}
function VotingWorkspace({
  features,
  access,
  guest,
}: {
  features: VoteFeature[];
  access: Access;
  guest: boolean;
}) {
  const [snapshot, setSnapshot] = useState<VoteSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const load = useCallback(() => {
    if (lock.current) return;
    const ticket = access.begin(false);
    if (!ticket) return;
    setLoading(true);
    setError("");
    void requestJSON(ticket, "votes", votesSchema)
      .then((data) => {
        ticket.check();
        if (guest && data.votedFeatureIds.length)
          throw new Error("Invalid anonymous vote response");
        if (features.some((feature) => !Object.hasOwn(data.counts, feature.id)))
          throw new Error("Incomplete vote response");
        setSnapshot(data);
      })
      .catch((failure: unknown) => {
        if (ticket.current() && !ownershipError(failure, access))
          setError(errorText(failure));
      })
      .finally(() => {
        if (ticket.current()) setLoading(false);
        ticket.close();
      });
    return ticket.abort;
  }, [access, guest, features]);
  useEffect(() => load(), [load]);
  async function vote(feature: VoteFeature) {
    if (guest || lock.current || !snapshot) return;
    const voted = snapshot.votedFeatureIds.includes(feature.id);
    if (!voted && !feature.eligible) return;
    const ticket = access.begin();
    if (!ticket) return;
    lock.current = true;
    setBusy(feature.id);
    setError("");
    setNotice("");
    try {
      const data = await requestJSON(
        ticket,
        `votes/${encodeURIComponent(feature.id)}`,
        votesSchema,
        voted ? "DELETE" : "PUT",
        {},
      );
      ticket.check();
      if (features.some((feature) => !Object.hasOwn(data.counts, feature.id)))
        throw new Error("Incomplete vote response");
      setSnapshot(data);
      setNotice(voted ? "Голос отозван." : "Голос учтён.");
    } catch (failure) {
      if (ticket.current() && !ownershipError(failure, access))
        setError(errorText(failure));
    } finally {
      if (ticket.current()) {
        lock.current = false;
        setBusy(null);
      }
      ticket.close();
    }
  }
  return (
    <>
      {guest && <SessionState phase="guest" refresh={() => access.refresh()} />}
      {loading && (
        <p role="status" className={styles.muted}>
          Загружаем голоса…
        </p>
      )}
      {error && (
        <div className={styles.state}>
          <p role="alert">{error}</p>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => load()}
            disabled={busy !== null || loading}
          >
            Обновить голоса
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {!features.length ? (
        <p className={styles.muted}>
          В этом разделе пока нет возможностей для голосования.
        </p>
      ) : (
        <ul className={styles.voteList}>
          {features.map((feature) => {
            const voted =
              snapshot?.votedFeatureIds.includes(feature.id) === true;
            return (
              <li key={feature.id} className={styles.voteRow}>
                <div>
                  <Link
                    href={`/features/${encodeURIComponent(feature.id)}`}
                    prefetch={false}
                  >
                    {feature.title}
                  </Link>
                  <p className={styles.muted}>
                    {snapshot
                      ? `${snapshot.counts[feature.id] ?? 0} голосов`
                      : "Количество ещё не загружено"}
                    {voted ? " · Ваш голос учтён" : ""}
                  </p>
                  {!feature.eligible && !voted && (
                    <p className={styles.hint}>
                      Голосование пока закрыто. Условия и оценки указаны на
                      странице возможности.
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className={voted ? styles.secondary : styles.primary}
                  disabled={
                    guest ||
                    loading ||
                    busy !== null ||
                    !snapshot ||
                    (!feature.eligible && !voted)
                  }
                  aria-pressed={voted}
                  aria-label={`${voted ? "Отозвать голос за" : "Поддержать"} «${feature.title}»`}
                  onClick={() => void vote(feature)}
                >
                  {busy === feature.id
                    ? "Сохраняем…"
                    : voted
                      ? "Отозвать голос"
                      : feature.eligible
                        ? "Поддержать"
                        : "Голосование закрыто"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
