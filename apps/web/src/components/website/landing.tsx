import Image from "next/image";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  LibraryBig,
  ListMusic,
} from "lucide-react";
import {
  ProductPlatformSchema,
  getFeatureSupport,
  productRegistryV1,
  type ProductPlatform,
  type ProductRegistryV1,
} from "@aurelia/core";
import styles from "./landing.module.css";

const navigation = [
  { href: "/docs", label: "Документация" },
  { href: "/features", label: "Возможности" },
  { href: "/versions", label: "Версии" },
  { href: "/roadmap", label: "Планы" },
] as const;

const platformNames: Record<ProductPlatform, string> = {
  web: "Браузер",
  android: "Android",
  ios: "iPhone",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};
type Distribution = ProductRegistryV1["distributions"][ProductPlatform];
const distributionLabels: Record<Distribution["status"], string> = {
  hosted: "Доступен онлайн",
  "private-build": "Приватная сборка",
  "public-release": "Публичный выпуск",
  planned: "В планах",
  unavailable: "Недоступен",
  unknown: "Статус уточняется",
};

function platformDescription(platform: ProductPlatform, value: Distribution) {
  if (value.status === "hosted")
    return "Откройте плеер без установки. Доступность аудио зависит от источника и браузера.";
  if (value.status === "private-build")
    return "Нативный клиент в разработке и проверке. Публичный установщик ещё не выпущен.";
  if (value.status === "public-release")
    return value.version
      ? `Версия ${value.version}. Возможности и условия указаны в описании выпуска.`
      : "Возможности и условия указаны в описании выпуска.";
  if (value.status === "planned")
    return `Отдельное приложение для ${platformNames[platform]} — направление развития. Дата выпуска не назначена.`;
  if (value.status === "unavailable")
    return "Приложение сейчас недоступно. Изменения статуса появятся в реестре возможностей.";
  return "Поддержка этой платформы ещё уточняется. Проверенные возможности появятся в реестре.";
}

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M16 3v26M3 16h26M6.8 6.8l18.4 18.4M6.8 25.2 25.2 6.8"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="5" fill="currentColor" />
    </svg>
  );
}

function StudioRecords() {
  return (
    <figure className={styles.recordStage}>
      <div className={styles.recordStack} aria-hidden="true">
        <div className={styles.recordHalo} />
        <div className={styles.backCover}>
          <Image
            src="/art/blue-hours.svg"
            alt=""
            width={380}
            height={380}
            sizes="(max-width: 600px) 55vw, 300px"
            unoptimized
          />
        </div>
        <div className={styles.vinyl}>
          <div className={styles.vinylLabel}>
            <BrandMark />
            <span>AURELIA</span>
          </div>
        </div>
        <div className={styles.frontCover}>
          <Image
            src="/art/afterglow.svg"
            alt=""
            width={440}
            height={440}
            sizes="(max-width: 600px) 65vw, 360px"
            priority
            unoptimized
          />
        </div>
        <div className={styles.smallCover}>
          <Image
            src="/art/still-life.svg"
            alt=""
            width={180}
            height={180}
            sizes="(max-width: 600px) 28vw, 150px"
            unoptimized
          />
        </div>
        <span className={styles.recordEdition}>МЕСТО ДЛЯ ВАШЕЙ МУЗЫКИ</span>
      </div>
      <figcaption>
        <span className={styles.captionRule} />
        Оригинальные обложки Aurelia Studio
      </figcaption>
    </figure>
  );
}

export function WebsiteHeader() {
  return (
    <header className={`${styles.shell} ${styles.header}`}>
      <Link
        href="/"
        prefetch={false}
        className={styles.brand}
        aria-label="Aurelia — главная"
      >
        <BrandMark />
        <span>aurelia</span>
      </Link>
      <nav className={styles.navigation} aria-label="О сервисе">
        {navigation.map((item) => (
          <Link key={item.href} href={item.href} prefetch={false}>
            {item.label}
          </Link>
        ))}
      </nav>
      <Link href="/app/account" prefetch={false} className={styles.accountLink}>
        Аккаунт <ArrowUpRight size={15} aria-hidden="true" />
      </Link>
    </header>
  );
}

export function WebsiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={`${styles.shell} ${styles.footerInner}`}>
        <div className={styles.footerBrand}>
          <BrandMark />
          <span>aurelia</span>
        </div>
        <p>Больше внимания музыке.</p>
        <nav aria-label="Информация о проекте">
          <Link href="/docs" prefetch={false}>
            Документация
          </Link>
          <Link href="/versions" prefetch={false}>
            Версии
          </Link>
          <Link href="/app/account" prefetch={false}>
            Аккаунт
          </Link>
          <Link href="/feedback" prefetch={false}>
            Обратная связь
          </Link>
          <Link href="/privacy" prefetch={false}>
            Приватность
          </Link>
        </nav>
      </div>
    </footer>
  );
}

export function Landing() {
  const platforms = ProductPlatformSchema.options.map((platform) => ({
    platform,
    distribution: productRegistryV1.distributions[platform],
  }));
  const appleOffline = getFeatureSupport(
    productRegistryV1,
    "managed-offline-audio",
    "ios",
  );
  const browserOffline = getFeatureSupport(
    productRegistryV1,
    "managed-offline-audio",
    "web",
  );

  return (
    <div className={styles.landing} lang="ru">
      <a className={styles.skipLink} href="#aurelia-main">
        Перейти к содержимому
      </a>
      <WebsiteHeader />

      <main id="aurelia-main" tabIndex={-1}>
        <section
          className={`${styles.shell} ${styles.hero}`}
          aria-labelledby="aurelia-hero-title"
        >
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>
              <span /> Своя библиотека. Свой ритм.
            </p>
            <h1 id="aurelia-hero-title">
              Ближе <span>к музыке.</span>
            </h1>
            <p className={styles.heroDescription}>
              Открывайте новое. Собирайте близкое. Слушайте в своём ритме — в
              пространстве, где главное место занимает музыка.
            </p>
            <div className={styles.heroActions}>
              <Link href="/app" prefetch={false} className={styles.primaryLink}>
                Открыть плеер <ArrowUpRight size={19} aria-hidden="true" />
              </Link>
              <Link
                href="/features"
                prefetch={false}
                className={styles.textLink}
              >
                Узнать возможности <ArrowRight size={17} aria-hidden="true" />
              </Link>
            </div>
            <p className={styles.heroNote}>
              Начните в браузере. Подключите аккаунт, чтобы сохранять любимое.
            </p>
          </div>
          <StudioRecords />
        </section>

        <section
          className={`${styles.shell} ${styles.librarySection}`}
          aria-labelledby="aurelia-library-title"
        >
          <div className={styles.sectionIntro}>
            <p className={styles.eyebrow}>ОСТАВЛЯЙТЕ ТО, ЧТО ОТКЛИКАЕТСЯ</p>
            <h2 id="aurelia-library-title">Коллекция со своим характером.</h2>
            <p>
              Aurelia объединяет плеер, вашу библиотеку и доступные музыкальные
              источники. Любимые записи остаются рядом, а выбор — за вами.
            </p>
          </div>
          <div className={styles.featureGrid}>
            <article className={styles.feature}>
              <LibraryBig size={25} strokeWidth={1.4} aria-hidden="true" />
              <span className={styles.featureNumber}>01</span>
              <h3>Собирайте своё</h3>
              <p>
                Избранное, плейлисты и описания — для песен, к которым хочется
                возвращаться.
              </p>
            </article>
            <article className={styles.feature}>
              <ListMusic size={25} strokeWidth={1.4} aria-hidden="true" />
              <span className={styles.featureNumber}>02</span>
              <h3>Настройте настроение</h3>
              <p>
                Добавляйте следующее в очередь и меняйте порядок под вечер,
                дорогу или новый день.
              </p>
            </article>
            <article className={styles.feature}>
              <AudioLines size={25} strokeWidth={1.4} aria-hidden="true" />
              <span className={styles.featureNumber}>03</span>
              <h3>Слушайте внимательнее</h3>
              <p>
                Тексты и таймкоды помогают быть ближе к песне, когда они
                доступны для выбранной записи.
              </p>
            </article>
          </div>
        </section>

        {(appleOffline === "partial" || appleOffline === "verified") && (
          <section
            className={`${styles.shell} ${styles.offlineSection}`}
            aria-labelledby="aurelia-offline-title"
          >
            <div className={styles.offlineArt} aria-hidden="true">
              <Image
                src="/art/parallel.svg"
                alt=""
                width={280}
                height={280}
                sizes="(max-width: 600px) 55vw, 230px"
                unoptimized
              />
              <div className={styles.copyLabel}>
                <ArrowDownToLine size={16} /> <span>Музыка с собой</span>
              </div>
            </div>
            <div className={styles.offlineCopy}>
              <p className={styles.eyebrow}>
                У КАЖДОЙ ПЛАТФОРМЫ СВОИ ВОЗМОЖНОСТИ
              </p>
              <h2 id="aurelia-offline-title">
                Музыка рядом.
                <br />
                Даже вдали от сети.
              </h2>
              <p>
                В{" "}
                {productRegistryV1.distributions.ios.status === "private-build"
                  ? "приватном Apple-клиенте"
                  : "Apple-клиенте"}{" "}
                можно сохранять доступные записи для прослушивания офлайн.
                Загрузка идёт, пока приложение открыто; обложки и выбранные
                тексты сохраняются вместе с музыкой.
              </p>
              <p className={styles.finePrint}>
                {browserOffline === "unsupported"
                  ? "В браузере музыкальных офлайн-копий пока нет. "
                  : "Возможности офлайн различаются по платформам. "}
                Доступность сохранения зависит от источника и формата; условия и
                границы проверок указаны в реестре.
              </p>
              <Link
                href="/features"
                prefetch={false}
                className={styles.textLink}
              >
                Посмотреть условия <ArrowRight size={17} aria-hidden="true" />
              </Link>
            </div>
          </section>
        )}

        <section
          className={`${styles.shell} ${styles.platformSection}`}
          aria-labelledby="aurelia-platform-title"
        >
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>СЛУШАЙТЕ ТАМ, ГДЕ УДОБНО</p>
              <h2 id="aurelia-platform-title">
                Одно пространство.
                <br />
                Разные устройства.
              </h2>
            </div>
            <p>
              Сайт доступен сейчас. У приложений — свой этап разработки и
              проверки. Здесь виден актуальный статус каждого.
            </p>
          </div>
          <div className={styles.platformGrid}>
            {platforms.map(({ platform, distribution }) => (
              <article key={platform} className={styles.platformCard}>
                <div className={styles.platformTop}>
                  <h3>{platformNames[platform]}</h3>
                  <span
                    className={
                      distribution.status === "hosted" ||
                      distribution.status === "public-release"
                        ? styles.availableStatus
                        : styles.platformStatus
                    }
                  >
                    <span />
                    {distributionLabels[distribution.status]}
                  </span>
                </div>
                <p>{platformDescription(platform, distribution)}</p>
                {distribution.status === "hosted" && (
                  <Link
                    href="/app"
                    prefetch={false}
                    className={styles.platformAction}
                  >
                    Открыть плеер <ArrowUpRight size={16} aria-hidden="true" />
                  </Link>
                )}
                {distribution.status === "public-release" && (
                  <Link
                    href="/versions"
                    prefetch={false}
                    className={styles.platformAction}
                  >
                    О выпуске <ArrowUpRight size={16} aria-hidden="true" />
                  </Link>
                )}
              </article>
            ))}
          </div>
          <p className={styles.deliveryNote}>
            Браузерному аудио нужен работающий сервер доставки. В приватных
            приложениях аудио приходит на само устройство. Доступность каждой
            записи зависит от музыкального источника.
          </p>
        </section>

        <section
          className={`${styles.shell} ${styles.nextSection}`}
          aria-labelledby="aurelia-next-title"
        >
          <div>
            <p className={styles.eyebrow}>ПРОЗРАЧНО О ТОМ, ЧТО ДАЛЬШЕ</p>
            <h2 id="aurelia-next-title">
              Хорошая музыка — надолго.
              <br />
              Хороший продукт — в развитии.
            </h2>
            <p>
              Возможности, платформы и планы собраны в одном реестре: что
              работает, что проверяется и что ещё впереди.
            </p>
          </div>
          <div className={styles.nextLinks}>
            <Link href="/docs" prefetch={false}>
              Как устроена Aurelia <ArrowUpRight size={20} aria-hidden="true" />
            </Link>
            <Link href="/roadmap" prefetch={false}>
              Куда движется проект <ArrowUpRight size={20} aria-hidden="true" />
            </Link>
          </div>
        </section>
      </main>

      <WebsiteFooter />
    </div>
  );
}
