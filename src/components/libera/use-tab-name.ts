import { useTranslations } from "next-intl";
import type { PageKind } from "./page-tabs";

/**
 * What a tab shows as its name. A file's tab is named after the file; an app page's tab (Spending) has no file, and
 * its title is translated.
 */
export function useTabName() {
  const t = useTranslations("pageTabs");
  return (tab: { file: { name: string }; page?: { kind: PageKind } }) => (tab.page ? t(`title.${tab.page.kind}`) : tab.file.name);
}
