// Runs the cup engine off the main thread, so a 20,000-player preview never freezes the form.
import { previewCup, publishChecks, validateCupConfig } from "./cup.js";

onmessage = (e) => {
  const { id, config, ctx } = e.data;
  const errors = validateCupConfig(config);
  if (errors.length) { postMessage({ id, errors, previews: [], checks: errors }); return; }
  const previews = previewCup(config);
  const checks = publishChecks(config, ctx, previews);
  // Per-player arrays are big and unused here: send the summaries only.
  postMessage({ id, errors: [], checks, previews: previews.map(p => ({ size: p.size, N: p.N, minutes: p.minutes, problems: p.problems, sim: { ...p.sim, won: undefined, staked: undefined, config: undefined } })) });
};
