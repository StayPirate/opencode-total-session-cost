import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, onCleanup } from "solid-js";

export const id = "opencode-cost-bar";

export const SessionCostPlugin: TuiPlugin = async (api) => {
  const showCostBreakdown = async (sessionID: string) => {
    let parentCost = 0;
    let taskCost = 0;
    let subagentCost = 0;

    const modelCosts: Record<string, number> = {};

    const addModelCost = (providerID: string, modelID: string, cost: number) => {
      const key = `${providerID}/${modelID}`;
      modelCosts[key] = (modelCosts[key] || 0) + cost;
    };

    const calculateCostRecursive = async (currID: string, fallbackSession?: any): Promise<void> => {
      const sessionObj = api.state.session.get(currID) || fallbackSession;
      let sessionCost = 0;
      if (sessionObj && typeof sessionObj.cost === "number") {
        sessionCost = sessionObj.cost;
        if (currID === sessionID) {
          parentCost += sessionCost;
        } else if (sessionObj.agent === "explore" || sessionObj.agent === "general") {
          taskCost += sessionCost;
        } else {
          subagentCost += sessionCost;
        }
      }

      let messagesAttributedCost = 0;
      try {
        const msgRes = await api.client.session.messages({ sessionID: currID });
        if (msgRes.data) {
          for (const item of msgRes.data) {
            const msg = item.info as any;
            if (msg && msg.role === "assistant" && typeof msg.cost === "number" && msg.cost > 0) {
              const provider = msg.providerID || (sessionObj?.model?.providerID) || "unknown";
              const model = msg.modelID || (sessionObj?.model?.id) || "unknown";
              addModelCost(provider, model, msg.cost);
              messagesAttributedCost += msg.cost;
            }
          }
        }
      } catch (err) {}

      const remainder = sessionCost - messagesAttributedCost;
      if (remainder > 0.0001) {
        const provider = (sessionObj?.model?.providerID) || "unknown";
        const model = (sessionObj?.model?.id) || "unknown";
        addModelCost(provider, model, remainder);
      }

      try {
        const childrenRes = await api.client.session.children({ sessionID: currID });
        if (childrenRes.data) {
          for (const child of childrenRes.data) {
            await calculateCostRecursive(child.id, child);
          }
        }
      } catch (err) {}
    };

    await calculateCostRecursive(sessionID);
    const total = parentCost + taskCost + subagentCost;

    // Format Session breakdown
    const sessionSection = `By session\nSession:   $${parentCost.toFixed(2)}\nTask:      $${taskCost.toFixed(2)}\nSub-agent: $${subagentCost.toFixed(2)}\n---------------\nTotal:     $${total.toFixed(2)}`;

    // Format Model breakdown
    let maxLabelLength = 6; // Length of "Total:" is 6
    for (const key of Object.keys(modelCosts)) {
      const label = `${key}:`;
      if (label.length > maxLabelLength) {
        maxLabelLength = label.length;
      }
    }

    const sortedModels = Object.entries(modelCosts).sort((a, b) => b[1] - a[1]);
    const modelLines: string[] = [];
    for (const [key, cost] of sortedModels) {
      const label = `${key}:`;
      const paddedLabel = label.padEnd(maxLabelLength + 1, " ");
      modelLines.push(`${paddedLabel}$${cost.toFixed(2)}`);
    }

    const modelSeparator = "-".repeat(maxLabelLength + 7);
    const paddedTotalLabel = "Total:".padEnd(maxLabelLength + 1, " ");
    const modelTotalLine = `${paddedTotalLabel}$${total.toFixed(2)}`;

    const modelSection = `By provider/model\n${modelLines.join("\n")}\n${modelSeparator}\n${modelTotalLine}`;

    api.ui.toast({
      title: "Session Costs Breakdown",
      message: `${sessionSection}\n\n${modelSection}`,
      variant: "success",
      duration: 10000
    });
  };

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
          <text
            fg="gray"
            onMouseUp={(e: any) => {
              if (props?.session_id && e.button === 0) {
                showCostBreakdown(props.session_id);
              }
            }}
          >
            {" "}[ ${total().toFixed(2)} ]
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

        await showCostBreakdown(currentSessionID);
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
