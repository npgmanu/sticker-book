"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { activeAlbum, albumSections as sections, catalogStickers, getCatalogSticker, getCatalogStickerByDisplayCode, getSectionStickers, makeStickerCode, stickerDisplayNumber, type AlbumSection } from "./catalog";
import { ImportExtras } from "./import-extras";
import { parseStickerList, type StickerListParseResult } from "./sticker-list-parser";
import { TradeCompare } from "./trade-compare";
import { TradeBasket, TradeHistory, type TradeHistoryEntry } from "./trade-basket";
import { VoiceAdd, type VoiceSavedEntry } from "./voice-add";
import { FlagIcon } from "./flag-icon";
import { AdminDashboard } from "./admin-dashboard";

type Tab = "album" | "needs" | "trade" | "profile";
type Viewer = { name: string; email: string; signedIn: boolean; isAdmin?: boolean };
type Collection = Record<string, number>;
type AccountState = "loading" | "signedOut" | "onboarding" | "ready" | "error";
type SetupMethod = "new" | "already" | "import";
type PackEntry = {
  id: number;
  code: string;
  displayCode: string;
  sectionName: string;
  result: "new" | "extra";
  quantity: number;
};

const icons = {
  album: "▦",
  needs: "◇",
  trade: "⇄",
  profile: "◉",
};

export default function StickerBook({ viewer }: { viewer: Viewer }) {
  const [tab, setTab] = useState<Tab>("album");
  const [selectedSection, setSelectedSection] = useState<AlbumSection | null>(null);
  const [collection, setCollection] = useState<Collection>({});
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importExtrasOpen, setImportExtrasOpen] = useState(false);
  const [basketOpen, setBasketOpen] = useState(false);
  const [basket, setBasket] = useState<Collection>({});
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryEntry[]>([]);
  const [notice, setNotice] = useState("");
  const [pendingSaves, setPendingSaves] = useState(0);
  const [accountState, setAccountState] = useState<AccountState>("loading");
  const [activeViewer, setActiveViewer] = useState(viewer);
  const [displayName, setDisplayName] = useState(viewer.name);
  const collectionRef = useRef<Collection>({});
  const packSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const tradeSaveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    async function loadAccount() {
      try {
        const accountResponse = await fetch("/api/account");
        if (accountResponse.status === 401) { setAccountState("signedOut"); return; }
        if (!accountResponse.ok) throw new Error("Account unavailable");
        const accountData = await accountResponse.json();
        const sessionResponse = await fetch("/api/auth/session");
        const sessionData = await sessionResponse.json();
        if (sessionData.viewer) setActiveViewer({ name: sessionData.viewer.displayName, email: sessionData.viewer.email, signedIn: true, isAdmin: Boolean(sessionData.viewer.isAdmin) });
        if (accountData.profile?.displayName) setDisplayName(accountData.profile.displayName);
        if (!accountData.profile?.onboardingCompleted) {
          setAccountState("onboarding");
          return;
        }

        const [collectionResponse, tradesResponse] = await Promise.all([fetch("/api/collection"), fetch("/api/trades")]);
        if (!collectionResponse.ok || !tradesResponse.ok) throw new Error("Collection unavailable");
        const [collectionData, tradesData] = await Promise.all([collectionResponse.json(), tradesResponse.json()]);
        collectionRef.current = collectionData.collection ?? {};
        setCollection(collectionRef.current);
        setBasket(tradesData.basket ?? {});
        setTradeHistory(tradesData.history ?? []);
        setAccountState("ready");
      } catch {
        setAccountState("error");
      }
    }
    void loadAccount();
  }, []);

  const allStickers = useMemo(
    () => catalogStickers.map((sticker) => ({
      ...sticker,
      section: sections.find((section) => section.code === sticker.sectionCode)!,
    })),
    [],
  );

  const stats = useMemo(() => {
    const quantities = allStickers.map((sticker) => collection[sticker.code] ?? 0);
    const unique = quantities.filter((quantity) => quantity > 0).length;
    const extras = quantities.reduce((sum, quantity) => sum + Math.max(0, quantity - 1), 0);
    return {
      unique,
      missing: allStickers.length - unique,
      extras,
      percent: Math.round((unique / allStickers.length) * 100),
    };
  }, [allStickers, collection]);

  async function setQuantity(code: string, quantity: number) {
    const safeQuantity = Math.max(0, Math.min(99, quantity));
    const previousQuantity = collectionRef.current[code] ?? 0;
    collectionRef.current = { ...collectionRef.current, [code]: safeQuantity };
    setCollection(collectionRef.current);
    if (!activeViewer.signedIn) return;
    setPendingSaves((current) => current + 1);
    try {
      const response = await fetch("/api/collection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, quantity: safeQuantity }),
      });
      if (!response.ok) throw new Error("Save failed");
      if (safeQuantity === 0) setBasket((current) => Object.fromEntries(Object.entries(current).filter(([basketCode]) => basketCode !== code)));
    } catch {
      collectionRef.current = { ...collectionRef.current, [code]: previousQuantity };
      setCollection(collectionRef.current);
      setNotice("That change could not be saved. Try again.");
    } finally {
      setPendingSaves((current) => Math.max(0, current - 1));
    }
  }

  async function adjustQuantity(code: string, delta: 1 | -1) {
    const previousQuantity = collectionRef.current[code] ?? 0;
    const nextQuantity = Math.max(0, Math.min(99, previousQuantity + delta));
    collectionRef.current = { ...collectionRef.current, [code]: nextQuantity };
    setCollection(collectionRef.current);
    setPendingSaves((current) => current + 1);
    try {
      const save = packSaveQueue.current.then(async () => {
        const response = await fetch("/api/collection", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, action: delta === 1 ? "increment" : "decrement" }),
        });
        if (!response.ok) throw new Error("Save failed");
      });
      packSaveQueue.current = save.catch(() => undefined);
      await save;
    } catch {
      collectionRef.current = { ...collectionRef.current, [code]: previousQuantity };
      setCollection(collectionRef.current);
      setNotice("That change could not be saved. Try again.");
    } finally {
      setPendingSaves((current) => Math.max(0, current - 1));
    }
    return { previousQuantity, nextQuantity };
  }

  async function basketAction(action: "basket_adjust" | "clear" | "complete" | "complete_comparison" | "undo" | "traded_one", data: Record<string, unknown> = {}) {
    try {
      const operation = tradeSaveQueue.current.then(async () => {
        const response = await fetch("/api/trades", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...data }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Trade action failed");
        return result;
      });
      tradeSaveQueue.current = operation.then(() => undefined).catch(() => undefined);
      const result = await operation;
      if (result.basket) setBasket(result.basket);
      if (result.collection) { collectionRef.current = result.collection; setCollection(result.collection); }
      if (result.history) setTradeHistory(result.history);
      return result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Trade action failed");
      return null;
    }
  }

  async function adjustBasket(code: string, delta: 1 | -1) { await basketAction("basket_adjust", { code, delta }); }
  async function clearBasket() { await basketAction("clear"); }
  async function tradedOne(code: string) { const result = await basketAction("traded_one", { code }); if (result) setNotice(`${code} traded. One extra removed.`); }
  async function completeTrade() { const result = await basketAction("complete"); return result?.completed ?? null; }
  async function completeComparedTrade(incoming: string[], outgoing: string[]) {
    const result = await basketAction("complete_comparison", { incoming, outgoing });
    if (result) setNotice(`${result.completed.received} added and ${result.completed.given} traded.`);
    return result?.completed ?? null;
  }
  async function undoTrade(historyId: string) { const result = await basketAction("undo", { historyId }); if (result) setNotice("Trade undone. Your collection was restored."); return Boolean(result); }

  const basketTotal = Object.values(basket).reduce((sum, quantity) => sum + quantity, 0);

  const activeTitle = selectedSection
    ? selectedSection.name
    : tab === "album"
      ? "My Album"
      : tab === "needs"
        ? "Still Needed"
        : tab === "trade"
          ? "Extras"
          : "Collector Profile";

  if (accountState === "signedOut") return <AccountGate />;
  if (accountState === "loading") return <AccountLoading />;
  if (accountState === "error") return <AccountError />;
  if (accountState === "onboarding") {
    return (
      <Onboarding
        defaultName={displayName}
        onComplete={(data) => {
          setDisplayName(data.displayName);
          collectionRef.current = data.collection;
          setCollection(data.collection);
          setAccountState("ready");
        }}
      />
    );
  }

  const displayedViewer = { ...activeViewer, name: displayName };

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <div className="phone-frame">
        <header className="topbar">
          <button
            className={`icon-button ${selectedSection ? "is-visible" : ""}`}
            aria-label="Back to album"
            onClick={() => setSelectedSection(null)}
          >
            ←
          </button>
          <div className="brand-lockup">
            <span className="brand-mark">SB</span>
            <span>STICKER BOOK</span>
          </div>
          <span className="topbar-spacer" aria-hidden="true" />
        </header>

        <section className="page-content" aria-live="polite">
          {selectedSection ? (
            <StickerGrid
              section={selectedSection}
              collection={collection}
              setQuantity={setQuantity}
              basket={basket}
              onAddToBasket={(code) => void adjustBasket(code, 1)}
              onOpenBasket={() => setBasketOpen(true)}
              onSelectSection={(nextSection) => {
                setSelectedSection(nextSection);
                document.querySelector(".phone-frame")?.scrollTo({ top: 0, behavior: "smooth" });
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            />
          ) : tab === "album" ? (
            <AlbumView
              stats={stats}
              collection={collection}
              onOpenSection={setSelectedSection}
            />
          ) : tab === "needs" ? (
            <ListView
              kind="needs"
              stickers={allStickers.filter((sticker) => (collection[sticker.code] ?? 0) === 0)}
              collection={collection}
              setQuantity={setQuantity}
              basket={basket}
              tradeHistory={tradeHistory}
              onBasketAdjust={adjustBasket}
              onTradedOne={tradedOne}
              onCompleteComparedTrade={completeComparedTrade}
              onOpenBasket={() => setBasketOpen(true)}
            />
          ) : tab === "trade" ? (
            <ListView
              kind="trade"
              stickers={allStickers.filter((sticker) => (collection[sticker.code] ?? 0) > 1)}
              collection={collection}
              setQuantity={setQuantity}
              basket={basket}
              tradeHistory={tradeHistory}
              onBasketAdjust={adjustBasket}
              onTradedOne={tradedOne}
              onCompleteComparedTrade={completeComparedTrade}
              onOpenBasket={() => setBasketOpen(true)}
              onImportExtras={() => setImportExtrasOpen(true)}
            />
          ) : (
            <ProfileView viewer={displayedViewer} stats={stats} onImport={() => setImportOpen(true)} />
          )}
        </section>

        {basketTotal > 0 && <button className="basket-fab" onClick={() => setBasketOpen(true)}><span>▱</span> Trade Pile <b>{basketTotal}</b></button>}

        <nav className="bottom-nav" aria-label="Primary navigation">
          {(["album", "needs"] as Tab[]).map((item) => (
            <button
              key={item}
              className={tab === item && !selectedSection ? "active" : ""}
              onClick={() => { setSelectedSection(null); setTab(item); }}
              aria-current={tab === item && !selectedSection ? "page" : undefined}
            >
              <span className="nav-icon">{icons[item]}</span>
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
          <button className="nav-add" onClick={() => setAddOpen(true)} aria-label="Add Stickers">
            <span className="nav-add-icon">＋</span>
            <span className="nav-add-label">Add</span>
          </button>
          {(["trade", "profile"] as Tab[]).map((item) => (
            <button
              key={item}
              className={tab === item && !selectedSection ? "active" : ""}
              onClick={() => { setSelectedSection(null); setTab(item); }}
              aria-current={tab === item && !selectedSection ? "page" : undefined}
            >
              <span className="nav-icon">{icons[item]}</span>
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>

        {addOpen && (
          <PackMode
            stickers={allStickers}
            collection={collection}
            onAdjust={adjustQuantity}
            onClose={() => setAddOpen(false)}
          />
        )}
        {importOpen && (
          <ImportCollection
            collection={collection}
            onClose={() => setImportOpen(false)}
            onImported={(nextCollection, importedCount) => {
              collectionRef.current = nextCollection;
              setCollection(nextCollection);
              setImportOpen(false);
              setNotice(`${importedCount} missing stickers imported.`);
            }}
          />
        )}
        {importExtrasOpen && (
          <ImportExtras
            collection={collection}
            onClose={() => setImportExtrasOpen(false)}
            onImported={(nextCollection, importedExtras, updatedStickers) => {
              collectionRef.current = nextCollection;
              setCollection(nextCollection);
              setImportExtrasOpen(false);
              setNotice(updatedStickers > 0 ? `${importedExtras} extras added to Trade.` : "Your Trade pile was already up to date.");
            }}
          />
        )}
        {basketOpen && <TradeBasket basket={basket} collection={collection} onAdjust={adjustBasket} onClear={clearBasket} onComplete={completeTrade} onUndo={undoTrade} onClose={() => setBasketOpen(false)} />}

        {notice && (
          <button className="toast" onClick={() => setNotice("")}>
            {notice} <span>×</span>
          </button>
        )}
        {pendingSaves > 0 && <span className="save-dot" aria-label="Saving" />}
        <span className="sr-only">Current page: {activeTitle}</span>
      </div>
    </main>
  );
}

function normalizePackCode(value: string) {
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact === "00") return makeStickerCode("FWC", 0);
  const officialSticker = getCatalogStickerByDisplayCode(compact);
  if (officialSticker) return officialSticker.code;
  const match = compact.match(/^([A-Z]{3})(\d{1,2})$/);
  if (!match) return null;
  const code = makeStickerCode(match[1], Number(match[2]));
  return getCatalogSticker(code) ? code : null;
}

function PackMode({
  stickers,
  collection,
  onAdjust,
  onClose,
}: {
  stickers: { section: AlbumSection; number: number; code: string; displayCode: string; name: string }[];
  collection: Collection;
  onAdjust: (code: string, delta: 1 | -1) => Promise<{ previousQuantity: number; nextQuantity: number }>;
  onClose: () => void;
}) {
  const [entry, setEntry] = useState("");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [recent, setRecent] = useState<PackEntry[]>([]);
  const [feedback, setFeedback] = useState<{ kind: "new" | "extra" | "error"; code: string } | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const entryRef = useRef<HTMLInputElement>(null);
  const quantityRef = useRef(collection);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryId = useRef(0);

  useEffect(() => {
    quantityRef.current = collection;
  }, [collection]);

  useEffect(() => {
    entryRef.current?.focus();
    return () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
  }, []);

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    const directCode = normalizePackCode(query);
    return stickers
      .filter((sticker) => {
        if (directCode && sticker.code === directCode) return true;
        const numberMatch = /^\d{1,2}$/.test(query) && sticker.number === Number(query);
        return (
          sticker.section.name.toLowerCase().includes(query) ||
          sticker.section.code.toLowerCase().includes(query) ||
          sticker.code.toLowerCase().includes(query) ||
          sticker.displayCode.toLowerCase().includes(query) ||
          sticker.name.toLowerCase().includes(query) ||
          numberMatch
        );
      })
      .slice(0, 8);
  }, [search, stickers]);

  function refocus() {
    requestAnimationFrame(() => entryRef.current?.focus());
  }

  function showFeedback(nextFeedback: { kind: "new" | "extra" | "error"; code: string }) {
    setFeedback(nextFeedback);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 1200);
  }

  function addSticker(code: string) {
    const sticker = stickers.find((item) => item.code === code);
    if (!sticker) {
      showFeedback({ kind: "error", code: entry || code });
      refocus();
      return;
    }

    const previousQuantity = quantityRef.current[sticker.code] ?? 0;
    const nextQuantity = Math.min(99, previousQuantity + 1);
    quantityRef.current = { ...quantityRef.current, [sticker.code]: nextQuantity };
    entryId.current += 1;
    setRecent((current) => [
      {
        id: entryId.current,
        code: sticker.code,
        displayCode: sticker.displayCode,
        sectionName: sticker.section.name,
        result: previousQuantity === 0 ? "new" : "extra",
        quantity: nextQuantity,
      },
      ...current,
    ].slice(0, 7));
    showFeedback({ kind: previousQuantity === 0 ? "new" : "extra", code: sticker.displayCode });
    setEntry("");
    setSearch("");
    void onAdjust(sticker.code, 1);
    refocus();
  }

  function submitEntry(event: React.FormEvent) {
    event.preventDefault();
    const code = normalizePackCode(entry);
    if (!code) {
      showFeedback({ kind: "error", code: entry });
      refocus();
      return;
    }
    addSticker(code);
  }

  function correctEntry(item: PackEntry) {
    const currentQuantity = quantityRef.current[item.code] ?? 0;
    quantityRef.current = { ...quantityRef.current, [item.code]: Math.max(0, currentQuantity - 1) };
    setRecent((current) => current.filter((entryItem) => entryItem.id !== item.id));
    void onAdjust(item.code, -1);
    showFeedback({ kind: "error", code: `${item.displayCode} removed` });
    refocus();
  }

  function undoLatest() {
    const [latest] = recent;
    if (!latest) return;
    correctEntry(latest);
  }

  function addVoiceResults(entries: VoiceSavedEntry[]) {
    const packEntries = entries.map((item) => {
      entryId.current += 1;
      return { ...item, displayCode: getCatalogSticker(item.code)?.displayCode ?? item.code, id: entryId.current };
    });
    setRecent((current) => [...packEntries, ...current].slice(0, 7));
    const latest = packEntries[0];
    if (latest) showFeedback({ kind: latest.result, code: latest.code });
  }

  return (
    <div className="pack-backdrop" role="presentation">
      <section className="pack-mode" role="dialog" aria-modal="true" aria-labelledby="pack-title">
        <header className="pack-header">
          <button onClick={onClose} aria-label="Close Add Stickers">×</button>
          <div><p>FAST ENTRY</p><h2 id="pack-title">Add Stickers</h2></div>
          <span className="pack-session-count"><b>{recent.length}</b><small>added</small></span>
        </header>

        <div className="pack-entry-zone">
          <p className="pack-instruction">Enter one sticker code at a time</p>
          <form className="pack-form" onSubmit={submitEntry}>
            <input
              ref={entryRef}
              value={entry}
              onChange={(event) => setEntry(event.target.value.toUpperCase())}
              placeholder="MEX3"
              aria-label="Sticker code"
              autoComplete="off"
              autoCapitalize="characters"
              enterKeyHint="go"
              spellCheck={false}
            />
            <button className="voice-button" type="button" onClick={() => setVoiceOpen(true)} aria-label="Add stickers by voice">🎙</button>
            <button className="pack-add-button" type="submit" aria-label="Add sticker">＋</button>
          </form>
          <div className={`pack-feedback ${feedback?.kind ?? "idle"}`} aria-live="assertive">
            {feedback?.kind === "new" && <><span>✓</span><strong>NEW</strong><small>{feedback.code} added</small></>}
            {feedback?.kind === "extra" && <><span>＋</span><strong>EXTRA +1</strong><small>{feedback.code} added</small></>}
            {feedback?.kind === "error" && <><span>!</span><strong>{feedback.code.endsWith("removed") ? "UNDONE" : "CODE NOT FOUND"}</strong><small>{feedback.code.endsWith("removed") ? feedback.code : "Try a code like USA12 or BRA8"}</small></>}
            {!feedback && <><span>↵</span><strong>READY</strong><small>Try MEX3 or USA12</small></>}
          </div>
        </div>

        <div className="pack-scroll">
          <section className="recent-entries">
            <div className="pack-section-title">
              <div><p className="eyebrow">THIS SESSION</p><h3>Recently entered</h3></div>
              <button onClick={undoLatest} disabled={!recent.length}>↶ Undo last</button>
            </div>
            {recent.length ? (
              <div className="entry-list">
                {recent.map((item) => (
                  <div className="entry-row" key={item.id}>
                    <span className={`entry-badge ${item.result}`}>{item.result === "new" ? "NEW" : "+1"}</span>
                    <span className="entry-details"><strong>{item.displayCode}</strong><small>{item.sectionName}</small></span>
                    <span className="entry-quantity">×{collection[item.code] ?? item.quantity}</span>
                    <button onClick={() => correctEntry(item)} aria-label={`Remove entry ${item.code}`}>−1</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-session"><span>▱</span><p>Your latest stickers will appear here.</p></div>
            )}
          </section>

          <section className={`pack-search ${searchOpen ? "open" : ""}`}>
            <button className="search-toggle" onClick={() => { setSearchOpen((current) => !current); setSearch(""); }} aria-expanded={searchOpen}>
              <span>⌕</span><strong>Can&apos;t find a code? Search instead</strong><b>{searchOpen ? "−" : "+"}</b>
            </button>
            {searchOpen && <>
              <div className="search-field">
                <span>⌕</span>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Country, section, or number" aria-label="Search stickers" />
                {search && <button onClick={() => setSearch("")} aria-label="Clear search">×</button>}
              </div>
              {search && (
                <div className="search-results">
                  {searchResults.length ? searchResults.map((sticker) => (
                    <button key={sticker.code} onClick={() => addSticker(sticker.code)}>
                      <FlagIcon code={sticker.section.code} fallback={sticker.section.flag} />
                      <span><strong>{sticker.displayCode}</strong><small>{sticker.section.name} · {sticker.name}</small></span>
                      <b>{(collection[sticker.code] ?? 0) > 0 ? `×${collection[sticker.code]}` : "ADD"}</b>
                    </button>
                  )) : <p>No stickers match that search.</p>}
                </div>
              )}
            </>}
          </section>
        </div>
        {voiceOpen && <VoiceAdd stickers={stickers} collection={collection} onAdjust={onAdjust} onSaved={addVoiceResults} onClose={() => { setVoiceOpen(false); refocus(); }} />}
      </section>
    </div>
  );
}

function ImportCollection({
  collection,
  onClose,
  onImported,
}: {
  collection: Collection;
  onClose: () => void;
  onImported: (collection: Collection, importedCount: number) => void;
}) {
  const [step, setStep] = useState<"paste" | "review">("paste");
  const [rawList, setRawList] = useState("");
  const [review, setReview] = useState<StickerListParseResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const currentCollected = Object.values(collection).filter((quantity) => quantity > 0).length;
  const currentExtras = Object.values(collection).reduce(
    (total, quantity) => total + Math.max(0, quantity - 1),
    0,
  );

  function reviewImport() {
    const parsed = parseStickerList(rawList);
    setReview(parsed);
    setAcknowledged(false);
    setError("");
    setStep("review");
  }

  async function confirmImport() {
    if (!review?.codes.length || !acknowledged) return;
    setImporting(true);
    setError("");
    try {
      const response = await fetch("/api/collection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "import_missing",
          albumId: activeAlbum.id,
          missingCodes: review.codes,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Import failed");
      onImported(data.collection, data.importedMissing);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="import-backdrop" role="presentation">
      <section className="import-mode" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <header className="import-header">
          <button onClick={step === "review" ? () => setStep("paste") : onClose} aria-label={step === "review" ? "Back to pasted list" : "Close import"}>{step === "review" ? "←" : "×"}</button>
          <div><p>{activeAlbum.title.toUpperCase()}</p><h2 id="import-title">Import Collection</h2></div>
          <span>{step === "paste" ? "1 / 2" : "2 / 2"}</span>
        </header>

        {step === "paste" ? (
          <div className="import-paste-step">
            <div className="import-intro">
              <span>↧</span>
              <div><p className="eyebrow">PASTE A MISSING LIST</p><h1>Bring your list with you.</h1></div>
            </div>
            <p className="import-copy">Paste the missing stickers you already track in Notes, a spreadsheet, text, or a social post.</p>
            <label className="field-label" htmlFor="collection-import">Missing-sticker list</label>
            <textarea
              id="collection-import"
              value={rawList}
              onChange={(event) => setRawList(event.target.value)}
              placeholder={"FWC 4, 8\nMEX 3, 6, 7, 9, 10\nRSA 4, 5, 7, 15, 19\nUSA 6, 7, 8, 12"}
              autoFocus
              spellCheck={false}
            />
            <div className="import-format-help">
              <strong>Flexible formatting</strong>
              <span>Commas, spaces, and line breaks all work.</span>
              <span>Codes can look like MEX3 or MEX 3.</span>
              <span>Uppercase and lowercase are both accepted.</span>
            </div>
            <div className="selected-import-album">
              <span>{String(activeAlbum.year).slice(-2)}</span><div><small>SELECTED ALBUM</small><strong>{activeAlbum.title}</strong></div><b>✓</b>
            </div>
            <footer className="import-footer">
              <button className="import-cancel" onClick={onClose}>Cancel</button>
              <button className="import-primary" disabled={!rawList.trim()} onClick={reviewImport}>Review Import</button>
            </footer>
          </div>
        ) : (
          <div className="import-review-step">
            <div className="review-heading"><p className="eyebrow">REVIEW BEFORE IMPORTING</p><h1>Here&apos;s what we found.</h1></div>
            <div className="import-detection-stats">
              <div><strong>{review?.codes.length ?? 0}</strong><span>Missing stickers detected</span></div>
              <div><strong>{review?.groups.length ?? 0}</strong><span>Sections found</span></div>
            </div>

            {review?.groups.length ? (
              <div className="import-review-groups">
                {review.groups.map((group) => (
                  <div key={group.section.code}>
                    <strong>{group.section.code}</strong>
                    <span>{group.numbers.join(", ")}</span>
                  </div>
                ))}
              </div>
            ) : <div className="no-import-matches">No valid stickers were detected.</div>}

            <section className={`import-issues ${review?.issues.length ? "has-issues" : "clear"}`}>
              <header><span>{review?.issues.length ? "!" : "✓"}</span><div><strong>{review?.issues.length ? `${review.issues.length} unmatched ${review.issues.length === 1 ? "entry" : "entries"}` : "Everything matched"}</strong><small>{review?.issues.length ? "These entries will not be imported." : "No invalid entries found."}</small></div></header>
              {!!review?.issues.length && <ul>{review.issues.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul>}
            </section>

            <section className="replacement-warning">
              <span>!</span>
              <div><strong>This replaces your current collected and missing status.</strong><p>{currentCollected} collected stickers will be recalculated from this list. Your {currentExtras} existing extra{currentExtras === 1 ? "" : "s"} will not be changed.</p><small>Extras stay saved even if their code appears in the missing list.</small></div>
            </section>
            <label className="import-acknowledge">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span>I understand this will replace my current collection status.</span>
            </label>
            {error && <p className="import-error" role="alert">{error}</p>}
            <footer className="import-footer review">
              <button className="import-cancel" onClick={() => setStep("paste")}>Edit List</button>
              <button className="import-primary" disabled={!review?.codes.length || !acknowledged || importing} onClick={() => void confirmImport()}>{importing ? "Importing…" : `Import ${review?.codes.length ?? 0} Needs`}</button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}

function AccountGate() {
  const [mode, setMode] = useState<"signup" | "login" | "reset">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const response = await fetch(`/api/auth/${mode === "reset" ? "manual-reset" : mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mode === "reset" ? { email, resetCode, newPassword: password } : { email, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Account request failed");
      if (mode === "reset") { setMode("login"); setPassword(""); setResetCode(""); setError("Password reset. You can sign in now."); setSaving(false); return; }
      window.location.reload();
    } catch (accountError) { setError(accountError instanceof Error ? accountError.message : "Account request failed"); setSaving(false); }
  }
  return (
    <main className="app-shell account-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <section className="phone-frame account-gate">
        <div className="account-brand"><span className="brand-mark">SB</span><span>STICKER BOOK</span></div>
        <div className="gate-art" aria-hidden="true">
          <div className="gate-sticker gate-one"><span>USA</span><strong>04</strong></div>
          <div className="gate-sticker gate-two"><span>BRA</span><strong>07</strong></div>
          <div className="gate-sticker gate-three"><span>GER</span><strong>11</strong></div>
        </div>
        <div className="gate-copy">
          <p className="eyebrow">YOUR COLLECTION. YOUR PROGRESS.</p>
          <h1>Every sticker has its place.</h1>
          <p>Track what you own, find what you need, and keep your trade pile ready.</p>
        </div>
        <form className="account-form" onSubmit={submit}>
          <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
          {mode === "reset" && <label>Reset code<input value={resetCode} onChange={(event) => setResetCode(event.target.value)} autoComplete="one-time-code" required /></label>}
          <label>{mode === "reset" ? "New password" : "Password"}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "signup" || mode === "reset" ? "new-password" : "current-password"} minLength={10} required /></label>
          {error && <p className="import-error" role="alert">{error}</p>}
          <button className="primary-account-action" type="submit" disabled={saving}>{saving ? "Please wait…" : mode === "signup" ? "Create account" : mode === "reset" ? "Reset password" : "Sign in"}</button>
          <button className="account-switch" type="button" onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setError(""); }}>{mode === "signup" ? "I already have an account" : "Create a new account"}</button>
          {mode === "login" && <button className="account-switch reset-link" type="button" onClick={() => { setMode("reset"); setError("Contact the site owner to request a one-time reset code."); }}>Forgot password?</button>}
          {mode === "reset" && <button className="account-switch" type="button" onClick={() => { setMode("login"); setError(""); }}>Back to sign in</button>}
        </form>
        <p className="privacy-note"><span>●</span> Your sticker collection stays private to your account.</p>
      </section>
    </main>
  );
}

function AccountLoading() {
  return (
    <main className="app-shell account-shell">
      <section className="phone-frame state-screen">
        <div className="account-brand"><span className="brand-mark">SB</span><span>STICKER BOOK</span></div>
        <div className="loading-sticker"><span>Loading your album</span><i /></div>
      </section>
    </main>
  );
}

function AccountError() {
  return (
    <main className="app-shell account-shell">
      <section className="phone-frame state-screen">
        <div className="account-brand"><span className="brand-mark">SB</span><span>STICKER BOOK</span></div>
        <div className="error-card">
          <span>!</span>
          <h1>We could not open your collection.</h1>
          <p>Your stickers are safe. Reload the page to try again.</p>
          <button onClick={() => window.location.reload()}>Try again</button>
          <button onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.reload(); }}>Sign out</button>
        </div>
      </section>
    </main>
  );
}

function parseStickerCodes(value: string) {
  return parseStickerList(value).codes;
}

function Onboarding({
  defaultName,
  onComplete,
}: {
  defaultName: string;
  onComplete: (data: { displayName: string; collection: Collection }) => void;
}) {
  const [step, setStep] = useState(1);
  const [displayName, setDisplayName] = useState(defaultName.includes("@") ? "" : defaultName);
  const [albumId, setAlbumId] = useState("world-cup-2026");
  const [method, setMethod] = useState<SetupMethod | null>(null);
  const [quickCode, setQuickCode] = useState("");
  const [missingCodes, setMissingCodes] = useState<string[]>([]);
  const [importList, setImportList] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const validCodes = useMemo(
    () => new Set(catalogStickers.map((sticker) => sticker.code)),
    [],
  );
  const importedCodes = useMemo(
    () => parseStickerCodes(importList).filter((code) => validCodes.has(code)),
    [importList, validCodes],
  );

  function addMissingCode(event: React.FormEvent) {
    event.preventDefault();
    const [code] = parseStickerCodes(quickCode);
    if (!code || !validCodes.has(code)) {
      setError("Try a sticker code like USA-04.");
      return;
    }
    setMissingCodes((current) => (current.includes(code) ? current : [...current, code]));
    setQuickCode("");
    setError("");
  }

  async function finishSetup() {
    if (!method) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim(),
          albumId,
          setupMethod: method,
          missingCodes: method === "already" ? missingCodes : method === "import" ? importedCodes : [],
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Setup could not be saved");
      onComplete({ displayName: data.profile.displayName, collection: data.collection });
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : "Setup could not be saved");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="app-shell onboarding-shell">
      <section className="phone-frame onboarding-frame">
        <header className="onboarding-header">
          <div className="account-brand"><span className="brand-mark">SB</span><span>STICKER BOOK</span></div>
          <span>{step} of 3</span>
        </header>
        <div className="onboarding-progress" aria-label={`Step ${step} of 3`}>
          {[1, 2, 3].map((item) => <i key={item} className={item <= step ? "active" : ""} />)}
        </div>

        <div className="onboarding-body">
          {step === 1 && (
            <section className="onboarding-step welcome-step">
              <div className="welcome-emblem"><span><small>WORLD ALBUM</small><strong>26</strong></span></div>
              <p className="eyebrow">WELCOME TO STICKER BOOK</p>
              <h1>Let&apos;s set up your collection.</h1>
              <p className="step-copy">This takes less than a minute. First, what should we call you?</p>
              <label className="field-label" htmlFor="display-name">Display name</label>
              <input
                className="text-field"
                id="display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value.slice(0, 40))}
                placeholder="Manny"
                autoComplete="nickname"
              />
              <p className="field-help">No profile details needed.</p>
            </section>
          )}

          {step === 2 && (
            <section className="onboarding-step">
              <p className="eyebrow">CHOOSE AN ALBUM</p>
              <h1>Which book are you collecting?</h1>
              <p className="step-copy">You can add more albums later.</p>
              <button className={`album-choice ${albumId === "world-cup-2026" ? "selected" : ""}`} onClick={() => setAlbumId("world-cup-2026")}>
                <span className="choice-cover"><small>WORLD ALBUM</small><b>26</b><em>STICKER BOOK</em></span>
                <span><small>SOCCER · 2026</small><strong>World Cup 2026</strong><em>{sections.length} sections · {validCodes.size} stickers</em></span>
                <i>✓</i>
              </button>
              <div className="future-albums"><span>＋</span><p><strong>More albums coming</strong><small>Your account is ready for future collections.</small></p></div>
            </section>
          )}

          {step === 3 && (
            <section className="onboarding-step setup-step">
              <p className="eyebrow">SET UP YOUR COLLECTION</p>
              <h1>Where are you starting?</h1>
              <p className="step-copy">Choose the quickest match. You can change any sticker later.</p>
              <div className="setup-options">
                <button className={method === "new" ? "selected" : ""} onClick={() => { setMethod("new"); setError(""); }}>
                  <span className="setup-icon">◇</span><span><strong>Starting a new album</strong><small>Everything starts missing.</small></span><i>✓</i>
                </button>
                <button className={method === "already" ? "selected" : ""} onClick={() => { setMethod("already"); setError(""); }}>
                  <span className="setup-icon">✓</span><span><strong>Already working on my album</strong><small>Tell us only what is missing.</small></span><i>✓</i>
                </button>
                <button className={method === "import" ? "selected" : ""} onClick={() => { setMethod("import"); setError(""); }}>
                  <span className="setup-icon">↧</span><span><strong>Import a list</strong><small>Paste your existing needs list.</small></span><i>✓</i>
                </button>
              </div>

              {method === "new" && <div className="method-note"><span>◇</span><p><strong>All {validCodes.size} stickers will start missing.</strong><small>Add each one as it goes into your physical album.</small></p></div>}

              {method === "already" && (
                <div className="missing-setup">
                  <label className="field-label" htmlFor="quick-missing">Add missing sticker codes</label>
                  <form onSubmit={addMissingCode} className="quick-missing-form">
                    <input id="quick-missing" value={quickCode} onChange={(event) => setQuickCode(event.target.value)} placeholder="USA-04" autoComplete="off" />
                    <button type="submit">Add</button>
                  </form>
                  <p className="field-help">Everything else will start as collected.</p>
                  {missingCodes.length > 0 && <div className="missing-tokens">{missingCodes.map((code) => <button key={code} onClick={() => setMissingCodes((current) => current.filter((item) => item !== code))}>{code}<span>×</span></button>)}</div>}
                  <strong className="recognized-count">{missingCodes.length} marked missing</strong>
                </div>
              )}

              {method === "import" && (
                <div className="missing-setup">
                  <label className="field-label" htmlFor="import-list">Paste your missing-sticker list</label>
                  <textarea id="import-list" value={importList} onChange={(event) => setImportList(event.target.value)} placeholder={"USA-04, USA-09\nGER-11\nBRA-07"} />
                  <p className="field-help">Separate codes with commas, spaces, or new lines.</p>
                  <strong className="recognized-count">{importedCodes.length} sticker{importedCodes.length === 1 ? "" : "s"} recognized</strong>
                </div>
              )}
            </section>
          )}
        </div>

        {error && <p className="onboarding-error" role="alert">{error}</p>}
        <footer className="onboarding-footer">
          {step > 1 && <button className="back-step" onClick={() => { setStep((current) => current - 1); setError(""); }}>Back</button>}
          {step < 3 ? (
            <button className="next-step" disabled={step === 1 && !displayName.trim()} onClick={() => setStep((current) => current + 1)}>Continue</button>
          ) : (
            <button className="next-step" disabled={!method || saving} onClick={() => void finishSetup()}>{saving ? "Saving…" : "Open my album"}</button>
          )}
        </footer>
      </section>
    </main>
  );
}

function AlbumView({
  stats,
  collection,
  onOpenSection,
}: {
  stats: { unique: number; missing: number; extras: number; percent: number };
  collection: Collection;
  onOpenSection: (section: AlbumSection) => void;
}) {
  const [filter, setFilter] = useState<"all" | "incomplete" | "completed">("all");
  const sectionProgress = useMemo(
    () =>
      sections.map((section, albumOrder) => {
        const collected = getSectionStickers(section.code)
          .map((sticker) => collection[sticker.code] ?? 0)
          .filter((quantity) => quantity > 0).length;
        return {
          section,
          collected,
          complete: collected === section.count,
          percentage: Math.round((collected / section.count) * 100),
          albumOrder,
        };
      }),
    [collection],
  );
  const visibleSections = sectionProgress
    .filter((item) => filter === "all" || (filter === "completed" ? item.complete : !item.complete))
    .sort((a, b) => (filter === "all" && a.complete !== b.complete ? Number(a.complete) - Number(b.complete) : a.albumOrder - b.albumOrder));

  return (
    <>
      <section className="album-hero">
        <div className="album-spectrum" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        <div className="album-kicker">MY ACTIVE ALBUM <span>⌄</span></div>
        <div className="album-title-row">
          <div className="cup-ball"><small>WORLD</small><strong>26</strong></div>
          <div>
            <h1>World Cup 2026</h1>
            <p>International Edition · {catalogStickers.length} stickers</p>
          </div>
        </div>
        <div className="completion-row">
          <div className="completion-number">
            <strong>{stats.percent}%</strong>
            <span>complete</span>
          </div>
          <div className="completion-copy">
            <strong>{stats.missing} still needed</strong>
            <span>{stats.extras} extra{stats.extras === 1 ? "" : "s"} ready to trade</span>
          </div>
        </div>
        <div className="hero-progress"><span style={{ width: `${stats.percent}%` }} /></div>
        <p className="collected-total">{stats.unique} of {catalogStickers.length} stickers collected</p>
      </section>

      <section className="section-list">
        <div className="section-heading">
          <div><p className="eyebrow">ALBUM SECTIONS</p><h2>Teams &amp; highlights</h2></div>
          <span>{visibleSections.length} shown</span>
        </div>
        <div className="section-filters" role="group" aria-label="Filter album sections">
          {(["all", "incomplete", "completed"] as const).map((item) => (
            <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
              {item[0].toUpperCase() + item.slice(1)}
              <span>{item === "all" ? sectionProgress.length : sectionProgress.filter((section) => item === "completed" ? section.complete : !section.complete).length}</span>
            </button>
          ))}
        </div>
        <div className="section-card-list">
          {visibleSections.map(({ section, collected, complete, percentage }) => (
            <button className={`section-card tone-${section.tone} ${complete ? "is-complete" : ""}`} key={section.code} onClick={() => onOpenSection(section)}>
              <span className="flag-tile"><FlagIcon code={section.code} fallback={section.flag} /></span>
              <span className="section-info">
                <strong>{section.name}</strong>
                <span className="section-meta"><b>{section.code}</b><i>·</i><em>{collected} / {section.count}</em></span>
                <span className="mini-progress"><i style={{ width: `${percentage}%` }} /></span>
              </span>
              <span className={`section-count ${complete ? "complete" : ""}`}>
                {complete ? "✓" : <><strong>{percentage}</strong><small>%</small></>}
              </span>
              <span className="chevron">›</span>
            </button>
          ))}
          {!visibleSections.length && <div className="empty-filter"><span>✓</span><strong>No sections here yet</strong><small>Keep collecting and check back.</small></div>}
        </div>
      </section>
    </>
  );
}

function StickerGrid({
  section,
  collection,
  setQuantity,
  basket,
  onAddToBasket,
  onOpenBasket,
  onSelectSection,
}: {
  section: AlbumSection;
  collection: Collection;
  setQuantity: (code: string, quantity: number) => void;
  basket: Collection;
  onAddToBasket: (code: string) => void;
  onOpenBasket: () => void;
  onSelectSection: (section: AlbumSection) => void;
}) {
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  const stickers = getSectionStickers(section.code);
  const collected = stickers.filter((sticker) => (collection[sticker.code] ?? 0) > 0).length;
  const sectionIndex = sections.findIndex((item) => item.code === section.code);
  const previousSection = sectionIndex > 0 ? sections[sectionIndex - 1] : null;
  const nextSection = sectionIndex < sections.length - 1 ? sections[sectionIndex + 1] : null;

  function moveTo(nextSectionToOpen: AlbumSection | null) {
    if (!nextSectionToOpen) return;
    setExpandedCode(null);
    onSelectSection(nextSectionToOpen);
  }

  return (
    <section className="grid-page">
      <div className={`section-banner tone-${section.tone}`}>
        <span className="big-flag"><FlagIcon code={section.code} fallback={section.flag} /></span>
        <div><p>{section.code}</p><h1>{section.name}</h1><span>{collected} of {section.count} collected</span></div>
        <strong>{Math.round((collected / section.count) * 100)}%</strong>
      </div>
      <SectionTurner previousSection={previousSection} nextSection={nextSection} sectionIndex={sectionIndex} onMove={moveTo} />
      <div className="grid-legend">
        <span><i className="legend-missing" /> Missing</span>
        <span><i className="legend-owned" /> Collected</span>
        <span><i className="legend-extra" /> Extra</span>
      </div>
      <div className="sticker-grid">
        {stickers.map((sticker) => {
          const quantity = collection[sticker.code] ?? 0;
          const extras = Math.max(0, quantity - 1);
          const reserved = basket[sticker.code] ?? 0;
          const available = Math.max(0, extras - reserved);
          const isExpanded = expandedCode === sticker.code;
          return (
            <article className={`sticker-tile ${quantity === 0 ? "missing" : quantity === 1 ? "owned" : "extra"} ${isExpanded ? "expanded" : ""}`} key={sticker.code}>
              <button className="sticker-main" onClick={() => quantity === 0 && setQuantity(sticker.code, 1)} aria-label={`${sticker.displayCode}, ${quantity === 0 ? "missing, tap to collect" : `collected, quantity ${quantity}`}`}>
                <span className="foil-corner" />
                {quantity === 0 ? <span className="missing-mark">○</span> : <span className="collected-check">✓</span>}
                {extras > 0 && <span className="extra-corner">+{extras}</span>}
                <span className="sticker-code">{sticker.displayCode}</span>
                <strong>{stickerDisplayNumber(sticker).padStart(2, "0")}</strong>
                <span className="sticker-state">{quantity === 0 ? "MISSING · TAP TO ADD" : extras > 0 ? `COLLECTED · ${extras} EXTRA${extras === 1 ? "" : "S"}` : "COLLECTED"}</span>
              </button>
              {quantity > 0 && (
                <div className="tile-quick-actions">
                  <button className="increase-extra" onClick={() => setQuantity(sticker.code, quantity + 1)} aria-label={`Add an extra ${sticker.displayCode}`}>＋ Extra</button>
                  <button className="manage-sticker" onClick={() => setExpandedCode(isExpanded ? null : sticker.code)} aria-expanded={isExpanded} aria-label={`Manage ${sticker.displayCode}`}>{isExpanded ? "Close" : "Manage"}</button>
                </div>
              )}
              {isExpanded && <div className="sticker-manage-panel">
                <p>{extras === 0 ? "No extras" : `${extras} extra${extras === 1 ? "" : "s"}${reserved ? ` · ${reserved} in Trade Pile` : ""}`}</p>
                {extras > 0 && <button disabled={available < 1} onClick={() => setQuantity(sticker.code, Math.max(1, quantity - 1))}>Remove Extra</button>}
                {extras > 0 && <button disabled={available < 1} onClick={() => onAddToBasket(sticker.code)}>{available > 0 ? "Add to Trade Pile" : "All in Trade Pile"}</button>}
                {reserved > 0 && <button onClick={onOpenBasket}>Open Trade Pile</button>}
                {quantity === 1 ? <button className="mark-missing" onClick={() => { setQuantity(sticker.code, 0); setExpandedCode(null); }}>Mark Missing</button> : <small>Album copy protected</small>}
              </div>}
            </article>
          );
        })}
      </div>
      <SectionTurner previousSection={previousSection} nextSection={nextSection} sectionIndex={sectionIndex} onMove={moveTo} compact />
    </section>
  );
}

function SectionTurner({
  previousSection,
  nextSection,
  sectionIndex,
  onMove,
  compact = false,
}: {
  previousSection: AlbumSection | null;
  nextSection: AlbumSection | null;
  sectionIndex: number;
  onMove: (section: AlbumSection | null) => void;
  compact?: boolean;
}) {
  return (
    <nav className={`section-turner ${compact ? "compact" : ""}`} aria-label="Move between album sections">
      <button disabled={!previousSection} onClick={() => onMove(previousSection)}>
        <span>‹</span><span><small>PREVIOUS</small><strong>{previousSection?.code ?? "Start"}</strong></span>
      </button>
      <span>{sectionIndex + 1} / {sections.length}</span>
      <button disabled={!nextSection} onClick={() => onMove(nextSection)}>
        <span><small>NEXT</small><strong>{nextSection?.code ?? "End"}</strong></span><span>›</span>
      </button>
    </nav>
  );
}

function ListView({ kind, stickers, collection, setQuantity, basket, tradeHistory, onBasketAdjust, onTradedOne, onCompleteComparedTrade, onOpenBasket, onImportExtras }: { kind: "needs" | "trade"; stickers: { section: AlbumSection; number: number; code: string; displayCode: string }[]; collection: Collection; setQuantity: (code: string, quantity: number) => void; basket: Collection; tradeHistory: TradeHistoryEntry[]; onBasketAdjust: (code: string, delta: 1 | -1) => Promise<void>; onTradedOne: (code: string) => Promise<void>; onCompleteComparedTrade: (incoming: string[], outgoing: string[]) => Promise<{ id: string; received: number; given: number; total: number } | null>; onOpenBasket: () => void; onImportExtras?: () => void }) {
  const [actionMessage, setActionMessage] = useState("");
  const [compareOpen, setCompareOpen] = useState(false);
  const [tradeSearch, setTradeSearch] = useState("");
  const isNeeds = kind === "needs";
  const searchText = tradeSearch.trim().toLowerCase();
  const compactSearch = searchText.replace(/[^a-z0-9]/g, "");
  const visibleStickers = !isNeeds && searchText
    ? stickers.filter((sticker) => {
        const searchable = `${sticker.section.code} ${sticker.section.name} ${sticker.code} ${sticker.displayCode} ${sticker.number}`.toLowerCase();
        const compactSticker = `${sticker.section.code}${sticker.number}`.toLowerCase();
        if (!compactSearch) return searchable.includes(searchText);
        if (/^\d+$/.test(compactSearch)) return sticker.number === Number(compactSearch);
        return searchable.includes(searchText) || searchable.replace(/[^a-z0-9]/g, "").includes(compactSearch) || compactSticker.includes(compactSearch);
      })
    : stickers;
  const allGrouped = sections
    .map((section) => ({
      section,
      stickers: stickers.filter((sticker) => sticker.section.code === section.code),
    }))
    .filter((group) => group.stickers.length);
  const grouped = sections
    .map((section) => ({
      section,
      stickers: visibleStickers.filter((sticker) => sticker.section.code === section.code),
    }))
    .filter((group) => group.stickers.length);
  const totalStickers = catalogStickers.length;
  const uniqueCollected = Object.values(collection).filter((quantity) => quantity > 0).length;
  const completion = Math.round((uniqueCollected / totalStickers) * 100);
  const totalDuplicates = stickers.reduce(
    (total, sticker) => total + Math.max(0, (collection[sticker.code] ?? 0) - 1),
    0,
  );
  const totalReserved = Object.values(basket).reduce((sum, quantity) => sum + quantity, 0);
  const totalAvailable = stickers.reduce((sum, sticker) => sum + Math.max(0, (collection[sticker.code] ?? 0) - 1 - (basket[sticker.code] ?? 0)), 0);
  const uniqueAvailable = stickers.filter((sticker) => Math.max(0, (collection[sticker.code] ?? 0) - 1 - (basket[sticker.code] ?? 0)) > 0).length;

  const plainTextLines = allGrouped.map(({ section, stickers: groupStickers }) => {
    const numbers = groupStickers.flatMap((sticker) => {
      if (isNeeds) return stickerDisplayNumber(sticker);
      const available = Math.max(0, (collection[sticker.code] ?? 0) - 1 - (basket[sticker.code] ?? 0));
      if (available === 0) return [];
      return available > 1 ? `${stickerDisplayNumber(sticker)} x${available}` : stickerDisplayNumber(sticker);
    });
    return `${section.code}: ${numbers.join(", ")}`;
  }).filter((line) => !line.endsWith(": "));
  const listText = isNeeds
    ? [`World Cup 2026 Needs`, `${stickers.length} needed · ${completion}% complete`, "", ...plainTextLines].join("\n")
    : [`World Cup 2026 Available Extras`, `${uniqueAvailable} unique · ${totalAvailable} available`, "", ...plainTextLines].join("\n");

  function showActionMessage(message: string) {
    setActionMessage(message);
    window.setTimeout(() => setActionMessage(""), 1600);
  }

  async function copyList() {
    try {
      await navigator.clipboard.writeText(listText);
      showActionMessage("List copied");
    } catch {
      showActionMessage("Could not copy the list");
    }
  }

  async function shareList() {
    if (!navigator.share) {
      await copyList();
      return;
    }
    try {
      await navigator.share({
        title: isNeeds ? "My World Cup 2026 Needs" : "My World Cup 2026 Extras",
        text: listText,
      });
      showActionMessage("List shared");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        showActionMessage("Sharing was not available");
      }
    }
  }

  return (
    <section className={`list-page auto-list-page ${kind}`}>
      <div className={`list-hero ${kind}`}>
        <div className="list-hero-heading">
          <div>
            <p className="eyebrow">{isNeeds ? "MY COLLECTION" : "TRADE"}</p>
            <h1>{isNeeds ? "Needs" : "Extras"}</h1>
          </div>
        </div>
        {isNeeds ? (
          <div className="needs-total"><strong>{stickers.length}</strong><span>stickers still needed</span><small>{completion}% complete</small></div>
        ) : (
          <>
            <div className="list-summary two">
              <div><strong>{stickers.length}</strong><span>Unique extras</span></div>
              <div><strong>{totalDuplicates}</strong><span>Total extra stickers</span></div>
            </div>
            {totalReserved > 0 && <p className="basket-summary"><strong>{totalReserved}</strong> in Trade Pile <span>·</span> <strong>{totalAvailable}</strong> ready to trade</p>}
          </>
        )}

        <div className={`list-actions ${isNeeds ? "needs-actions" : ""}`}>
          <button onClick={() => void copyList()}><span>▤</span> Copy List</button>
          <button onClick={() => void shareList()}><span>↗</span> Share List</button>
          {isNeeds && <button onClick={() => setCompareOpen(true)}><span>⇄</span> Compare</button>}
          {!isNeeds && <button onClick={onImportExtras}><span>⇧</span> Import</button>}
        </div>
      </div>

      {!isNeeds && (
        <div className="trade-tools"><button className="basket-launch" onClick={onOpenBasket}><span>▱</span><strong>Trade Pile</strong><b>{Object.values(basket).reduce((sum, quantity) => sum + quantity, 0)}</b></button><button className="compare-launch" onClick={() => setCompareOpen(true)}><span>⇄</span><strong>Compare Lists</strong><b>›</b></button></div>
      )}

      {!isNeeds && (
        <div className="trade-search-wrap">
          <label className="trade-search-field">
            <span>⌕</span>
            <input value={tradeSearch} onChange={(event) => setTradeSearch(event.target.value)} placeholder="Search team or sticker, e.g. USA8" aria-label="Search trade extras" />
            {tradeSearch && <button type="button" onClick={() => setTradeSearch("")} aria-label="Clear trade search">×</button>}
          </label>
          <small>{searchText ? `${visibleStickers.length} matching extra${visibleStickers.length === 1 ? "" : "s"}` : "Search by team, country code, sticker code, or number"}</small>
        </div>
      )}

      <div className="group-list auto-groups">
        <div className="list-explainer">
          <span>{isNeeds ? "Tap a number when you collect it." : searchText ? "Showing matching extras only." : "The first copy always stays in your album."}</span>
          <small>{grouped.length} section{grouped.length === 1 ? "" : "s"}</small>
        </div>
        {grouped.length ? grouped.map(({ section, stickers: groupStickers }) => (
          <article className="auto-list-group" key={section.code}>
            <header>
              <span className="auto-code">{section.code}</span>
              <span className="auto-section-name"><b><FlagIcon code={section.code} fallback={section.flag} /></b><strong>{section.name}</strong></span>
              <small>{isNeeds ? groupStickers.length : groupStickers.reduce((total, sticker) => total + Math.max(0, (collection[sticker.code] ?? 0) - 1), 0)}</small>
            </header>
            {isNeeds ? <div className="number-list">
              {groupStickers.map((sticker, index) => {
                const extras = Math.max(0, (collection[sticker.code] ?? 0) - 1);
                return (
                  <span key={sticker.code}>
                    <button onClick={() => setQuantity(sticker.code, isNeeds ? 1 : Math.max(1, (collection[sticker.code] ?? 1) - 1))} aria-label={isNeeds ? `Mark ${sticker.code} collected` : `Remove one extra ${sticker.code}`}>
                      {stickerDisplayNumber(sticker)}{!isNeeds && extras > 1 && <b>x{extras}</b>}
                    </button>
                    {index < groupStickers.length - 1 && <i>,</i>}
                  </span>
                );
              })}
            </div> : <div className="extra-inventory-list">{groupStickers.map((sticker) => {
              const quantity = collection[sticker.code] ?? 0;
              const extras = Math.max(0, quantity - 1);
              const reserved = basket[sticker.code] ?? 0;
              const available = Math.max(0, extras - reserved);
              return <article className="extra-inventory-row" key={sticker.code}><div className="extra-identity"><strong>{sticker.displayCode}</strong><small><b>{extras}</b> extra{extras === 1 ? "" : "s"} <span>·</span> <b>{reserved}</b> in Trade Pile <span>·</span> <b>{available}</b> ready</small></div><div className="extra-stepper"><button disabled={available < 1} onClick={() => setQuantity(sticker.code, Math.max(1, quantity - 1))} aria-label={`Remove one extra ${sticker.displayCode}`}>−</button><strong>{extras}</strong><button onClick={() => setQuantity(sticker.code, quantity + 1)} aria-label={`Add one extra ${sticker.displayCode}`}>＋</button></div><div className="extra-row-actions"><button disabled={available < 1} onClick={() => void onBasketAdjust(sticker.code, 1)}>{available > 0 ? "＋ Add to Trade Pile" : "All in Trade Pile"}</button><button disabled={available < 1} onClick={() => void onTradedOne(sticker.code)}>Traded One</button></div></article>;
            })}</div>}
          </article>
        )) : (
          <div className={`list-complete-state ${isNeeds ? "needs" : "extras"}`}>
            <span>{isNeeds ? "✓" : searchText ? "⌕" : "◇"}</span>
            <h2>{isNeeds ? "Album complete!" : searchText ? "No matching extras" : "No extras yet"}</h2>
            <p>{isNeeds ? "You have every sticker." : searchText ? "Try another team name, country code, or sticker number." : "Additional copies you add will appear here."}</p>
          </div>
        )}
      </div>
      {!isNeeds && <TradeHistory history={tradeHistory} />}
      {compareOpen && <TradeCompare collection={collection} basket={basket} onCompleteTrade={onCompleteComparedTrade} onClose={() => setCompareOpen(false)} />}
      {actionMessage && <div className="list-action-toast" role="status">✓ {actionMessage}</div>}
    </section>
  );
}

function ProfileView({
  viewer,
  stats,
  onImport,
}: {
  viewer: Viewer;
  stats: { unique: number; missing: number; extras: number; percent: number };
  onImport: () => void;
}) {
  return (
    <section className="profile-page">
      <div className="profile-card">
        <div className="profile-avatar">{viewer.name.slice(0, 1).toUpperCase()}</div>
        <h1>{viewer.name}</h1>
        <p>{viewer.signedIn ? viewer.email : "Sign in to save your collection across devices."}</p>
      </div>
      <div className="profile-stats">
        <div><strong>{stats.percent}%</strong><span>Album complete</span></div>
        <div><strong>{stats.unique + stats.extras}</strong><span>Total stickers</span></div>
      </div>
      <div className="settings-list">
        <div className="active-album-setting"><span>▣</span><div><strong>World Cup 2026</strong><small>Active album</small></div></div>
        <button onClick={onImport}><span>↧</span><div><strong>Import collection</strong><small>Paste a missing-sticker list</small></div><b>›</b></button>
        <AccountTools />
        {viewer.isAdmin && <AdminDashboard />}
        <a className="settings-link" href="/privacy"><span>i</span><div><strong>Privacy</strong><small>How your account data is used</small></div><b>›</b></a>
      </div>
      {viewer.signedIn && <button className="signout" onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.reload(); }}>Sign out</button>}
    </section>
  );
}

function AccountTools() {
  const [panel, setPanel] = useState<"none" | "password" | "delete">("none");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  async function changePassword(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setMessage("");
    const response = await fetch("/api/auth/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
    const data = await response.json(); setSaving(false);
    if (!response.ok) { setMessage(data.error ?? "Password could not be changed"); return; }
    setMessage("Password changed successfully."); setCurrentPassword(""); setNewPassword("");
  }
  async function deleteAccount(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setMessage("");
    const response = await fetch("/api/auth/delete-account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: deletePassword, confirmation }) });
    const data = await response.json(); setSaving(false);
    if (!response.ok) { setMessage(data.error ?? "Account could not be deleted"); return; }
    window.location.reload();
  }
  return <>
    <button onClick={() => { setPanel(panel === "password" ? "none" : "password"); setMessage(""); }}><span>⌁</span><div><strong>Change password</strong><small>Update your account password</small></div><b>›</b></button>
    {panel === "password" && <form className="account-settings-form" onSubmit={changePassword}><input type="password" placeholder="Current password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /><input type="password" placeholder="New password, 10+ characters" minLength={10} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /><button disabled={saving}>{saving ? "Saving…" : "Change password"}</button>{message && <p>{message}</p>}</form>}
    <button className="danger-setting" onClick={() => { setPanel(panel === "delete" ? "none" : "delete"); setMessage(""); }}><span>!</span><div><strong>Delete account</strong><small>Permanently remove your data</small></div><b>›</b></button>
    {panel === "delete" && <form className="account-settings-form danger-form" onSubmit={deleteAccount}><p>This permanently deletes your account, collection, and trade history.</p><input type="password" placeholder="Password" value={deletePassword} onChange={(event) => setDeletePassword(event.target.value)} required /><input placeholder="Type DELETE" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /><button disabled={saving || confirmation !== "DELETE"}>{saving ? "Deleting…" : "Delete account forever"}</button>{message && <p>{message}</p>}</form>}
  </>;
}
