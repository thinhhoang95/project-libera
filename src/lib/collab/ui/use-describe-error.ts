"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { describeError } from "./client";

/** `describeError` in the interface language: `const describe = useDescribeError(); setError(describe(caught))`. */
export function useDescribeError(): (error: unknown) => string {
  const t = useTranslations("lib.collab.ui.client");
  return useCallback((error: unknown) => describeError(error, t), [t]);
}
