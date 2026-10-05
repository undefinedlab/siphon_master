"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
}

interface BrowserSpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  error: string;
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Chrome updates each result index in place (interim → longer interim → final).
 * Never use += across events — overwrite per index and join once.
 */
function spokenTextFromResults(results: SpeechRecognitionResultList): string {
  const parts: string[] = [];
  for (let i = 0; i < results.length; i++) {
    parts[i] = results[i][0].transcript;
  }
  return parts.join("");
}

export interface UseSpeechRecognitionOptions {
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
}

export function useSpeechRecognition({ onTranscript, onError }: UseSpeechRecognitionOptions) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const prefixRef = useRef("");
  const lastEmittedRef = useRef("");
  const activeRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  }, [onTranscript, onError]);

  useEffect(() => {
    setIsSupported(Boolean(getSpeechRecognitionCtor()));
  }, []);

  const teardown = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
    try {
      recognition.abort();
    } catch {
      /* already stopped */
    }
    recognitionRef.current = null;
  }, []);

  const emitIfChanged = useCallback((transcript: string) => {
    if (!activeRef.current || transcript === lastEmittedRef.current) return;
    lastEmittedRef.current = transcript;
    onTranscriptRef.current(transcript);
  }, []);

  const stopListening = useCallback(() => {
    activeRef.current = false;
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        teardown();
      }
    }
    setIsListening(false);
  }, [teardown]);

  const startListening = useCallback(
    (currentValue: string) => {
      const Ctor = getSpeechRecognitionCtor();
      if (!Ctor) return;

      teardown();

      const trimmed = currentValue.trimEnd();
      prefixRef.current = trimmed ? `${trimmed} ` : "";
      lastEmittedRef.current = prefixRef.current;
      activeRef.current = true;

      const recognition = new Ctor();
      recognition.continuous = true;
      // Final-only: Chrome interim slots often repeat the full phrase and cause duplication.
      recognition.interimResults = false;
      recognition.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";

      recognition.onresult = (event: BrowserSpeechRecognitionEvent) => {
        if (!activeRef.current) return;
        const spoken = spokenTextFromResults(event.results);
        emitIfChanged(prefixRef.current + spoken);
      };

      recognition.onend = () => {
        activeRef.current = false;
        teardown();
        setIsListening(false);
      };

      recognition.onerror = (event: BrowserSpeechRecognitionErrorEvent) => {
        if (event.error !== "aborted") {
          onErrorRef.current?.(event.error);
        }
        activeRef.current = false;
        teardown();
        setIsListening(false);
      };

      recognitionRef.current = recognition;

      try {
        recognition.start();
        setIsListening(true);
      } catch {
        activeRef.current = false;
        teardown();
        onErrorRef.current?.("unavailable");
        setIsListening(false);
      }
    },
    [emitIfChanged, teardown],
  );

  const toggleListening = useCallback(
    (currentValue: string) => {
      if (isListening) {
        stopListening();
      } else {
        startListening(currentValue);
      }
    },
    [isListening, startListening, stopListening],
  );

  useEffect(() => () => teardown(), [teardown]);

  return { isListening, isSupported, toggleListening, stopListening };
}
