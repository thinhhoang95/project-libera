// HTTP headers cannot contain arbitrary Unicode. Keep an ASCII fallback for
// older clients and preserve the original filename in the UTF-8 parameter.
export function contentDisposition(disposition: "inline" | "attachment", fileName: string) {
  const fallback = Array.from(fileName, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code > 126 || character === '"' || character === "\\" ? "_" : character;
  }).join("");
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
