"use client";

import Link from "next/link";
import type { Phase } from "./participation-session";
import styles from "./participation.module.css";

export function SessionState({
  phase,
  refresh,
}: {
  phase: Phase;
  refresh: () => void;
}) {
  if (phase === "loading")
    return (
      <p role="status" className={styles.muted}>
        Проверяем сеанс…
      </p>
    );
  if (phase === "error")
    return (
      <div className={styles.state}>
        <p role="alert">Не удалось проверить сеанс.</p>
        <button type="button" className={styles.secondary} onClick={refresh}>
          Попробовать снова
        </button>
      </div>
    );
  return (
    <p className={styles.muted}>
      <Link href="/app/account" prefetch={false}>
        Войдите в аккаунт
      </Link>
      , чтобы участвовать. Отдельная регистрация не нужна.
    </p>
  );
}
