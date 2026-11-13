// What an account needs agreed to; offline use needs none of it. Agreeing is remembered on this device until the
// terms change.
import { Show, createEffect, createSignal } from "solid-js";
import { readJson, writeJson } from "../core/storage";

export const termsUrl = "https://makework.dev/terms/";
export const privacyUrl = "https://makework.dev/privacy/";
export const minimumAge = 16;
// The date at the top of the terms; raise it when they change, so everyone agrees again.
const termsVersion = "2026-11-05";
const agreedKey = "mw.terms.agreed";

export const agreedBefore = () => readJson<string>(agreedKey, "") === termsVersion;
export const rememberAgreement = () => writeJson(agreedKey, termsVersion);

function Link(props: { href: string; label: string }) {
  return <a href={props.href} target="_blank" rel="noopener noreferrer">{props.label}</a>;
}

export default function AccountAgreement(props: { onChange: (agreed: boolean) => void }) {
  const before = agreedBefore();
  const [age, setAge] = createSignal(before);
  const [terms, setTerms] = createSignal(before);
  const [privacy, setPrivacy] = createSignal(before);
  createEffect(() => props.onChange(age() && terms() && privacy()));

  return (
    <Show when={!before} fallback={
      <p class="hint auth-note">
        You agreed to the <Link href={termsUrl} label="Terms of service" /> and read the{" "}
        <Link href={privacyUrl} label="Privacy policy" />.
      </p>
    }>
      <fieldset class="auth-agreement">
        <legend class="hint">An account needs these. Offline, MakeWork needs none of them.</legend>
        <label class="auth-remember">
          <input type="checkbox" checked={age()} onChange={(e) => setAge(e.currentTarget.checked)} />
          I'm {minimumAge} or older
        </label>
        <label class="auth-remember">
          <input type="checkbox" checked={terms()} onChange={(e) => setTerms(e.currentTarget.checked)} />
          <span>I agree to the <Link href={termsUrl} label="Terms of service" /></span>
        </label>
        <label class="auth-remember">
          <input type="checkbox" checked={privacy()} onChange={(e) => setPrivacy(e.currentTarget.checked)} />
          <span>I've read the <Link href={privacyUrl} label="Privacy policy" /></span>
        </label>
      </fieldset>
    </Show>
  );
}
