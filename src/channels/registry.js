// A channel registry holds the installed channel plugins. state.js/app.js/the
// frontend drive themselves off this list instead of hardcoding each channel.
const REQUIRED_FACTORIES = ["createDriver", "createAdapter", "createRuntime"];

export function createRegistry(plugins = []) {
  const byId = new Map();
  for (const plugin of plugins) {
    validatePlugin(plugin);
    if (byId.has(plugin.meta.id)) {
      throw new Error(`duplicate channel id: ${plugin.meta.id}`);
    }
    byId.set(plugin.meta.id, plugin);
  }
  return {
    getChannel(id) {
      return byId.get(id) ?? null;
    },
    listChannels() {
      return [...byId.values()];
    },
  };
}

function validatePlugin(plugin) {
  if (!plugin?.meta?.id) {
    throw new Error("channel plugin requires meta.id");
  }
  for (const fn of REQUIRED_FACTORIES) {
    if (typeof plugin[fn] !== "function") {
      throw new Error(`channel plugin ${plugin.meta.id} missing factory ${fn}`);
    }
  }
}
