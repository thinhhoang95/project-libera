"use client";

import { ArrowDown, ArrowUp, Building2, Plus, User, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { CslName } from "@/lib/references/types";

// Editor for a CSL name list (authors, editors): each name is a person
// (family, given, particle) or an institution (literal), and names can be
// reordered, added and removed.

const field = "libera-panel-field h-8 min-w-0 rounded-lg px-2 text-[13px]";
const iconButton = "libera-sidebar-icon-button inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg disabled:pointer-events-none disabled:opacity-30";

function isInstitution(name: CslName) {
  return name.literal !== undefined && !name.family && !name.given;
}

/** Empty parts removed; a name with nothing left is dropped by `cleanNameList`. */
function cleanName(name: CslName): CslName {
  const clean: CslName = {};
  for (const [part, value] of Object.entries(name) as Array<[keyof CslName, string | undefined]>) {
    if (typeof value === "string" && value.trim()) clean[part] = value.trim();
  }
  return clean;
}

/** The names with empty parts and empty names removed. */
export function cleanNameList(names: CslName[]) {
  return names.map(cleanName).filter((name) => Object.keys(name).length > 0);
}

export function NameListEditor({
  label,
  addLabel,
  names,
  onChange,
}: {
  label: string;
  /** The Add button's text ("Add author"), translated by the caller. */
  addLabel?: string;
  names: CslName[];
  onChange: (names: CslName[]) => void;
}) {
  const t = useTranslations("references.nameListEditor");
  function update(index: number, patch: Partial<CslName>) {
    onChange(names.map((name, current) => current === index ? { ...name, ...patch } : name));
  }

  function move(index: number, offset: number) {
    const next = [...names];
    const [name] = next.splice(index, 1);
    next.splice(index + offset, 0, name);
    onChange(next);
  }

  function toggleKind(index: number) {
    const name = names[index];
    if (isInstitution(name)) {
      update(index, { literal: undefined, family: name.literal ?? "" });
    } else {
      const literal = [name.given, name["non-dropping-particle"], name.family].filter(Boolean).join(" ");
      onChange(names.map((current, position) => position === index ? { literal } : current));
    }
  }

  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">{label}</legend>
      {names.map((name, index) => {
        const institution = isInstitution(name);
        const rowLabel = t("row", { label, number: index + 1 });
        return (
          <div key={index} className="flex items-center gap-1" role="group" aria-label={rowLabel}>
            <button
              type="button"
              className={iconButton}
              title={institution ? t("institutionTitle") : t("personTitle")}
              aria-label={institution ? t("switchToPerson", { row: rowLabel }) : t("switchToInstitution", { row: rowLabel })}
              onClick={() => toggleKind(index)}
            >
              {institution ? <Building2 aria-hidden className="h-3.5 w-3.5" /> : <User aria-hidden className="h-3.5 w-3.5" />}
            </button>
            {institution ? (
              <input className={`${field} flex-1`} aria-label={t("nameAria", { row: rowLabel })} placeholder={t("institutionPlaceholder")} value={name.literal ?? ""} onChange={(event) => update(index, { literal: event.target.value })} />
            ) : (
              <>
                <input className={`${field} w-16`} aria-label={t("particleAria", { row: rowLabel })} placeholder={t("particleExample")} value={name["non-dropping-particle"] ?? ""} onChange={(event) => update(index, { "non-dropping-particle": event.target.value })} />
                <input className={`${field} flex-1`} aria-label={t("familyAria", { row: rowLabel })} placeholder={t("familyPlaceholder")} value={name.family ?? ""} onChange={(event) => update(index, { family: event.target.value })} />
                <input className={`${field} flex-1`} aria-label={t("givenAria", { row: rowLabel })} placeholder={t("givenPlaceholder")} value={name.given ?? ""} onChange={(event) => update(index, { given: event.target.value })} />
              </>
            )}
            <button type="button" className={iconButton} aria-label={t("moveUpAria", { row: rowLabel })} title={t("moveUp")} disabled={index === 0} onClick={() => move(index, -1)}>
              <ArrowUp aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={iconButton} aria-label={t("moveDownAria", { row: rowLabel })} title={t("moveDown")} disabled={index === names.length - 1} onClick={() => move(index, 1)}>
              <ArrowDown aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={iconButton} data-tone="destructive" aria-label={t("removeAria", { row: rowLabel })} title={t("remove")} onClick={() => onChange(names.filter((_, position) => position !== index))}>
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <button type="button" className="libera-panel-button h-7 px-2.5" onClick={() => onChange([...names, { family: "", given: "" }])}>
        <Plus aria-hidden className="h-3.5 w-3.5" /> <span className="libera-btn-label">{addLabel ?? `Add ${label.toLowerCase().replace(/s$/, "")}`}</span>
      </button>
    </fieldset>
  );
}
