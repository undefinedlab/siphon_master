"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronsDown, LayoutDashboard, Loader2, Mic, MicOff, Send, Settings } from "lucide-react";
import { builderChainProfile } from "@/builder_agent/blocks";
import { stripInternalArmCopy } from "@/builder_agent/stripArmCopy";
import { useDashboardCustomize } from "@/components/landing/dashboard-customize-context";
import { readStoredHomeChainId } from "@/lib/chains/homeChains";
import { getSelectedChainId } from "@/lib/networks";
import { useSpeechRecognition } from "@/lib/useSpeechRecognition";
import "./BuildAiPrompt.css";

export interface BuildChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

type SuggestionItem = { label: string; text: string };

function buildSuggestions(primary: string, quote: string, solana: boolean): SuggestionItem[] {
  const items: SuggestionItem[] = [
    {
      label: "Suggest me",
      text: "Suggest me a strategy based on what's happening in the market",
    },
    {
      label: "Market",
      text: "What's going on with the market right now?",
    },
    {
      label: "Limit order",
      text: `Deposit ${quote} and place a limit buy for ${primary} at my target price`,
    },
    {
      label: "DCA loop",
      text: `Deposit ${quote} once, then loop swap to ${primary} every 24 hours until empty`,
    },
    {
      label: "Stop-loss exit",
      text: `Deposit ${primary}, stop loss when price hits my stop, swap to ${quote} and withdraw`,
    },
    {
      label: "Loop until empty",
      text: `Deposit 500 ${quote}, loop swap to ${primary} and withdraw every 24 hours`,
    },
    {
      label: "Scheduled entry",
      text: `Deposit ${quote}, wait 1 hour, then limit buy ${primary} when price dips 8%`,
    },
    {
      label: "Take profit",
      text: `Deposit ${primary}, take profit at 8% above current price, swap to ${quote} and withdraw`,
    },
    {
      label: "Recurring swap",
      text: `Deposit ${quote} and swap to ${primary} on a daily loop until funds run out`,
    },
  ];
  if (solana) {
    items.splice(3, 0, {
      label: "Jupiter Earn",
      text: `Deposit ${quote} and enter Jupiter Earn for jlUSDC yield`,
    });
  } else {
    items.push({
      label: "Vault bridge",
      text: `Deposit ${quote} on Arbitrum, bridge to Base, then limit buy ${primary}`,
    });
  }
  items.push({
    label: "Exit to stables",
    text: `Deposit ${primary}, take profit at my target price, swap everything to ${quote} and withdraw`,
  });
  return items;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function SuggestionMarquee({
  disabled,
  onPickPrompt,
  suggestions,
}: {
  disabled?: boolean;
  onPickPrompt: (text: string) => void;
  suggestions: SuggestionItem[];
}) {
  const reduced = usePrefersReducedMotion();

  const handlePick = (item: SuggestionItem) => {
    if (disabled) return;
    onPickPrompt(item.text);
  };

  const renderStrip = (suffix: string) => (
    <div className="build-ai-marquee-strip" aria-hidden={suffix === "b"}>
      {suggestions.map((item, i) => (
        <Fragment key={`${suffix}-${item.label}`}>
          {i > 0 ? (
            <span className="build-ai-marquee-dot" aria-hidden>
              ·
            </span>
          ) : null}
          <button
            type="button"
            className="build-ai-marquee-chip"
            disabled={disabled}
            onClick={() => handlePick(item)}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );

  if (reduced) {
    return (
      <div className="build-ai-marquee build-ai-marquee--static" role="region" aria-label="Suggested prompts">
        <div className="build-ai-marquee-static-row">
          {suggestions.map((item, i) => (
            <Fragment key={item.label}>
              {i > 0 ? <span className="build-ai-marquee-dot" aria-hidden>·</span> : null}
              <button
                type="button"
                className="build-ai-marquee-chip"
                disabled={disabled}
                onClick={() => handlePick(item)}
              >
                {item.label}
              </button>
            </Fragment>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="build-ai-marquee" role="region" aria-label="Suggested prompts">
      <div className="build-ai-marquee-track">
        {renderStrip("a")}
        {renderStrip("b")}
      </div>
    </div>
  );
}

export interface BuildAiPromptProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onSubmit?: (prompt: string) => void | Promise<void>;
  placeholder?: string;
  submitLabel?: string;
  isLoading?: boolean;
  disabled?: boolean;
  className?: string;
  disclaimer?: string;
  /** @deprecated use messages */
  botMessage?: string | null;
  messages?: BuildChatMessage[];
  onChatActiveChange?: (active: boolean) => void;
  /** Dashboard widget band visibility — toggle sits right of Send in the input row. */
  widgetsVisible?: boolean;
  onToggleWidgets?: () => void;
  /** Canvas/build mode — hide hero title and anchor chat (e.g. after picking a strategy). */
  buildViewActive?: boolean;
}

export default function BuildAiPrompt({
  value: controlledValue,
  defaultValue = "",
  onChange,
  onSubmit,
  placeholder = "Ask a question or describe your strategy…",
  submitLabel = "Send",
  isLoading = false,
  disabled = false,
  className = "",
  disclaimer = "AI can make mistakes. Review before committing funds.",  botMessage = null,
  messages = [],
  onChatActiveChange,
  widgetsVisible = true,
  onToggleWidgets,
  buildViewActive = false,
}: BuildAiPromptProps) {
  const { panelOpen, togglePanel } = useDashboardCustomize();
  const [internalValue, setInternalValue] = useState(defaultValue);
  const threadRef = useRef<HTMLDivElement>(null);
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : internalValue;

  const [chainTick, setChainTick] = useState(0);
  useEffect(() => {
    const bump = () => setChainTick((n) => n + 1);
    window.addEventListener("siphon:chainChanged", bump);
    window.addEventListener("siphon:homeChainChanged", bump);
    return () => {
      window.removeEventListener("siphon:chainChanged", bump);
      window.removeEventListener("siphon:homeChainChanged", bump);
    };
  }, []);

  const suggestions = useMemo(() => {
    const profile = builderChainProfile({
      chainId: getSelectedChainId(),
      homeChainId: readStoredHomeChainId(),
    });
    return buildSuggestions(
      profile.primaryToken,
      profile.quoteToken,
      profile.kind === "solana",
    );
    // chainTick forces refresh after home/chain switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainTick]);

  const setValue = useCallback(
    (next: string) => {
      if (!isControlled) {
        setInternalValue(next);
      }
      onChange?.(next);
    },
    [isControlled, onChange]
  );

  const { isListening, isSupported, toggleListening, stopListening } = useSpeechRecognition({
    onTranscript: (text) => {
      setValue(text);
    },
  });

  const inputDisabled = disabled || isLoading;

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isLoading) return;
    stopListening();
    await onSubmit?.(trimmed);
    if (!isControlled) {
      setInternalValue("");
    }
  }, [value, disabled, isLoading, onSubmit, isControlled, stopListening]);

  const canSubmit = value.trim().length > 0 && !disabled && !isLoading;
  const lastMsg = messages[messages.length - 1];
  const awaitingAnswer = lastMsg?.role === "assistant";
  const inputPlaceholder = awaitingAnswer ? "Type your answer..." : placeholder;

  const displayMessages =
    messages.length > 0
      ? messages
      : botMessage
        ? [{ id: "legacy-bot", role: "assistant" as const, content: botMessage }]
        : [];

  const isEmpty = displayMessages.length === 0 && !isLoading;
  const chatActive = !isEmpty || isLoading;
  const promptExpanded = chatActive || buildViewActive;
  /** Fixed bottom strip when widgets are collapsed and chat/build mode is active */
  const chatAnchored = !widgetsVisible && promptExpanded;

  useEffect(() => {
    onChatActiveChange?.(chatActive);
  }, [chatActive, onChatActiveChange]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;

    const syncThread = () => {
      el.scrollTop = el.scrollHeight;
    };

    syncThread();
    const observer = new ResizeObserver(syncThread);
    observer.observe(el);
    return () => observer.disconnect();
  }, [displayMessages.length, isLoading]);

  const threadContent = !isEmpty && (
    <div className="build-ai-thread-fade-wrap">
      <div
        ref={threadRef}
        className="build-ai-prompt-thread"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
      >
        <div className="build-ai-thread-spacer" aria-hidden />
      {displayMessages.map((msg) => {
        const text = msg.role === "assistant" ? stripInternalArmCopy(msg.content) : msg.content;
        if (!text.trim()) return null;
        return (
          <div
            key={msg.id}
            className={`build-ai-prompt-msg build-ai-prompt-msg--${msg.role}`}
          >
            <span className="build-ai-prompt-msg-label">
              {msg.role === "user" ? "You" : "Builder"}
            </span>
            <p className="build-ai-prompt-msg-text">{text}</p>
          </div>
        );
      })}
      {isLoading && (
        <div className="build-ai-prompt-msg build-ai-prompt-msg--assistant build-ai-prompt-msg--typing">
          <span className="build-ai-prompt-msg-label">Builder</span>
          <p className="build-ai-prompt-msg-text">Thinking…</p>
        </div>
      )}
      </div>
    </div>
  );

  const inputDock = (
    <div className={`build-ai-prompt-dock ${chatAnchored ? "build-ai-prompt-dock--anchored" : ""} ${className}`.trim()}>
      <SuggestionMarquee
        disabled={disabled || isLoading}
        onPickPrompt={setValue}
        suggestions={suggestions}
      />
      <div className="build-ai-prompt-input-row">
        <button
          type="button"
          className={`build-ai-prompt-widgets-btn build-ai-prompt-widgets-btn--settings-mobile${panelOpen ? " build-ai-prompt-widgets-btn--active" : ""}`}
          onClick={togglePanel}
          title={panelOpen ? "Done customizing" : "Customize dashboard"}
          aria-label={panelOpen ? "Done customizing" : "Customize dashboard"}
          aria-expanded={panelOpen}
          aria-controls="dashboard-customize-panel"
        >
          <Settings className="build-ai-prompt-widgets-icon" strokeWidth={1.75} aria-hidden />
        </button>
        <div className="build-ai-prompt-composer">
          <div className="build-ai-prompt-field">
            <input
              type="text"
              value={value}
              onChange={(e) => {
                if (isListening) stopListening();
                setValue(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder={inputPlaceholder}
              className="build-ai-prompt-input"
              disabled={inputDisabled}
              aria-label={awaitingAnswer ? "Answer for builder agent" : "Strategy description for AI builder"}
            />
            <button
              type="button"
              className={`build-ai-prompt-mic-btn build-ai-prompt-mic-btn--inline${isListening ? " build-ai-prompt-mic-btn--listening" : ""}`}
              onClick={() => toggleListening(value)}
              disabled={inputDisabled || !isSupported}
              title={
                !isSupported
                  ? "Voice input not supported in this browser"
                  : isListening
                    ? "Stop listening"
                    : "Speak your prompt"
              }
              aria-label={isListening ? "Stop voice input" : "Start voice input"}
              aria-pressed={isListening}
            >
              {isListening ? (
                <MicOff className="build-ai-prompt-action-icon" strokeWidth={2} aria-hidden />
              ) : (
                <Mic className="build-ai-prompt-action-icon" strokeWidth={2} aria-hidden />
              )}
            </button>
          </div>
          <button
            type="button"
            className="build-ai-prompt-icon-btn build-ai-prompt-submit"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            title={isLoading ? "Sending…" : submitLabel}
            aria-label={isLoading ? "Sending…" : submitLabel}
          >
            {isLoading ? (
              <Loader2 className="build-ai-prompt-action-icon build-ai-prompt-action-icon--spin" strokeWidth={2} aria-hidden />
            ) : (
              <Send className="build-ai-prompt-action-icon" strokeWidth={2} aria-hidden />
            )}
          </button>
        </div>
        {onToggleWidgets ? (
          <button
            type="button"
            className="build-ai-prompt-widgets-btn build-ai-prompt-widgets-btn--outside"
            onClick={onToggleWidgets}
            title={widgetsVisible ? "Collapse dashboard" : "Show dashboard"}
            aria-label={widgetsVisible ? "Collapse dashboard" : "Show dashboard"}
            aria-expanded={widgetsVisible}
          >
            {widgetsVisible ? (
              <ChevronsDown className="build-ai-prompt-widgets-icon" strokeWidth={2} aria-hidden />
            ) : (
              <LayoutDashboard className="build-ai-prompt-widgets-icon" strokeWidth={2} aria-hidden />
            )}
          </button>
        ) : null}
      </div>
      {disclaimer && (
        <p className="build-ai-prompt-disclaimer">{disclaimer}</p>
      )}
    </div>
  );

  return (
    <div
      className={`build-hero-chat ${
        chatAnchored ? "build-hero-chat--anchored" : "build-hero-chat--centered"
      }`}
    >
      <div className={`build-ai-centered-column ${promptExpanded ? "build-ai-centered-column--active" : ""}`}>
        {isEmpty && !promptExpanded && (
          <div className="build-ai-tagline-block" aria-hidden={false}>
            <p className="build-ai-tagline-welcome">Welcome to the Siphon</p>
            <h2 className="build-ai-tagline">
              <span className="build-ai-tagline-line">The Confidential Execution</span>
              <span className="build-ai-tagline-line"> for On-Chain Finance</span>
            </h2>
            <p className="build-ai-tagline-sub">What are you up to today?</p>
          </div>
        )}
        {!isEmpty && threadContent}
        {inputDock}
      </div>
    </div>
  );
}
