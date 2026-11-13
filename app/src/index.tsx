/* @refresh reload */
import { lazy } from "solid-js";
import { render } from "solid-js/web";
import "@fontsource-variable/comfortaa";
import "@fontsource-variable/fira-code";
import "@fontsource/barlow-condensed/400.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/rajdhani/500.css";
import "@fontsource/rajdhani/700.css";
import "./theme/base.css";
import { initTheme } from "./theme/store";
import { initAppIcon } from "./core/appIcon";
import { startCrashReports } from "./core/crashReports";
import { watchFarewell } from "./core/farewell";
import { initPower } from "./core/power";
import { isPopout, terminalWindowId } from "./core/popout";
import App from "./App";
import { watchCopy } from "./markdown/copy";
import { watchDesktopLinks } from "./core/openLinks";

// A terminal window shows one code channel terminal and nothing of the app (no sign-in, no workspace).
const TerminalWindow = lazy(() => import("./plugins/builtin/code/TerminalWindow"));

render(() => {
  initTheme();
  initPower();
  if (terminalWindowId !== null) return <TerminalWindow id={terminalWindowId} />;
  // Before any workspace joins its rooms: the bye goes out ahead of Trystero's own leave.
  watchFarewell();
  // The app icon carries the mention badge, which belongs to the main window.
  if (!isPopout()) initAppIcon();
  if (!isPopout()) startCrashReports();
  watchDesktopLinks();
  watchCopy();
  return <App />;
}, document.getElementById("root") as HTMLElement);
