// Members' display names and avatars, and the signed-in user. A backend made without a user id acts as mockUserId (tests).
import { botUsername } from "../core/botName";
import type { MockPlugin } from "./backend";
import { InvalidRequest } from "./errors";
import { inviteOpen, inviteProof, inviteTokenKey, inviteUseTextV2 } from "../p2p/invite";

export const mockUserId = 1;

export const members: MockPlugin = {
  manifest: {
    name: "members",
    version: "1.0.0",
    description: "Profiles of the workspace's users.",
    tables: [
      {
        name: "members_profiles", parent: null,
        // Nickname and bio are this workspace's own; the rest comes from the account.
        // `key_x`, `key_y`: the member's public account key, kept here since commits can go with a snapshot.
        columns: { user_id: "bigint", key_x: "text", key_y: "text", username: "text", display_name: "text", color: "text", avatar: "text", nickname: "text", bio: "text", bot: "bool", bot_type: "text", bot_number: "int" },
      },
      // Who was kicked: until they rejoin (a new profile) their changes are refused (p2p/policy.ts), and their app leaves.
      { name: "members_kicks", parent: null, columns: { user_id: "bigint", kicked_by: "bigint", created_at: "timestamp" } },
      // A member moved to another account by the owner (core/memberMove.ts): from_id is shown as to_id everywhere.
      { name: "members_moves", parent: null, columns: { from_id: "bigint", to_id: "bigint", name: "text", moved_by: "bigint", created_at: "timestamp" } },
      // `public_token`: the token itself, for an invite shown on the nodes' invite pages (public anyway); empty for one
      // whose token only its creator can open (`sealed_token`). `uses`: joins counted on the row by v1 uses (before
      //); v2 joins are rows of members_invite_joins.
      { name: "members_invites", parent: null, columns: {
        token_key: "text", sealed_token: "text", label: "text", created_by: "bigint", created_at: "timestamp", expires_at: "timestamp",
        max_uses: "int", uses: "int", revoked: "bool", public_token: "text",
        // Joiners become guests (p2p/permissions.ts guestsFrom): the Guest role, and no chat from before they joined.
        guest: "bool",
      } },
      // A signed use of an invite, written and removed in the joiner's own commit with their profile: proof that this
      // join had the token. `uses` is set only by v1 uses.
      { name: "members_invite_uses", parent: null, columns: {
        invite_id: "bigint", user_id: "bigint", token_key: "text", proof: "text", uses: "int", used_at: "timestamp",
      } },
      // One row per join with an invite (v2), kept: what an invite's use limit counts. Rows rather than a counter, so
      // two people joining with one invite at once both get in.
      { name: "members_invite_joins", parent: null, columns: { invite_id: "bigint", user_id: "bigint", use_id: "bigint", joined_at: "timestamp" } },
      // A guest made a full member, by someone with Manage roles.
      { name: "members_promotions", parent: null, columns: { user_id: "bigint", promoted_by: "bigint", created_at: "timestamp" } },
      { name: "members_rotations", parent: null, columns: { generation: "int", created_by: "bigint", created_at: "timestamp" } },
      { name: "members_secrets", parent: null, columns: { user_id: "bigint", generation: "int", sealed: "text" } },
      { name: "members_snapshots", parent: null, columns: {
        cutoff_index: "bigint", cutoff_hash: "text", genesis_hash: "text", vector: "text", content: "text",
        archive_content: "text", created_by: "bigint", created_at: "timestamp",
      } },
    ],
  },

  register({ onApi, data, onApiRead, onApiInsert }) {
    onApi("whoami", "Returns the signed-in user: { user_id }.", [], (r) => ({ user_id: r.userId }));
    onApi("set-profile", "Sets the signed-in user's profile, adding it on first use; returns { updated, created }.", [
      { name: "username", type: "text", required: false },
      { name: "display_name", type: "text" },
      { name: "color", type: "text" },
      { name: "avatar", type: "text", required: false, description: "\"gen:<seed>\" for a generated pattern, or a small data:image URL." },
      { name: "invite_token", type: "text", required: false },
      { name: "key_x", type: "text", required: false },
      { name: "key_y", type: "text", required: false },
      { name: "node", type: "bool", required: false, description: "A node's own profile: no invite, once a member with Manage nodes added the node." },
    ], (r) => {
      const { invite_token: inviteToken, node, ...profile } = r.args;
      const values = Object.fromEntries(Object.entries(profile).filter(([, v]) => v !== null));
      if (data.update("members_profiles", values, { user_id: r.userId }) > 0) return { updated: true, created: false };
      const invites = data.select("members_invites", {});
      if (invites.length && typeof inviteToken !== "string" && node !== true) throw new InvalidRequest("A valid workspace invite is required to join.");
      if (typeof inviteToken === "string") {
        return addWithInvite(inviteToken, r.userId, values);
      }
      data.insert("members_profiles", { ...values, user_id: r.userId });
      return { updated: true, created: true };
    });
    onApi("set-workspace-profile", "Sets the signed-in user's nickname and about text in this workspace; returns { updated }.", [
      { name: "nickname", type: "text", required: false, description: "Shown instead of the display name here; empty for none." },
      { name: "bio", type: "text", required: false, description: "About me, up to 500 characters." },
    ], (r) => {
      const nickname = String(r.args.nickname ?? "").trim().slice(0, 48);
      const bio = String(r.args.bio ?? "").trim().slice(0, 500);
      if (data.update("members_profiles", { nickname, bio }, { user_id: r.userId }) > 0) return { updated: true };
      data.insert("members_profiles", { user_id: r.userId, nickname, bio });
      return { updated: true };
    });
    onApi("set-bot-profile", "Creates or updates the profile marker for a workspace bot.", [
      { name: "user_id", type: "bigint" }, { name: "bot_type", type: "text" }, { name: "nickname", type: "text" },
      { name: "bot_number", type: "int", required: false },
      { name: "avatar", type: "text", required: false, description: "gen:<seed> picks the robot face; empty keeps it." },
    ], (r) => {
      const userId = Number(r.args.user_id);
      const names = ["Waffle", "Biscuit", "Pickle", "Noodle", "Muffin", "Gizmo", "Sprout", "Pogo", "Zigzag", "Button"];
      const nickname = String(r.args.nickname ?? "").trim().slice(0, 48) || `${names[Math.abs(userId) % names.length]} ${100 + (Math.abs(userId) % 900)}`;
      const type = String(r.args.bot_type).toLowerCase();
      const avatar = String(r.args.avatar ?? "").slice(0, 80);
      const values = {
        user_id: userId, username: botUsername(type), display_name: nickname,
        nickname, bot: true, bot_type: type, bot_number: Number(r.args.bot_number ?? 1),
        ...(avatar ? { avatar } : {}),
      };
      if (data.update("members_profiles", values, { user_id: values.user_id }) > 0) return { updated: true };
      data.insert("members_profiles", { bio: "", ...values });
      return { updated: true };
    });
    onApi("kick", "Removes a member: their profile goes and their changes are refused until they join again with an invite. Returns { kicked }.", [
      { name: "user_id", type: "bigint" },
    ], (r) => {
      const kicked = data.delete("members_profiles", { user_id: r.args.user_id }) > 0;
      if (kicked) data.insert("members_kicks", { user_id: r.args.user_id, kicked_by: r.userId, created_at: new Date().toISOString() });
      return { kicked };
    });
    onApi("create-invite", "Creates a workspace invite; returns { id, token }. The token is shown only once, unless the invite is public.", [
      { name: "token", type: "text" },
      { name: "sealed_token", type: "text" },
      { name: "label", type: "text", required: false },
      { name: "expires_at", type: "timestamp", required: false },
      { name: "max_uses", type: "int", required: false },
      { name: "public", type: "bool", required: false, description: "Shown on the nodes' invite pages: its token is kept readable in the workspace." },
      { name: "guest", type: "bool", required: false, description: "Joiners become guests: the Guest role, and no chat from before they joined." },
    ], (r) => {
      const token = String(r.args.token ?? "");
      const tokenKey = inviteTokenKey(token);
      const sealedToken = String(r.args.sealed_token ?? "");
      if (!tokenKey || !sealedToken) throw new InvalidRequest("A valid, locally sealed invite token is required.");
      const label = String(r.args.label ?? "").trim().slice(0, 64);
      const given = r.args.expires_at ?? null;
      const expiry = given instanceof Date ? given.toISOString() : given;
      if (expiry !== null && (typeof expiry !== "string" || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()))
        throw new InvalidRequest("Invite expiry must be a future date.");
      const maxUses = r.args.max_uses === null || r.args.max_uses === undefined ? null : Number(r.args.max_uses);
      if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1))
        throw new InvalidRequest("Invite use limit must be a positive whole number.");
      const id = data.insert("members_invites", {
        token_key: tokenKey, sealed_token: sealedToken, label, created_by: r.userId, created_at: new Date().toISOString(),
        expires_at: expiry, max_uses: maxUses, uses: 0, revoked: false, public_token: r.args.public === true ? token : "",
        ...(r.args.guest === true ? { guest: true } : {}),
      });
      return { id, token };
    });
    onApi("promote-guest", "Makes a guest a full member; returns { id }.", [{ name: "user_id", type: "bigint" }],
      (r) => ({ id: data.insert("members_promotions", { user_id: r.args.user_id, promoted_by: r.userId, created_at: new Date().toISOString() }) }));
    onApi("rotate-secret", "Records a new workspace room secret encrypted to every current member.", [
      { name: "generation", type: "int" }, { name: "secrets", type: "text" },
    ], (r) => {
      let secrets: { user_id: number; sealed: string }[];
      try {
        const value: unknown = JSON.parse(String(r.args.secrets));
        if (!Array.isArray(value) || value.some((row) => !row || !Number.isSafeInteger(row.user_id) || typeof row.sealed !== "string"))
          throw new Error("invalid secret rows");
        secrets = value as { user_id: number; sealed: string }[];
      } catch {
        throw new InvalidRequest("Secret rotation data is malformed.");
      }
      const generation = Number(r.args.generation);
      data.insert("members_rotations", { generation, created_by: r.userId, created_at: new Date().toISOString() });
      for (const row of secrets) data.insert("members_secrets", { ...row, generation });
      return { generation };
    });
    onApi("revoke-invite", "Revokes a workspace invite; returns { revoked }.", [
      { name: "id", type: "bigint" },
    ], (r) => ({ revoked: data.update("members_invites", { revoked: true }, { id: r.args.id }) > 0 }));
    onApi("delete-invite", "Permanently removes a closed (revoked, expired or used up) invite; returns { deleted }.", [
      { name: "id", type: "bigint" },
    ], (r) => {
      const invite = data.select("members_invites", { id: r.args.id })[0];
      const joins = invite ? data.select("members_invite_joins", { invite_id: invite.id }).length : 0;
      if (!invite || inviteOpen(invite, joins))
        throw new InvalidRequest("Only a closed invite (revoked, expired or used up) can be permanently deleted.");
      return { deleted: data.delete("members_invites", { id: r.args.id }) > 0 };
    });
    onApiRead((r) => data.select(r.table, r.where));
    onApiInsert((r) => data.insert(r.table, r.values));

    function addWithInvite(inviteToken: string, userId: number, values: Record<string, unknown>) {
      const tokenKey = inviteTokenKey(inviteToken);
      const invite = tokenKey ? data.select("members_invites", { token_key: tokenKey })[0] : undefined;
      if (!invite || !inviteOpen(invite, data.select("members_invite_joins", { invite_id: invite.id }).length))
        throw new InvalidRequest("That invite has expired, been revoked or reached its use limit.");
      const proof = inviteProof(inviteToken, inviteUseTextV2(Number(invite.id), userId));
      if (!proof) throw new InvalidRequest("That invite token is invalid.");
      const now = new Date().toISOString();
      const useId = data.insert("members_invite_uses", { invite_id: invite.id, user_id: userId, token_key: tokenKey, proof, used_at: now });
      data.insert("members_invite_joins", { invite_id: invite.id, user_id: userId, use_id: useId, joined_at: now });
      data.insert("members_profiles", { ...values, user_id: userId });
      data.delete("members_invite_uses", { id: useId });
      return { updated: true, created: true };
    }
  },
};
