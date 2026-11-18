"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { useDescribeError } from "../ui/use-describe-error";
import { describeReviewError } from "./reviews";

/**
 * Words anything the reviews controller threw or stored (`snapshot.error`, `snapshot.failed[id]`, a rejected
 * `request()`) in the interface language: `const describe = useDescribeReviewError(); setError(describe(caught))`.
 */
export function useDescribeReviewError(): (error: unknown) => string {
  const t = useTranslations("lib.collab.client.reviews");
  const describeClientError = useDescribeError();
  return useCallback((error: unknown) => describeReviewError(error, t, describeClientError), [t, describeClientError]);
}
