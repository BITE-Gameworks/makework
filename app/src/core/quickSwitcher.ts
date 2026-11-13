// Whether the quick switcher (shell/QuickSwitcher.tsx) is open: the one place to find channels, things inside them,
// messages and commands.
import { createSignal } from "solid-js";

const [quickSwitcherOpen, setQuickSwitcherOpen] = createSignal(false);
export { quickSwitcherOpen, setQuickSwitcherOpen };

export const toggleQuickSwitcher = () => setQuickSwitcherOpen(!quickSwitcherOpen());
