// Whether this is an installed build, as opposed to a dev run (`npm run dev:desktop`, test instances). Never read
// `app.isPackaged` for this: Electron only checks that the executable isn't named electron(.exe), so the dev runs'
// renamed copy `MakeWork-dev.exe` (electron/devExe.js) counted as installed. It then loaded the last build in dist/
// instead of the dev server and used the installed app's profile, folders and taskbar id. Dev runs start
// Electron's default app with the app's folder (`electron .`), which sets `process.defaultApp`; installed builds never do.
import { app } from "electron";

export const installed = app.isPackaged && !process.defaultApp;
