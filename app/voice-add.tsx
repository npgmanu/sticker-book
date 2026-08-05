"use client";

import { useEffect, useRef, useState } from "react";
import { albumSections, getSectionStickers, hasStickerNumber, makeStickerCode, type AlbumSection } from "./catalog";

export type VoiceSavedEntry = {
  code: string;
  sectionName: string;
  result: "new" | "extra";
  quantity: number;
};

type Sticker = { section: AlbumSection; number: number; code: string };
type Draft = {
  id: number;
  sectionCode: string;
  number: number;
  quantity: number;
  uncertain: boolean;
  note?: string;
};
type SpeechResultEvent = {
  results: ArrayLike<{ 0: { transcript: string }; length: number }>;
};
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const numberWords: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

function normalizeSpeech(value: string) {
  return value
    .toLowerCase()
    .replace(/\b([a-z])\.\s*([a-z])\.\s*([a-z])\.?/g, "$1 $2 $3")
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/g, (word) => String(numberWords[word]))
    .replace(/\s+/g, " ")
    .trim();
}

export function parseVoiceList(transcript: string) {
  const text = normalizeSpeech(transcript);
  const aliases = albumSections.flatMap((section) => {
    const spelledCode = section.code.toLowerCase().split("").join(" ");
    const extraAliases = section.code === "USA"
      ? ["america", "united states of america", "u s a"]
      : section.code === "FWC"
        ? ["opening page", "opening pages", "f w c"]
        : [];
    return [section.name.toLowerCase(), section.code.toLowerCase(), spelledCode, ...extraAliases]
      .map((alias) => ({ alias, section }));
  });
  const aliasMap = new Map<string, AlbumSection>();
  aliases.forEach(({ alias, section }) => aliasMap.set(alias, section));
  const escapedAliases = Array.from(aliasMap.keys())
    .sort((left, right) => right.length - left.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matches = Array.from(text.matchAll(new RegExp(`\\b(${escapedAliases.join("|")})\\b`, "g")));
  const warnings: string[] = [];
  const drafts: Draft[] = [];
  let nextId = 1;

  if (!matches.length) {
    return { drafts, warnings: ["No country or section could be matched."] };
  }

  const prefix = text.slice(0, matches[0].index ?? 0).trim();
  const prefixQuantity = prefix.match(/(\d+)\s*(?:copies|copy|of)(?:\s+of)?\s*$/);
  const unknownPrefix = prefix
    .replace(/\d+\s*(?:copies|copy|of)(?:\s+of)?\s*$/, "")
    .replace(/\b(?:add|please|sticker|stickers|the|of)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
  if (unknownPrefix) warnings.push(`Could not understand “${prefix}”.`);

  matches.forEach((match, matchIndex) => {
    const section = aliasMap.get(match[1]);
    if (!section) return;
    const start = (match.index ?? 0) + match[0].length;
    const end = matchIndex < matches.length - 1 ? matches[matchIndex + 1].index ?? text.length : text.length;
    const rawSegment = text.slice(start, end).trim();
    let masked = rawSegment;
    const cues: Array<{ index: number; quantity: number }> = [];

    const collectCue = (pattern: RegExp, quantity: (matchValue: RegExpMatchArray) => number) => {
      Array.from(masked.matchAll(pattern)).forEach((cue) => {
        const cueIndex = cue.index ?? 0;
        cues.push({ index: cueIndex, quantity: Math.max(1, Math.min(20, quantity(cue))) });
        masked = `${masked.slice(0, cueIndex)}${" ".repeat(cue[0].length)}${masked.slice(cueIndex + cue[0].length)}`;
      });
    };
    collectCue(/\b(\d+)\s*(?:copies|copy|times)\b/g, (cue) => Number(cue[1]));
    collectCue(/\bx\s*(\d+)\b/g, (cue) => Number(cue[1]));
    collectCue(/\btwice\b/g, () => 2);

    const numberMatches = Array.from(masked.matchAll(/\b\d{1,2}\b/g));
    if (!numberMatches.length) {
      warnings.push(`No sticker number was found after ${section.name}.`);
      return;
    }
    const segmentDrafts = numberMatches.map((numberMatch) => {
      const number = Number(numberMatch[0]);
      const valid = hasStickerNumber(section.code, number);
      return {
        id: nextId++, sectionCode: section.code, number, quantity: 1,
        uncertain: !valid,
        note: valid ? undefined : `${section.code} does not include sticker ${number}.`,
        position: numberMatch.index ?? 0,
      };
    });
    cues.forEach((cue) => {
      const previous = [...segmentDrafts].reverse().find((draft) => draft.position < cue.index);
      (previous ?? segmentDrafts[0]).quantity = cue.quantity;
    });
    if (matchIndex === 0 && prefixQuantity && segmentDrafts[0]) {
      segmentDrafts[0].quantity = Math.max(1, Math.min(20, Number(prefixQuantity[1])));
    }

    const residue = masked
      .replace(/\b\d{1,2}\b/g, "")
      .replace(/\b(?:and|number|numbers|sticker|stickers|of|then|plus|add|please)\b/g, "")
      .replace(/[^a-z0-9]+/g, "");
    if (residue) {
      segmentDrafts.forEach((draft) => {
        draft.uncertain = true;
        draft.note = `Check the words after ${section.name}.`;
      });
      warnings.push(`Check “${rawSegment}” after ${section.name}.`);
    }
    drafts.push(...segmentDrafts.map((draft) => ({
      id: draft.id,
      sectionCode: draft.sectionCode,
      number: draft.number,
      quantity: draft.quantity,
      uncertain: draft.uncertain,
      note: draft.note,
    })));
  });

  const combined = new Map<string, Draft>();
  drafts.forEach((draft) => {
    const key = `${draft.sectionCode}-${draft.number}`;
    const existing = combined.get(key);
    if (existing) {
      existing.quantity = Math.min(20, existing.quantity + draft.quantity);
      existing.uncertain = existing.uncertain || draft.uncertain;
      existing.note = existing.note ?? draft.note;
    } else {
      combined.set(key, draft);
    }
  });
  return { drafts: Array.from(combined.values()), warnings };
}

export function VoiceAdd({
  stickers,
  collection,
  onAdjust,
  onSaved,
  onClose,
}: {
  stickers: Sticker[];
  collection: Record<string, number>;
  onAdjust: (code: string, delta: 1 | -1) => Promise<{ previousQuantity: number; nextQuantity: number }>;
  onSaved: (entries: VoiceSavedEntry[]) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<"listening" | "review" | "unavailable" | "summary">("listening");
  const [transcript, setTranscript] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState({ added: 0, newCount: 0, extras: 0 });
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualId = useRef(1000);

  function startListening() {
    recognitionRef.current?.abort();
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setError("Voice Add needs browser speech-to-text or a connected speech service. This browser does not provide either one.");
      setStage("unavailable");
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;
    let heard = "";
    let failed = false;
    setTranscript("");
    setDrafts([]);
    setWarnings([]);
    setError("");
    setStage("listening");
    recognition.onresult = (event) => {
      heard = Array.from(event.results).map((result) => result[0]?.transcript ?? "").join(" ").trim();
      setTranscript(heard);
    };
    recognition.onerror = (event) => {
      failed = true;
      setError(event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "Microphone access was blocked. Allow microphone access in your browser, then try again."
        : "Speech recognition could not finish. Voice Add requires browser speech-to-text or a connected speech service.");
      setStage("unavailable");
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      if (failed) return;
      if (!heard) {
        setError("No speech was detected. Try again and say a country with a sticker number.");
        setStage("unavailable");
        return;
      }
      const parsed = parseVoiceList(heard);
      setDrafts(parsed.drafts);
      setWarnings(parsed.warnings);
      setStage("review");
    };
    try {
      recognition.start();
    } catch {
      setError("Speech recognition could not start. Voice Add requires browser speech-to-text or a connected speech service.");
      setStage("unavailable");
    }
  }

  useEffect(() => {
    const startTimer = window.setTimeout(() => startListening(), 0);
    return () => {
      window.clearTimeout(startTimer);
      recognitionRef.current?.abort();
      if (summaryTimer.current) clearTimeout(summaryTimer.current);
    };
  }, []);

  function updateDraft(id: number, changes: Partial<Draft>) {
    setDrafts((current) => current.map((draft) => {
      if (draft.id !== id) return draft;
      const next = { ...draft, ...changes };
      const section = albumSections.find((item) => item.code === next.sectionCode);
      const valid = Boolean(section && hasStickerNumber(section.code, next.number) && next.quantity >= 1);
      return { ...next, uncertain: !valid, note: valid ? undefined : `Choose a sticker number used in ${section?.code ?? "this section"}.` };
    }));
  }

  async function save() {
    const invalid = drafts.some((draft) => {
      const section = albumSections.find((item) => item.code === draft.sectionCode);
      return !section || !hasStickerNumber(section.code, draft.number) || draft.quantity < 1;
    });
    if (!drafts.length || invalid) return;
    setSaving(true);
    const working = { ...collection };
    const savedEntries: VoiceSavedEntry[] = [];
    let newCount = 0;
    let extras = 0;
    for (const draft of drafts) {
      const code = makeStickerCode(draft.sectionCode, draft.number);
      const sticker = stickers.find((item) => item.code === code);
      if (!sticker) continue;
      for (let copy = 0; copy < draft.quantity; copy += 1) {
        const previous = working[code] ?? 0;
        const result = await onAdjust(code, 1);
        working[code] = result.nextQuantity;
        const kind = previous === 0 ? "new" : "extra";
        if (kind === "new") newCount += 1;
        else extras += 1;
        savedEntries.push({ code, sectionName: sticker.section.name, result: kind, quantity: result.nextQuantity });
      }
    }
    onSaved(savedEntries.reverse());
    setSummary({ added: savedEntries.length, newCount, extras });
    setSaving(false);
    setStage("summary");
    summaryTimer.current = setTimeout(onClose, 2600);
  }

  const invalidDraft = drafts.some((draft) => {
    const section = albumSections.find((item) => item.code === draft.sectionCode);
    return !section || !hasStickerNumber(section.code, draft.number) || draft.quantity < 1;
  });

  return (
    <section className={`voice-layer ${stage}`} aria-label="Voice Add">
      {stage === "listening" && (
        <div className="voice-listening-state">
          <button className="voice-close" onClick={onClose} aria-label="Cancel Voice Add">×</button>
          <div className="voice-pulse"><span /><i /><i /><i /></div>
          <p className="eyebrow">LISTENING</p>
          <h2>Say your stickers.</h2>
          <p className="voice-example">Try “Mexico 3, USA 12, Brazil 8.”</p>
          <div className="voice-live-text">{transcript || "Listening for country names, codes, numbers, and quantities…"}</div>
          <p className="voice-service-note">Using your browser&apos;s speech recognition. A separate AI parsing service is not connected, so you will review every result before saving.</p>
          <button className="voice-stop" onClick={() => recognitionRef.current?.stop()}>Stop and review</button>
        </div>
      )}

      {stage === "unavailable" && (
        <div className="voice-unavailable-state">
          <span>●</span><p className="eyebrow">VOICE ADD</p><h2>Voice recognition is not ready.</h2><p>{error}</p>
          <div className="voice-unavailable-actions"><button onClick={startListening}>Try Again</button><button onClick={onClose}>Cancel</button></div>
        </div>
      )}

      {stage === "review" && (
        <div className="voice-review-state">
          <header className="voice-review-heading"><div><p className="eyebrow">REVIEW BEFORE SAVING</p><h2>Detected Stickers</h2></div><button onClick={onClose} aria-label="Cancel Voice Add">×</button></header>
          <p className="voice-transcript"><strong>Heard:</strong> “{transcript}”</p>
          <p className="voice-service-note review-note">This draft uses browser speech recognition and the album&apos;s built-in parser. A dedicated AI parsing service is not connected.</p>
          {drafts.length ? <div className="voice-entry-list">{drafts.map((draft) => {
            const section = albumSections.find((item) => item.code === draft.sectionCode) ?? albumSections[0];
            return <div className={`voice-entry-row ${draft.uncertain ? "uncertain" : ""}`} key={draft.id}>
              {draft.uncertain && <span className="uncertain-mark">!</span>}
              <label><span>Section</span><select value={draft.sectionCode} onChange={(event) => updateDraft(draft.id, { sectionCode: event.target.value })}>{albumSections.map((item) => <option value={item.code} key={item.code}>{item.code} · {item.name}</option>)}</select></label>
              <label><span>Number</span><input type="number" min={getSectionStickers(section.code)[0]?.number ?? 1} max={getSectionStickers(section.code).at(-1)?.number ?? section.count} value={draft.number} onChange={(event) => updateDraft(draft.id, { number: Number(event.target.value) })} /></label>
              <div className="voice-quantity"><span>Quantity</span><div><button onClick={() => updateDraft(draft.id, { quantity: Math.max(1, draft.quantity - 1) })}>−</button><strong>×{draft.quantity}</strong><button onClick={() => updateDraft(draft.id, { quantity: Math.min(20, draft.quantity + 1) })}>＋</button></div></div>
              <button className="remove-voice-entry" onClick={() => setDrafts((current) => current.filter((item) => item.id !== draft.id))} aria-label={`Remove ${draft.sectionCode} ${draft.number}`}>×</button>
              {draft.note && <small>{draft.note}</small>}
            </div>;
          })}</div> : <div className="voice-no-results">No stickers could be detected. Try again or add an entry manually.</div>}
          {!!warnings.length && <div className="voice-warnings"><strong>Needs your attention</strong>{warnings.map((warning, index) => <span key={`${warning}-${index}`}>! {warning}</span>)}</div>}
          <button className="add-voice-entry" onClick={() => { manualId.current += 1; setDrafts((current) => [...current, { id: manualId.current, sectionCode: albumSections[0].code, number: getSectionStickers(albumSections[0].code)[0]?.number ?? 1, quantity: 1, uncertain: false }]); }}>＋ Add another entry</button>
          <footer className="voice-review-footer"><button className="voice-try-again" onClick={startListening}>Try Again</button><button className="voice-cancel" onClick={onClose}>Cancel</button><button className="voice-save" disabled={!drafts.length || invalidDraft || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save Stickers"}</button></footer>
        </div>
      )}

      {stage === "summary" && (
        <div className="voice-summary-state" role="status"><span>✓</span><h2>{summary.added} stickers added</h2><div><strong>{summary.newCount}</strong><small>new</small><strong>{summary.extras}</strong><small>extras</small></div><button onClick={onClose}>Back to Add Stickers</button></div>
      )}
    </section>
  );
}
