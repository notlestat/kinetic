// A Vue 3 pricing grid written with render functions, so the runtime-only build
// works without a Vue compiler plugin. Every component has a name except Divider.

import { createApp, defineComponent, h, type PropType } from "vue";

interface Plan {
  id: string;
  name: string;
  price: number;
  features: string[];
}

const PLANS: Plan[] = [
  { id: "starter", name: "Starter", price: 9, features: ["1 project", "Email support"] },
  { id: "team", name: "Team", price: 29, features: ["10 projects", "Priority support"] },
  { id: "scale", name: "Scale", price: 99, features: ["Unlimited projects", "Dedicated support"] },
];

const PriceTag = defineComponent({
  name: "PriceTag",
  props: { amount: { type: Number, required: true }, period: { type: String, default: "month" } },
  setup(props) {
    return () => h("p", { class: "price" }, [`$${props.amount}`, h("span", `/${props.period}`)]);
  },
});

const FeatureList = defineComponent({
  name: "FeatureList",
  props: { items: { type: Array as PropType<string[]>, required: true } },
  setup(props) {
    return () => h("ul", { class: "features" }, props.items.map((item) => h("li", { key: item }, item)));
  },
});

// A functional component with no name: the production build renames the function.
const Divider = () => h("hr", { class: "divider", "aria-hidden": "true" });

const PlanCard = defineComponent({
  name: "PlanCard",
  // sessionToken is a fake credential: the capture must leave it out of framework.json.
  props: { plan: { type: Object as PropType<Plan>, required: true }, sessionToken: { type: String, default: "" } },
  setup(props) {
    return () =>
      h("article", { class: "plan" }, [
        h("h3", props.plan.name),
        h(PriceTag, { amount: props.plan.price }),
        h(Divider),
        h(FeatureList, { items: props.plan.features }),
        h("button", { type: "button", class: "choose" }, `Choose ${props.plan.name}`),
      ]);
  },
});

const PricingGrid = defineComponent({
  name: "PricingGrid",
  props: { plans: { type: Array as PropType<Plan[]>, required: true } },
  setup(props) {
    return () =>
      h("section", { class: "pricing" }, [
        h("h2", "Plans"),
        h(
          "div",
          { class: "plans" },
          props.plans.map((plan) => h(PlanCard, { key: plan.id, plan, sessionToken: "test-session-not-a-real-secret" })),
        ),
      ]);
  },
});

const App = defineComponent({
  name: "App",
  setup() {
    return () => h(PricingGrid, { plans: PLANS });
  },
});

createApp(App).mount("#app");
