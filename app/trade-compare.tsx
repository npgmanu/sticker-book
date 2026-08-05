"use client";

import { useMemo, useState } from "react";
import { activeAlbum, albumSections, getCatalogSticker, getSectionStickers, makeStickerCode } from "./catalog";
import { parseStickerList, type StickerListParseResult } from "./sticker-list-parser";
import { FlagIcon } from "./flag-icon";

type Collection = Record<string, number>;
type MatchGroup = { code: string; name: string; flag: string; numbers: number[] };

function groupMatches(codes: string[]): MatchGroup[] {
  const codeSet = new Set(codes);
  return albumSections
    .map((section) => ({
      code: section.code,
      name: section.name,
      flag: section.flag,
      numbers: getSectionStickers(section.code)
        .filter((sticker) => codeSet.has(sticker.code))
        .map((sticker) => sticker.number),
    }))
    .filter((group) => group.numbers.length);
}

function MatchResults({ title, groups, emptyCopy, onAddToBasket }: { title: string; groups: MatchGroup[]; emptyCopy: string; onAddToBasket?: (code: string) => void }) {
  const count = groups.reduce((total, group) => total + group.numbers.length, 0);
  const displayNumber = (code: string, number: number) => getCatalogSticker(makeStickerCode(code, number))?.displayCode === "00" ? "00" : String(number);
  return (
    <section className="compare-result-card">
      <header><div><p>{title}</p><h3>{count} match{count === 1 ? "" : "es"}</h3></div><span>{count}</span></header>
      {groups.length ? <div className="compare-result-groups">{groups.map((group) => (
        <div key={group.code}><strong>{group.code}</strong>{onAddToBasket ? <span className="compare-basket-numbers">{group.numbers.map((number) => <button key={number} onClick={() => onAddToBasket(makeStickerCode(group.code, number))}>{displayNumber(group.code, number)} <i>＋</i></button>)}</span> : <span>{group.numbers.map((number) => displayNumber(group.code, number)).join(", ")}</span>}<b><FlagIcon code={group.code} fallback={group.flag} /></b></div>
      ))}</div> : <p className="compare-empty-result">{emptyCopy}</p>}
    </section>
  );
}

export function TradeCompare({ collection, basket, onAddToBasket, onOpenBasket, onClose }: { collection: Collection; basket: Collection; onAddToBasket: (code: string) => void; onOpenBasket: () => void; onClose: () => void }) {
  const [theirExtras, setTheirExtras] = useState("");
  const [theirNeeds, setTheirNeeds] = useState("");
  const [extrasParse, setExtrasParse] = useState<StickerListParseResult | null>(null);
  const [needsParse, setNeedsParse] = useState<StickerListParseResult | null>(null);
  const [compared, setCompared] = useState(false);
  const [message, setMessage] = useState("");

  const theyHaveForYou = useMemo(
    () => (extrasParse?.codes ?? []).filter((code) => (collection[code] ?? 0) === 0),
    [collection, extrasParse],
  );
  const youHaveForThem = useMemo(
    () => (needsParse?.codes ?? []).filter((code) => Math.max(0, (collection[code] ?? 0) - 1 - (basket[code] ?? 0)) > 0),
    [basket, collection, needsParse],
  );
  const theirGroups = useMemo(() => groupMatches(theyHaveForYou), [theyHaveForYou]);
  const yourGroups = useMemo(() => groupMatches(youHaveForThem), [youHaveForThem]);
  const totalMatches = theyHaveForYou.length + youHaveForThem.length;

  function compare() {
    setExtrasParse(theirExtras.trim() ? parseStickerList(theirExtras) : { codes: [], groups: [], issues: [] });
    setNeedsParse(theirNeeds.trim() ? parseStickerList(theirNeeds) : { codes: [], groups: [], issues: [] });
    setCompared(true);
    setMessage("");
  }

  function clear() {
    setTheirExtras("");
    setTheirNeeds("");
    setExtrasParse(null);
    setNeedsParse(null);
    setCompared(false);
    setMessage("");
  }

  async function copyResults() {
    const displayNumber = (code: string, number: number) => getCatalogSticker(makeStickerCode(code, number))?.displayCode === "00" ? "00" : String(number);
    const theirLines = theirGroups.map((group) => `${group.code}: ${group.numbers.map((number) => displayNumber(group.code, number)).join(", ")}`);
    const yourLines = yourGroups.map((group) => `${group.code}: ${group.numbers.map((number) => displayNumber(group.code, number)).join(", ")}`);
    const text = [
      `${activeAlbum.title} Trade Comparison`,
      `${totalMatches} total matches`,
      "",
      `THEY HAVE FOR YOU (${theyHaveForYou.length})`,
      ...(theirLines.length ? theirLines : ["No matches"]),
      "",
      `YOU HAVE FOR THEM (${youHaveForThem.length})`,
      ...(yourLines.length ? yourLines : ["No matches"]),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Results copied");
    } catch {
      setMessage("Could not copy results");
    }
    window.setTimeout(() => setMessage(""), 1600);
  }

  return (
    <div className="compare-backdrop" role="presentation">
      <section className="compare-mode" role="dialog" aria-modal="true" aria-labelledby="compare-title">
        <header className="compare-header">
          <button onClick={onClose} aria-label="Close Compare List">×</button>
          <div><p>TRADE</p><h2 id="compare-title">Compare Lists</h2></div>
          <span>⇄</span>
        </header>

        <div className="compare-body">
          <div className="compare-intro"><h1>Find matching stickers</h1><p>Paste one list or both. This will not change your collection.</p></div>

          <label className="compare-paste-card">
            <span className="compare-direction">↓</span>
            <span className="compare-label"><strong>What they have</strong><small>Matches your Needs</small></span>
            <textarea value={theirExtras} onChange={(event) => { setTheirExtras(event.target.value); setCompared(false); }} placeholder={"MEX 3, 6, 9\nUSA 8, 12\nGermany 4, 11"} spellCheck={false} />
            {!!extrasParse?.issues.length && <span className="compare-issues"><b>Check these entries</b>{extrasParse.issues.map((issue, index) => <i key={`${issue}-${index}`}>{issue}</i>)}</span>}
          </label>

          <label className="compare-paste-card needs-card">
            <span className="compare-direction">↑</span>
            <span className="compare-label"><strong>What they need</strong><small>Matches your Extras</small></span>
            <textarea value={theirNeeds} onChange={(event) => { setTheirNeeds(event.target.value); setCompared(false); }} placeholder={"MEX3, MEX6, MEX9\nUSA 12\nGER 11"} spellCheck={false} />
            {!!needsParse?.issues.length && <span className="compare-issues"><b>Check these entries</b>{needsParse.issues.map((issue, index) => <i key={`${issue}-${index}`}>{issue}</i>)}</span>}
          </label>

          {!compared ? (
            <button className="run-compare" disabled={!theirExtras.trim() && !theirNeeds.trim()} onClick={compare}>Compare Lists</button>
          ) : (
            <div className="compare-results">
              <div className="compare-total"><span>⇄</span><div><strong>{totalMatches}</strong><small>Total matches</small></div></div>
              <MatchResults title="They Have for You" groups={theirGroups} emptyCopy="They do not have any stickers you currently need." />
              <MatchResults title="You Have for Them" groups={yourGroups} emptyCopy="You do not have available extras from their needs list." onAddToBasket={onAddToBasket} />
              <div className="compare-actions"><button onClick={() => void copyResults()}>▤ Copy Results</button><button onClick={onOpenBasket}>▱ Basket {Object.values(basket).reduce((sum, quantity) => sum + quantity, 0)}</button><button onClick={clear}>Clear</button></div>
            </div>
          )}
          <p className="compare-format-note">Works with MEX 3, MEX3, or Mexico 3.</p>
        </div>
        {message && <div className="compare-toast" role="status">✓ {message}</div>}
      </section>
    </div>
  );
}
