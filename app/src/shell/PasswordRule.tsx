// Under a new-password field (create an account, reset, change password): what a password needs, shown before typing
// and warning colored while the typed one is too short, so a disabled button is never left unexplained.
import { minPasswordLength } from "../core/account";

export default function PasswordRule(props: { password: string; id?: string }) {
  const missing = () => minPasswordLength - props.password.length;
  const short = () => props.password !== "" && missing() > 0;
  return (
    <p id={props.id} class="hint password-rule" classList={{ short: short() }}>
      {short()
        ? `${missing()} more character${missing() === 1 ? "" : "s"} needed (at least ${minPasswordLength}).`
        : `At least ${minPasswordLength} characters.`}
    </p>
  );
}
