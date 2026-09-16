import type { Plugin, PluginModule } from "@opencode-ai/plugin";

export const id = "opencode-total-session-cost";

export const server: Plugin = async (ctx) => {
  return {}; // No-op backend hooks
};

const pluginModule: PluginModule = {
  id,
  server
};

export default pluginModule;
