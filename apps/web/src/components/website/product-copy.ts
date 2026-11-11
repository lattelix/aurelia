import type { ProductFeature, ProductPlatform } from "@aurelia/core";

// Display translations only. All states, evidence and availability come from the registry.
export const platformNames: Record<ProductPlatform, string> = {
  web: "Web / PWA",
  android: "Android",
  ios: "iPhone",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

export const categoryNames: Record<string, string> = {
  playback: "Воспроизведение",
  library: "Библиотека и файлы",
  discovery: "Музыкальные открытия",
  account: "Аккаунт",
  appearance: "Оформление",
  community: "Совместное прослушивание",
  platform: "Приложения и выпуски",
};

export const implementationNames = {
  implemented: "Реализовано",
  partial: "Частичная реализация",
  planned: "Планируется",
  absent: "Не реализовано",
  unknown: "Не оценено",
} satisfies Record<
  ProductFeature["platforms"]["web"]["implementation"]["status"],
  string
>;

export const verificationNames = {
  verified: "Проверено",
  partial: "Частично проверено",
  unverified: "Не проверено",
  unknown: "Нет оценки проверки",
} satisfies Record<
  ProductFeature["platforms"]["web"]["verification"]["status"],
  string
>;

export const supportNames = {
  verified: "Проверено",
  partial: "Частично",
  planned: "Планируется",
  unsupported: "Не поддерживается",
  unverified: "Не проверено",
  unknown: "Неизвестно",
};

export const distributionNames = {
  hosted: "Работающий сайт",
  "private-build": "Приватная сборка",
  "public-release": "Публичный выпуск",
  planned: "Планируется",
  unavailable: "Недоступно",
  unknown: "Неизвестно",
};

export const channelNames = {
  production: "Рабочий сервис",
  development: "Разработка",
  preview: "Предварительный выпуск",
  stable: "Стабильный выпуск",
  unknown: "Не определён",
};

const featureCopy: Record<string, { title: string; description: string }> = {
  "music-playback": {
    title: "Воспроизведение музыки",
    description:
      "Запускайте запись, меняйте позицию и продолжайте слушать с учётом возможностей источника и платформы.",
  },
  "queue-editing": {
    title: "Управление очередью",
    description:
      "Добавляйте следующую запись, меняйте порядок и удаляйте вхождения, сохраняя текущую композицию.",
  },
  "sleep-timer": {
    title: "Таймер сна",
    description: "Остановка через выбранное время или после текущей записи.",
  },
  "synchronized-lyrics": {
    title: "Тексты и таймкоды",
    description:
      "Обычные и синхронные тексты, выбор версии записи, поправка времени и переход к строке.",
  },
  "managed-offline-audio": {
    title: "Музыка без сети",
    description:
      "Проверенные копии записей в отдельной библиотеке владельца с лимитом места и управлением загрузкой.",
  },
  "managed-offline-assets": {
    title: "Сохранённые обложки и тексты",
    description:
      "Сведения об альбоме, обложка и выбранные тексты рядом с сохранённой записью, когда они доступны.",
  },
  "local-audio-files": {
    title: "Личные аудиофайлы",
    description:
      "Отдельная библиотека приватных копий выбранных MP3, M4A и FLAC, включаемая по желанию.",
  },
  "audio-file-export": {
    title: "Экспорт аудиофайлов",
    description:
      "Отдельный файл доступной сохранённой записи с метаданными, обложкой и файлами текстов.",
  },
  "playlist-management": {
    title: "Плейлисты и коллекции",
    description:
      "Создание и редактирование плейлистов, фильтры и сохранённый порядок записей.",
  },
  "metadata-transfer": {
    title: "Перенос библиотеки",
    description:
      "Перенос музыкальных метаданных с проверкой неоднозначных совпадений.",
  },
  "account-library-sync": {
    title: "Библиотека аккаунта",
    description:
      "Общий профиль и обновление сохранённой музыки после обновления данных или возвращения в приложение.",
  },
  "music-metadata-api": {
    title: "Музыкальный API",
    description:
      "Общий сервис метаданных песен, альбомов, артистов, плейлистов и региональных подборок.",
  },
  "music-catalogue-browse": {
    title: "Поиск и каталог",
    description:
      "Музыкальный поиск и страницы альбомов, артистов и плейлистов в приложениях.",
  },
  "regional-charts": {
    title: "Региональные чарты",
    description:
      "Выбор страны и музыкальных коллекций, которые предоставляет источник чартов.",
  },
  "listening-history": {
    title: "История прослушивания",
    description: "История аккаунта по фактическому прогрессу воспроизведения.",
  },
  "music-recommendations": {
    title: "Рекомендации",
    description:
      "Музыкальные предложения по библиотеке и сигналам прослушивания.",
  },
  "appearance-palettes": {
    title: "Локальное оформление",
    description:
      "Палитры и системная, светлая или тёмная тема выбираются независимо.",
  },
  "appearance-account-sync": {
    title: "Синхронизация оформления",
    description:
      "Настройки внешнего вида в аккаунте для согласованного оформления на разных устройствах.",
  },
  "layout-presets": {
    title: "Варианты интерфейса",
    description:
      "Общие варианты компоновки с учётом размеров экрана и доступности каждой платформы.",
  },
  "listening-rooms": {
    title: "Комнаты прослушивания",
    description:
      "Общий выбор музыки, роли и приглашения; позднее — синхронное прослушивание с независимыми источниками.",
  },
  "music-recognition": {
    title: "Распознавание музыки",
    description:
      "Определение записи и проверка подходящего совпадения в музыкальном каталоге.",
  },
  "platform-applications": {
    title: "Приложения для платформ",
    description:
      "Отдельно проверяемые браузерные, мобильные и настольные приложения.",
  },
  "public-installers": {
    title: "Публичные пакеты",
    description:
      "Проверенные установочные файлы с контрольными суммами и инструкцией для поддерживаемых платформ.",
  },
  "app-store-distribution": {
    title: "Магазины приложений",
    description:
      "Подготовка лицензирования, пакетов и платформенной проверки перед публикацией реальных страниц магазинов.",
  },
};

export function featureText(feature: ProductFeature) {
  return (
    featureCopy[feature.id] ?? {
      title: feature.title,
      description: feature.description,
    }
  );
}

export function displayDate(value: string) {
  return new Intl.DateTimeFormat("ru", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}
