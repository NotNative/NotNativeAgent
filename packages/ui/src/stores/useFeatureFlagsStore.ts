import { create } from 'zustand';

/** Feature flags store (doc 01 §14): P0 carries the plan-mode health flag. */
interface FeatureFlagsState {
  planModeExperimentalEnabled: boolean;
  setPlanModeExperimentalEnabled: (value: boolean) => void;
}

export const useFeatureFlagsStore = create<FeatureFlagsState>((set) => ({
  planModeExperimentalEnabled: false,
  setPlanModeExperimentalEnabled: (value) => set({ planModeExperimentalEnabled: value }),
}));
