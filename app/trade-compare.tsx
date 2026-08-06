"use client";

import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { activeAlbum, albumSections, getCatalogSticker, getSectionStickers, makeStickerCode } from "./catalog";
import { parseStickerList, type StickerListParseResult } from "./sticker-list-parser";
import { FlagIcon } from "./flag-icon";

type Collection = Record<string, number>;
type MatchGroup = { code: string; name: string; flag: string; numbers: number[] };
type CompletedTrade = { id: string; received: number; given: number; total: number };

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

function displayNumber(code: string, number: number) {
  return getCatalogSticker(makeStickerCode(code, number))?.displayCode === "00" ? "00" : String(number);
}

function MatchResults({
  title,
  helper,
  groups,
  emptyCopy,
  selected,
  onToggle,
  tone,
}: {
  title: string;
  helper: string;
  groups: MatchGroup[];
  emptyCopy: string;
  selected: Set<string>;
  onToggle: (code: string) => void;
  tone: "incoming" | "outgoing";
}) {
  const count = groups.reduce((total, group) => total + group.numbers.length, 0);
  const selectedCount = groups.reduce(
    (total, group) => total + group.numbers.filter((number) => selected.has(makeStickerCode(group.code, number))).length,
    0,
  );
  return (
    <section className={`compare-result-card ${tone}`}>
      <header><div><p>{title}</p><h3>{helper}</h3></div><span>{selectedCount}/{count}</span></header>
      {groups.length ? <div className="compare-result-groups">{groups.map((group) => (
        <div key={group.code}>
          <strong>{group.code}</strong>
          <span className="compare-select-numbers">{group.numbers.map((number) => {
            const code = makeStickerCode(group.code, number);
            const isSelected = selected.has(code);
            return <button className={isSelected ? "selected" : ""} aria-pressed={isSelected} key={number} onClick={() => onToggle(code)}>{displayNumber(group.code, number)} <i>{isSelected ? "✓" : "+"}</i></button>;
          })}</span>
          <b><FlagIcon code={group.code} fallback={group.flag} /></b>
        </div>
      ))}</div> : <p className="compare-empty-result">{emptyCopy}</p>}
    </section>
  );
}

export function TradeCompare({
  collection,
  basket,
  onCompleteTrade,
  onClose,
}: {
  collection: Collection;
  basket: Collection;
  onCompleteTrade: (incoming: string[], outgoing: string[]) => Promise<CompletedTrade | null>;
  onClose: () => void;
}) {
  const [theirExtras, setTheirExtras] = useState("");
  const [theirNeeds, setTheirNeeds] = useState("");
  const [extrasParse, setExtrasParse] = useState<StickerListParseResult | null>(null);
  const [needsParse, setNeedsParse] = useState<StickerListParseResult | null>(null);
  const [step, setStep] = useState<"paste" | "results" | "review" | "complete">("paste");
  const [selectedIncoming, setSelectedIncoming] = useState<Set<string>>(new Set());
  const [selectedOutgoing, setSelectedOutgoing] = useState<Set<string>>(new Set());
  const [completed, setCompleted] = useState<CompletedTrade | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  const selectedIncomingCodes = theyHaveForYou.filter((code) => selectedIncoming.has(code));
  const selectedOutgoingCodes = youHaveForThem.filter((code) => selectedOutgoing.has(code));
  const selectedTotal = selectedIncomingCodes.length + selectedOutgoingCodes.length;

  function compare() {
    const parsedExtras = theirExtras.trim() ? parseStickerList(theirExtras) : { codes: [], groups: [], issues: [], corrections: [] };
    const parsedNeeds = theirNeeds.trim() ? parseStickerList(theirNeeds) : { codes: [], groups: [], issues: [], corrections: [] };
    const incoming = parsedExtras.codes.filter((code) => (collection[code] ?? 0) === 0);
    const outgoing = parsedNeeds.codes.filter((code) => Math.max(0, (collection[code] ?? 0) - 1 - (basket[code] ?? 0)) > 0);
    setExtrasParse(parsedExtras);
    setNeedsParse(parsedNeeds);
    setSelectedIncoming(new Set(incoming));
    setSelectedOutgoing(new Set(outgoing));
    setStep("results");
    setError("");
    setMessage("");
  }

  function changePaste(side: "have" | "need", value: string) {
    if (side === "have") setTheirExtras(value);
    else setTheirNeeds(value);
    setStep("paste");
    setError("");
  }

  function toggle(setter: Dispatch<SetStateAction<Set<string>>>, code: string) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function clear() {
    setTheirExtras("");
    setTheirNeeds("");
    setExtrasParse(null);
    setNeedsParse(null);
    setSelectedIncoming(new Set());
    setSelectedOutgoing(new Set());
    setStep("paste");
    setError("");
    setMessage("");
  }

  async function completeTrade() {
    setBusy(true);
    setError("");
    const result = await onCompleteTrade(selectedIncomingCodes, selectedOutgoingCodes);
    setBusy(false);
    if (!result) {
      setError("Your collection changed or the trade could not be saved. Compare the lists again.");
      return;
    }
    setCompleted(result);
    setStep("complete");
  }

  async function copyResults() {
    const groupsToLines = (groups: MatchGroup[], selected: Set<string>) => groups.flatMap((group) => {
      const numbers = group.numbers.filter((number) => selected.has(makeStickerCode(group.code, number)));
      return numbers.length ? [`${group.code}: ${numbers.map((number) => displayNumber(group.code, number)).join(", ")}`] : [];
    });
    const theirLines = groupsToLines(theirGroups, selectedIncoming);
    const yourLines = groupsToLines(yourGroups, selectedOutgoing);
    const text = [
      `${activeAlbum.title} Trade`,
      "",
      `I RECEIVE (${selectedIncomingCodes.length})`,
      ...(theirLines.length ? theirLines : ["None"]),
      "",
      `I GIVE (${selectedOutgoingCodes.length})`,
      ...(yourLines.length ? yourLines : ["None"]),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Trade copied");
    } catch {
      setMessage("Could not copy trade");
    }
    window.setTimeout(() => setMessage(""), 1600);
  }

  const smartMatches = [...(extrasParse?.corrections ?? []), ...(needsParse?.corrections ?? [])];

  return (
    <div className="compare-backdrop" role="presentation">
      <section className="compare-mode" role="dialog" aria-modal="true" aria-labelledby="compare-title">
        <header className="compare-header">
          <button onClick={step === "review" ? () => setStep("results") : onClose} aria-label={step === "review" ? "Back to trade matches" : "Close Compare List"}>{step === "review" ? "←" : "×"}</button>
          <div><p>{step === "review" ? "FINAL CHECK" : "SMART TRADE"}</p><h2 id="compare-title">{step === "review" ? "Review Trade" : "Compare Lists"}</h2></div>
          <span>⇄</span>
        </header>

        <div className="compare-body">
          {step === "complete" && completed ? (
            <div className="trade-complete-state compare-complete"><span>✓</span><h2>Trade complete</h2><p><strong>{completed.received}</strong> added to your collection and crossed off Needs. <strong>{completed.given}</strong> removed from your Extras.</p><button onClick={onClose}>Done</button></div>
          ) : step === "review" ? (
            <div className="compare-review">
              <div className="compare-intro"><h1>Ready to update your book.</h1><p>Both sides will update together when you confirm.</p></div>
              <div className="trade-review-summary"><div className="incoming"><span>↓</span><strong>{selectedIncomingCodes.length}</strong><small>added to your collection</small></div><div className="outgoing"><span>↑</span><strong>{selectedOutgoingCodes.length}</strong><small>removed from your extras</small></div></div>
              <MatchResults title="You receive" helper="Crosses these off Needs" groups={groupMatches(selectedIncomingCodes)} emptyCopy="No incoming stickers selected." selected={selectedIncoming} onToggle={(code) => toggle(setSelectedIncoming, code)} tone="incoming" />
              <MatchResults title="You give" helper="Removes these from Extras" groups={groupMatches(selectedOutgoingCodes)} emptyCopy="No outgoing stickers selected." selected={selectedOutgoing} onToggle={(code) => toggle(setSelectedOutgoing, code)} tone="outgoing" />
              {error && <p className="compare-error" role="alert">{error}</p>}
              <div className="compare-confirm-actions"><button onClick={() => setStep("results")}>Back</button><button disabled={!selectedTotal || busy} onClick={() => void completeTrade()}>{busy ? "Saving Trade…" : "Complete Trade"}</button></div>
            </div>
          ) : (
            <>
              <div className="compare-intro"><h1>Build the whole trade.</h1><p>Paste both lists. Smart matching handles country names, codes, loose formatting, and common spelling mistakes.</p></div>

              <label className="compare-paste-card">
                <span className="compare-direction">↓</span>
                <span className="compare-label"><strong>What they have</strong><small>Adds matches to your collection</small></span>
                <textarea value={theirExtras} onChange={(event) => changePaste("have", event.target.value)} placeholder={"MEX 3, 6, 9\nUSA 8 / 12\nGermny: 4, 11"} spellCheck />
                {!!extrasParse?.issues.length && <span className="compare-issues"><b>Could not match these</b>{extrasParse.issues.map((issue, index) => <i key={`${issue}-${index}`}>{issue}</i>)}</span>}
              </label>

              <label className="compare-paste-card needs-card">
                <span className="compare-direction">↑</span>
                <span className="compare-label"><strong>What they need</strong><small>Removes matches from your extras</small></span>
                <textarea value={theirNeeds} onChange={(event) => changePaste("need", event.target.value)} placeholder={"Mexico 3, 6, 9\nU.S.A. 12\nGER11"} spellCheck />
                {!!needsParse?.issues.length && <span className="compare-issues"><b>Could not match these</b>{needsParse.issues.map((issue, index) => <i key={`${issue}-${index}`}>{issue}</i>)}</span>}
              </label>

              {step === "paste" ? (
                <button className="run-compare" disabled={!theirExtras.trim() && !theirNeeds.trim()} onClick={compare}>Find Trade Matches</button>
              ) : (
                <div className="compare-results">
                  {!!smartMatches.length && <div className="smart-match-note"><span>✦</span><div><strong>Smart Paste fixed {smartMatches.length} {smartMatches.length === 1 ? "entry" : "entries"}</strong><small>{smartMatches.slice(0, 3).join(" · ")}{smartMatches.length > 3 ? " · …" : ""}</small></div></div>}
                  <div className="compare-total"><span>⇄</span><div><strong>{selectedTotal}</strong><small>selected for this trade</small></div></div>
                  <MatchResults title="You receive" helper="Adds to Collection and clears Needs" groups={theirGroups} emptyCopy="They do not have any stickers you currently need." selected={selectedIncoming} onToggle={(code) => toggle(setSelectedIncoming, code)} tone="incoming" />
                  <MatchResults title="You give" helper="Removes from your available Extras" groups={yourGroups} emptyCopy="You do not have available extras from their needs list." selected={selectedOutgoing} onToggle={(code) => toggle(setSelectedOutgoing, code)} tone="outgoing" />
                  <button className="review-complete-trade" disabled={!selectedTotal} onClick={() => setStep("review")}>Review &amp; Complete Trade <span>›</span></button>
                  <div className="compare-actions"><button onClick={() => void copyResults()}>▤ Copy Trade</button><button onClick={clear}>Clear</button></div>
                </div>
              )}
              <p className="compare-format-note">Smart Paste accepts MEX3, Mexico 3, “Mexco: #3 / #6,” and similar lists.</p>
            </>
          )}
        </div>
        {message && <div className="compare-toast" role="status">✓ {message}</div>}
      </section>
    </div>
  );
}
