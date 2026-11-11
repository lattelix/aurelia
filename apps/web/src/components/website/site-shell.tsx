import { WebsiteFooter, WebsiteHeader } from "./landing";
import styles from "./landing.module.css";

export function SiteShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.landing} lang="ru">
      <a className={styles.skipLink} href="#main-content">
        Перейти к содержимому
      </a>
      <WebsiteHeader />
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
      <WebsiteFooter />
    </div>
  );
}
