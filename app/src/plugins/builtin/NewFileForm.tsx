// Name and type of a new text or code file (files and code channels): the type picks the extension.
import { createSignal, onMount } from "solid-js";
import Select from "../../ui/Select";
import { fileTypes, withType } from "./fileTypes";

export default function NewFileForm(props: { onSave: (name: string) => unknown; onCancel: () => void; class?: string }) {
  const [ext, setExt] = createSignal<string>("txt");
  let input!: HTMLInputElement;
  let done = false;
  onMount(() => requestAnimationFrame(() => input.focus()));
  const finish = (save: boolean) => {
    if (done) return;
    const name = input.value.trim();
    if (!save || !name) return props.onCancel();
    done = true;
    void Promise.resolve(props.onSave(withType(name, ext()))).finally(() => (done = false));
  };
  return (
    <form class={`new-file-form ${props.class ?? ""}`} onSubmit={(event) => { event.preventDefault(); finish(true); }}
      onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), finish(false))}>
      <input ref={input} class="mw-input mw-box view-input" placeholder="File name" aria-label="File name" required />
      <Select value={ext()} label="File type" options={fileTypes.map((type) => ({ value: type.ext, label: `${type.label} (.${type.ext})` }))}
        onChange={setExt} search />
      <button class="mw-button primary mw-box" type="submit">Create</button>
    </form>
  );
}
