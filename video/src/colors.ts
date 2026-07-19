// Board palette — must match frontend/src (see docs/contracts.md). Keep in sync by hand;
// there are only five colors so a build-time import isn't worth it.
export const colors = {
  bg: "#0E1116",
  text: "#E6EDF3",
  agentBlue: "#4C90F0",
  pendingAmber: "#D9822B",
  committedGreen: "#3DCC91",
} as const;
