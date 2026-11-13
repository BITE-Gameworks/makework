// Helpers loaded into the app page (dev run) by run.sh: `LH` talks to the app's own modules as the signed-in owner.
// Nothing here is hard-coded to one workspace: LH.init("Name") finds the workspace and its bots by name.
window.LH = {
  ws: null, bots: {},
  async mods() { return { w: await import('/src/core/workspaces.ts'), n: await import('/src/core/navigation.ts') }; },
  // Finds the workspace by (part of) its name and learns its bots' user ids by nickname.
  async init(name) {
    const { w } = await this.mods();
    const found = Object.values(w.workspaces.byId).find((x) => String(x.info?.name ?? '').toLowerCase().includes(String(name).toLowerCase()));
    if (!found) throw new Error('No workspace named ' + name + '. Have: ' + Object.values(w.workspaces.byId).map((x) => x.info?.name).join(', '));
    this.ws = found.id;
    this.bots = Object.fromEntries((await this.read('bots', 'bots_bots')).map((r) => [r.nickname, Number(r.user_id)]));
    return { ws: this.ws, bots: this.bots, channels: found.channels.map((c) => c.name + ':' + c.type) };
  },
  async chan(name) { const { w } = await this.mods(); return w.workspaces.byId[this.ws].channels.find((c) => c.name === name)?.id; },
  async open(name) { const { n } = await this.mods(); n.openChannel(this.ws, await this.chan(name)); },
  // `@Nickname` in the text becomes a real mention of that bot.
  async say(channel, text, thread = null) {
    const { w } = await this.mods();
    let body = text;
    for (const [nick, id] of Object.entries(this.bots)) body = body.split('@' + nick).join('<@' + id + '>');
    const r = await w.workspaceApi(this.ws).plugin('chat').call('post-message', { channel_id: await this.chan(channel), body, thread_id: thread });
    return r.id;
  },
  async msgs(channel, thread = null) {
    const { w } = await this.mods();
    const names = Object.fromEntries(Object.entries(this.bots).map(([n, id]) => [id, n]));
    const { rows } = await w.workspaceApi(this.ws).plugin('chat').call('list-messages', { channel_id: await this.chan(channel), thread_id: thread });
    return rows.map((m) => ({ id: m.id, who: names[m.author_id] || 'owner', body: m.body, steps: m.steps || undefined, replies: m.reply_count }));
  },
  async read(plugin, table, where) {
    const { w } = await this.mods();
    return w.workspaceApi(this.ws ?? Object.keys(w.workspaces.byId)[0]).plugin(plugin).read(table, where);
  },
  async log(nick, n = 25) {
    const b = await import('/src/core/bots.ts');
    const row = (await this.read('bots', 'bots_bots')).find((r) => r.nickname === nick);
    return b.botLog(this.ws, Number(row.id)).slice(-n);
  },
  // Sends a message and waits until the bots add nothing for `quiet` ms (or `max` ms pass). Returns the new messages.
  async task(channel, text, { thread = null, quiet = 12000, max = 300000 } = {}) {
    const before = (await this.msgs(channel, thread)).length;
    await this.say(channel, text, thread);
    const start = Date.now();
    let last = Date.now(), count = before + 1;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const now = (await this.msgs(channel, thread)).length;
      if (now !== count) { count = now; last = Date.now(); }
      if (now > before + 1 && Date.now() - last > quiet) break;
      if (Date.now() - start > max) break;
    }
    return (await this.msgs(channel, thread)).slice(before + 1);
  },
  // A rough picture of a design channel (paths, rects, ellipses, text, nested groups) as a PNG data URL, for checking drawings.
  async render(channel, size = 700) {
    const nodes = (await this.read('design', 'design_nodes', { channel_id: await this.chan(channel) })).filter((r) => r.deleted !== true);
    const { pathData, scaledPaths } = await import('/src/plugins/builtin/design/vector.ts');
    const by = new Map(); nodes.forEach((n) => { const k = n.parent_id ?? 0; (by.get(k) ?? by.set(k, []).get(k)).push(n); });
    const paint = (list) => (list || []).filter((p) => p.visible !== false).map((p) => p.color)[0];
    const draw = (parent, ox, oy) => (by.get(parent) || []).sort((a, b) => a.z - b.z).map((n) => {
      const props = JSON.parse(n.props), x = ox + Number(n.x), y = oy + Number(n.y), w = Number(n.width), h = Number(n.height);
      const fill = paint(props.fills) || 'none', stroke = paint(props.strokes), sw = props.strokes?.[0]?.width || 1;
      const st = `fill="${fill}" ${stroke ? `stroke="${stroke}" stroke-width="${sw}"` : ''}`;
      if (n.kind === 'path' && props.vector) return `<path transform="translate(${x} ${y})" d="${pathData(scaledPaths(props.vector, w, h))}" ${st}/>`;
      if (n.kind === 'rect' || n.kind === 'frame') return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${st}/>` + draw(n.id, x, y);
      if (n.kind === 'ellipse') return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${st}/>`;
      if (n.kind === 'text') return `<text x="${x}" y="${y + h * 0.8}" font-size="${Math.max(10, h * 0.8)}" fill="${fill === 'none' ? '#fff' : fill}">${(props.text || n.name).replaceAll('<', '&lt;')}</text>`;
      if (n.kind === 'group') return draw(n.id, x, y);
      return '';
    }).join('');
    const body = draw(0, 0, 0) + draw(null, 0, 0);
    const xs = nodes.flatMap((n) => [Number(n.x), Number(n.x) + Number(n.width)]), ys = nodes.flatMap((n) => [Number(n.y), Number(n.y) + Number(n.height)]);
    const x0 = Math.min(0, ...xs) - 10, y0 = Math.min(0, ...ys) - 10, x1 = Math.max(...xs, 100) + 10, y1 = Math.max(...ys, 100) + 10;
    const k = size / Math.max(x1 - x0, y1 - y0);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${(x1 - x0) * k}" height="${(y1 - y0) * k}" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}"><rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="#1b2030"/>${body}</svg>`;
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
    const c = document.createElement('canvas'); c.width = (x1 - x0) * k; c.height = (y1 - y0) * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  },
};
