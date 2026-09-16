import type {
  TuiHostSlotMap,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext
} from "@opencode-ai/plugin/tui";
import type { Message } from "@opencode-ai/sdk/v2";
import { createSignal, onCleanup } from "solid-js";
import { collectCosts, formatBreakdown, type CostDeps, type MessageLike } from "./cost.ts";

export const id = "opencode-total-session-cost";

const toMessageLike = (message: Message): MessageLike => {
  if (message.role === "assistant") {
    return {
      role: message.role,
      cost: message.cost,
      providerID: message.providerID,
      modelID: message.modelID
    };
  }
  return { role: message.role };
};

const createDeps = (api: TuiPluginApi): CostDeps => ({
  getSession: (sessionID) => api.state.session.get(sessionID),
  getMessages: (sessionID) => api.state.session.messages(sessionID).map(toMessageLike),
  getChildren: async (sessionID) => {
    try {
      const res = await api.client.session.children({ sessionID });
      return res.data ?? [];
    } catch (error) {
      console.error(`[${id}] failed to load children of session ${sessionID}`, error);
      return [];
    }
  }
});

export const SessionCostPlugin: TuiPlugin = async (api) => {
  const showCostBreakdown = async (sessionID: string) => {
    const breakdown = await collectCosts(sessionID, createDeps(api));

    api.ui.toast({
      title: "Session Costs Breakdown",
      message: formatBreakdown(breakdown),
      variant: "success",
      duration: 10000
    });
  };

  api.slots?.register({
    slots: {
      session_prompt_right: (
        ctx: Readonly<TuiSlotContext>,
        props: TuiHostSlotMap["session_prompt_right"]
      ) => {
        const [total, setTotal] = createSignal<number>(0);
        let requestId = 0;

        const update = async () => {
          const currentRequest = ++requestId;
          const sessionID = props.session_id;
          if (!sessionID) {
            setTotal(0);
            return;
          }

          const breakdown = await collectCosts(sessionID, createDeps(api));
          if (currentRequest !== requestId) return;

          setTotal(breakdown.total);
        };

        const unsubMsgUpdated = api.event.on("message.updated", () => void update());
        const unsubMsgRemoved = api.event.on("message.removed", () => void update());
        const unsubSessionUpdated = api.event.on("session.updated", () => void update());
        const unsubSessionIdle = api.event.on("session.idle", () => void update());
        const interval = setInterval(() => void update(), 3000);

        onCleanup(() => {
          unsubMsgUpdated();
          unsubMsgRemoved();
          unsubSessionUpdated();
          unsubSessionIdle();
          clearInterval(interval);
        });

        void update();

        return (
          <text
            fg={ctx.theme.current.textMuted}
            onMouseUp={(event) => {
              if (event.button === 0) {
                void showCostBreakdown(props.session_id);
              }
            }}
          >
            {" "}[ ${total().toFixed(2)} ]
          </text>
        );
      }
    }
  });

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
        const currentSessionID =
          api.route.current &&
          api.route.current.name === "session" &&
          typeof api.route.current.params?.sessionID === "string"
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

export const tui = SessionCostPlugin;

const pluginModule: TuiPluginModule = {
  id,
  tui: SessionCostPlugin
};

export default pluginModule;