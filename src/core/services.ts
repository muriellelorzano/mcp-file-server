import type { Config } from "../config.js";
import { createSandbox, type Sandbox } from "./sandbox.js";

export type Services = Readonly<{
  sandbox: Sandbox;
  config: Config;
}>;

export function createServices(config: Config): Services {
  return Object.freeze({
    sandbox: createSandbox(config.workspaceRoot),
    config,
  });
}

