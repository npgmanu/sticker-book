import assert from "node:assert/strict";
import test from "node:test";
import { albumSectionData, stickerCatalogData } from "../app/catalog-data.ts";

test("the checklist catalog contains every official row once", () => {
  assert.equal(stickerCatalogData.length, 980);
  assert.equal(albumSectionData.length, 49);
  assert.equal(new Set(stickerCatalogData.map((sticker) => sticker.code)).size, 980);
  assert.equal(new Set(stickerCatalogData.map((sticker) => sticker.displayCode)).size, 980);
  assert.deepEqual(stickerCatalogData.map((sticker) => sticker.sortOrder), Array.from({ length: 980 }, (_, index) => index + 1));
});

test("section totals agree with their catalog rows", () => {
  for (const section of albumSectionData) {
    const stickers = stickerCatalogData.filter((sticker) => sticker.sectionCode === section.code);
    assert.equal(stickers.length, section.count, section.code);
  }
});

test("special and representative sticker codes retain official display values", () => {
  const stickerZero = stickerCatalogData.find((sticker) => sticker.code === "FWC-00");
  assert.equal(stickerZero?.displayCode, "00");
  assert.equal(stickerZero?.number, 0);
  assert.equal(stickerCatalogData.find((sticker) => sticker.code === "MEX-03")?.displayCode, "MEX3");
  assert.equal(stickerCatalogData.find((sticker) => sticker.code === "PAN-20")?.displayCode, "PAN20");
  assert.equal(stickerCatalogData.at(-1)?.displayCode, "FWC19");
});

test("all checklist metadata needed by the database is present", () => {
  for (const sticker of stickerCatalogData) {
    assert.ok(sticker.name);
    assert.ok(sticker.type);
    assert.ok(sticker.sourceUrl.startsWith("https://"));
    assert.equal(typeof sticker.foil, "boolean");
  }
});
