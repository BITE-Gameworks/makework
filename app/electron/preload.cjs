// The only native API the page sees. Typed in src/core/desktop.ts.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("makeworkDesktop", {
  platform: process.platform,
  takeLastCrash: () => ipcRenderer.invoke("app:take-last-crash"),
  onFarewell: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("app:farewell", listener);
    return () => ipcRenderer.off("app:farewell", listener);
  },
  farewellDone: () => ipcRenderer.send("app:farewell-done"),
  takeOpenLinks: () => ipcRenderer.invoke("app:take-open-links"),
  onOpenLinks: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("app:open-links", listener);
    return () => ipcRenderer.off("app:open-links", listener);
  },
  onQuitCheck: (count) => {
    const listener = () => ipcRenderer.send("app:quit-check-done", Number(count()) || 0);
    ipcRenderer.on("app:quit-check", listener);
    return () => ipcRenderer.off("app:quit-check", listener);
  },
  latestVersion: () => ipcRenderer.invoke("app:latest-version"),
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  focus: () => ipcRenderer.send("window:focus"),
  setIcon: (pngDataUrl, count, extra) => ipcRenderer.send("window:set-icon", pngDataUrl, count, extra),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  // Tabs in their own window (src/core/popout.ts): the page asks, the main process decides where windows go.
  popout: {
    open: (place, at) => ipcRenderer.invoke("popout:open", place, at),
    openInMain: (place) => ipcRenderer.invoke("popout:open-in-main", place),
    returnTab: (place) => ipcRenderer.invoke("popout:return", place),
    dragStart: (place) => ipcRenderer.send("popout:drag-start", place),
    dragMove: (x, y) => ipcRenderer.send("popout:drag-move", x, y),
    dragEnd: (place, x, y) => ipcRenderer.invoke("popout:drag-end", place, x, y),
    dragCancel: () => ipcRenderer.send("popout:drag-cancel"),
    onDragState: (handler) => {
      const listener = (_event, region) => handler(region);
      ipcRenderer.on("popout:drag-state", listener);
      return () => ipcRenderer.off("popout:drag-state", listener);
    },
    onTabDragOver: (handler) => {
      const listener = (_event, at) => handler(at);
      ipcRenderer.on("window:tab-drag-over", listener);
      return () => ipcRenderer.off("window:tab-drag-over", listener);
    },
    onTabDragLeave: (handler) => {
      const listener = () => handler();
      ipcRenderer.on("window:tab-drag-leave", listener);
      return () => ipcRenderer.off("window:tab-drag-leave", listener);
    },
    onTabReceived: (handler) => {
      const listener = (_event, tab) => handler(tab);
      ipcRenderer.on("window:tab-received", listener);
      return () => ipcRenderer.off("window:tab-received", listener);
    },
  },
  background: {
    get: () => ipcRenderer.invoke("background:get"),
    set: (changes) => ipcRenderer.invoke("background:set", changes),
  },
  // Whether the computer runs on battery (src/core/power.ts).
  power: {
    onBattery: () => ipcRenderer.invoke("power:on-battery"),
    onChange: (handler) => {
      const listener = (_event, onBattery) => handler(onBattery);
      ipcRenderer.on("power:changed", listener);
      return () => ipcRenderer.off("power:changed", listener);
    },
    noteBattery: () => ipcRenderer.send("power:has-battery"),
  },
  onMaximizedChange: (handler) => {
    const listener = (_event, maximized) => handler(maximized);
    ipcRenderer.on("window:maximized", listener);
    return () => ipcRenderer.off("window:maximized", listener);
  },
  onScreenShareCancelled: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("screen-share:cancelled", listener);
    return () => ipcRenderer.off("screen-share:cancelled", listener);
  },
  browserKeys: (guestId, events) => ipcRenderer.invoke("browser:keys", guestId, events),
  browserDomStart: (guestId) => ipcRenderer.invoke("browser:dom-start", guestId),
  browserDomStop: (guestId) => ipcRenderer.invoke("browser:dom-stop", guestId),
  browserDomListen: (handler) => {
    const listener = (_event, guestId, events) => handler(guestId, events);
    ipcRenderer.on("browser:dom-events", listener);
    return () => ipcRenderer.off("browser:dom-events", listener);
  },
  browserAdblock: () => ipcRenderer.invoke("browser:adblock"),
  browserAnchors: (guestId, kind, items) => ipcRenderer.invoke("browser:anchors", guestId, kind, items),
  browserCapture: (guestId) => ipcRenderer.invoke("browser:capture", guestId),
  browserElementCapture: {
    start: (guestId, nodeId) => ipcRenderer.invoke("browser:element-capture", guestId, nodeId),
    answer: (guestId, sdp) => ipcRenderer.invoke("browser:element-answer", guestId, sdp),
    stop: (guestId) => ipcRenderer.invoke("browser:element-stop", guestId),
    onOffer: (handler) => {
      const listener = (_event, guestId, nodeId, sdp) => handler(guestId, nodeId, sdp);
      ipcRenderer.on("browser:element-offer", listener);
      return () => ipcRenderer.off("browser:element-offer", listener);
    },
  },
  browserFetch: (guestId, url) => ipcRenderer.invoke("browser:fetch", guestId, url),
  browserProxy: {
    register: (token, partition) => ipcRenderer.invoke("browser:proxy-register", token, partition),
    unregister: (token) => ipcRenderer.invoke("browser:proxy-unregister", token),
    answer: (id, answer) => ipcRenderer.send("browser:proxy-answer", id, answer),
    listen: (handler) => {
      const listener = (_event, id, token, url) => handler(id, token, url);
      ipcRenderer.on("browser:proxy-need", listener);
      return () => ipcRenderer.off("browser:proxy-need", listener);
    },
  },
  browserExtensions: {
    install: (extensionId) => ipcRenderer.invoke("browser-extensions:install", extensionId),
    apply: (partition, ids) => ipcRenderer.invoke("browser-extensions:apply", partition, ids),
  },
  screenSources: () => ipcRenderer.invoke("screen-share:sources"),
  chooseScreenSource: (id, audio) => ipcRenderer.invoke("screen-share:choose", id, audio),
  shareAudio: {
    start: () => ipcRenderer.invoke("share-audio:start"),
    stop: () => ipcRenderer.invoke("share-audio:stop"),
  },
  openContent: (hash, name) => ipcRenderer.invoke("content:open-external", hash, name),
  googleSignIn: (options) => ipcRenderer.invoke("google:sign-in", options),
  githubSignIn: (options) => ipcRenderer.invoke("github:sign-in", options),
  githubCancel: () => ipcRenderer.invoke("github:cancel"),
  content: {
    has: (hash) => ipcRenderer.invoke("content:has", hash),
    size: (hash) => ipcRenderer.invoke("content:size", hash),
    readRange: (hash, start, end) => ipcRenderer.invoke("content:read-range", hash, start, end),
    partOpen: (resumeHash, workspaceId) => ipcRenderer.invoke("content:part-open", resumeHash, workspaceId),
    partAppend: (id, bytes) => ipcRenderer.invoke("content:part-append", id, bytes),
    partFinish: (id, expected) => ipcRenderer.invoke("content:part-finish", id, expected),
    partClose: (id, discard) => ipcRenderer.invoke("content:part-close", id, discard),
    remove: (hash) => ipcRenderer.invoke("content:delete", hash),
    removeShared: (hash) => ipcRenderer.invoke("content:delete-shared", hash),
  },
  storage: {
    pick: (workspaceId) => ipcRenderer.invoke("storage:pick", workspaceId),
    pickExisting: () => ipcRenderer.invoke("storage:pick-existing"),
    assign: (token, workspaceId, fields) => ipcRenderer.invoke("storage:assign", token, workspaceId, fields),
    describe: (workspaceId, fields) => ipcRenderer.invoke("storage:describe", workspaceId, fields),
    location: (workspaceId) => ipcRenderer.invoke("storage:location", workspaceId),
    locations: () => ipcRenderer.invoke("storage:locations"),
    loadCommits: (workspaceId) => ipcRenderer.invoke("storage:commits-load", workspaceId),
    addCommits: (workspaceId, commits) => ipcRenderer.invoke("storage:commits-add", workspaceId, commits),
    compactCommits: (workspaceId, hashes) => ipcRenderer.invoke("storage:commits-compact", workspaceId, hashes),
    loadCheckpoint: (workspaceId) => ipcRenderer.invoke("storage:checkpoint-load", workspaceId),
    saveCheckpoint: (workspaceId, checkpoint) => ipcRenderer.invoke("storage:checkpoint-save", workspaceId, checkpoint),
    deleteCheckpoint: (workspaceId) => ipcRenderer.invoke("storage:checkpoint-delete", workspaceId),
    move: (workspaceId, token, data) => ipcRenderer.invoke("storage:move", workspaceId, token, data),
    onMoveProgress: (handler) => {
      const listener = (_event, progress) => handler(progress);
      ipcRenderer.on("storage:move-progress", listener);
      return () => ipcRenderer.off("storage:move-progress", listener);
    },
    show: (workspaceId) => ipcRenderer.invoke("storage:show", workspaceId),
    forget: (workspaceId) => ipcRenderer.invoke("storage:forget", workspaceId),
    release: (workspaceId) => ipcRenderer.invoke("storage:release", workspaceId),
  },
  save: {
    choose: (kind, suggestedName) => ipcRenderer.invoke("save:choose", kind, suggestedName),
    mkdir: (id, segments, free) => ipcRenderer.invoke("save:mkdir", id, segments, free),
    write: (id, segments, hash) => ipcRenderer.invoke("save:write", id, segments, hash),
    done: (id) => ipcRenderer.invoke("save:done", id),
  },
  git: {
    pickFolder: () => ipcRenderer.invoke("git:pick-folder"),
    openFolder: (folder) => ipcRenderer.invoke("git:open-folder", folder),
    branches: (folder) => ipcRenderer.invoke("git:branches", folder),
    log: (folder, from, skip, max) => ipcRenderer.invoke("git:log", folder, from, skip, max),
    status: (folder) => ipcRenderer.invoke("git:status", folder),
    workingDiff: (folder, file) => ipcRenderer.invoke("git:working-diff", folder, file),
    show: (folder, sha) => ipcRenderer.invoke("git:show", folder, sha),
    files: (folder, rev) => ipcRenderer.invoke("git:files", folder, rev),
    blame: (folder, rev, file) => ipcRenderer.invoke("git:blame", folder, rev, file),
    branchList: (folder) => ipcRenderer.invoke("git:branch-list", folder),
    graph: (folder, options) => ipcRenderer.invoke("git:graph", folder, options),
    remoteHeads: (folder) => ipcRenderer.invoke("git:remote-heads", folder),
    createBranch: (folder, name, from) => ipcRenderer.invoke("git:branch-create", folder, name, from),
    deleteBranch: (folder, name, protectedNames) => ipcRenderer.invoke("git:branch-delete", folder, name, protectedNames),
    switchBranch: (folder, name) => ipcRenderer.invoke("git:switch", folder, name),
    commit: (folder, options) => ipcRenderer.invoke("git:commit", folder, options),
    fetch: (folder) => ipcRenderer.invoke("git:fetch", folder),
    pushCheck: (folder, branch) => ipcRenderer.invoke("git:push-check", folder, branch),
    push: (folder, options) => ipcRenderer.invoke("git:push", folder, options),
    merge: (folder) => ipcRenderer.invoke("git:merge", folder),
    mergeBranch: (folder, source) => ipcRenderer.invoke("git:merge-branch", folder, source),
    mergeInto: (folder, target) => ipcRenderer.invoke("git:merge-into", folder, target),
    mergeConflicts: (folder, target) => ipcRenderer.invoke("git:merge-conflicts", folder, target),
    mergeFile: (folder, versions) => ipcRenderer.invoke("git:merge-file", folder, versions),
    mergeDiff: (folder, receiving, tree, file) => ipcRenderer.invoke("git:merge-diff", folder, receiving, tree, file),
    mergeResolved: (folder, options) => ipcRenderer.invoke("git:merge-resolved", folder, options),
    revertTo: (folder, sha, options) => ipcRenderer.invoke("git:revert-to", folder, sha, options),
    stashList: (folder) => ipcRenderer.invoke("git:stash-list", folder),
    stashPush: (folder, options) => ipcRenderer.invoke("git:stash-push", folder, options),
    stashRestore: (folder, sha) => ipcRenderer.invoke("git:stash-restore", folder, sha),
    stashDelete: (folder, sha) => ipcRenderer.invoke("git:stash-delete", folder, sha),
    useAccount: (id, credentials) => ipcRenderer.invoke("git:account", id, credentials),
  },
  web: {
    read: (address) => ipcRenderer.invoke("web:read", address),
    search: (query) => ipcRenderer.invoke("web:search", query),
  },
  video: {
    hasFfmpeg: () => ipcRenderer.invoke("video:has-ffmpeg"),
    probeSound: (hash) => ipcRenderer.invoke("video:probe-sound", hash),
    cached: (hash, kind) => ipcRenderer.invoke("video:cached", hash, kind),
    convert: (id, hash, kind) => ipcRenderer.invoke("video:convert", id, hash, kind),
    cancel: (id) => ipcRenderer.send("video:cancel", id),
    onProgress: (handler) => {
      const listener = (_event, id, value) => handler(id, value);
      ipcRenderer.on("video:progress", listener);
      return () => ipcRenderer.off("video:progress", listener);
    },
  },
  media: {
    resolve: (address, audioOnly) => ipcRenderer.invoke("media:resolve", address, audioOnly),
    list: (address) => ipcRenderer.invoke("media:list", address),
    release: (session) => ipcRenderer.invoke("media:release", session),
  },
  github: {
    deviceStart: (clientId, account) => ipcRenderer.invoke("github:device-start", clientId, account),
    deviceWait: (handle) => ipcRenderer.invoke("github:device-wait", handle),
    deviceCancel: (handle) => ipcRenderer.invoke("github:device-cancel", handle),
    openDevicePage: () => ipcRenderer.invoke("github:open-device-page"),
  },
  release: {
    inspect: (folder) => ipcRenderer.invoke("release:inspect", folder),
    build: (folder, branch, plan) => ipcRenderer.invoke("release:build", folder, branch, plan),
    stop: () => ipcRenderer.send("release:stop"),
    onLog: (handler) => {
      const listener = (_event, line) => handler(line);
      ipcRenderer.on("release:log", listener);
      return () => ipcRenderer.off("release:log", listener);
    },
    pickFiles: () => ipcRenderer.invoke("release:pick-files"),
    upload: (target, file, name) => ipcRenderer.invoke("release:upload", target, file, name),
    onProgress: (handler) => {
      const listener = (_event, file, done) => handler(file, done);
      ipcRenderer.on("release:progress", listener);
      return () => ipcRenderer.off("release:progress", listener);
    },
  },
  secrets: {
    available: () => ipcRenderer.invoke("secret:available"),
    get: (key) => ipcRenderer.invoke("secret:get", key),
    set: (key, value) => ipcRenderer.invoke("secret:set", key, value),
    remove: (key) => ipcRenderer.invoke("secret:delete", key),
  },
  code: {
    sync: (workspaceId, channelId, entries) => ipcRenderer.invoke("code:sync", workspaceId, channelId, entries),
    openFolder: (workspaceId, channelId) => ipcRenderer.invoke("code:open-folder", workspaceId, channelId),
    startServer: (serverId, workspaceId, channelId, override) => ipcRenderer.invoke("lsp:start", serverId, workspaceId, channelId, override),
    installServer: (serverId) => ipcRenderer.invoke("lsp:install", serverId),
    installedServers: () => ipcRenderer.invoke("lsp:installed"),
    uninstallServer: (serverId) => ipcRenderer.invoke("lsp:uninstall", serverId),
    sendServer: (id, text) => ipcRenderer.send("lsp:send", id, text),
    stopServer: (id) => ipcRenderer.send("lsp:stop", id),
    onServer: (handler) => {
      const message = (_event, id, text) => handler(id, { text });
      const exit = (_event, id, code, errors) => handler(id, { exit: code, errors });
      ipcRenderer.on("lsp:message", message);
      ipcRenderer.on("lsp:exit", exit);
      return () => {
        ipcRenderer.off("lsp:message", message);
        ipcRenderer.off("lsp:exit", exit);
      };
    },
    terminalsAvailable: () => ipcRenderer.invoke("term:available"),
    startTerminal: (options) => ipcRenderer.invoke("term:start", options),
    writeTerminal: (id, data) => ipcRenderer.send("term:write", id, data),
    resizeTerminal: (id, cols, rows) => ipcRenderer.send("term:resize", id, cols, rows),
    killTerminal: (id) => ipcRenderer.send("term:kill", id),
    closeTerminal: (id) => ipcRenderer.send("term:close", id),
    restartTerminal: (id) => ipcRenderer.invoke("term:restart", id),
    popOutTerminal: (id, at) => ipcRenderer.invoke("term:popout", id, at),
    adoptTerminal: (id) => ipcRenderer.invoke("term:adopt", id),
    returnTerminal: (id) => ipcRenderer.send("term:return", id),
    onTerminal: (handler) => {
      const data = (_event, id, text) => handler(id, { data: text });
      const exit = (_event, id, code) => handler(id, { exit: code });
      const returned = (_event, id, state) => handler(id, { returned: state });
      ipcRenderer.on("term:data", data);
      ipcRenderer.on("term:exit", exit);
      ipcRenderer.on("term:returned", returned);
      return () => {
        ipcRenderer.off("term:data", data);
        ipcRenderer.off("term:exit", exit);
        ipcRenderer.off("term:returned", returned);
      };
    },
  },
  mirror: {
    apply: (key, workspaceName, entries) => ipcRenderer.invoke("mirror:apply", key, workspaceName, entries),
    open: (key, workspaceName, inner) => ipcRenderer.invoke("mirror:open", key, workspaceName, inner),
    scan: (key) => ipcRenderer.invoke("mirror:scan", key),
    adopt: (key, relative, stats, moveTo) => ipcRenderer.invoke("mirror:adopt", key, relative, stats, moveTo),
    onChanges: (handler) => {
      const listener = (_event, key, changes) => handler(key, changes);
      ipcRenderer.on("mirror:changes", listener);
      return () => ipcRenderer.off("mirror:changes", listener);
    },
  },
});
