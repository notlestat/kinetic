// A React pricing section animated with Framer Motion, for Kinetic's framework capture tests.
// Components set displayName so their names survive minification, except PriceTag,
// which is left unnamed on purpose: the capture should flag its minified name.

import { motion, type Variants } from "framer-motion";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

interface Plan {
  id: string;
  name: string;
  price: number;
}

const PLANS: Plan[] = [
  { id: "starter", name: "Starter", price: 9 },
  { id: "team", name: "Team", price: 29 },
  { id: "scale", name: "Scale", price: 99 },
];

const grid: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { delayChildren: 0.2, staggerChildren: 0.12 } },
};

const card: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } },
};

// No displayName: the production build renames this function.
const PriceTag = ({ amount }: { amount: number }) => (
  <p className="price">
    ${amount}
    <span>/month</span>
  </p>
);

function CtaButton({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <motion.button
      type="button"
      className="choose"
      onClick={onSelect}
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: "spring", stiffness: 400, damping: 17 }}
    >
      {label}
    </motion.button>
  );
}
CtaButton.displayName = "CtaButton";

function PlanCard({ plan, onSelect }: { plan: Plan; onSelect: (id: string) => void }) {
  return (
    <motion.article className="plan" variants={card} whileHover={{ y: -6 }}>
      <h3>{plan.name}</h3>
      <PriceTag amount={plan.price} />
      <CtaButton label={`Choose ${plan.name}`} onSelect={() => onSelect(plan.id)} />
    </motion.article>
  );
}
PlanCard.displayName = "PlanCard";

// apiToken is a fake credential: the capture must leave it out of framework.json.
function PricingSection({ plans, apiToken }: { plans: Plan[]; apiToken: string }) {
  return (
    <section className="pricing" data-token-length={apiToken.length}>
      <motion.h2 initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: "easeOut", delay: 0.1 }}>
        Plans
      </motion.h2>
      <motion.div className="plans" initial="hidden" animate="visible" variants={grid}>
        {plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} onSelect={() => undefined} />
        ))}
      </motion.div>
    </section>
  );
}
PricingSection.displayName = "PricingSection";

function App() {
  return <PricingSection plans={PLANS} apiToken="test-token-not-a-real-secret" />;
}
App.displayName = "App";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
