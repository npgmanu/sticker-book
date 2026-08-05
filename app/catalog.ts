import { albumSectionData, stickerCatalogData } from "./catalog-data";

export type AlbumSection = {
  code: string;
  name: string;
  flag: string;
  tone: string;
  count: number;
};

export type CatalogSticker = {
  id: string;
  sectionId: string;
  sectionCode: string;
  code: string;
  displayCode: string;
  number: number;
  sortOrder: number;
  team: string;
  name: string;
  type: string;
  position: string | null;
  foil: boolean;
  sourceUrl: string;
};

export const activeAlbum = {
  id: "world-cup-2026",
  slug: "world-cup-2026",
  title: "World Cup 2026",
  year: 2026,
};

export const albumSections: AlbumSection[] = albumSectionData.map((section) => ({ ...section }));
export const catalogStickers: CatalogSticker[] = stickerCatalogData.map((sticker) => ({ ...sticker }));

const catalogByCode = new Map(catalogStickers.map((sticker) => [sticker.code, sticker]));
const catalogByDisplayCode = new Map(catalogStickers.map((sticker) => [sticker.displayCode, sticker]));
const sectionStickerMap = new Map(
  albumSections.map((section) => [
    section.code,
    catalogStickers.filter((sticker) => sticker.sectionCode === section.code),
  ]),
);

export function makeStickerCode(section: string, number: number) {
  return `${section.toUpperCase()}-${String(number).padStart(2, "0")}`;
}

export function getCatalogSticker(code: string) {
  return catalogByCode.get(code.toUpperCase());
}

export function getCatalogStickerByDisplayCode(displayCode: string) {
  return catalogByDisplayCode.get(displayCode.toUpperCase());
}

export function getSectionStickers(sectionCode: string) {
  return sectionStickerMap.get(sectionCode.toUpperCase()) ?? [];
}

export function hasStickerNumber(sectionCode: string, number: number) {
  return catalogByCode.has(makeStickerCode(sectionCode, number));
}

export function stickerDisplayNumber(sticker: Pick<CatalogSticker, "displayCode" | "number">) {
  return sticker.displayCode === "00" ? "00" : String(sticker.number);
}

export function stickerDisplayCode(code: string) {
  return getCatalogSticker(code)?.displayCode ?? code.replace("-", "");
}
