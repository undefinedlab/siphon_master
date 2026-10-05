/**
 * Regex / keyword builder agent — disconnected from the live builder chat.
 * Set HEURISTIC_AGENT_ENABLED to true only for local experiments or tests.
 */
export const HEURISTIC_AGENT_ENABLED = false;

export { parsePrompt } from "../parsePrompt";
export { applyFollowUpAnswer, applyIntentFromMessage, mergeParsed } from "../parseFollowUp";
export { getNextQuestion, getMissingFields } from "../questions";
export { processHeuristicTurn } from "./processTurn";
export { generateFlowFromPrompt } from "./generateFlow";
