import { z } from "zod";

/**
 * User-toggled experiments (the Settings → Experiments switches). Distinct
 * from `FeatureFlags`: flags are operator-set via env at server start,
 * experiments are user-toggled at runtime and persisted server-side so
 * server-owned policy (e.g. skill injection) can honor them.
 */
/**
 * The complete experiment key list. Add an entry here without changing the
 * database schema; experiment values use key/value persistence.
 */
export const experimentKeys = [
  "claudeCodeMockCliTraffic",
  "editMessages",
  "newOnboarding",
  "toolsHub",
] as const;
export const experimentKeySchema = z.enum(experimentKeys);
export type ExperimentKey = z.infer<typeof experimentKeySchema>;

export const experimentsSchema = z.record(experimentKeySchema, z.boolean());
export type Experiments = z.infer<typeof experimentsSchema>;

/**
 * What an installation starts with before the user touches a toggle. Most
 * experiments default off — opting in is the point — but one that has proven
 * itself ships on and keeps its toggle as the opt-out.
 *
 * Only unset keys read this default: `setExperiments` persists every key, so
 * an installation that has saved any toggle keeps its stored values here.
 */
export const defaultExperiments: Experiments = {
  claudeCodeMockCliTraffic: false,
  editMessages: true,
  newOnboarding: false,
  toolsHub: false,
};
