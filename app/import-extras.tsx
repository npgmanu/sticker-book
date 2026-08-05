"use client";

import { useMemo, useState } from "react";
import { activeAlbum, getCatalogSticker, stickerDisplayNumber } from "./catalog";
import { parseExtrasList, type ExtrasListParseResult } from "./sticker-list-parser";

type Collection = Record<string, number>;

export function ImportExtras({
  collection,
  onClose,
  onImported,
}: {
  collection: Collection;
  onClose: () => void;
  onImported: (collection: Collection, importedExtras: number, updatedStickers: number) => void;
}) {
  const [step, setStep] = useState<"paste" | "review">("paste");
  const [rawList, setRawList] = useState("");
  const [review, setReview] = useState<ExtrasListParseResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const extraCopies = useMemo(
    () => review?.items.reduce((total, item) => total + item.quantity, 0) ?? 0,
    [review],
  );
  const albumCopiesAdded = review?.items.filter((item) => (collection[item.code] ?? 0) === 0).length ?? 0;

  function reviewImport() {
    setReview(parseExtrasList(rawList));
    setError("");
    setStep("review");
  }

  async function confirmImport() {
    if (!review?.items.length) return;
    setImporting(true);
    setError("");
    try {
      const response = await fetch("/api/collection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "import_extras",
          albumId: activeAlbum.id,
          extras: review.items.map((item) => ({ code: item.code, quantity: item.quantity })),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Extras could not be imported");
      onImported(data.collection, data.importedExtras, data.updatedStickers);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Extras could not be imported");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="import-backdrop" role="presentation">
      <section className="import-mode extras-import" role="dialog" aria-modal="true" aria-labelledby="extras-import-title">
        <header className="import-header">
          <button onClick={step === "review" ? () => setStep("paste") : onClose} aria-label={step === "review" ? "Back to duplicate list" : "Close extras import"}>{step === "review" ? "←" : "×"}</button>
          <div><p>TRADE INVENTORY</p><h2 id="extras-import-title">Import Extras</h2></div>
          <span>{step === "paste" ? "1 / 2" : "2 / 2"}</span>
        </header>

        {step === "paste" ? (
          <div className="import-paste-step">
            <div className="import-intro">
              <span>⇧</span>
              <div><p className="eyebrow">PASTE A DUPLICATE LIST</p><h1>Build your trade pile.</h1></div>
            </div>
            <p className="import-copy">Paste the extras you already track. The number after x is the number of extra copies.</p>
            <label className="field-label" htmlFor="extras-import-list">Duplicate list</label>
            <textarea
              id="extras-import-list"
              value={rawList}
              onChange={(event) => setRawList(event.target.value)}
              placeholder={"MEX: 4, 8 x2\nUSA: 3 x2, 14\nBRA: 7"}
              autoFocus
              spellCheck={false}
            />
            <div className="import-format-help">
              <strong>How quantities work</strong>
              <span>MEX4 means one extra copy.</span>
              <span>MEX8 x2 means two extra copies.</span>
              <span>Country names, codes, commas, and line breaks work.</span>
            </div>
            <footer className="import-footer">
              <button className="import-cancel" onClick={onClose}>Cancel</button>
              <button className="import-primary" disabled={!rawList.trim()} onClick={reviewImport}>Review Extras</button>
            </footer>
          </div>
        ) : (
          <div className="import-review-step">
            <div className="review-heading"><p className="eyebrow">REVIEW BEFORE SAVING</p><h1>Check your trade pile.</h1></div>
            <div className="import-detection-stats">
              <div><strong>{review?.items.length ?? 0}</strong><span>Unique stickers</span></div>
              <div><strong>{extraCopies}</strong><span>Extra copies detected</span></div>
            </div>

            {review?.groups.length ? (
              <div className="import-review-groups extras-review-groups">
                {review.groups.map((group) => (
                  <div key={group.section.code}>
                    <strong>{group.section.code}</strong>
                    <span>{group.items.map((item) => {
                      const sticker = getCatalogSticker(item.code)!;
                      return `${stickerDisplayNumber(sticker)} x${item.quantity}`;
                    }).join(", ")}</span>
                  </div>
                ))}
              </div>
            ) : <div className="no-import-matches">No valid extras were detected.</div>}

            <section className={`import-issues ${review?.issues.length ? "has-issues" : "clear"}`}>
              <header><span>{review?.issues.length ? "!" : "✓"}</span><div><strong>{review?.issues.length ? `${review.issues.length} unmatched ${review.issues.length === 1 ? "entry" : "entries"}` : "Everything matched"}</strong><small>{review?.issues.length ? "Review these before saving the matched extras." : "No invalid entries found."}</small></div></header>
              {!!review?.issues.length && <ul>{review.issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul>}
            </section>

            <section className="extras-merge-note">
              <span>✓</span>
              <div><strong>Your existing extras are protected.</strong><p>The app keeps the higher extra count for each sticker. It never reduces or doubles an existing count.</p>{albumCopiesAdded > 0 && <small>{albumCopiesAdded} missing sticker{albumCopiesAdded === 1 ? "" : "s"} will also receive a protected album copy.</small>}</div>
            </section>
            {error && <p className="import-error" role="alert">{error}</p>}
            <footer className="import-footer review">
              <button className="import-cancel" onClick={() => setStep("paste")}>Edit List</button>
              <button className="import-primary" disabled={!review?.items.length || importing} onClick={() => void confirmImport()}>{importing ? "Saving…" : `Save ${extraCopies} Extras`}</button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
