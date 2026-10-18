"use client";

import { ArrowDown, ArrowUp, Building2, Plus, User, X } from "lucide-react";
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
  names,
  onChange,
}: {
  label: string;
  names: CslName[];
  onChange: (names: CslName[]) => void;
}) {
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
        const rowLabel = `${label} ${index + 1}`;
        return (
          <div key={index} className="flex items-center gap-1" role="group" aria-label={rowLabel}>
            <button
              type="button"
              className={iconButton}
              title={institution ? "Institution: make this a person" : "Person: make this an institution"}
              aria-label={institution ? `${rowLabel}: switch to person` : `${rowLabel}: switch to institution`}
              onClick={() => toggleKind(index)}
            >
              {institution ? <Building2 aria-hidden className="h-3.5 w-3.5" /> : <User aria-hidden className="h-3.5 w-3.5" />}
            </button>
            {institution ? (
              <input className={`${field} flex-1`} aria-label={`${rowLabel} name`} placeholder="Institution" value={name.literal ?? ""} onChange={(event) => update(index, { literal: event.target.value })} />
            ) : (
              <>
                <input className={`${field} w-16`} aria-label={`${rowLabel} particle`} placeholder="van" value={name["non-dropping-particle"] ?? ""} onChange={(event) => update(index, { "non-dropping-particle": event.target.value })} />
                <input className={`${field} flex-1`} aria-label={`${rowLabel} family name`} placeholder="Family name" value={name.family ?? ""} onChange={(event) => update(index, { family: event.target.value })} />
                <input className={`${field} flex-1`} aria-label={`${rowLabel} given name`} placeholder="Given name" value={name.given ?? ""} onChange={(event) => update(index, { given: event.target.value })} />
              </>
            )}
            <button type="button" className={iconButton} aria-label={`Move ${rowLabel} up`} title="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
              <ArrowUp aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={iconButton} aria-label={`Move ${rowLabel} down`} title="Move down" disabled={index === names.length - 1} onClick={() => move(index, 1)}>
              <ArrowDown aria-hidden className="h-3.5 w-3.5" />
            </button>
            <button type="button" className={iconButton} data-tone="destructive" aria-label={`Remove ${rowLabel}`} title="Remove" onClick={() => onChange(names.filter((_, position) => position !== index))}>
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      <button type="button" className="libera-panel-button h-7 px-2.5" onClick={() => onChange([...names, { family: "", given: "" }])}>
        <Plus aria-hidden className="h-3.5 w-3.5" /> Add {label.toLowerCase().replace(/s$/, "")}
      </button>
    </fieldset>
  );
}
