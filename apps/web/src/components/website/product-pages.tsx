import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Download,
  FileAudio,
  Fingerprint,
  Headphones,
  Layers,
  ListMusic,
  Monitor,
  Radio,
  ShieldCheck,
  Timer,
  type LucideIcon,
} from "lucide-react";
import {
  ProductPlatformSchema,
  canVote,
  getFeatureSupport,
  productRegistryV1,
  type ProductFeature,
  type ProductPlatform,
  type ProductRegistryV1,
} from "@aurelia/core";
import type { ReactNode } from "react";
import {
  categoryNames,
  channelNames,
  displayDate,
  distributionNames,
  featureText,
  implementationNames,
  platformNames,
  supportNames,
  verificationNames,
} from "./product-copy";
import styles from "./product-pages.module.css";
import { FeatureVoting } from "./participation";

const registry = productRegistryV1;
const platforms = ProductPlatformSchema.options;
type Distribution = ProductRegistryV1["distributions"][ProductPlatform];

function PageIntro({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <header className={styles.intro}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1>{title}</h1>
      <div className={styles.lead}>{children}</div>
    </header>
  );
}

function PageLinks() {
  return (
    <nav className={styles.pageLinks} aria-label="О продукте">
      <Link href="/features">Функции</Link>
      <Link href="/platforms">Платформы</Link>
      <Link href="/versions">Версии</Link>
      <Link href="/roadmap">Планы</Link>
      <Link href="/docs">Руководство</Link>
      <Link href="/feedback">Обратная связь</Link>
    </nav>
  );
}

function SnapshotNote() {
  return (
    <p className={styles.snapshot}>
      Срез реестра:{" "}
      <time dateTime={registry.reviewedAt}>
        {displayDate(registry.reviewedAt)}
      </time>
      . Это дата проверки описания, а не дата выпуска приложения.
    </p>
  );
}

function SourceNote() {
  const source = registry.source;
  return (
    <aside className={styles.sourceNote}>
      <ShieldCheck size={21} aria-hidden="true" />
      <div>
        {source.visibility === "public-source-preview" ? (
          <>
            <strong>Экспериментальный публичный срез исходников.</strong>
            <p>
              Отдельный репозиторий Aurelia опубликован под лицензией{" "}
              {source.license}.{" "}
              <a
                href={source.repositoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Исходники Aurelia на GitHub (новая вкладка)"
              >
                Исходники Aurelia на GitHub
              </a>
              .
            </p>
            <p>
              Web-проверки прошли. Полная сборка опубликованного набора
              исходников и готовность нативного выпуска ещё требуют проверки.
              Нативные установщики пока не опубликованы.
            </p>
          </>
        ) : (
          <>
            <strong>Открытое описание. Отдельное решение о выпуске.</strong>
            <p>
              Исходный код закрыт. Публичная лицензия пока не выбрана. Нативные
              приложения проходят отдельную проверку и подготовку к
              распространению. Приватная сборка не становится публичным пакетом
              после теста или установки.
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

function StateLegend() {
  return (
    <section className={styles.legend} aria-labelledby="status-legend">
      <div>
        <p className={styles.eyebrow}>Как читать статусы</p>
        <h2 id="status-legend">Три разных ответа.</h2>
      </div>
      <dl>
        <div>
          <dt>Реализация</dt>
          <dd>Есть ли код функции на выбранной платформе.</dd>
        </div>
        <div>
          <dt>Проверка</dt>
          <dd>
            Что подтвердили тесты и реальные сценарии. «Частично» требует чтения
            условий.
          </dd>
        </div>
        <div>
          <dt>Доступность</dt>
          <dd>Можно ли открыть сервис или получить опубликованный пакет.</dd>
        </div>
      </dl>
    </section>
  );
}

function SupportBadge({
  feature,
  platform,
}: {
  feature: ProductFeature;
  platform: ProductPlatform;
}) {
  const support = getFeatureSupport(registry, feature.id, platform);
  return (
    <span className={styles.badge} data-status={support}>
      {supportNames[support]}
    </span>
  );
}

function Availability({ value }: { value: Distribution }) {
  return (
    <span className={styles.availability} data-status={value.status}>
      {distributionNames[value.status]}
    </span>
  );
}

function ArtifactAction({ value }: { value: Distribution }) {
  if (value.status === "hosted" && value.artifact?.kind === "website") {
    return (
      <Link className={styles.textLink} href="/app" prefetch={false}>
        Открыть плеер <ArrowRight size={16} aria-hidden="true" />
      </Link>
    );
  }
  if (value.status === "public-release" && value.artifact) {
    return (
      <a className={styles.textLink} href={value.artifact.url}>
        {value.artifact.kind === "store"
          ? "Страница в магазине"
          : value.artifact.kind === "website"
            ? "Открыть сервис"
            : "Получить пакет"}
        <ArrowUpRight size={16} aria-hidden="true" />
      </a>
    );
  }
  return (
    <p className={styles.noDownload}>
      {value.status === "private-build"
        ? "Публичного файла для установки пока нет."
        : "Ссылка появится после принятого публичного выпуска."}
    </p>
  );
}

function FeatureCard({ feature }: { feature: ProductFeature }) {
  const copy = featureText(feature);
  return (
    <article className={styles.featureCard}>
      <p className={styles.cardKind}>
        {feature.surface === "service"
          ? "Сервис / API"
          : "Возможность приложения"}
      </p>
      <h3>
        <Link href={`/features/${feature.id}`}>{copy.title}</Link>
      </h3>
      <p className={styles.cardDescription}>{copy.description}</p>
      <dl className={styles.miniMatrix}>
        {platforms.map((platform) => (
          <div key={platform}>
            <dt>{platformNames[platform]}</dt>
            <dd>
              <SupportBadge feature={feature} platform={platform} />
            </dd>
          </div>
        ))}
      </dl>
      <Link className={styles.textLink} href={`/features/${feature.id}`}>
        Условия и проверки <ArrowRight size={15} aria-hidden="true" />
      </Link>
    </article>
  );
}

export function FeaturesPage() {
  return (
    <article className={styles.page}>
      <PageIntro
        eyebrow="Возможности Aurelia"
        title="Всё, что умеет музыка здесь."
      >
        <p>
          Один реестр для всех платформ: {registry.features.length} функций,{" "}
          {platforms.length} платформ. Реализованные возможности и будущие идеи
          остаются в одном списке, с явными условиями.
        </p>
      </PageIntro>
      <PageLinks />
      <StateLegend />
      <nav className={styles.categoryLinks} aria-label="Категории функций">
        {registry.categories.map((category) => (
          <a key={category.id} href={`#${category.id}`}>
            {categoryNames[category.id] ?? category.title}
          </a>
        ))}
      </nav>
      {registry.categories.map((category) => {
        const features = registry.features.filter(
          (feature) => feature.categoryId === category.id,
        );
        if (!features.length) return null;
        return (
          <section
            className={styles.section}
            id={category.id}
            key={category.id}
            aria-labelledby={`${category.id}-title`}
          >
            <div className={styles.sectionHeading}>
              <h2 id={`${category.id}-title`}>
                {categoryNames[category.id] ?? category.title}
              </h2>
              <span>{features.length} в реестре</span>
            </div>
            <div className={styles.featureGrid}>
              {features.map((feature) => (
                <FeatureCard key={feature.id} feature={feature} />
              ))}
            </div>
          </section>
        );
      })}
      <SourceNote />
      <SnapshotNote />
    </article>
  );
}

function PlatformCard({ platform }: { platform: ProductPlatform }) {
  const value = registry.distributions[platform];
  return (
    <article className={styles.platformCard}>
      <div className={styles.platformHeading}>
        <Monitor size={21} aria-hidden="true" />
        <h2>{platformNames[platform]}</h2>
      </div>
      <Availability value={value} />
      <dl className={styles.facts}>
        <div>
          <dt>Канал</dt>
          <dd>{channelNames[value.channel]}</dd>
        </div>
        <div>
          <dt>Формальная версия</dt>
          <dd>{value.version ?? "Не назначена"}</dd>
        </div>
        <div>
          <dt>Публичный выпуск</dt>
          <dd>
            {value.releasedAt ? (
              <time dateTime={value.releasedAt}>
                {displayDate(value.releasedAt)}
              </time>
            ) : (
              "Не объявлен"
            )}
          </dd>
        </div>
      </dl>
      <ArtifactAction value={value} />
    </article>
  );
}

function FeatureMatrix() {
  return (
    <div
      className={styles.tableRegion}
      role="region"
      aria-label="Матрица функций по платформам, прокручивается горизонтально"
      tabIndex={0}
    >
      <table className={styles.matrix}>
        <caption>
          Сводная проверка функций. Доступность приложения указана отдельно
          выше; готовность API не означает готовый экран.
        </caption>
        <thead>
          <tr>
            <th scope="col">Функция</th>
            {platforms.map((platform) => (
              <th scope="col" key={platform}>
                {platformNames[platform]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {registry.features.map((feature) => (
            <tr key={feature.id}>
              <th scope="row">
                <Link href={`/features/${feature.id}`}>
                  {featureText(feature).title}
                </Link>
                {feature.surface === "service" ? (
                  <small>Сервис / API</small>
                ) : null}
              </th>
              {platforms.map((platform) => (
                <td key={platform}>
                  <SupportBadge feature={feature} platform={platform} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PlatformsPage() {
  return (
    <article className={styles.page}>
      <PageIntro
        eyebrow="Платформы"
        title="Одна библиотека. Разные возможности."
      >
        <p>
          Работающий сайт, приватные приложения и будущие платформы показаны
          отдельно. Возможность в исходниках и опубликованный файл для установки
          — разные стадии.
        </p>
      </PageIntro>
      <PageLinks />
      <section
        className={styles.platformGrid}
        aria-label="Доступность приложений"
      >
        {platforms.map((platform) => (
          <PlatformCard platform={platform} key={platform} />
        ))}
      </section>
      <StateLegend />
      <section className={styles.section} aria-labelledby="platform-matrix">
        <div className={styles.sectionHeading}>
          <h2 id="platform-matrix">Сравнение возможностей</h2>
          <span>Условия — в карточке функции</span>
        </div>
        <FeatureMatrix />
      </section>
      <SourceNote />
      <SnapshotNote />
    </article>
  );
}

function VerificationEvidence({ ids }: { ids: string[] }) {
  const records = registry.evidence.filter((record) => ids.includes(record.id));
  if (!records.length)
    return (
      <p className={styles.muted}>
        Для этой платформы ещё нет связанных подтверждений в реестре.
      </p>
    );
  const outcomes = {
    passed: "Пройдено",
    partial: "Частичный результат",
    blocked: "Проверка заблокирована",
    failed: "Не пройдено",
  };
  const kinds = {
    "automated-checks": "Автоматические проверки",
    "browser-check": "Проверка в браузере",
    "http-check": "HTTP-проверка",
    build: "Сборка",
    "device-check": "Проверка на устройстве",
    "code-review": "Проверка кода",
  };
  return (
    <ul className={styles.evidenceList}>
      {records.map((record) => (
        <li key={record.id}>
          <div>
            <strong>{kinds[record.kind]}</strong>
            <span>{outcomes[record.outcome]}</span>
          </div>
          <p>
            <time dateTime={record.checkedAt}>
              {displayDate(record.checkedAt)}
            </time>{" "}
            ·{" "}
            {record.version
              ? `Версия ${record.version}`
              : "Без формальной версии"}
          </p>
          <p lang="en">{record.scope}</p>
        </li>
      ))}
    </ul>
  );
}

function FeaturePlatformCard({
  feature,
  platform,
}: {
  feature: ProductFeature;
  platform: ProductPlatform;
}) {
  const state = feature.platforms[platform];
  return (
    <article className={styles.platformDetail}>
      <div className={styles.sectionHeading}>
        <h3>{platformNames[platform]}</h3>
        <SupportBadge feature={feature} platform={platform} />
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Реализация</dt>
          <dd>{implementationNames[state.implementation.status]}</dd>
        </div>
        <div>
          <dt>Проверка</dt>
          <dd>{verificationNames[state.verification.status]}</dd>
        </div>
        <div>
          <dt>Доступность приложения</dt>
          <dd>{distributionNames[registry.distributions[platform].status]}</dd>
        </div>
      </dl>
      <details className={styles.details}>
        <summary>Условия и описание проверок</summary>
        <p className={styles.detailLabel}>
          Точная формулировка из реестра, на языке оригинала:
        </p>
        <p lang="en">{state.implementation.note}</p>
        <VerificationEvidence ids={state.verification.evidenceIds} />
      </details>
    </article>
  );
}

function Assessment({ feature }: { feature: ProductFeature }) {
  if (feature.assessment.status === "unestimated")
    return (
      <div className={styles.assessment}>
        <Timer size={21} aria-hidden="true" />
        <div>
          <strong>Оценка ещё не проведена</strong>
          <p>
            Объём работы, текущие расходы и дальнейшее сопровождение требуют
            отдельного рассмотрения. Стоимость и даты пока не определены.
          </p>
        </div>
      </div>
    );
  const assessment = feature.assessment;
  return (
    <div className={styles.assessment}>
      <ShieldCheck size={21} aria-hidden="true" />
      <div>
        <strong>
          Оценка рассмотрена{" "}
          <time dateTime={assessment.reviewedAt}>
            {displayDate(assessment.reviewedAt)}
          </time>
        </strong>
        <dl className={styles.reviewedAssessment}>
          {(
            [
              ["Объём работы", assessment.effort],
              ["Текущие расходы", assessment.runningCash],
              ["Сопровождение", assessment.maintenance],
            ] as const
          ).map(([name, item]) => (
            <div key={name}>
              <dt>
                {name} ·{" "}
                {item.result === "unknown" ? "Пока неизвестно" : "Есть оценка"}
              </dt>
              <dd lang="en">
                <p>{item.summary}</p>
                <details>
                  <summary lang="ru">Допущения и риски</summary>
                  <p>{item.assumptions}</p>
                  <p>{item.risks}</p>
                </details>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export function FeatureDetailPage({ id }: { id: string }) {
  const feature = registry.features.find((item) => item.id === id);
  if (!feature)
    return (
      <article className={styles.page}>
        <PageIntro
          eyebrow="Реестр функций"
          title="Такой функции пока нет в реестре."
        >
          <p>Проверьте ссылку или вернитесь к общему списку.</p>
        </PageIntro>
        <Link className={styles.textLink} href="/features">
          Все функции <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </article>
    );
  const copy = featureText(feature);
  return (
    <article className={styles.page}>
      <Link className={styles.backLink} href="/features">
        ← Все функции
      </Link>
      <PageIntro
        eyebrow={
          feature.surface === "service"
            ? "Общий сервис / API"
            : (categoryNames[feature.categoryId] ?? "Возможность приложения")
        }
        title={copy.title}
      >
        <p>{copy.description}</p>
      </PageIntro>
      {feature.surface === "service" ? (
        <p className={styles.callout}>
          Эта запись описывает сервис метаданных. Его проверка не означает, что
          соответствующий интерфейс уже готов во всех приложениях.
        </p>
      ) : null}
      <StateLegend />
      <section
        className={styles.detailGrid}
        aria-label="Реализация, проверки и доступность по платформам"
      >
        {platforms.map((platform) => (
          <FeaturePlatformCard
            feature={feature}
            platform={platform}
            key={platform}
          />
        ))}
      </section>
      <Assessment feature={feature} />
      {feature.id === "app-store-distribution" && (
        <p className={styles.muted}>
          Стоимость участия:{" "}
          <a
            href="https://developer.apple.com/programs/enroll/"
            target="_blank"
            rel="noreferrer"
          >
            официальные условия Apple Developer Program
          </a>
          . Оценка не означает покупку или обещание принятия в магазин.
        </p>
      )}
      <FeatureVoting
        features={[
          {
            id: feature.id,
            title: copy.title,
            eligible: canVote(registry, feature.id),
          },
        ]}
      />
      <p className={styles.muted}>
        {canVote(registry, feature.id)
          ? "Условия участия рассмотрены в реестре. Голосовать можно только через подключённый сервис с входом в аккаунт."
          : "Голосование для этой функции пока не открыто. Идея в списке не означает обещание выпуска или срока."}
      </p>
      <SourceNote />
      <SnapshotNote />
    </article>
  );
}

export function VersionsPage() {
  const releases = platforms.filter(
    (platform) => registry.distributions[platform].status === "public-release",
  );
  return (
    <article className={styles.page}>
      <PageIntro eyebrow="Версии и выпуски" title="Что доступно сейчас.">
        <p>
          У работающего сервиса, приватной сборки и публичного пакета разные
          истории. Здесь показаны только объявленные сведения из единого
          реестра.
        </p>
      </PageIntro>
      <PageLinks />
      {releases.length === 0 ? (
        <section className={styles.releaseEmpty} aria-labelledby="no-releases">
          <Layers size={30} aria-hidden="true" />
          <div>
            <p className={styles.eyebrow}>Публичные пакеты</p>
            <h2 id="no-releases">Формальные выпуски пока не объявлены.</h2>
            <p>
              Не назначенная версия остаётся неизвестной. Номер из исходников,
              успешная сборка и установка для проверки не заменяют
              опубликованный выпуск.
            </p>
          </div>
        </section>
      ) : null}
      <section className={styles.section} aria-labelledby="distribution-state">
        <div className={styles.sectionHeading}>
          <h2 id="distribution-state">Текущее состояние доставки</h2>
          <span>Отдельно для каждой платформы</span>
        </div>
        <div className={styles.platformGrid}>
          {platforms.map((platform) => (
            <PlatformCard platform={platform} key={platform} />
          ))}
        </div>
      </section>
      <section
        className={styles.explainerGrid}
        aria-label="Как появляются версии"
      >
        <div>
          <h2>Обновление сервиса</h2>
          <p>
            Web может работать в production без назначенной формальной версии.
            Это доступность сайта, а не обещание нативного пакета.
          </p>
        </div>
        <div>
          <h2>Публичный выпуск</h2>
          <p>
            Нужны согласованная версия, дата, канал и реальный опубликованный
            артефакт. Проверка пакета, лицензии, notices и контрольной суммы
            проходит отдельно.
          </p>
        </div>
        <div>
          <h2>Предел проверки</h2>
          <p>
            Подтверждение относится к конкретной платформе и версии. Результаты
            другой сборки или короткого сценария не становятся полной приёмкой.
          </p>
        </div>
      </section>
      <SourceNote />
      <SnapshotNote />
    </article>
  );
}

function PlannedFeature({ feature }: { feature: ProductFeature }) {
  const planned = platforms.filter(
    (platform) =>
      feature.platforms[platform].implementation.status === "planned",
  );
  return (
    <article className={styles.roadmapItem}>
      <div>
        <p className={styles.cardKind}>
          {categoryNames[feature.categoryId] ?? feature.categoryId}
        </p>
        <h3>
          <Link href={`/features/${feature.id}`}>
            {featureText(feature).title}
          </Link>
        </h3>
        <p>{featureText(feature).description}</p>
        <p className={styles.platformLine}>
          Планируется:{" "}
          {planned.map((platform) => platformNames[platform]).join(", ")}
        </p>
      </div>
      <div className={styles.roadmapAside}>
        <span className={styles.badge} data-status="planned">
          {feature.assessment.status === "unestimated"
            ? "Без оценки"
            : "Оценка рассмотрена"}
        </span>
        <Link className={styles.textLink} href={`/features/${feature.id}`}>
          Подробнее <ArrowRight size={15} aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

export function RoadmapPage() {
  const planned = registry.features.filter((feature) =>
    platforms.some(
      (platform) =>
        feature.platforms[platform].implementation.status === "planned",
    ),
  );
  const needsAcceptance = registry.features.filter((feature) =>
    platforms.some(
      (platform) =>
        ["implemented", "partial"].includes(
          feature.platforms[platform].implementation.status,
        ) && feature.platforms[platform].verification.status !== "verified",
    ),
  );
  return (
    <article className={styles.page}>
      <PageIntro eyebrow="Планы" title="Следующий шаг — с понятными условиями.">
        <p>
          Тот же реестр, без отдельного списка обещаний. Направления различаются
          по платформам; объём работы, расходы и сопровождение оцениваются до
          открытия голосования.
        </p>
      </PageIntro>
      <PageLinks />
      <aside className={styles.callout}>
        <div>
          <strong>Один аккаунт — один голос за функцию.</strong>
          <p>
            {registry.services.voting === "not-connected"
              ? "Голосование пока не подключено."
              : "За функции с рассмотренной оценкой можно голосовать после входа. Голос можно снять."}{" "}
            {registry.services.funding.status === "not-connected"
              ? "Сбор средств не подключён."
              : ""}{" "}
            <Link href="/feedback">Личные отзывы и запросы</Link> доступны после
            входа и не публикуются автоматически.
          </p>
        </div>
      </aside>
      <FeatureVoting
        features={planned
          .filter((feature) => feature.assessment.status === "reviewed")
          .map((feature) => ({
            id: feature.id,
            title: featureText(feature).title,
            eligible: canVote(registry, feature.id),
          }))}
      />
      <section className={styles.section} aria-labelledby="planned-features">
        <div className={styles.sectionHeading}>
          <h2 id="planned-features">Направления из реестра</h2>
          <span>
            {planned.length} функций с планируемым платформенным срезом
          </span>
        </div>
        <div className={styles.roadmapList}>
          {planned.map((feature) => (
            <PlannedFeature feature={feature} key={feature.id} />
          ))}
        </div>
      </section>
      <section
        className={styles.acceptanceSection}
        aria-labelledby="acceptance-title"
      >
        <p className={styles.eyebrow}>Довести и проверить</p>
        <h2 id="acceptance-title">Реализация — начало приёмки.</h2>
        <p>
          Для этих функций остаются непроверенные сценарии хотя бы на одной
          реализованной платформе. Подробности и связанные подтверждения — в
          общей карточке.
        </p>
        <ul className={styles.acceptanceLinks}>
          {needsAcceptance.map((feature) => (
            <li key={feature.id}>
              <Link href={`/features/${feature.id}`}>
                {featureText(feature).title}
                <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section
        className={styles.explainerGrid}
        aria-label="Правила планирования"
      >
        <div>
          <h2>Сначала оценка</h2>
          <p>
            Объём работы, текущие расходы и сопровождение рассматриваются
            отдельно. Неизвестная цена не означает нулевую стоимость.
          </p>
        </div>
        <div>
          <h2>Один аккаунт — один голос</h2>
          <p>
            Голос можно снять. Он выражает интерес к функции и не становится
            заказом, её ценой или обещанием срока.
          </p>
        </div>
        <div>
          <h2>Поддержка — отдельное решение</h2>
          <p>
            Платежи выключены. Они не увеличивают вес голоса и не означают
            обещание реализации.
          </p>
        </div>
      </section>
      <SnapshotNote />
    </article>
  );
}

function GuideSection({
  id,
  icon: Icon,
  title,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className={styles.guideSection}
      id={id}
      aria-labelledby={`${id}-heading`}
    >
      <Icon size={24} aria-hidden="true" />
      <div>
        <h2 id={`${id}-heading`}>{title}</h2>
        {children}
      </div>
    </section>
  );
}

export function ProductDocsPage() {
  return (
    <article className={styles.page}>
      <PageIntro eyebrow="Руководство" title="Музыка, без лишних догадок.">
        <p>
          Как начать слушать, сохранить свою библиотеку и понять ограничения
          источника. Для платформенных различий рядом есть{" "}
          <Link href="/platforms">матрица возможностей</Link>.
        </p>
      </PageIntro>
      <PageLinks />
      <div className={styles.guideLayout}>
        <nav className={styles.guideNav} aria-label="Разделы руководства">
          <span>На этой странице</span>
          <a href="#start">Начать слушать</a>
          <a href="#profile">Аккаунт и библиотека</a>
          <a href="#offline">Сохранение без сети</a>
          <a href="#lyrics">Версия текста</a>
          <a href="#export">Экспорт и файлы</a>
          <a href="#availability">Если запись недоступна</a>
        </nav>
        <div>
          <GuideSection
            id="start"
            icon={Headphones}
            title="Начните с одной записи."
          >
            <p>
              Откройте плеер, найдите композицию и нажмите Play. Открытие
              страницы и восстановление очереди оставляют воспроизведение на
              паузе.
            </p>
            <p>
              Очередь хранит отдельные вхождения: одна композиция может
              встретиться несколько раз. Play next добавляет запись следом,
              обычное добавление — в очередь.
            </p>
            <Link className={styles.textLink} href="/app" prefetch={false}>
              Открыть плеер <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </GuideSection>
          <GuideSection
            id="profile"
            icon={Fingerprint}
            title="Профиль хранит музыкальную библиотеку."
          >
            <p>
              На сайте доступны email с паролем и Telegram. Коды входа на email
              выключены; Google и Apple сейчас не подключены. Наличие адаптера в
              коде не означает готовый способ входа.
            </p>
            <p>
              Используйте один аккаунт для избранного и плейлистов. Привязка
              способа входа выполняется явно в Account; одинаковый email сам по
              себе не объединяет профили. В нативных приложениях данные
              обновляются после refresh или возврата в приложение.
            </p>
            <p>
              Вход в Aurelia не даёт подписку или доступ к личному аккаунту
              музыкального источника.
            </p>
          </GuideSection>
          <GuideSection
            id="offline"
            icon={Download}
            title="Сохраните до отключения сети."
          >
            <p>
              Managed offline реализован в приватных Apple-клиентах. В Downloads
              можно сохранить отдельную запись или явно включить избранное,
              личную библиотеку и выбранные плейлисты. Личная библиотека здесь —
              избранное и песни ваших плейлистов.
            </p>
            <ol>
              <li>
                Выберите лимит места. По умолчанию — 512 MiB, только Wi-Fi;
                автоматические наборы выключены.
              </li>
              <li>
                Оставьте приложение на экране, пока идёт загрузка. Передача одна
                и работает только в foreground. Уход в фон не обещает
                завершения.
              </li>
              <li>
                Дождитесь Ready / Available offline. До проверки целостности
                файл не считается готовой копией.
              </li>
            </ol>
            <p>
              Ожидание foreground или Wi-Fi снимается после возвращения
              подходящих условий. Ручная пауза и ошибка требуют Resume. Для
              одной записи действует лимит 128 MiB; кроме общей квоты нужен
              запас свободного места.
            </p>
            <p>
              Сохранённые копии изолированы по владельцу. Смена аккаунта или
              истечение сохранённого входа закрывает доступ к ним. Это не общая
              папка музыки и не бессрочный доступ к источнику.
            </p>
            <Link
              className={styles.textLink}
              href="/features/managed-offline-audio"
            >
              Платформенные условия <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </GuideSection>
          <GuideSection
            id="lyrics"
            icon={ListMusic}
            title="Проверьте, что текст от той записи."
          >
            <p>
              Откройте lyrics и выберите совпадение по исполнителю, названию,
              альбому и длительности. Концертная, студийная и короткая версии
              могут иметь разные таймкоды.
            </p>
            <p>
              У синхронного текста доступны подсветка, переход к строке и
              поправка времени там, где это поддерживает клиент. Отсутствующий
              текст — нормальное состояние; у инструментальной записи его может
              не быть.
            </p>
            <p>
              У managed-копии выбранные plain/LRC и обложка сохраняются
              отдельно, если доступны. Ручной выбор текста имеет приоритет при
              последующем дополнении метаданных.
            </p>
          </GuideSection>
          <GuideSection
            id="export"
            icon={FileAudio}
            title="Отдельный файл — отдельное действие."
          >
            <p>
              В приватном Apple-клиенте Export сначала готовит M4A доступной
              managed-копии. AAC переносится без повторного кодирования;
              название, исполнитель, альбом и plain lyrics добавляются при
              наличии. Обложка может быть встроена и приложена как JPEG, тексты
              — как TXT и LRC.
            </p>
            <p>
              На iPhone после подготовки Save to Files открывает выбор места для
              копии. Share… — отдельное действие с системным выбором получателя.
              Подготовка файла сама ничего не отправляет.
            </p>
            <p>
              Личные MP3, M4A и FLAC подключаются отдельным opt-in и системным
              выбором файлов. Создаётся приватная копия; оригинал не изменяется
              и не становится частью облачной библиотеки. Поддержку конкретного
              файла проверяет устройство.
            </p>
            <p>
              JSON-перенос библиотеки содержит метаданные. Это не аудиофайл и не
              резервная копия аккаунта.
            </p>
          </GuideSection>
          <GuideSection
            id="availability"
            icon={Radio}
            title="Источник может ответить отказом."
          >
            <p>
              Доступность зависит от записи, сети, региона и поведения внешнего
              сервиса. Аккаунт Aurelia не заменяет подписку музыкального
              источника; весь каталог, lossless и постоянная работа внешнего API
              не обещаются.
            </p>
            <p>
              Если запись недоступна, проверьте другую версию или повторите
              явное действие позже. Сохранённая повреждённая или чужая копия не
              должна незаметно переключаться на сеть. Web/PWA offline-страница
              не означает сохранённую музыку.
            </p>
            <p>
              Региональные чарты показывают доступные подборки источника. Они
              могут содержать коллекции и не обещают прямой рейтинг каждой
              песни.
            </p>
          </GuideSection>
        </div>
      </div>
      <aside className={styles.callout}>
        <BookOpen size={21} aria-hidden="true" />
        <div>
          <strong>Нужна точная граница?</strong>
          <p>
            Читайте карточку функции: там отдельно указаны код, подтверждения и
            канал приложения. Личные отзывы доступны в разделе обратной связи, а
            голоса за оценённые функции — в планах проекта.
          </p>
          <Link className={styles.textLink} href="/features">
            Перейти к функциям <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </aside>
      <SourceNote />
      <SnapshotNote />
    </article>
  );
}
