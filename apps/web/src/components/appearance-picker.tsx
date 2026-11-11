"use client";
import { useId } from "react";
import { Monitor, Sun, Moon, Check, type LucideIcon } from "lucide-react";
import {
  nativeMaterialAvailability,
  type ThemeChoice,
  type ThemeSkin,
} from "./theme-contract";
import { useTheme } from "./theme-provider";
const appearanceOptions: {
  value: ThemeChoice;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];
const skinOptions: { value: ThemeSkin; label: string; description: string }[] =
  [
    {
      value: "base",
      label: "Base",
      description: "Clean neutrals. A red and pink accent.",
    },
    {
      value: "rainbow",
      label: "Rainbow",
      description: "Color accents and soft gradients.",
    },
    {
      value: "midnight",
      label: "Midnight",
      description: "Warm neutrals. An amber accent.",
    },
  ];
function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  change,
  skin = false,
}: {
  label: string;
  value: T;
  options: {
    value: T;
    label: string;
    description?: string;
    icon?: LucideIcon;
  }[];
  change: (next: T) => void;
  skin?: boolean;
}) {
  const groupId = useId();
  return (
    <div
      className={skin ? "appearance-skins" : "appearance-modes"}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        const delta = ["ArrowRight", "ArrowDown"].includes(event.key)
          ? 1
          : ["ArrowLeft", "ArrowUp"].includes(event.key)
            ? -1
            : 0;
        if (!delta && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const current = options.findIndex((option) => option.value === value);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : (current + delta + options.length) % options.length;
        change(options[next].value);
        event.currentTarget
          .querySelectorAll<HTMLButtonElement>('button[role="radio"]')
          [next]?.focus();
      }}
    >
      {options.map(
        ({ value: option, label: title, description, icon: Icon }) => (
          <button
            type="button"
            key={option}
            role="radio"
            aria-label={title}
            aria-describedby={
              description ? `${groupId}-${option}-description` : undefined
            }
            aria-checked={value === option}
            tabIndex={value === option ? 0 : -1}
            className={`appearance-option ${value === option ? "selected" : ""}`}
            data-preview={skin ? option : undefined}
            onClick={() => change(option)}
          >
            {skin ? (
              <span className="appearance-preview" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            ) : Icon ? (
              <Icon size={17} aria-hidden="true" />
            ) : null}
            <span className="appearance-option-title">
              {title}
              {skin && value === option ? (
                <Check size={15} aria-hidden="true" />
              ) : null}
            </span>
            {description ? (
              <small id={`${groupId}-${option}-description`}>
                {description}
              </small>
            ) : null}
          </button>
        ),
      )}
    </div>
  );
}
export function AppearancePicker() {
  const {
    theme,
    skin,
    setTheme,
    setSkin,
    reduceMotion,
    increaseContrast,
    reduceTransparency,
    nativeAppearance,
  } = useTheme();
  const materials = nativeMaterialAvailability(nativeAppearance);
  return (
    <div className="appearance-picker">
      <div className="appearance-block">
        <h2>Color mode</h2>
        <p>Follow your device, or choose light or dark.</p>
        <ChoiceGroup
          label="Appearance"
          value={theme}
          options={appearanceOptions}
          change={setTheme}
        />
      </div>
      <div className="appearance-block">
        <h2>Style</h2>
        <p>Each style works in light and dark. Choices stay on this device.</p>
        <ChoiceGroup
          label="Style"
          value={skin}
          options={skinOptions}
          change={setSkin}
          skin
        />
      </div>
      {reduceMotion || increaseContrast || reduceTransparency ? (
        <p className="appearance-accessibility">
          {reduceMotion ? "Reduced motion is on. " : ""}
          {increaseContrast ? "Higher contrast is on. " : ""}
          {reduceTransparency ? "Reduced transparency is on. " : ""}Following
          your device settings.
        </p>
      ) : null}
      <div className="appearance-native">
        <h2>Native materials</h2>
        <ul aria-label="Native material availability">
          {materials.map((material) => (
            <li
              key={material.id}
              data-available={material.available ? "true" : "false"}
            >
              <span>
                <strong>{material.label}</strong>
                <small>{material.reason}</small>
              </span>
              <span className="appearance-availability">
                {material.available ? "Available" : "Unavailable"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
