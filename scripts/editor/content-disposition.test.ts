import assert from "node:assert/strict";
import test from "node:test";
import { contentDisposition } from "../../src/lib/content-disposition";

test("response filenames preserve Unicode and punctuation in an ASCII-safe header", () => {
  for (const disposition of ["inline", "attachment"] as const) {
    for (const name of ["report.pdf", "General CV—GWU(F) - copie.pdf", "Đề cương ✈️.pdf", "a\"b\\c\r\n.pdf", "a'b*(1)!%.zip"]) {
      const value = contentDisposition(disposition, name);
      const response = new Response(null, { headers: { "Content-Disposition": value } });
      assert.equal(response.headers.get("Content-Disposition"), value);
      assert.match(value, /^[\x20-\x7E]+$/);
      assert.ok(value.startsWith(`${disposition}; filename="`));
      assert.equal(decodeURIComponent(value.split("filename*=UTF-8''")[1]), name);
      assert.doesNotMatch(value.split("filename*=UTF-8''")[1], /[!'()*]/);
    }
  }
});
