import { solidView } from "../../solid";
import type { ClientPlugin } from "../../types";
import { gitSkills, localGitSkills } from "./agentSkills";
import ConnectionSettings from "./ConnectionSettings";
import GitView from "./GitView";
import { startBackgroundWatch } from "./watch";

// Working copies on this device are checked for new remote commits even while their channel isn't open.
startBackgroundWatch();

export const gitPlugin: ClientPlugin = {
  manifest: {
    id: "makework.git",
    icon: "channel-git",
    name: "Version control",
    version: "1.0.0",
    description: "Branches and commit history of a GitHub, GitLab or local repository, imported for the whole workspace.",
    author: "MakeWork",
  },
  agentSkills: { git: [...gitSkills, ...localGitSkills] },
  channelViews: { git: solidView(GitView) },
  settings: [{
    type: "custom", key: "connections", label: "Host connections", render: ConnectionSettings,
    hint: "Your tokens for GitHub and GitLab on this computer. Each version control channel uses one, picked from its More menu.",
  }],
};
