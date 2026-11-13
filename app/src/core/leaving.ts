// The app reloading the page itself (signing out, an account deleted): the browser's "Leave site?" that new uploads on
// their way to a node raise (core/farewell.ts) must not come then. Asked after the sign-out or deletion was done, a
// "Stay" left the page signed in without a session. No imports, so core/account.ts can use it without a cycle through
// core/farewell.ts.

let onPurpose = false;

export function reloadOnPurpose(): void {
  onPurpose = true;
  location.reload();
}

export function leavingOnPurpose(): boolean {
  return onPurpose;
}
