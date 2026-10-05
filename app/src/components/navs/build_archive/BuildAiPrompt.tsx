"use client";

import { useCallback, useState } from "react";
import "./BuildAiPrompt.css";

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
  botMessage?: string | null;
}

export default function BuildAiPrompt({
  value: controlledValue,
  defaultValue = "",
  onChange,
  onSubmit,
  placeholder = "Describe your flow (limit, loop, schedule…) and AI will build + connect blocks…",
  submitLabel = "Send",
  isLoading = false,
  disabled = false,
  className = "",
  disclaimer = "AI can make mistakes. Review before committing funds.",
  botMessage = null,
}: BuildAiPromptProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : internalValue;

  const setValue = useCallback(
    (next: string) => {
      if (!isControlled) {
        setInternalValue(next);
      }
      onChange?.(next);
    },
    [isControlled, onChange]
  );

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || disabled || isLoading) return;
    await onSubmit?.(trimmed);
    if (!isControlled) {
      setInternalValue("");
    }
  }, [value, disabled, isLoading, onSubmit, isControlled]);

  const canSubmit = value.trim().length > 0 && !disabled && !isLoading;
  const inputPlaceholder = botMessage
    ? "Type your answer..."
    : placeholder;

  return (
    <div className={`build-ai-prompt ${className}`.trim()}>
      {botMessage && (
        <div className="build-ai-prompt-bubble" role="status" aria-live="polite">
          <span className="build-ai-prompt-bubble-label">Builder</span>
          <p className="build-ai-prompt-bubble-text">{botMessage}</p>
        </div>
      )}

      <div className="build-ai-prompt-inner">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={inputPlaceholder}
          className="build-ai-prompt-input"
          disabled={disabled || isLoading}
          aria-label={botMessage ? "Answer for builder agent" : "Strategy description for AI builder"}
        />
        <button
          type="button"
          className="build-ai-prompt-submit"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
        >
          {isLoading ? "Sending..." : submitLabel}
        </button>
      </div>
      {disclaimer && (
        <p className="build-ai-prompt-disclaimer">{disclaimer}</p>
      )}
    </div>
  );
}
