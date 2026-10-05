export { processBuilderTurn } from "./conversation";
export type {
  BlockType,
  BuilderAgentResult,
  BuilderAgentSession,
  BuilderAgentTurnResult,
  MissingField,
  ParsedPrompt,
  StrategyKind,
  StrategySide,
} from "./types";

/** Disconnected regex agent — see ./heuristic */
export {
  HEURISTIC_AGENT_ENABLED,
  generateFlowFromPrompt,
  parsePrompt,
  processHeuristicTurn,
} from "./heuristic";
