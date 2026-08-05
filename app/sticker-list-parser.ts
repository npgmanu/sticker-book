import { albumSections, getSectionStickers, hasStickerNumber, makeStickerCode, type AlbumSection } from "./catalog";

export type StickerListParseResult = {
  codes: string[];
  groups: { section: AlbumSection; numbers: number[] }[];
  issues: string[];
};

export type ExtrasListItem = {
  code: string;
  section: AlbumSection;
  number: number;
  quantity: number;
};

export type ExtrasListParseResult = {
  items: ExtrasListItem[];
  groups: { section: AlbumSection; items: ExtrasListItem[] }[];
  issues: string[];
};

const extraAliases: Record<string, string[]> = {
  USA: ["America", "United States", "United States of America", "US", "U S A"],
  FWC: ["Introduction", "FIFA Museum", "Opening Page", "Opening Pages", "F W C"],
  KOR: ["South Korea", "Korea"],
  BIH: ["Bosnia", "Bosnia and Herzegovina"],
  TUR: ["Turkey"],
  CIV: ["Ivory Coast", "Cote d Ivoire", "Cote d'Ivoire"],
  NED: ["Holland"],
  IRN: ["Iran"],
  CPV: ["Cape Verde"],
  KSA: ["Saudi"],
  COD: ["DR Congo", "Democratic Republic of the Congo", "Congo"],
};

export function parseStickerList(value: string): StickerListParseResult {
  const aliases = albumSections.flatMap((section) =>
    [section.code, section.name, ...(extraAliases[section.code] ?? [])]
      .map((alias) => ({ alias, section })),
  );
  const aliasMap = new Map(aliases.map(({ alias, section }) => [alias.toLowerCase(), section]));
  const aliasPattern = Array.from(aliasMap.keys())
    .sort((left, right) => right.length - left.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const recognized = new Set<string>();
  const issues: string[] = [];

  value.split(/\r?\n/).forEach((rawLine, lineIndex) => {
    let line = rawLine.trim();
    if (!line) return;
    const standaloneZero = line.match(/^#?00(?=\s*[,;]|$)/);
    if (standaloneZero) {
      recognized.add(makeStickerCode("FWC", 0));
      line = line.slice(standaloneZero[0].length).replace(/^[\s,;]+/, "");
      if (!line) return;
    }
    const matches = Array.from(line.matchAll(new RegExp(`(?:^|[^A-Za-z])(${aliasPattern})(?=\\s*[-:,]?\\s*\\d)`, "gi")))
      .map((match) => {
        const aliasOffset = match[0].toLowerCase().lastIndexOf(match[1].toLowerCase());
        return { alias: match[1], index: (match.index ?? 0) + aliasOffset };
      });

    if (!matches.length) {
      issues.push(`Line ${lineIndex + 1}: “${line}” could not be matched`);
      return;
    }

    const prefix = line.slice(0, matches[0].index).replace(/[\s,:;-]/g, "");
    if (prefix) issues.push(`Line ${lineIndex + 1}: “${prefix}” was not recognized`);

    matches.forEach((match, matchIndex) => {
      const section = aliasMap.get(match.alias.toLowerCase());
      if (!section) return;
      const start = match.index + match.alias.length;
      const end = matchIndex < matches.length - 1 ? matches[matchIndex + 1].index : line.length;
      const segment = line.slice(start, end).replace(/^[\s,:;-]+/, "").trim();
      const tokens = segment.split(/[\s,;]+/).filter(Boolean);

      if (!tokens.length) {
        issues.push(`Line ${lineIndex + 1}: no sticker numbers found after ${section.code}`);
        return;
      }

      let foundNumber = false;
      tokens.forEach((token) => {
        const cleanToken = token.replace(/^#/, "");
        if (/^x\d+$/i.test(cleanToken)) return;
        if (!/^\d+$/.test(cleanToken)) {
          issues.push(`Line ${lineIndex + 1}: “${token}” after ${section.code} was not recognized`);
          return;
        }
        foundNumber = true;
        const number = Number(cleanToken);
        if (!hasStickerNumber(section.code, number)) {
          issues.push(`Line ${lineIndex + 1}: ${section.code} ${number} does not exist`);
          return;
        }
        recognized.add(makeStickerCode(section.code, number));
      });
      if (!foundNumber) issues.push(`Line ${lineIndex + 1}: no sticker numbers found after ${section.code}`);
    });
  });

  const groups = albumSections
    .map((section) => ({
      section,
      numbers: getSectionStickers(section.code)
        .filter((sticker) => recognized.has(sticker.code))
        .map((sticker) => sticker.number),
    }))
    .filter((group) => group.numbers.length);

  return {
    codes: groups.flatMap((group) => group.numbers.map((number) => makeStickerCode(group.section.code, number))),
    groups,
    issues,
  };
}

export function parseExtrasList(value: string): ExtrasListParseResult {
  const aliases = albumSections.flatMap((section) =>
    [section.code, section.name, ...(extraAliases[section.code] ?? [])]
      .map((alias) => ({ alias, section })),
  );
  const aliasMap = new Map(aliases.map(({ alias, section }) => [alias.toLowerCase(), section]));
  const aliasPattern = Array.from(aliasMap.keys())
    .sort((left, right) => right.length - left.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const quantities = new Map<string, number>();
  const issues: string[] = [];

  function addExtra(section: AlbumSection, number: number, quantity: number, lineNumber: number) {
    if (!hasStickerNumber(section.code, number)) {
      issues.push(`Line ${lineNumber}: ${section.code} ${number} does not exist`);
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 98) {
      issues.push(`Line ${lineNumber}: ${section.code} ${number} has an invalid extra quantity`);
      return;
    }
    const code = makeStickerCode(section.code, number);
    quantities.set(code, Math.min(98, (quantities.get(code) ?? 0) + quantity));
  }

  value.split(/\r?\n/).forEach((rawLine, lineIndex) => {
    let line = rawLine.trim();
    if (!line) return;
    const lineNumber = lineIndex + 1;
    const standaloneZero = line.match(/^#?00(?:\s*[x×]\s*(\d{1,3}))?(?=\s*[,;]|$)/i);
    if (standaloneZero) {
      addExtra(albumSections.find((section) => section.code === "FWC")!, 0, Number(standaloneZero[1] ?? 1), lineNumber);
      line = line.slice(standaloneZero[0].length).replace(/^[\s,;]+/, "");
      if (!line) return;
    }

    const matches = Array.from(line.matchAll(new RegExp(`(?:^|[^A-Za-z])(${aliasPattern})(?=\\s*[-:,]?\\s*\\d)`, "gi")))
      .map((match) => {
        const aliasOffset = match[0].toLowerCase().lastIndexOf(match[1].toLowerCase());
        return { alias: match[1], index: (match.index ?? 0) + aliasOffset };
      });

    if (!matches.length) {
      issues.push(`Line ${lineNumber}: “${line}” could not be matched`);
      return;
    }

    const prefix = line.slice(0, matches[0].index).replace(/[\s,:;-]/g, "");
    if (prefix) issues.push(`Line ${lineNumber}: “${prefix}” was not recognized`);

    matches.forEach((match, matchIndex) => {
      const section = aliasMap.get(match.alias.toLowerCase());
      if (!section) return;
      const start = match.index + match.alias.length;
      const end = matchIndex < matches.length - 1 ? matches[matchIndex + 1].index : line.length;
      const segment = line.slice(start, end).replace(/^[\s,:;-]+/, "").trim();
      const numberMatches = Array.from(segment.matchAll(/#?(\d{1,2})(?:\s*[x×]\s*(\d{1,3}))?/gi));

      if (!numberMatches.length) {
        issues.push(`Line ${lineNumber}: no sticker numbers found after ${section.code}`);
        return;
      }

      numberMatches.forEach((numberMatch) => {
        addExtra(section, Number(numberMatch[1]), Number(numberMatch[2] ?? 1), lineNumber);
      });
      const residue = segment
        .replace(/#?\d{1,2}(?:\s*[x×]\s*\d{1,3})?/gi, "")
        .replace(/[\s,;:&+\-]/g, "");
      if (residue) issues.push(`Line ${lineNumber}: “${residue}” after ${section.code} was not recognized`);
    });
  });

  const items = albumSections.flatMap((section) =>
    getSectionStickers(section.code).flatMap((sticker) => {
      const quantity = quantities.get(sticker.code) ?? 0;
      return quantity ? [{ code: sticker.code, section, number: sticker.number, quantity }] : [];
    }),
  );
  const groups = albumSections
    .map((section) => ({ section, items: items.filter((item) => item.section.code === section.code) }))
    .filter((group) => group.items.length);

  return { items, groups, issues };
}
