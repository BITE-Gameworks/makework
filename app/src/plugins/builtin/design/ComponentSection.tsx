import { For, Show } from "solid-js";
import { Icon } from "../../../theme/icons";
import Select from "../../../ui/Select";
import {
  addVariant, createInstance, detachInstances, renameVariant, resetOverrides, setVariant, swapComponent, variantsOf,
} from "./actions";
import { variantProperties, variantValues } from "./components";
import type { Editor } from "./editor";
import { Section } from "./fields";
import type { Point } from "./model";

// What the properties panel needs from the view to show and place components.
export interface Place {
  reveal(ids: number[]): void;
  center(): Point;
}

const instances = (n: number) => (n === 1 ? "1 instance" : `${n} instances`);

// The selected layer's component: a main with its instances, a variant set, an instance with its main, or a layer
// in an instance.
export function ComponentSection(props: { editor: Editor; place: Place }) {
  const ed = props.editor;
  const one = () => (ed.topSelected().length === 1 ? ed.node(ed.topSelected()[0]) : undefined);
  const instance = () => {
    const n = one();
    return n && n.props.instanceOf !== null ? n : undefined;
  };
  const copy = () => (one() && ed.isCopy(one()!.id) ? one() : undefined);
  const main = (id: number | null | undefined) => {
    const n = ed.node(id);
    return n?.props.main ? n : undefined;
  };
  const inSet = (id: number) => !!ed.node(ed.node(id)?.parentId)?.props.variantSet;
  const usedBy = (mainId: number) => variantsOf(ed, mainId).flatMap((v) => ed.instancesOf(v));
  const overridden = (ids: number[]) => ids.some((id) => (ed.node(id)?.props.overrides.length ?? 0) > 0);
  const properties = (mainId: number) => variantProperties(variantsOf(ed, mainId).map((id) => ed.node(id)!.name));

  return (
    <>
      <Show when={one()?.props.variantSet ? one() : undefined}>
        {(set) => (
          <Section title="Variant set" actions={<Icon name="design-component" size={14} />}>
            <For each={variantProperties(ed.children(set().id).filter((id) => ed.node(id)?.props.main).map((id) => ed.node(id)!.name))}>
              {([key, values]) => <p class="design-note">{key}: {values.join(", ")}</p>}
            </For>
            <div class="design-button-row">
              <Show when={ed.children(set().id).findLast((id) => ed.node(id)?.props.main)}>
                {(last) => <button class="mw-button mw-box" onClick={() => void addVariant(ed, last())}>Add variant</button>}
              </Show>
              <button class="mw-button mw-box" onClick={() => void createInstance(ed, set().id)}>Create instance</button>
            </div>
          </Section>
        )}
      </Show>
      <Show when={one()?.props.main ? one() : undefined}>
        {(n) => (
          <Section title={inSet(n().id) ? "Variant" : "Main component"} actions={<Icon name="design-component" size={14} />}>
            <Show when={inSet(n().id)}>
              <For each={Object.entries(variantValues(n().name))}>
                {([key, value]) => (
                  <label class="design-field design-variant-field" title={`${key} of this variant`}>
                    <span class="design-field-label">{key}</span>
                    <input class="design-field-input" value={value} spellcheck={false}
                      onChange={(e) => renameVariant(ed, n().id, key, e.currentTarget.value)}
                      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
                  </label>
                )}
              </For>
            </Show>
            <p class="design-note">{instances(ed.instancesOf(n().id).length)}. Changes here show in every instance.</p>
            <div class="design-button-row">
              <button class="mw-button mw-box" onClick={() => void createInstance(ed, n().id)}>Create instance</button>
              <Show when={inSet(n().id)}>
                <button class="mw-button mw-box" onClick={() => void addVariant(ed, n().id)}>Add variant</button>
              </Show>
              <Show when={usedBy(n().id).length > 0}>
                <button class="icon-button" title="Select instances" aria-label="Select instances" onClick={() => props.place.reveal(usedBy(n().id))}>
                  <Icon name="design-instance" />
                </button>
              </Show>
            </div>
          </Section>
        )}
      </Show>
      <Show when={instance()}>
        {(n) => (
          <Section title="Instance" actions={<Icon name="design-instance" size={14} />}>
            <Show when={main(n().props.instanceOf)} fallback={<p class="design-note">Its main component was deleted; it keeps how it looks.</p>}>
              {(m) => (
                <Show when={inSet(m().id)} fallback={
                  <Select label="Component" value={m().id} search={ed.mains().length > 12}
                    prefix={<Icon name="design-component" size={14} />}
                    options={ed.mains().map((id) => ({ value: id, label: ed.node(id)?.name ?? "" }))}
                    onChange={(id) => swapComponent(ed, n().id, id)} />
                }>
                  <p class="design-note">{ed.node(m().parentId)?.name}</p>
                  <For each={properties(m().id)}>
                    {([key, values]) => (
                      <div class="design-variant-row">
                        <span class="design-field-label">{key}</span>
                        <Select class="design-grow" label={key} value={variantValues(m().name)[key] ?? null} placeholder="None"
                          options={values.map((v) => ({ value: v, label: v }))} onChange={(v) => setVariant(ed, n().id, key, v)} />
                      </div>
                    )}
                  </For>
                </Show>
              )}
            </Show>
            <div class="design-button-row">
              <Show when={main(n().props.instanceOf)}>
                <button class="icon-button" title="Go to main component" aria-label="Go to main component"
                  onClick={() => props.place.reveal([n().props.instanceOf!])}><Icon name="design-component" /></button>
              </Show>
              <button class="icon-button" title="Reset overrides" aria-label="Reset overrides" disabled={!overridden(ed.instanceLayers(n().id))}
                onClick={() => resetOverrides(ed, [n().id])}><Icon name="undo" /></button>
              <button class="icon-button" title="Detach instance" aria-label="Detach instance" onClick={() => detachInstances(ed, [n().id])}>
                <Icon name="design-detach" />
              </button>
            </div>
          </Section>
        )}
      </Show>
      <Show when={copy()}>
        {(n) => (
          <Section title="In an instance" actions={<Icon name="design-instance" size={14} />}>
            <p class="design-note">
              <Show when={n().props.overrides.length} fallback="Follows its main component.">
                Changed here: {n().props.overrides.join(", ")}.
              </Show>
            </p>
            <div class="design-button-row">
              <button class="mw-button mw-box" onClick={() => props.place.reveal([ed.instanceOf(n().id)!])}>Select instance</button>
              <button class="mw-button mw-box" disabled={!n().props.overrides.length} onClick={() => resetOverrides(ed, [n().id])}>Reset</button>
            </div>
          </Section>
        )}
      </Show>
    </>
  );
}

// The document's components (a variant set counts once), shown while nothing is selected: insert one in the view's
// middle, or go to it.
export function ComponentList(props: { editor: Editor; place: Place }) {
  const ed = props.editor;
  const entries = () => [...new Set(ed.mains().map((id) => {
    const parent = ed.node(ed.node(id)?.parentId);
    return parent?.props.variantSet ? parent.id : id;
  }))];
  return (
    <Show when={entries().length > 0}>
      <Section title="Components">
        <For each={entries()}>
          {(id) => (
            <Show when={ed.node(id)}>
              {(n) => (
                <div class="design-component-row">
                  <Icon name="design-component" size={14} />
                  <button class="design-component-name" title="Go to the main component" onClick={() => props.place.reveal([id])}>{n().name}</button>
                  <button class="icon-button" title="Insert an instance" aria-label={`Insert an instance of ${n().name}`} disabled={!ed.canEdit()}
                    onClick={() => void createInstance(ed, id, props.place.center())}><Icon name="add" /></button>
                </div>
              )}
            </Show>
          )}
        </For>
      </Section>
    </Show>
  );
}
