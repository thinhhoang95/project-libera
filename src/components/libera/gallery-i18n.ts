"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";

/**
 * Plain modules of the gallery (the gallery store, save menus, screenshot capture) have no hooks, yet they raise
 * errors and name menu items. A mounted viewer hands them the interface translator here; `galleryText` then
 * resolves a full message key such as `imageSave.saveToGallery`.
 */
type Translator = (key: string, values?: Record<string, string | number>) => string;

let translator: Translator | null = null;

/** Call from any gallery component that may run before one of the plain modules is used. */
export function useRegisterGalleryTranslator() {
  const t = useTranslations();
  useEffect(() => { translator = t as unknown as Translator; }, [t]);
}

export function galleryText(key: string, values?: Record<string, string | number>) {
  return translator ? translator(key, values) : key;
}
