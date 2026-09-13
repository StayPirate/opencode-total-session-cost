import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, onCleanup } from "solid-js";

export const id = "opencode-cost-bar";

export const SessionCostPlugin: TuiPlugin = async (api) => {
  // Register TUI slots with reactive signals defined inside the renderers
  api.slots?.register({
    slots: {
      // session_prompt_right: Persistent cost tracker in the prompt header right panel next to active model info
      session_prompt_right: (ctx: any, props: any) => {
        const [total, setTotal] = createSignal<number>(0);

        const calculateCost = async (sessionID: string): Promise<number> => {
          let totalCost = 0;

          const sessionObj = api.state.session.get(sessionID);
          if (sessionObj && typeof sessionObj.cost === "number") {
            totalCost += sessionObj.cost;
          }

          try {
            const childrenRes = await api.client.session.children({ sessionID });
            if (childrenRes.data) {
              for (const child of childrenRes.data) {
                totalCost += await calculateCost(child.id);
              }
            }
          } catch (err) {}

          return totalCost;
        };

        const update = async () => {
          const sessionID = props?.session_id;
          if (sessionID) {
            const res = await calculateCost(sessionID);
            setTotal(res);
          } else {
            setTotal(0);
          }
        };

        const unsubMsgUpdated = api.event.on("message.updated", update);
        const unsubMsgRemoved = api.event.on("message.removed", update);
        const interval = setInterval(update, 3000);

        onCleanup(() => {
          unsubMsgUpdated();
          unsubMsgRemoved();
          clearInterval(interval);
        });

        // Trigger update immediately
        update();

        return (
          <text fg="green">
            {" "}Total: ${total().toFixed(2)}
          </text>
        );
      }
    }
  });

  // Register slash command /total_cost (and alias /costs)
  api.command?.register(() => [
    {
      title: "Total Session Cost",
      value: "total_cost",
      description: "Display total cost breakdown of current session and child sessions",
      category: "Cost Tracking",
      slash: {
        name: "total_cost",
        aliases: ["costs"]
      },
      onSelect: async () => {
        const currentSessionID = api.route.current && api.route.current.name === "session" && typeof api.route.current.params?.sessionID === "string"
          ? api.route.current.params.sessionID
          : null;

        if (!currentSessionID) {
          api.ui.toast({
            title: "No Active Session",
            message: "Please open a session to check costs.",
            variant: "warning",
            duration: 4000
          });
          return;
        }

        let parentCost = 0;
        let childrenCost = 0;

        const calculateCostRecursive = async (sessionID: string): Promise<void> => {
          const sessionObj = api.state.session.get(sessionID);
          if (sessionObj && typeof sessionObj.cost === "number") {
            if (sessionID === currentSessionID) {
              parentCost += sessionObj.cost;
            } else {
              childrenCost += sessionObj.cost;
            }
          }

          try {
            const childrenRes = await api.client.session.children({ sessionID });
            if (childrenRes.data) {
              for (const child of childrenRes.data) {
                await calculateCostRecursive(child.id);
              }
            }
          } catch (err) {}
        };

        await calculateCostRecursive(currentSessionID);
        const total = parentCost + childrenCost;

        api.ui.toast({
          title: "Session Costs Breakdown",
          message: `Active: $${parentCost.toFixed(2)} | Children: $${childrenCost.toFixed(2)} | Total: $${total.toFixed(2)}`,
          variant: "success",
          duration: 6000
        });
      }
    }
  ]);
};

// Export named constant for loaders looking for `export const tui = ...`
export const tui = SessionCostPlugin;

// Export default module configuration
const pluginModule: TuiPluginModule = {
  id,
  tui: SessionCostPlugin
};

export default pluginModule;
