// AWS Signature Version 4 for the S3 blob driver, written against
// node:crypto so the server does not need the AWS SDK. Covers what the driver
// sends: header-signed requests with a known payload hash.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html

import { createHash, createHmac } from "node:crypto";

export interface SigningInput {
  method: string;
  url: URL;
  /** Headers to sign and send. `host` and `x-amz-date` are added. */
  headers: Record<string, string>;
  /** Hex sha256 of the body (sha256 of "" for no body), or "UNSIGNED-PAYLOAD". */
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

export interface SignedRequest {
  /** Every signed header, lower-cased, plus `authorization`. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
export { EMPTY_SHA256 };

/** RFC 3986 encoding as SigV4 wants it: everything but unreserved characters. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPath(url: URL): string {
  if (url.pathname === "" || url.pathname === "/") return "/";
  // S3 signs each segment encoded once. URL.pathname is already encoded, so
  // decode first to avoid double-encoding.
  return url.pathname
    .split("/")
    .map((segment) => encode(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(([key, value]) => [encode(key), encode(value)] as const);
  pairs.sort(([aKey, aValue], [bKey, bValue]) => (aKey === bKey ? (aValue < bValue ? -1 : 1) : aKey < bKey ? -1 : 1));
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function signRequest(input: SigningInput): SignedRequest {
  const timestamp = amzDate(input.date);
  const day = timestamp.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  headers.host = input.url.host;
  headers["x-amz-date"] = timestamp;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.url),
    canonicalQuery(input.url),
    names.map((name) => `${name}:${headers[name]}\n`).join(""),
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign };
}
