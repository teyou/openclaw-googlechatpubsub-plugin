import test from "node:test";
import assert from "node:assert/strict";
import { loadModuleUnderTest } from "./helpers/harness.mjs";

const { guessMimeType, EXT_TO_MIME } = await loadModuleUnderTest();

test("guessMimeType", async (t) => {
  await t.test("maps a known extension", () => {
    assert.equal(guessMimeType("photo.png"), "image/png");
    assert.equal(guessMimeType("doc.pdf"), "application/pdf");
    assert.equal(guessMimeType("notes.md"), "text/markdown");
    assert.equal(guessMimeType("sheet.xlsx"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  await t.test("is case-insensitive about the extension", () => {
    assert.equal(guessMimeType("PHOTO.PNG"), "image/png");
    assert.equal(guessMimeType("Report.PdF"), "application/pdf");
    assert.equal(guessMimeType("CLIP.MoV"), "video/quicktime");
  });

  await t.test("falls back to application/octet-stream for an unknown extension", () => {
    assert.equal(guessMimeType("archive.tar.zst"), "application/octet-stream");
    assert.equal(guessMimeType("thing.qqq"), "application/octet-stream");
  });

  await t.test("falls back to application/octet-stream when there is no extension", () => {
    assert.equal(guessMimeType("README"), "application/octet-stream");
    assert.equal(guessMimeType(""), "application/octet-stream");
  });

  await t.test("treats a dotfile as having no extension", () => {
    // node:path.extname(".env") === "" — the leading dot is not an extension.
    assert.equal(guessMimeType(".env"), "application/octet-stream");
  });

  await t.test("uses only the final extension of a multi-dot name", () => {
    assert.equal(guessMimeType("backup.png.zip"), "application/zip");
    assert.equal(guessMimeType("my.report.v2.pdf"), "application/pdf");
  });

  await t.test("resolves extensions off a full path, not just a bare name", () => {
    assert.equal(guessMimeType("/var/tmp/nested/dir/image.webp"), "image/webp");
  });

  await t.test("every entry in the table round-trips through the lookup", () => {
    const entries = Object.entries(EXT_TO_MIME);
    assert.ok(entries.length >= 25, `expected a substantial MIME table, got ${entries.length}`);
    for (const [ext, mime] of entries) {
      assert.equal(guessMimeType(`file${ext}`), mime, `mismatch for ${ext}`);
      assert.equal(guessMimeType(`FILE${ext.toUpperCase()}`), mime, `case mismatch for ${ext}`);
    }
  });
});
