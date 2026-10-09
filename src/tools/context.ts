import type { Services } from "../core/services.js";

export type ToolContext = {
  agentId: string;
  services: Services;
};