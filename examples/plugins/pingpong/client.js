// A small multiplayer game demonstrating declared data, presence, cursors, and live events.
const table = "example_pingpong_games";
const width = 800;
const height = 500;
const paddleWidth = 18;
const paddleHeight = 90;
const radius = 10;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const earlier = (a, b) => a.at < b.at || (a.at === b.at && a.userId < b.userId);

function pingPong(element, context) {
  element.innerHTML = `
    <style>
      .pingpong { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; gap: calc(var(--mw-margin) / 2); padding: calc(var(--mw-margin) / 2) var(--mw-margin); overflow: auto; color: var(--mw-text); }
      .pingpong-score { display: flex; align-items: center; justify-content: center; gap: calc(var(--mw-margin) + var(--mw-margin)); }
      .pingpong-side { min-width: 0; display: flex; flex-direction: column; align-items: center; gap: calc(var(--mw-margin) / 4); }
      .pingpong-points { font-size: calc(var(--mw-font-size) + var(--mw-font-size)); font-weight: 700; line-height: 1; }
      .pingpong-holder { color: var(--mw-text-muted); text-align: center; font-size: var(--mw-font-size); }
      .pingpong-holder-dot { display: inline-block; width: var(--mw-font-size); height: var(--mw-font-size); border-radius: 50%; margin-right: calc(var(--mw-margin) / 4); }
      .pingpong-field { box-sizing: border-box; width: 100%; flex: 1 1 0; min-height: 0; min-width: 0; margin: 0 auto; position: relative; display: flex; align-items: center; justify-content: center; }
      .pingpong-canvas { display: block; width: 100%; height: 100%; background: var(--mw-darker); border: var(--mw-border-width) solid var(--mw-border); border-radius: var(--mw-corner); touch-action: none; }
      .pingpong-controls { display: flex; justify-content: center; gap: calc(var(--mw-margin) / 2); }
      .pingpong button { color: var(--mw-accent-text); background: var(--mw-accent); border: 0; border-radius: var(--mw-corner); padding: calc(var(--mw-margin) / 4) var(--mw-margin); font: inherit; cursor: pointer; }
      .pingpong button:disabled { opacity: .5; cursor: default; }
      .pingpong-note { color: var(--mw-text-muted); text-align: center; }
      .pingpong-error { color: var(--mw-warning); text-align: center; }
    </style>
    <main class="pingpong">
      <header class="pingpong-score">
        <div class="pingpong-side"><strong>Left</strong><span class="pingpong-left-score pingpong-points">0</span><span class="pingpong-left-holder pingpong-holder"></span></div>
        <div class="pingpong-side"><strong>Right</strong><span class="pingpong-right-score pingpong-points">0</span><span class="pingpong-right-holder pingpong-holder"></span></div>
      </header>
      <div class="pingpong-result" aria-live="polite"></div>
      <div class="pingpong-field"><canvas class="pingpong-canvas" aria-label="Ping-pong field"></canvas></div>
      <div class="pingpong-controls"><button class="pingpong-start" type="button">Start</button><button class="pingpong-stop" type="button">Stop</button></div>
      <div class="pingpong-note">Drag either paddle near your goal. Paddle claims are shared with everyone in the channel.</div>
      <div class="pingpong-error" role="status"></div>
    </main>`;

  const canvas = element.querySelector("canvas");
  const field = element.querySelector(".pingpong-field");
  const draw = canvas.getContext("2d");
  const startButton = element.querySelector(".pingpong-start");
  const stopButton = element.querySelector(".pingpong-stop");
  const error = element.querySelector(".pingpong-error");
  const leftScore = element.querySelector(".pingpong-left-score");
  const rightScore = element.querySelector(".pingpong-right-score");
  const leftHolder = element.querySelector(".pingpong-left-holder");
  const rightHolder = element.querySelector(".pingpong-right-holder");
  const result = element.querySelector(".pingpong-result");
  const myId = context.users.me();

  let game = null;
  let ball = { x: width / 2, y: height / 2, vx: 0, vy: 0, t: performance.now() };
  let lastTick = performance.now();
  let lastSend = 0;
  let respawnAt = 0;
  let localPresence = {};
  let ballReceivedAt = performance.now();
  let dragSide = null;
  let grabOffset = { x: 0, y: 0 };
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let frame = 0;
  let idleTimer = 0;
  let disposed = false;
  let cursorLayer = null;

  const user = (id) => {
    if (id == null) return null;
    try { return context.users.get(Number(id)); } catch { return null; }
  };

  function report(reason) {
    error.textContent = reason ? reason.message || String(reason) : "";
  }

  async function refresh() {
    const rows = await context.api.read(table, { channel_id: context.channel.id });
    game = rows[0] || null;
    if (game) {
      leftScore.textContent = String(Number(game.left_score) || 0);
      rightScore.textContent = String(Number(game.right_score) || 0);
      startButton.disabled = !context.can("edit_content") || !!game.running;
      stopButton.disabled = !context.can("edit_content") || !game.running;
      showHolder(leftHolder, game.left_holder);
      showHolder(rightHolder, game.right_holder);
    } else {
      startButton.disabled = !context.can("edit_content");
      stopButton.disabled = true;
    }
    report("");
  }

  function showHolder(element, id) {
    element.replaceChildren();
    const profile = user(id);
    if (!profile) {
      element.textContent = "No paddle holder";
      return;
    }
    const dot = document.createElement("span");
    dot.className = "pingpong-holder-dot";
    dot.style.background = profile.color || "var(--mw-text-muted)";
    element.append(dot, document.createTextNode(profile.displayName));
  }

  async function ensureGame() {
    const rows = await context.api.read(table, { channel_id: context.channel.id });
    if (rows.length) {
      game = rows[0];
      return game;
    }
    await context.api.insert(table, {
      channel_id: context.channel.id,
      left_score: 0,
      right_score: 0,
      left_holder: null,
      right_holder: null,
      running: false,
    });
    const created = await context.api.read(table, { channel_id: context.channel.id });
    game = created[0] || null;
    if (!game) throw new Error("The shared game row wasn't created.");
    return game;
  }

  async function updateGame(changes) {
    const current = game || await ensureGame();
    await context.api.update(table, changes, { id: current.id });
    await refresh();
  }

  function activeMembers() {
    const members = context.presence.others().map(({ userId, state }) => ({
      userId,
      state: state && typeof state === "object" ? state : {},
    }));
    if (myId != null) members.push({ userId: myId, state: localPresence });
    return members;
  }

  function authority() {
    const members = activeMembers().sort((a, b) => a.userId - b.userId);
    const started = members.find(({ state }) => Number.isFinite(Number(state.startedBy)) && state.startedBy != null);
    return started ? Number(started.state.startedBy) : members[0]?.userId ?? null;
  }

  // Sorting every claim the same way makes near-simultaneous grabs converge on one holder.
  function claims(side) {
    return activeMembers().flatMap(({ userId, state }) =>
      state.hold === side && Number.isFinite(Number(state.at)) ? [{ userId, at: Number(state.at), state }] : []);
  }

  function winningClaim(side) {
    return claims(side).sort((a, b) => earlier(a, b) ? -1 : earlier(b, a) ? 1 : 0)[0] || null;
  }

  function paddle(side) {
    const heldPosition = winningClaim(side)?.state;
    if (heldPosition) {
      const heldX = Number(heldPosition[`${side}X`]);
      const heldY = Number(heldPosition[`${side}Y`]);
      return {
        x: clamp(Number.isFinite(heldX) ? heldX : side === "left" ? 55 : width - 55 - paddleWidth, ...paddleXBounds(side)),
        y: clamp(Number.isFinite(heldY) ? heldY : height / 2 - paddleHeight / 2, 0, height - paddleHeight),
      };
    }
    const position = activeMembers().flatMap(({ userId, state }) => {
      const x = Number(state[`${side}X`]);
      const y = Number(state[`${side}Y`]);
      const movedAt = Number(state[`${side}MovedAt`]);
      return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(movedAt)
        ? [{ userId, x, y, movedAt }] : [];
    }).sort((a, b) => b.movedAt - a.movedAt || a.userId - b.userId)[0];
    if (!position) return { x: side === "left" ? 55 : width - 55 - paddleWidth, y: height / 2 - paddleHeight / 2 };
    const defaultX = side === "left" ? 55 : width - 55 - paddleWidth;
    return {
      x: clamp(Number.isFinite(position.x) ? position.x : defaultX, ...paddleXBounds(side)),
      y: clamp(Number.isFinite(position.y) ? position.y : height / 2 - paddleHeight / 2, 0, height - paddleHeight),
    };
  }

  function paddleXBounds(side) {
    return side === "left" ? [25, 150] : [width - 150 - paddleWidth, width - 25 - paddleWidth];
  }

  function setPresence(next) {
    localPresence = { ...localPresence, ...next };
    context.presence.set(localPresence);
  }

  function logicalPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - offsetX) / scale,
      y: (event.clientY - bounds.top - offsetY) / scale,
    };
  }

  function drawField() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(rect.width * dpr);
    const pixelHeight = Math.round(rect.height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    scale = Math.min(rect.width / width, rect.height / height);
    offsetX = (rect.width - width * scale) / 2;
    offsetY = (rect.height - height * scale) / 2;
    draw.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offsetX, dpr * offsetY);
    draw.fillStyle = getComputedStyle(element).getPropertyValue("--mw-darker").trim();
    draw.fillRect(0, 0, width, height);
    draw.strokeStyle = getComputedStyle(element).getPropertyValue("--mw-border").trim();
    draw.setLineDash([8, 10]);
    draw.beginPath();
    draw.moveTo(width / 2, 0);
    draw.lineTo(width / 2, height);
    draw.stroke();
    draw.setLineDash([]);
    draw.fillStyle = getComputedStyle(element).getPropertyValue("--mw-dark").trim();
    draw.fillRect(0, 0, 26, height);
    draw.fillRect(width - 26, 0, 26, height);
    for (const side of ["left", "right"]) {
      const p = paddle(side);
      const heldBy = winningClaim(side);
      draw.fillStyle = heldBy ? user(heldBy.userId)?.color || getComputedStyle(element).getPropertyValue("--mw-text").trim()
        : getComputedStyle(element).getPropertyValue("--mw-text").trim();
      draw.fillRect(p.x, p.y, paddleWidth, paddleHeight);
    }
    draw.beginPath();
    draw.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
    draw.fillStyle = getComputedStyle(element).getPropertyValue("--mw-accent").trim();
    draw.fill();
    cursorLayer?.redraw();
  }

  function activeBall(now) {
    if (!game?.running) return ball;
    if (authority() === myId) return ball;
    const elapsed = Math.max(0, (now - ballReceivedAt) / 1000);
    return { ...ball, x: ball.x + ball.vx * elapsed, y: ball.y + ball.vy * elapsed };
  }

  function simulate(now) {
    if (!game?.running || authority() !== myId || respawnAt > now) return;
    if (respawnAt) {
      respawnAt = 0;
      ball.vx = (Math.random() < .5 ? -1 : 1) * (260 + Math.random() * 80);
      ball.vy = (Math.random() * 2 - 1) * 180;
      ball.t = Date.now();
      context.events.send({ pingpongBall: { ...ball } });
    }
    const dt = clamp((now - lastTick) / 1000, 0, 0.05);
    ball.t = Date.now();
    let bounced = false;
    const previousX = ball.x;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    if (ball.y - radius <= 0 || ball.y + radius >= height) {
      ball.vy *= -1;
      ball.y = clamp(ball.y, radius, height - radius);
      bounced = true;
    }
    for (const side of ["left", "right"]) {
      const p = paddle(side);
      const toward = side === "left" ? ball.vx < 0 : ball.vx > 0;
      if (!toward) continue;
      const hitsX = side === "left"
        ? ball.x - radius <= p.x + paddleWidth && previousX + radius >= p.x
        : ball.x + radius >= p.x && previousX - radius <= p.x + paddleWidth;
      if (hitsX && ball.y + radius >= p.y && ball.y - radius <= p.y + paddleHeight) {
        ball.vx = (side === "left" ? 1 : -1) * Math.min(Math.abs(ball.vx) * 1.04, 650);
        ball.vy = clamp(ball.vy + ((ball.y - (p.y + paddleHeight / 2)) / (paddleHeight / 2)) * 110, -430, 430);
        ball.x = side === "left" ? p.x + paddleWidth + radius : p.x - radius;
        bounced = true;
      }
    }
    if (ball.x < 0 || ball.x > width) {
      const scorer = ball.x < 0 ? "right" : "left";
      const scoreField = scorer === "left" ? "left_score" : "right_score";
      const score = (Number(game?.[scoreField]) || 0) + 1;
      ball = { x: width / 2, y: height / 2, vx: 0, vy: 0, t: Date.now() };
      respawnAt = now + 1000;
      void updateGame({ [scoreField]: score }).catch(report);
      bounced = true;
    }
    if (bounced || now - lastSend >= 1000 / 15) {
      ball.t = Date.now();
      context.events.send({ pingpongBall: { ...ball } });
      lastSend = now;
    }
  }

  function tick(now) {
    if (disposed) return;
    if (context.active()) {
      if (dragSide && winningClaim(dragSide)?.userId !== myId) release();
      simulate(now);
      if (authority() !== myId && game?.running) {
        const predicted = activeBall(now);
        const correction = clamp((now - lastTick) / 140, 0, 1);
        ball.x += (predicted.x - ball.x) * correction;
        ball.y += (predicted.y - ball.y) * correction;
      }
      drawField();
      lastTick = now;
      frame = requestAnimationFrame(tick);
    } else {
      idleTimer = window.setTimeout(() => { if (!disposed && context.active()) frame = requestAnimationFrame(tick); }, 250);
    }
  }

  async function start() {
    if (!context.can("edit_content")) return;
    try {
      await ensureGame();
      ball = {
        x: width / 2,
        y: height / 2,
        vx: (Math.random() < .5 ? -1 : 1) * (260 + Math.random() * 80),
        vy: (Math.random() * 2 - 1) * 180,
        t: Date.now(),
      };
      result.textContent = "";
      ballReceivedAt = performance.now();
      setPresence({ startedBy: myId });
      await updateGame({ running: true });
      context.events.send({ pingpongBall: { ...ball } });
      report("");
    } catch (reason) { report(reason); }
  }

  function resetPaddles() {
    if (dragSide) {
      dragSide = null;
      if (activePointer !== null && canvas.hasPointerCapture(activePointer)) canvas.releasePointerCapture(activePointer);
      activePointer = null;
    }
    const at = Date.now();
    setPresence({
      hold: null,
      at: null,
      leftX: 55,
      leftY: height / 2 - paddleHeight / 2,
      leftMovedAt: at,
      rightX: width - 55 - paddleWidth,
      rightY: height / 2 - paddleHeight / 2,
      rightMovedAt: at,
    });
  }

  async function stop() {
    if (!context.can("edit_content")) return;
    try {
      const current = await ensureGame();
      const left = Number(current.left_score) || 0;
      const right = Number(current.right_score) || 0;
      const side = left > right ? "Left" : "Right";
      const winner = user(left > right ? current.left_holder : current.right_holder);
      const message = left === right ? "The game ended in a draw."
        : `${winner?.displayName || `${side} player`} won!`;
      result.textContent = message;
      await updateGame({
        running: false,
        left_holder: null,
        right_holder: null,
        left_score: 0,
        right_score: 0,
      });
      ball = { x: width / 2, y: height / 2, vx: 0, vy: 0, t: Date.now() };
      respawnAt = 0;
      resetPaddles();
      context.events.send({ pingpongStop: message, pingpongBall: { ...ball } });
    }
    catch (reason) { report(reason); }
  }

  function release() {
    if (!dragSide) return;
    dragSide = null;
    setPresence({ hold: null, at: null });
    canvas.releasePointerCapture?.(activePointer);
    activePointer = null;
    void refresh().catch(report);
  }
  let activePointer = null;

  canvas.addEventListener("pointerdown", (event) => {
    if (!context.can("edit_content") || myId == null) return;
    const point = logicalPoint(event);
    const side = ["left", "right"].find((candidate) => {
      const position = paddle(candidate);
      return point.x >= position.x && point.x <= position.x + paddleWidth
        && point.y >= position.y && point.y <= position.y + paddleHeight;
    });
    if (!side) return;
    const held = winningClaim(side);
    const at = Date.now();
    const claim = { userId: myId, at };
    if (held && held.userId !== myId && !earlier(claim, held)) return;
    const position = paddle(side);
    grabOffset = { x: point.x - position.x, y: point.y - position.y };
    dragSide = side;
    activePointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    setPresence({
      hold: side, at,
    });
    const field = side === "left" ? "left_holder" : "right_holder";
    void ensureGame().then(() => updateGame({ [field]: myId })).catch(report);
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = logicalPoint(event);
    context.cursors.move(point);
    if (!dragSide || event.pointerId !== activePointer) return;
    const side = dragSide;
    setPresence({
      [`${side}X`]: clamp(point.x - grabOffset.x, ...paddleXBounds(side)),
      [`${side}Y`]: clamp(point.y - grabOffset.y, 0, height - paddleHeight),
      [`${side}MovedAt`]: Date.now(),
    });
  });

  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    canvas.addEventListener(type, release);
  canvas.addEventListener("pointerleave", () => { if (!dragSide) context.cursors.move(null); });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  startButton.onclick = () => void start();
  stopButton.onclick = () => void stop();

  const stopEvents = context.events.listen((userId, message) => {
    if (typeof message?.pingpongStop === "string") {
      result.textContent = message.pingpongStop;
      ball = { x: width / 2, y: height / 2, vx: 0, vy: 0, t: Date.now() };
      respawnAt = 0;
      resetPaddles();
      return;
    }
    if (!message || typeof message !== "object" || !message.pingpongBall) return;
    // Only the member running the ball sends it; everyone else follows that copy.
    if (userId !== authority() || authority() === myId) return;
    const incoming = message.pingpongBall;
    if (![incoming.x, incoming.y, incoming.vx, incoming.vy, incoming.t].every(Number.isFinite)) return;
    const now = performance.now();
    const transit = Math.max(0, (Date.now() - incoming.t) / 1000);
    ball = {
      x: incoming.x + incoming.vx * transit,
      y: incoming.y + incoming.vy * transit,
      vx: incoming.vx,
      vy: incoming.vy,
      t: incoming.t,
    };
    ballReceivedAt = now;
  });
  const stopData = context.api.onEvent(() => void refresh().catch(report));
  const resize = new ResizeObserver(() => drawField());
  resize.observe(field);
  cursorLayer = context.cursors.draw(field, (point) => ({ x: offsetX + point.x * scale, y: offsetY + point.y * scale }));
  startButton.disabled = true;
  stopButton.disabled = true;
  void refresh().catch(report);
  frame = requestAnimationFrame(tick);

  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    clearTimeout(idleTimer);
    stopEvents();
    stopData();
    resize.disconnect();
    cursorLayer?.remove();
    context.cursors.move(null);
    context.presence.set(null);
  };
}

// A channel type's icon is an app icon name or the plugin's own SVG as a data URL. Draw it in currentColor so it
// takes the theme's colors.
const channelIcon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">'
  + '<rect x="2" y="4" width="5" height="16"/><circle cx="12" cy="12" r="2"/><rect x="17" y="4" width="5" height="16"/></svg>',
)}`;

export default {
  manifest: {
    id: "example.pingpong",
    name: "Ping-pong",
    version: "1.0.3",
    description: "A multiplayer ping-pong game that demonstrates live presence, events, and declared data.",
    author: "MakeWork examples",
    contributes: {
      channelTypes: [{ id: "pingpong", label: "Ping-pong", icon: channelIcon }],
    },
  },
  channelViews: { pingpong: pingPong },
};
