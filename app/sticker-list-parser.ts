import { albumSections, getSectionStickers, hasStickerNumber, makeStickerCode, type AlbumSection } from "./catalog";

export type StickerListParseResult = {
  codes: string[];
  groups: { section: AlbumSection; numbers: number[] }[];
  issues: string[];
  corrections: string[];
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

const pasteStopWords = new Set([
  "a", "and", "available", "duplicates", "extras", "for", "give", "has", "have", "i", "list", "me", "my",
  "need", "needs", "numbers", "of", "stickers", "team", "the", "their", "they", "to", "trade", "want", "wants",
  "what", "you", "your",
]);

function normalizeWords(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function fuzzySectionFromLine(line: string, aliases: { alias: string; normalized: string; section: AlbumSection }[]) {
  const firstNumber = line.search(/\d/);
  if (firstNumber < 0) return null;
  const words = normalizeWords(line.slice(0, firstNumber)).split(/\s+/).filter((word) => word && !pasteStopWords.has(word));
  if (!words.length) return null;
  const phrases = new Set<string>();
  for (let start = 0; start < words.length; start += 1) {
    for (let length = 1; length <= Math.min(6, words.length - start); length += 1) {
      phrases.add(words.slice(start, start + length).join(""));
    }
  }

  const bestBySection = new Map<string, { alias: string; phrase: string; distance: number; section: AlbumSection }>();
  aliases.forEach(({ alias, normalized, section }) => {
    const target = normalized.replace(/\s/g, "");
    phrases.forEach((phrase) => {
      if (Math.abs(phrase.length - target.length) > Math.max(2, Math.floor(target.length * 0.25))) return;
      const distance = editDistance(phrase, target);
      const allowed = target.length <= 3 ? 1 : target.length <= 7 ? 1 : Math.max(2, Math.floor(target.length * 0.2));
      if (distance > allowed) return;
      const current = bestBySection.get(section.code);
      if (!current || distance < current.distance || (distance === current.distance && target.length > current.alias.length)) {
        bestBySection.set(section.code, { alias, phrase, distance, section });
      }
    });
  });
  const ranked = Array.from(bestBySection.values()).sort((left, right) => left.distance - right.distance || right.alias.length - left.alias.length);
  if (!ranked.length || (ranked[1] && ranked[0].distance === ranked[1].distance && ranked[0].alias.length === ranked[1].alias.length)) return null;
  return ranked[0];
}

function numbersFromSegment(segment: string) {
  const withoutQuantities = segment.replace(/(\d)\s*[x×]\s*\d+/gi, "$1");
  const numbers: number[] = [];
  for (const match of withoutQuantities.matchAll(/#?(\d{1,4})(?:\s*[-–—]\s*#?(\d{1,4}))?/g)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (match[2] && end >= start && end - start <= 30) {
      for (let number = start; number <= end; number += 1) numbers.push(number);
    } else {
      numbers.push(start);
    }
  }
  return numbers;
}

export function parseStickerList(value: string): StickerListParseResult {
  const aliases = albumSections.flatMap((section) =>
    [section.code, section.name, ...(extraAliases[section.code] ?? [])]
      .map((alias) => ({ alias, normalized: normalizeWords(alias), section })),
  );
  const recognized = new Set<string>();
  const issues: string[] = [];
  const corrections = new Set<string>();

  const exactPatterns = aliases
    .map((entry) => ({
      ...entry,
      pattern: entry.normalized.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^A-Za-z0-9]*"),
    }))
    .sort((left, right) => right.pattern.length - left.pattern.length);

  value.split(/\r?\n/).forEach((rawLine, lineIndex) => {
    let line = rawLine.trim();
    if (!line) return;
    const standaloneZero = line.match(/^#?00(?=\s*[,;]|$)/);
    if (standaloneZero) {
      recognized.add(makeStickerCode("FWC", 0));
      line = line.slice(standaloneZero[0].length).replace(/^[\s,;]+/, "");
      if (!line) return;
    }
    const exactMatches = exactPatterns.flatMap((entry) => Array.from(line.matchAll(new RegExp(`(?:^|[^A-Za-z])(${entry.pattern})(?=$|[^A-Za-z])`, "gi"))).map((match) => {
      const aliasOffset = match[0].length - match[1].length;
      return { alias: match[1], index: (match.index ?? 0) + aliasOffset, length: match[1].length, section: entry.section };
    }));
    const matches = exactMatches
      .sort((left, right) => left.index - right.index || right.length - left.length)
      .filter((match, index, all) => !all.slice(0, index).some((kept) => match.index < kept.index + kept.length));

    if (!matches.length) {
      const fuzzy = fuzzySectionFromLine(line, aliases);
      if (!fuzzy) {
        issues.push(`Line ${lineIndex + 1}: “${line}” could not be matched`);
        return;
      }
      matches.push({ alias: fuzzy.phrase, index: 0, length: line.search(/\d/), section: fuzzy.section });
      corrections.add(`${fuzzy.phrase.toUpperCase()} → ${fuzzy.section.name}`);
    }

    matches.forEach((match, matchIndex) => {
      const section = match.section;
      const start = match.index + match.length;
      const end = matchIndex < matches.length - 1 ? matches[matchIndex + 1].index : line.length;
      const segment = line.slice(start, end);
      const numbers = numbersFromSegment(segment);
      if (!numbers.length) {
        issues.push(`Line ${lineIndex + 1}: no sticker numbers found after ${section.code}`);
        return;
      }
      numbers.forEach((number) => {
        if (!hasStickerNumber(section.code, number)) {
          issues.push(`Line ${lineIndex + 1}: ${section.code} ${number} does not exist`);
          return;
        }
        recognized.add(makeStickerCode(section.code, number));
      });
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
    corrections: Array.from(corrections),
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
