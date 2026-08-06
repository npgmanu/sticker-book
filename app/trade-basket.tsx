"use client";

import { useMemo, useState } from "react";
import { albumSections, getSectionStickers, stickerDisplayCode } from "./catalog";
import { FlagIcon } from "./flag-icon";

export type TradeHistoryEntry = {
  id: string;
  label: string;
  totalStickers: number;
  completedAt: string;
  items: { code: string; quantity: number; direction?: "incoming" | "outgoing" }[];
};

type Collection = Record<string, number>;
type Basket = Record<string, number>;

export function TradeBasket({
  basket,
  collection,
  onAdjust,
  onClear,
  onComplete,
  onUndo,
  onClose,
}: {
  basket: Basket;
  collection: Collection;
  onAdjust: (code: string, delta: 1 | -1) => Promise<void>;
  onClear: () => Promise<void>;
  onComplete: () => Promise<{ id: string; total: number } | null>;
  onUndo: (historyId: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"basket" | "confirm" | "complete">("basket");
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState<{ id: string; total: number } | null>(null);
  const [error, setError] = useState("");
  const items = useMemo(() => albumSections.flatMap((section) =>
    getSectionStickers(section.code).map((sticker) => {
      return { section, code: sticker.code, number: sticker.number, displayCode: sticker.displayCode, reserved: basket[sticker.code] ?? 0 };
    }).filter((item) => item.reserved > 0),
  ), [basket]);
  const groups = albumSections.map((section) => ({ section, items: items.filter((item) => item.section.code === section.code) })).filter((group) => group.items.length);
  const total = items.reduce((sum, item) => sum + item.reserved, 0);

  async function completeTrade() {
    setBusy(true);
    setError("");
    const result = await onComplete();
    setBusy(false);
    if (!result) {
      setError("The trade could not be completed. Review the basket and try again.");
      return;
    }
    setCompleted(result);
    setStep("complete");
  }

  async function undoTrade() {
    if (!completed) return;
    setBusy(true);
    const undone = await onUndo(completed.id);
    setBusy(false);
    if (undone) onClose();
    else setError("This trade can no longer be undone.");
  }

  async function removeAll(code: string, quantity: number) {
    for (let index = 0; index < quantity; index += 1) await onAdjust(code, -1);
  }

  return (
    <div className="basket-backdrop" role="presentation">
      <section className="basket-mode" role="dialog" aria-modal="true" aria-labelledby="basket-title">
        <header className="basket-header"><button onClick={step === "confirm" ? () => setStep("basket") : onClose} aria-label="Close Trade Basket">{step === "confirm" ? "←" : "×"}</button><div><p>{step === "confirm" ? "FINAL CHECK" : "STICKERS YOU'RE GIVING"}</p><h2 id="basket-title">{step === "confirm" ? "Review Trade" : "Trade Basket"}</h2></div><span>{total}<small>stickers</small></span></header>

        {step === "complete" && completed ? (
          <div className="trade-complete-state"><span>✓</span><h2>Trade complete</h2><p>{completed.total} sticker{completed.total === 1 ? " was" : "s were"} removed from Extras. Your basket is now empty.</p>{error && <small>{error}</small>}<button onClick={() => void undoTrade()} disabled={busy}>↶ Undo Trade</button><button onClick={onClose}>Done</button><em>Undo is available for 5 minutes.</em></div>
        ) : (
          <div className="basket-body">
            {step === "confirm" && <div className="confirm-trade-copy"><p className="eyebrow">YOU ARE GIVING</p><h1>Review what you&apos;re giving.</h1><p>Nothing changes until you confirm.</p></div>}
            {groups.length ? <div className={`basket-groups ${step === "confirm" ? "confirming" : ""}`}>{groups.map(({ section, items: groupItems }) => (
              <section className="basket-group" key={section.code}><header><span>{section.code}</span><strong>{section.name}</strong><b><FlagIcon code={section.code} fallback={section.flag} /></b></header><div>{groupItems.map((item) => {
                const extras = Math.max(0, (collection[item.code] ?? 0) - 1);
                const available = Math.max(0, extras - item.reserved);
                return <article key={item.code}><span className="basket-sticker-code"><strong>{item.displayCode}</strong><small>{step === "confirm" ? `Giving ${item.reserved}` : `${item.reserved} in this trade`}</small></span>{step === "confirm" ? <b className="confirm-quantity">×{item.reserved}</b> : <><div className="basket-quantity"><button onClick={() => void onAdjust(item.code, -1)} aria-label={`Decrease ${item.displayCode} in basket`}>−</button><strong>{item.reserved}</strong><button disabled={available < 1} onClick={() => void onAdjust(item.code, 1)} aria-label={`Increase ${item.displayCode} in basket`}>＋</button></div><button className="remove-basket-item" onClick={() => void removeAll(item.code, item.reserved)}>Remove</button></>}</article>;
              })}</div></section>
            ))}</div> : <div className="empty-basket"><span>▱</span><h2>Your basket is empty</h2><p>Add extras to start building a trade.</p></div>}
            {error && <p className="basket-error">{error}</p>}
            <footer className="basket-footer">{step === "confirm" ? <><button onClick={() => setStep("basket")}>Cancel</button><button disabled={!total || busy} onClick={() => void completeTrade()}>{busy ? "Completing…" : `Confirm ${total} Sticker${total === 1 ? "" : "s"}`}</button></> : <><button disabled={!total || busy} onClick={() => void onClear()}>Clear Basket</button><button disabled={!total || busy} onClick={() => setStep("confirm")}>Complete Trade</button></>}</footer>
          </div>
        )}
      </section>
    </div>
  );
}

export function TradeHistory({ history }: { history: TradeHistoryEntry[] }) {
  return (
    <details className="trade-history"><summary><span>⇄</span><strong>Trade History</strong><small>{history.length}</small><b>⌄</b></summary>{history.length ? <div className="trade-history-list">{history.slice(0, 5).map((entry) => <article key={entry.id}><span>⇄</span><div><strong>{entry.label}</strong><small>{new Date(`${entry.completedAt.replace(" ", "T")}Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · {entry.items.length} unique</small><em>{entry.items.slice(0, 4).map((item) => `${item.direction === "incoming" ? "↓" : "↑"} ${stickerDisplayCode(item.code)}${item.quantity > 1 ? ` x${item.quantity}` : ""}`).join(" · ")}{entry.items.length > 4 ? " · …" : ""}</em></div><b>{entry.totalStickers}</b></article>)}</div> : <p className="empty-history">Completed trades will appear here.</p>}</details>
  );
}
