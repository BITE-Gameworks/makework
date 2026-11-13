// Settings > Server: the services the app uses besides its members, the user server and the TURN server.
import { syncAccount } from "../core/account";
import { checkTurnServer, defaultTurnServer, setTurnServer, turnServer } from "../p2p/ice";
import AddressField, { UserServerField } from "./AddressField";

export default function ServicesSettings() {
  return (
    <div class="settings-section account-settings">
      <h2>Connections</h2>
      <div class="account-field">
        <span>User server</span>
        <UserServerField label="Accounts and private messages on" onChange={() => void syncAccount()} />
        <p class="hint">Keeps accounts so they work on every computer, and private messages until they are picked up.</p>
      </div>
      <div class="account-field">
        <span>TURN server</span>
        <AddressField label="Relays from" name="TURN server address" current={turnServer}
          defaultUrl={defaultTurnServer} check={checkTurnServer} set={setTurnServer} />
        <p class="hint">Only used when members can't reach each other any other way. It must take the user server's accounts.</p>
      </div>
    </div>
  );
}
