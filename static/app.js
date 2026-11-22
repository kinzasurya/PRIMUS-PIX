(() => {
  const LS_SESSION = "cp_session_token";
  const LS_ADMIN = "cp_admin_token";

  const state = {
    sessionToken: localStorage.getItem(LS_SESSION) || null,
    adminToken: localStorage.getItem(LS_ADMIN) || null,
    currentUser: null,
    sessionStatus: null,
    inAdminView: false,

    // Feed filters
    filterType: "",
    filterClass: "",
    searchQuery: "",
    viewingProfileId: null,
    inChatView: false,
    posts: [],
    stories: [],
    activeStory: null,
    openComments: new Set(),

    // Composer & Story Composer
    composerType: "vlog",
    postAudience: "all",
    storyType: "image",
    storyBgColor: "#ffd6e8",
    storyAudience: "all",
    flashAudience: "all",
    flashes: [],
    cameraTarget: null,
    capturedPostFile: null,
    capturedStoryFile: null,
    capturedFlashFile: null,

    // Chat / Texting
    chatPeerId: null, // null = Campus Group Chat
    chatPeerName: "Campus Group Chat",
    chatPeerSub: "Everyone in Primus Pix",
    chatPeers: [],
    editingMessageId: null,

    // Admin
    adminTab: "pending",
    adminData: { sessions: [], users: [], posts: [], notices: [], classes: [], polls: [] },
    adminSettings: null,
    editingNoticeId: null,
    editingPollId: null,
    prefillNoticeClass: "",
  };

  let pendingPollTimer = null;
  let activeGuardTimer = null;
  let adminPollTimer = null;
  let chatPollTimer = null;
  let searchDebounce = null;

  const $ = (id) => document.getElementById(id);

  // ---------- Utilities ----------

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function initials(name) {
    if (!name) return "?";
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0].toUpperCase())
      .join("");
  }

  function renderAvatar(avatarUrl, name) {
    if (avatarUrl) {
      return `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name || "Avatar")}" />`;
    }
    return escapeHtml(initials(name));
  }

  function syncMyNavIdentity() {
    if (!state.currentUser) return;
    const html = renderAvatar(state.currentUser.avatar_url, state.currentUser.name);
    if ($("nav-avatar")) $("nav-avatar").innerHTML = html;
    if ($("nav-user-name")) $("nav-user-name").textContent = state.currentUser.name;
    if ($("qp-avatar")) $("qp-avatar").innerHTML = html;
  }

  function timeAgo(iso) {
    if (!iso) return "";
    const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function toast(message, type = "info") {
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    $("toast-container").appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.auth === "student" && state.sessionToken) {
      headers.set("X-Session-Token", state.sessionToken);
    }
    if (options.auth === "admin" && state.adminToken) {
      headers.set("X-Admin-Token", state.adminToken);
    }
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
      options.body = JSON.stringify(options.json);
    }
    const res = await fetch(path, { ...options, headers });
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) {
      const err = new Error(data.detail || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------- View Switching ----------

  function stopTimers() {
    if (pendingPollTimer) { clearInterval(pendingPollTimer); pendingPollTimer = null; }
    if (activeGuardTimer) { clearInterval(activeGuardTimer); activeGuardTimer = null; }
    if (adminPollTimer) { clearInterval(adminPollTimer); adminPollTimer = null; }
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
  }

  function showOnly(viewId) {
    ["view-login", "view-pending", "view-app", "view-admin"].forEach((id) => {
      $(id).classList.toggle("hidden", id !== viewId);
    });
  }

  async function boot() {
    stopTimers();
    const params = new URLSearchParams(window.location.search);
    if (params.get("admin") === "1" && state.adminToken) {
      params.delete("admin");
      const cleanUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
      window.history.replaceState({}, "", cleanUrl);
      state.inAdminView = true;
      await enterAdminDashboard();
      return;
    }
    if (state.inAdminView && state.adminToken) {
      await enterAdminDashboard();
      return;
    }

    if (!state.sessionToken) {
      showOnly("view-login");
      return;
    }

    try {
      const info = await api("/api/auth/session", { auth: "student" });
      state.currentUser = info.user;
      state.sessionStatus = info.status;

      if (info.status === "approved") {
        enterStudentApp();
      } else if (info.status === "pending") {
        enterPendingView("pending");
      } else {
        enterPendingView(info.status);
      }
    } catch {
      clearStudentSession();
      showOnly("view-login");
    }
  }

  function clearStudentSession() {
    state.sessionToken = null;
    state.currentUser = null;
    state.sessionStatus = null;
    localStorage.removeItem(LS_SESSION);
  }

  // ---------- Pending / Denied View ----------

  function enterPendingView(status) {
    stopTimers();
    showOnly("view-pending");

    const u = state.currentUser || {};
    $("pending-reg").textContent = u.reg_number || "—";
    $("pending-name").textContent = u.name || "—";
    $("pending-class").textContent = u.class_name || "—";

    const icon = $("pending-icon");
    const title = $("pending-title");
    const desc = $("pending-desc");

    if (status === "pending") {
      icon.className = "status-icon pending";
      icon.innerHTML = `<div class="spinner"></div>`;
      title.textContent = "Waiting for Admin Approval";
      desc.textContent =
        "Your sign-in request has been sent to the administrator. This screen will automatically open the app as soon as you are allowed in.";
      $("check-status-btn").classList.remove("hidden");
      pendingPollTimer = setInterval(pollPendingStatus, 2500);
    } else if (status === "denied") {
      icon.className = "status-icon denied";
      icon.textContent = "✕";
      title.textContent = "Sign-In Not Allowed";
      desc.textContent = "The administrator denied this sign-in request.";
      $("check-status-btn").classList.add("hidden");
    } else if (status === "revoked") {
      icon.className = "status-icon denied";
      icon.textContent = "✕";
      title.textContent = "Session Revoked";
      desc.textContent = "Your session was ended by the administrator. You may request a new sign-in.";
      $("check-status-btn").classList.add("hidden");
    } else if (status === "banned") {
      icon.className = "status-icon denied";
      icon.textContent = "!";
      title.textContent = "Account Banned";
      desc.textContent = "Your registration number has been banned by the administrator.";
      $("check-status-btn").classList.add("hidden");
    } else {
      clearStudentSession();
      showOnly("view-login");
    }
  }

  async function pollPendingStatus(manual = false) {
    if (!state.sessionToken) return;
    try {
      const info = await api("/api/auth/session", { auth: "student" });
      state.currentUser = info.user;
      state.sessionStatus = info.status;
      if (info.status === "approved") {
        toast("Sign-in approved! Welcome to Primus Pix.", "success");
        enterStudentApp();
      } else if (info.status !== "pending") {
        enterPendingView(info.status);
      } else if (manual) {
        toast("Still waiting for admin verification.");
      }
    } catch {
      clearStudentSession();
      showOnly("view-login");
    }
  }

  // ---------- Student Social App ----------

  function enterStudentApp() {
    stopTimers();
    state.inAdminView = false;
    showOnly("view-app");

    syncMyNavIdentity();

    loadClassFilterOptions();
    if (state.viewingProfileId) {
      loadUserProfile(state.viewingProfileId);
    } else {
      showFeedMode();
    }

    // Periodically verify session wasn't revoked/banned by admin
    activeGuardTimer = setInterval(async () => {
      if (!state.sessionToken || state.inAdminView) return;
      try {
        const info = await api("/api/auth/session", { auth: "student" });
        if (info.status !== "approved") {
          toast("Your session is no longer active.", "error");
          enterPendingView(info.status);
        }
      } catch {
        clearStudentSession();
        showOnly("view-login");
      }
    }, 5000);
  }

  async function loadClassFilterOptions() {
    try {
      const data = await api("/api/meta/classes", { auth: "student" });
      const select = $("class-filter");
      const current = state.filterClass;
      select.innerHTML =
        `<option value="">All Classes</option>` +
        data.classes
          .map((c) => `<option value="${escapeHtml(c)}"${c === current ? " selected" : ""}>${escapeHtml(c)}</option>`)
          .join("");
    } catch {
      // ignore
    }
  }

  function setActiveNavTab(activeId) {
    ["fb-tab-home", "nav-insta-btn", "nav-tube-btn", "nav-close-friends-btn"].forEach((id) => {
      if ($(id)) $(id).classList.toggle("active", id === activeId);
    });
  }

  function showOnlyStudentSection(sectionId) {
    ["section-feed", "section-insta", "section-tube", "section-close-friends"].forEach((id) => {
      if ($(id)) $(id).classList.toggle("hidden", id !== sectionId);
    });
  }

  function showFeedMode() {
    state.viewingProfileId = null;
    state.inChatView = false;
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
    showOnlyStudentSection("section-feed");
    setActiveNavTab("fb-tab-home");
    if ($("portal-today-date")) {
      const nowStr = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
      $("portal-today-date").textContent = `Today is ${nowStr}`;
    }
    if ($("portal-hero-row")) $("portal-hero-row").classList.remove("hidden");
    if ($("notice-board-card")) $("notice-board-card").classList.remove("hidden");
    if ($("stories-section")) $("stories-section").classList.remove("hidden");
    if ($("flashes-section")) $("flashes-section").classList.remove("hidden");
    $("profile-banner").classList.add("hidden");
    $("feed-controls").classList.remove("hidden");
    loadNotices();
    loadStories();
    loadFlashes();
    loadIVote();
    loadFeed();
  }

  async function loadNotices() {
    const card = $("notice-board-card");
    const list = $("notice-board-list");
    if (!card || !list) return;
    card.classList.remove("hidden");
    try {
      const data = await api("/api/notices", { auth: "student" });
      const notices = data.notices || [];
      if (!notices.length) {
        list.innerHTML = `<p class="muted small" style="margin:0;">No official notices right now. Admins can post announcements from the Admin Panel.</p>`;
        return;
      }
      list.innerHTML = notices
        .map((n) => {
          const pr = n.priority || "info";
          const tagLabel = pr === "urgent" ? "Urgent" : pr === "important" ? "Important" : "Notice";
          const clsBadge = n.target_class
            ? `<span class="notice-class-pill">🎯 ${escapeHtml(n.target_class)} Only</span>`
            : "";
          return `
            <div class="notice-item ${pr}">
              <div class="notice-item-head">
                <div class="notice-item-title">${n.pinned ? "📌 " : ""}${escapeHtml(n.title)}</div>
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  ${clsBadge}
                  <span class="notice-tag ${pr}">${tagLabel}</span>
                  <span class="muted" style="font-size:0.74rem;">${timeAgo(n.updated_at || n.created_at)}</span>
                </div>
              </div>
              <p class="notice-item-body">${escapeHtml(n.body)}</p>
            </div>
          `;
        })
        .join("");
    } catch {
      list.innerHTML = `<p class="muted small" style="margin:0;">Unable to load notices.</p>`;
    }
  }

  async function loadFlashes() {
    const bar = $("flashes-bar");
    if (!bar) return;
    try {
      const data = await api("/api/flashes", { auth: "student" });
      state.flashes = data.flashes || [];
      renderFlashes();
    } catch {
      // ignore
    }
  }

  function renderFlashes() {
    const bar = $("flashes-bar");
    if (!bar) return;
    if (!state.flashes.length) {
      bar.innerHTML = `<p class="muted small" style="margin:4px 0;">No active Flashes yet — hit <strong>⚡ Drop a Flash</strong> to snap a live pic or share a quick vibe!</p>`;
      return;
    }
    bar.innerHTML = state.flashes
      .map((f) => {
        const isCf = f.audience === "close_friends";
        const isMine = state.currentUser && f.user_id === state.currentUser.id;
        return `
          <div class="flash-chip ${isCf ? "close-friends" : ""}">
            <div class="flash-chip-head">
              <div class="avatar-chip" style="width:24px;height:24px;font-size:0.7rem;">${renderAvatar(f.author_avatar, f.author_name)}</div>
              <div style="min-width:0;flex:1;">
                <div class="flash-chip-name">${escapeHtml(f.author_name)}</div>
                <div class="muted" style="font-size:0.68rem;">${isCf ? "⭐ Close Friends • " : ""}${timeAgo(f.created_at)}</div>
              </div>
              ${isMine ? `<button type="button" class="icon-btn" style="width:22px;height:22px;font-size:0.9rem;" data-del-flash="${f.id}" title="Delete Flash">&times;</button>` : ""}
            </div>
            ${f.media_url ? `<img class="flash-chip-img" src="${escapeHtml(f.media_url)}" alt="Flash snap" data-lightbox="${escapeHtml(f.media_url)}" />` : ""}
            ${f.text ? `<div class="flash-chip-text">${escapeHtml(f.text)}</div>` : ""}
          </div>
        `;
      })
      .join("");
  }

  function celebrateXP(amount, reason = "") {
    if (reason) toast(reason, "success");
  }

  async function loadGamification() {
    if (!state.sessionToken) return;
    try {
      const [me, lb] = await Promise.all([
        api("/api/gamification/me", { auth: "student" }),
        api("/api/gamification/leaderboard", { auth: "student" }),
      ]);

      // Topbar & Left Hero Card
      if ($("topbar-lv")) $("topbar-lv").textContent = `Lv.${me.level}`;
      if ($("topbar-xp-num")) $("topbar-xp-num").textContent = `${me.xp} XP`;
      if ($("side-avatar") && state.currentUser) $("side-avatar").textContent = initials(state.currentUser.name);
      if ($("side-name") && state.currentUser) $("side-name").textContent = state.currentUser.name;
      if ($("side-title")) $("side-title").textContent = `Lv. ${me.level} • ${me.title}`;
      if ($("side-xp-text")) $("side-xp-text").textContent = `${me.xp} XP`;
      if ($("side-next-xp")) $("side-next-xp").textContent = `Next Lv: ${me.next_xp} XP`;
      if ($("side-xp-bar")) $("side-xp-bar").style.width = `${Math.max(4, me.progress_pct)}%`;

      // Badges
      const badgesEl = $("side-badges");
      if (badgesEl) {
        badgesEl.innerHTML = me.badges.length
          ? me.badges.map((b) => `<span class="badge-chip">${b.icon} ${escapeHtml(b.label)}</span>`).join("")
          : `<span class="badge-empty">Post, react, or vote to unlock badges!</span>`;
      }

      // Daily Quests
      const doneCount = me.quests.filter((q) => q.done).length;
      if ($("quest-progress-chip")) $("quest-progress-chip").textContent = `${doneCount}/${me.quests.length}`;
      const qList = $("daily-quest-list");
      if (qList) {
        qList.innerHTML = me.quests
          .map(
            (q) => `
            <button type="button" class="quest-item ${q.done ? "done" : ""}" data-quest-action="${q.id}">
              <span>${q.done ? "✅" : "⬜"} ${escapeHtml(q.label)}</span>
              <span class="quest-xp">${q.done ? "Done" : `+${q.xp} XP`}</span>
            </button>
          `
          )
          .join("");
      }

      // Right Sidebar: Leaderboard
      const lbEl = $("leaderboard-list");
      if (lbEl) {
        lbEl.innerHTML = lb.students.length
          ? lb.students
              .map((s) => {
                const rankCls = s.rank === 1 ? "r1" : s.rank === 2 ? "r2" : s.rank === 3 ? "r3" : "";
                const crown = s.rank === 1 ? "👑" : s.rank;
                return `
                  <div class="lb-row" data-lb-profile="${s.id}">
                    <div class="lb-left">
                      <div class="lb-rank ${rankCls}">${crown}</div>
                      <div style="min-width:0;">
                        <div class="lb-name">${escapeHtml(s.name)}</div>
                        <div class="lb-sub">Lv.${s.level} &bull; ${escapeHtml(s.class_name)}</div>
                      </div>
                    </div>
                    <div class="lb-xp">${s.xp} XP</div>
                  </div>
                `;
              })
              .join("")
          : `<p class="muted small" style="margin:0;">Be the first on the board!</p>`;
      }

      // Right Sidebar: Class XP Battle
      const cbEl = $("class-battle-list");
      if (cbEl) {
        const maxXp = Math.max(1, ...lb.classes.map((c) => c.total_xp || 0));
        cbEl.innerHTML = lb.classes.length
          ? lb.classes
              .map((c) => {
                const pct = Math.max(8, Math.round(((c.total_xp || 0) / maxXp) * 100));
                return `
                  <div class="cb-row">
                    <div class="cb-head">
                      <span>${escapeHtml(c.class_name)}</span>
                      <span class="muted">${c.total_xp || 0} XP</span>
                    </div>
                    <div class="cb-track"><div class="cb-fill" style="width:${pct}%"></div></div>
                  </div>
                `;
              })
              .join("")
          : `<p class="muted small" style="margin:0;">No classes ranked yet.</p>`;
      }
    } catch {
      // ignore
    }
  }

  async function loadPolls() {
    const stage = $("poll-stage");
    if (!stage) return;
    try {
      const data = await api("/api/polls", { auth: "student" });
      const polls = data.polls || [];
      if (!polls.length) {
        stage.classList.add("hidden");
        return;
      }
      const p = polls[0];
      const total = Math.max(1, p.total_votes);
      stage.innerHTML = `
        <div class="card-head-row" style="margin-bottom:8px;">
          <span class="hub-badge">📊 LIVE CAMPUS POLL</span>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="muted small">${p.total_votes} vote${p.total_votes === 1 ? "" : "s"}</span>
            <button type="button" class="btn btn-ghost btn-sm" id="inline-new-poll-btn" style="padding:4px 10px;font-size:0.76rem;">+ New Poll</button>
          </div>
        </div>
        <h4 class="poll-question">${escapeHtml(p.question)}</h4>
        <div class="poll-options">
          ${p.options
            .map((opt, idx) => {
              const cnt = p.counts[idx] || 0;
              const pct = p.total_votes > 0 ? Math.round((cnt / total) * 100) : 0;
              const isVoted = p.my_vote === idx;
              return `
                <button type="button" class="poll-opt-btn ${isVoted ? "voted" : ""}" data-vote-poll="${p.id}" data-vote-opt="${idx}">
                  <div class="poll-opt-fill" style="width:${p.my_vote !== null ? pct : 0}%"></div>
                  <span class="poll-opt-label">${isVoted ? "✓ " : ""}${escapeHtml(opt)}</span>
                  <span class="poll-opt-pct">${p.my_vote !== null ? `${pct}%` : "Vote +15 XP"}</span>
                </button>
              `;
            })
            .join("")}
        </div>
      `;
      const newBtn = $("inline-new-poll-btn");
      if (newBtn) newBtn.addEventListener("click", openPollModal);
    } catch {
      // ignore
    }
  }

  function openPollModal() {
    $("poll-form").reset();
    $("modal-poll").classList.remove("hidden");
  }

  function closePollModal() {
    $("modal-poll").classList.add("hidden");
  }

  async function loadStories() {
    try {
      const data = await api("/api/stories", { auth: "student" });
      state.stories = data.stories || [];
      renderStories();
    } catch {
      // ignore
    }
  }

  function renderStories() {
    const bar = $("stories-bar");
    if (!bar) return;
    const addBtn = `
      <button type="button" class="fb-story-card create-card" id="add-story-btn">
        <div class="fb-story-create-top">+</div>
        <div class="fb-story-create-bottom">Create Story</div>
      </button>
    `;

    const items = state.stories
      .map((st) => {
        const isCf = st.audience === "close_friends";
        const bgHtml =
          st.story_type === "image" && st.media_url
            ? `<img class="fb-story-bg" src="${escapeHtml(st.media_url)}" alt="Story" />`
            : st.story_type === "video"
            ? `<div class="fb-story-text-preview" style="background:#111827;color:#fff;font-size:1.8rem;">▶</div>`
            : `<div class="fb-story-text-preview" style="background:${escapeHtml(st.bg_color || "#ffd6e8")};">${escapeHtml(st.caption.slice(0, 48))}</div>`;

        return `
          <button type="button" class="fb-story-card ${isCf ? "close-friends" : ""}" data-view-story="${st.id}">
            ${bgHtml}
            <div class="fb-story-avatar-ring">${renderAvatar(st.author_avatar, st.author_name)}</div>
            ${isCf ? `<span class="fb-story-cf-star">⭐ CF</span>` : ""}
            <div class="fb-story-name">${escapeHtml(st.author_name)}</div>
          </button>
        `;
      })
      .join("");

    bar.innerHTML = addBtn + items;
    const trigger = $("add-story-btn");
    if (trigger) trigger.addEventListener("click", openStoryComposer);
  }

  async function openStoryViewer(storyId) {
    const st = state.stories.find((s) => s.id === storyId);
    if (!st) return;
    state.activeStory = st;
    $("sv-author").textContent = `${st.author_name} (${st.author_class})`;
    $("sv-meta").textContent = timeAgo(st.created_at);
    if ($("sv-cf-badge")) {
      $("sv-cf-badge").classList.toggle("hidden", st.audience !== "close_friends");
    }
    if ($("sv-repost-badge")) {
      if (st.reposted_from) {
        $("sv-repost-badge").textContent = `🔁 Reposted from ${st.reposted_from}`;
        $("sv-repost-badge").classList.remove("hidden");
      } else {
        $("sv-repost-badge").classList.add("hidden");
      }
    }

    const delBtn = $("sv-delete-btn");
    const isOwner = state.currentUser && st.user_id === state.currentUser.id;
    delBtn.classList.toggle("hidden", !isOwner);

    // Reset drawers
    if ($("sv-viewers-drawer")) $("sv-viewers-drawer").classList.add("hidden");
    if ($("sv-comments-drawer")) $("sv-comments-drawer").classList.add("hidden");
    if ($("sv-viewers-btn")) $("sv-viewers-btn").classList.toggle("hidden", !isOwner);

    const card = $("story-viewer-card");
    const body = $("sv-body");
    const cap = $("sv-caption");

    if (st.story_type === "text") {
      card.style.background = st.bg_color || "#ffd6e8";
      body.innerHTML = `<div class="story-text-content">${escapeHtml(st.caption)}</div>`;
      cap.classList.add("hidden");
    } else if (st.story_type === "image") {
      card.style.background = "#14060b";
      body.innerHTML = `<img src="${escapeHtml(st.media_url)}" alt="Story" />`;
      if (st.caption) {
        cap.textContent = st.caption;
        cap.classList.remove("hidden");
      } else {
        cap.classList.add("hidden");
      }
    } else {
      card.style.background = "#14060b";
      body.innerHTML = `<video src="${escapeHtml(st.media_url)}" controls autoplay playsinline></video>`;
      if (st.caption) {
        cap.textContent = st.caption;
        cap.classList.remove("hidden");
      } else {
        cap.classList.add("hidden");
      }
    }

    $("modal-story-viewer").classList.remove("hidden");
    await refreshActiveStoryMeta();
  }

  async function refreshActiveStoryMeta() {
    if (!state.activeStory) return;
    try {
      const meta = await api(`/api/stories/${state.activeStory.id}/view`, {
        method: "POST",
        auth: "student",
      });
      $("sv-like-count").textContent = meta.like_count;
      $("sv-like-heart").textContent = meta.liked_by_me ? "♥" : "♡";
      $("sv-like-btn").classList.toggle("liked", !!meta.liked_by_me);

      const comments = meta.comments || [];
      $("sv-comment-count").textContent = comments.length;
      const cList = $("sv-comments-list");
      if (cList) {
        cList.innerHTML = comments.length
          ? comments
              .map(
                (c) => `
                <div class="comment-item">
                  <div class="comment-head">
                    <span class="comment-author">${escapeHtml(c.author_name)}</span>
                    <span class="muted">${timeAgo(c.created_at)}</span>
                  </div>
                  <p class="comment-body">${escapeHtml(c.body)}</p>
                </div>
              `
              )
              .join("")
          : `<p class="muted small" style="margin:0;">No comments yet. Be the first to reply!</p>`;
      }

      if (meta.viewers !== null && meta.viewers !== undefined) {
        $("sv-viewers-btn").classList.remove("hidden");
        $("sv-viewers-count").textContent = meta.viewers.length;
        const vList = $("sv-viewers-list");
        if (vList) {
          vList.innerHTML = meta.viewers.length
            ? meta.viewers
                .map(
                  (v) => `
                  <div class="sv-viewer-row">
                    <div style="display:flex;align-items:center;gap:9px;">
                      <div class="avatar-chip" style="width:28px;height:28px;">${renderAvatar(v.avatar_url, v.name)}</div>
                      <div>
                        <div style="font-weight:700;font-size:0.85rem;">${escapeHtml(v.name)}</div>
                        <div class="muted" style="font-size:0.74rem;">${escapeHtml(v.class_name)}</div>
                      </div>
                    </div>
                    <span class="muted" style="font-size:0.74rem;">${timeAgo(v.viewed_at)}</span>
                  </div>
                `
                )
                .join("")
            : `<p class="muted small" style="margin:0;">No one else has viewed your story yet.</p>`;
        }
      }
    } catch {
      // ignore
    }
  }

  function closeStoryViewer() {
    $("modal-story-viewer").classList.add("hidden");
    if ($("sv-viewers-drawer")) $("sv-viewers-drawer").classList.add("hidden");
    if ($("sv-comments-drawer")) $("sv-comments-drawer").classList.add("hidden");
    $("sv-body").innerHTML = "";
    state.activeStory = null;
  }

  function openStoryComposer() {
    $("story-form").reset();
    setStoryType("image");
    $("modal-story-composer").classList.remove("hidden");
  }

  function closeStoryComposer() {
    $("modal-story-composer").classList.add("hidden");
  }

  function setStoryType(type) {
    state.storyType = type;
    document.querySelectorAll("[data-stype]").forEach((b) => {
      b.classList.toggle("active", b.dataset.stype === type);
    });
    const fileField = $("story-file-field");
    const colorField = $("story-color-field");
    const mediaInput = $("story-media");
    const capLabel = $("story-caption-label");
    const capInput = $("story-caption");

    mediaInput.value = "";
    $("story-preview").innerHTML = "";
    $("story-preview").classList.add("hidden");

    if (type === "text") {
      fileField.classList.add("hidden");
      colorField.classList.remove("hidden");
      capLabel.textContent = "Your Story Text (required)";
      capInput.required = true;
      capInput.placeholder = "What's on your mind right now?";
    } else if (type === "video") {
      fileField.classList.remove("hidden");
      colorField.classList.add("hidden");
      $("story-media-label").textContent = "Choose Video";
      $("story-drop-text").textContent = "Click to upload a video for your 24h story";
      mediaInput.accept = "video/*";
      capLabel.textContent = "Caption (optional)";
      capInput.required = false;
      capInput.placeholder = "Add a caption...";
    } else {
      fileField.classList.remove("hidden");
      colorField.classList.add("hidden");
      $("story-media-label").textContent = "Choose Photo";
      $("story-drop-text").textContent = "Click to upload a photo for your 24h story";
      mediaInput.accept = "image/*";
      capLabel.textContent = "Caption (optional)";
      capInput.required = false;
      capInput.placeholder = "Add a caption...";
    }
  }

  // ---------- Texting / Messages ----------

  async function openChatMode(peerId = null, peerName = "Campus Group Chat", peerSub = "Everyone in Primus Pix") {
    state.inChatView = true;
    state.chatPeerId = peerId;
    state.chatPeerName = peerName;
    state.chatPeerSub = peerSub;

    showOnlyStudentSection("section-chat");
    setActiveNavTab("nav-messages-btn");
    $("chat-active-title").textContent = peerName;
    $("chat-active-sub").textContent = peerSub;

    await loadChatPeers();
    await loadChatMessages(true);

    if (chatPollTimer) clearInterval(chatPollTimer);
    chatPollTimer = setInterval(async () => {
      if (!state.inChatView || state.inAdminView) return;
      await loadChatPeers();
      await loadChatMessages(false);
    }, 2500);
  }

  async function loadChatPeers() {
    try {
      const data = await api("/api/chat/peers", { auth: "student" });
      state.chatPeers = data.peers || [];
      const list = $("chat-peer-list");
      const groupActive = state.chatPeerId === null ? "active" : "";
      const groupHtml = `
        <button type="button" class="chat-peer-item ${groupActive}" data-chat-peer="group">
          <div class="post-avatar" style="width:36px;height:36px;font-size:0.85rem;">ALL</div>
          <div style="min-width:0;">
            <div class="chat-peer-name">Campus Group Chat</div>
            <div class="chat-peer-preview">${escapeHtml(data.group.last_message || "Say hi!")}</div>
          </div>
        </button>
      `;
      const peersHtml = state.chatPeers
        .map((p) => {
          const act = state.chatPeerId === p.id ? "active" : "";
          return `
            <button type="button" class="chat-peer-item ${act}" data-chat-peer="${p.id}">
              <div class="post-avatar" style="width:36px;height:36px;font-size:0.85rem;">${renderAvatar(p.avatar_url, p.name)}</div>
              <div style="min-width:0;">
                <div class="chat-peer-name">${escapeHtml(p.name)}</div>
                <div class="chat-peer-preview">${escapeHtml(p.last_message || p.class_name)}</div>
              </div>
            </button>
          `;
        })
        .join("");

      list.innerHTML = groupHtml + peersHtml;
    } catch {
      // ignore
    }
  }

  async function loadChatMessages(scrollBottom = false) {
    // Do not overwrite DOM while the user is actively inline-editing a message
    if (state.editingMessageId && !scrollBottom) return;
    try {
      const url =
        state.chatPeerId === null
          ? "/api/chat/messages"
          : `/api/chat/messages?peer_id=${state.chatPeerId}`;
      const data = await api(url, { auth: "student" });
      const box = $("chat-messages");
      const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;

      if (!data.messages.length) {
        box.innerHTML = `<div class="muted small" style="text-align:center;margin:auto;">No messages yet. Say hello!</div>`;
        return;
      }

      box.innerHTML = data.messages
        .map((m) => {
          const mine = state.currentUser && m.sender_id === state.currentUser.id;
          const isEditing = mine && state.editingMessageId === m.id;
          const actionsHtml =
            mine && !isEditing
              ? `<span class="msg-actions">
                   <button type="button" class="msg-act-btn" data-edit-msg="${m.id}" data-edit-body="${escapeHtml(m.body)}">Edit</button>
                   <button type="button" class="msg-act-btn" data-del-msg="${m.id}">Delete</button>
                 </span>`
              : "";
          const contentHtml = isEditing
            ? `<form class="msg-edit-form" data-save-edit-msg="${m.id}">
                 <input type="text" value="${escapeHtml(m.body)}" required />
                 <button type="submit" class="msg-act-btn">Save</button>
                 <button type="button" class="msg-act-btn" data-cancel-edit-msg="1">Cancel</button>
               </form>`
            : `<div>${escapeHtml(m.body)}</div>`;

          return `
            <div class="msg-bubble ${mine ? "mine" : "theirs"}">
              <div class="msg-head-row">
                <div class="msg-meta" style="margin:0;">${mine ? "You" : escapeHtml(m.sender_name)} &bull; ${timeAgo(m.created_at)}</div>
                ${actionsHtml}
              </div>
              ${contentHtml}
            </div>
          `;
        })
        .join("");

      if (scrollBottom || wasNearBottom) {
        box.scrollTop = box.scrollHeight;
      }
    } catch {
      // ignore
    }
  }

  async function loadFeed() {
    const params = new URLSearchParams();
    if (state.filterType) params.set("post_type", state.filterType);
    if (state.filterClass) params.set("class_name", state.filterClass);
    if (state.searchQuery.trim()) params.set("q", state.searchQuery.trim());

    try {
      const data = await api(`/api/posts?${params.toString()}`, { auth: "student" });
      state.posts = data.posts;
      renderPosts(state.posts);
      renderCampusTV();
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        boot();
      } else {
        toast(err.message, "error");
      }
    }
  }

  async function loadUserProfile(userId) {
    state.viewingProfileId = userId;
    state.inChatView = false;
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
    showOnlyStudentSection("section-feed");
    setActiveNavTab("");
    if ($("portal-hero-row")) $("portal-hero-row").classList.add("hidden");
    if ($("stories-section")) $("stories-section").classList.add("hidden");
    if ($("flashes-section")) $("flashes-section").classList.add("hidden");
    if ($("notice-board-card")) $("notice-board-card").classList.add("hidden");
    $("profile-banner").classList.remove("hidden");
    $("feed-controls").classList.add("hidden");

    try {
      const data = await api(`/api/users/${userId}`, { auth: "student" });
      const p = data.profile;
      $("profile-avatar").innerHTML = renderAvatar(p.avatar_url, p.name);
      $("profile-name").textContent = p.name;
      $("profile-meta").textContent = `${p.reg_number} • ${p.class_name}`;
      const bioEl = $("profile-bio");
      if (bioEl) {
        if (p.bio) {
          bioEl.textContent = p.bio;
          bioEl.classList.remove("hidden");
        } else {
          bioEl.textContent = "";
          bioEl.classList.add("hidden");
        }
      }
      const isMe = state.currentUser && state.currentUser.id === p.id;
      if ($("open-edit-profile-btn")) {
        $("open-edit-profile-btn").classList.toggle("hidden", !isMe);
      }
      if ($("profile-make-avatar-btn")) {
        $("profile-make-avatar-btn").classList.toggle("hidden", !isMe);
      }
      if (isMe) {
        state.currentUser = {
          ...state.currentUser,
          name: p.name,
          bio: p.bio || "",
          avatar_url: p.avatar_url,
          can_change_name: p.can_change_name,
          days_remaining: p.days_remaining,
          next_name_change_at: p.next_name_change_at,
        };
        syncMyNavIdentity();
      }
      $("stat-pics").textContent = p.stats.pics;
      $("stat-vlogs").textContent = p.stats.vlogs;
      $("stat-blogs").textContent = p.stats.blogs;
      $("stat-likes").textContent = p.stats.total_likes;
      state.posts = data.posts;
      renderPosts(state.posts);
    } catch (err) {
      toast(err.message, "error");
      showFeedMode();
    }
  }

  function renderPosts(posts) {
    const list = $("feed-list");
    if (!posts.length) {
      list.innerHTML = `
        <div class="empty-state">
          <h3>No posts yet</h3>
          <p>Be the first to share a pic, vlog, or blog with your classmates!</p>
        </div>
      `;
      return;
    }

    list.innerHTML = posts.map((post) => renderPostCard(post)).join("");

    // Re-fetch comments for any post that was already expanded
    posts.forEach((post) => {
      if (state.openComments.has(post.id)) {
        loadComments(post.id);
      }
    });
  }

  function renderPostCard(post) {
    const isOwner = state.currentUser && post.user_id === state.currentUser.id;
    const typeLabel = post.post_type === "pic" ? "Pic" : post.post_type === "vlog" ? "Vlog" : "Blog";

    let mediaHtml = "";
    if (post.media_url) {
      if (post.post_type === "vlog") {
        mediaHtml = `
          <div class="post-media">
            <video src="${escapeHtml(post.media_url)}" controls playsinline preload="metadata"></video>
          </div>
        `;
      } else {
        mediaHtml = `
          <div class="post-media">
            <img src="${escapeHtml(post.media_url)}" alt="${escapeHtml(post.title || "Uploaded pic")}" data-lightbox="${escapeHtml(post.media_url)}" />
          </div>
        `;
      }
    }

    const bodyHtml =
      post.title || post.content
        ? `
          <div class="post-body">
            ${post.title ? `<h3 class="post-title">${escapeHtml(post.title)}</h3>` : ""}
            ${post.content ? `<p class="post-text">${escapeHtml(post.content)}</p>` : ""}
          </div>
        `
        : "";

    const commentsOpen = state.openComments.has(post.id);

    return `
      <article class="post-card" data-post-id="${post.id}">
        <div class="post-header">
          <div class="post-author" data-profile-id="${post.user_id}">
            <div class="post-avatar">${renderAvatar(post.author_avatar, post.author_name)}</div>
            <div>
              <div class="post-author-name">${escapeHtml(post.author_name)}</div>
              <div class="post-meta">${escapeHtml(post.author_reg_number)} &bull; ${escapeHtml(post.author_class)} &bull; ${timeAgo(post.created_at)}</div>
            </div>
          </div>
          <div class="post-header-right">
            ${post.audience === "close_friends" ? `<span class="cf-viewer-badge">⭐ Close Friends</span>` : ""}
            <span class="type-badge ${post.post_type}">${typeLabel}</span>
            ${isOwner ? `<button type="button" class="btn btn-danger-ghost btn-sm" data-delete-post="${post.id}">Delete</button>` : ""}
          </div>
        </div>

        ${post.post_type === "blog" ? `${mediaHtml}${bodyHtml}` : `${bodyHtml}${mediaHtml}`}

        <div class="post-actions">
          <button type="button" class="action-btn ${post.liked_by_me ? "liked" : ""}" data-like-post="${post.id}">
            <span>${post.liked_by_me ? "♥" : "♡"}</span>
            <span data-like-count="${post.id}">${post.like_count}</span>
          </button>
          <button type="button" class="action-btn" data-toggle-comments="${post.id}">
            <span>💬</span>
            <span data-comment-count="${post.id}">${post.comment_count}</span> Comments
          </button>
        </div>

        <div class="comments-box ${commentsOpen ? "" : "hidden"}" id="comments-box-${post.id}">
          <div class="comment-list" id="comment-list-${post.id}">
            <p class="muted small">Loading comments...</p>
          </div>
          <form class="comment-form" data-comment-form="${post.id}">
            <input type="text" placeholder="Write a comment..." required />
            <button type="submit" class="btn btn-primary btn-sm">Send</button>
          </form>
        </div>
      </article>
    `;
  }

  async function loadComments(postId) {
    const listEl = $(`comment-list-${postId}`);
    if (!listEl) return;
    try {
      const data = await api(`/api/posts/${postId}/comments`, { auth: "student" });
      if (!data.comments.length) {
        listEl.innerHTML = `<p class="muted small" style="margin:0 0 6px">No comments yet. Say something nice!</p>`;
        return;
      }
      listEl.innerHTML = data.comments
        .map((c) => {
          const canDel = state.currentUser && c.user_id === state.currentUser.id;
          return `
            <div class="comment-item">
              <div class="comment-head">
                <div>
                  <span class="comment-author" data-profile-id="${c.user_id}">${escapeHtml(c.author_name)}</span>
                  <span class="muted"> (${escapeHtml(c.author_class)}) &bull; ${timeAgo(c.created_at)}</span>
                </div>
                ${canDel ? `<button type="button" class="btn btn-danger-ghost btn-sm" style="padding:2px 7px;font-size:0.74rem" data-delete-comment="${c.id}" data-parent-post="${postId}">Delete</button>` : ""}
              </div>
              <p class="comment-body">${escapeHtml(c.body)}</p>
            </div>
          `;
        })
        .join("");
    } catch (err) {
      listEl.innerHTML = `<p class="muted small">Failed to load comments.</p>`;
    }
  }

  // ---------- Composer Modal ----------

  function setComposerType(type) {
    const safeType = type === "blog" ? "blog" : "vlog";
    state.composerType = safeType;
    document.querySelectorAll(".type-pill").forEach((b) => {
      b.classList.toggle("active", b.dataset.ctype === safeType);
    });

    const titleLabel = $("post-title-label");
    const titleInput = $("post-title");
    const fileField = $("composer-file-field");
    const mediaLabel = $("post-media-label");
    const mediaInput = $("post-media");
    const dropText = $("file-drop-text");
    const contentLabel = $("post-content-label");
    const contentInput = $("post-content");

    mediaInput.value = "";
    $("media-preview").innerHTML = "";
    $("media-preview").classList.add("hidden");

    if (safeType === "vlog") {
      fileField.classList.remove("hidden");
      titleLabel.textContent = "Video Title";
      titleInput.required = true;
      titleInput.placeholder = "e.g. A Day in Our Science Lab!";
      mediaLabel.textContent = "Upload Video (required)";
      mediaInput.accept = "video/*";
      dropText.textContent = "Click to choose a video (MP4, WEBM, MOV — max 100 MB)";
      contentLabel.textContent = "Description";
      contentInput.required = false;
      contentInput.rows = 3;
      contentInput.placeholder = "Tell classmates what this video is about...";
    } else {
      fileField.classList.add("hidden");
      titleLabel.textContent = "Blog Headline (required)";
      titleInput.required = true;
      titleInput.placeholder = "e.g. 5 Study Tips That Actually Worked";
      contentLabel.textContent = "Blog Article (required)";
      contentInput.required = true;
      contentInput.rows = 7;
      contentInput.placeholder = "Write your blog post here...";
    }
  }

  function setPostAudience(aud) {
    state.postAudience = aud === "close_friends" ? "close_friends" : "all";
    document.querySelectorAll("[data-post-aud]").forEach((b) => {
      b.classList.toggle("active", b.dataset.postAud === state.postAudience);
    });
  }

  function openComposer(defaultType = "vlog", defaultAudience = "all") {
    $("composer-form").reset();
    setComposerType(defaultType === "blog" ? "blog" : "vlog");
    setPostAudience(defaultAudience);
    $("modal-composer").classList.remove("hidden");
  }

  function closeComposer() {
    $("modal-composer").classList.add("hidden");
  }

  // ---------- Admin Dashboard ----------

  async function enterAdminDashboard() {
    stopTimers();
    state.inAdminView = true;
    showOnly("view-admin");
    await refreshAdminData();
    adminPollTimer = setInterval(refreshAdminData, 3000);
  }

  async function refreshAdminData(forceRenderFormTab = false) {
    if (!state.adminToken) return;
    try {
      const data = await api("/api/admin/overview", { auth: "admin" });
      state.adminData = data;
      if (state.adminTab === "email") {
        updateAdminCounters();
        if (forceRenderFormTab || !state.adminSettings) {
          state.adminSettings = await api("/api/admin/settings", { auth: "admin" });
          renderAdminOverview();
        }
      } else if (state.adminTab === "notices" || state.adminTab === "poll") {
        updateAdminCounters();
        if (forceRenderFormTab) {
          renderAdminOverview();
        }
      } else {
        renderAdminOverview();
      }
    } catch (err) {
      if (err.status === 401) {
        state.adminToken = null;
        state.inAdminView = false;
        localStorage.removeItem(LS_ADMIN);
        toast("Admin session expired. Please sign in again.", "error");
        boot();
      }
    }
  }

  function updateAdminCounters() {
    const { sessions, users, posts } = state.adminData;
    const pending = sessions.filter((s) => s.status === "pending");
    const active = sessions.filter((s) => s.status === "approved");

    $("adm-stat-pending").textContent = pending.length;
    $("adm-stat-active").textContent = active.length;
    $("adm-stat-users").textContent = users.length;
    $("adm-stat-posts").textContent = posts.length;
    $("pending-count-pill").textContent = pending.length;

    document.querySelectorAll("[data-admtab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.admtab === state.adminTab);
    });
  }

  function renderAdminOverview() {
    updateAdminCounters();
    const { sessions, users, posts } = state.adminData;
    const pending = sessions.filter((s) => s.status === "pending");

    const container = $("admin-tab-content");

    if (state.adminTab === "pending") {
      if (!pending.length) {
        container.innerHTML = `
          <div class="empty-state">
            <h3>No pending sign-in requests</h3>
            <p>When a student tries to sign in, their request will appear here automatically.</p>
          </div>
        `;
        return;
      }
      container.innerHTML = `<div class="admin-list">${pending
        .map(
          (s) => `
          <div class="admin-row-card pending-highlight">
            <div class="admin-row-main">
              <div class="admin-row-title">
                <span>${escapeHtml(s.name)}</span>
                <span class="status-pill pending">Pending</span>
              </div>
              <div class="admin-row-sub">
                Reg No: <strong>${escapeHtml(s.reg_number)}</strong> &bull;
                Class: <strong>${escapeHtml(s.class_name)}</strong> &bull;
                Requested ${timeAgo(s.created_at)}
              </div>
            </div>
            <div class="admin-row-actions">
              <button type="button" class="btn btn-success btn-sm" data-adm-approve="${s.id}">Allow</button>
              <button type="button" class="btn btn-danger btn-sm" data-adm-deny="${s.id}">Deny</button>
            </div>
          </div>
        `
        )
        .join("")}</div>`;
    } else if (state.adminTab === "notices") {
      const notices = state.adminData.notices || [];
      const classes = state.adminData.classes || [];
      const editing = notices.find((n) => n.id === state.editingNoticeId) || null;
      const initialSelected = editing
        ? (editing.target_class || "").split(",").map((s) => s.trim()).filter(Boolean)
        : state.prefillNoticeClass
        ? [state.prefillNoticeClass]
        : [];
      const selectedSet = new Set(initialSelected);

      const chipsHtml =
        `<button type="button" class="class-select-chip all-chip ${selectedSet.size === 0 ? "selected" : ""}" data-cls-chip="__ALL__">🌍 All Classes</button>` +
        classes
          .map(
            (c) =>
              `<button type="button" class="class-select-chip ${selectedSet.has(c) ? "selected" : ""}" data-cls-chip="${escapeHtml(c)}">🏫 ${escapeHtml(c)}</button>`
          )
          .join("");

      const listHtml = notices.length
        ? notices
            .map((n) => {
              const pr = n.priority || "info";
              const tagLabel = pr === "urgent" ? "Urgent" : pr === "important" ? "Important" : "Notice";
              const targetBadge = n.target_class
                ? `<span class="notice-class-pill">🎯 ${escapeHtml(n.target_class)}</span>`
                : `<span class="status-pill logged_out">🌍 All Classes</span>`;
              return `
                <div class="admin-row-card">
                  <div class="admin-row-main">
                    <div class="admin-row-title">
                      <span>${n.pinned ? "📌 " : ""}${escapeHtml(n.title)}</span>
                      ${targetBadge}
                      <span class="notice-tag ${pr}">${tagLabel}</span>
                    </div>
                    <div class="admin-row-sub" style="color:#374151;white-space:pre-wrap;margin-top:4px;">${escapeHtml(n.body)}</div>
                    <div class="admin-row-sub" style="margin-top:4px;">Updated ${timeAgo(n.updated_at || n.created_at)}</div>
                  </div>
                  <div class="admin-row-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-adm-edit-notice="${n.id}">Edit</button>
                    <button type="button" class="btn btn-danger btn-sm" data-adm-del-notice="${n.id}">Delete</button>
                  </div>
                </div>
              `;
            })
            .join("")
        : `<div class="empty-state"><h3>No notices posted yet</h3><p>Publish your first official announcement above — select All Classes or pick multiple specific classes!</p></div>`;

      container.innerHTML = `
        <div class="admin-list">
          <div class="admin-row-card" style="display:block;">
            <h3 style="margin:0 0 6px;">${editing ? "✏️ Edit Notice" : "📌 Post a New Notice"}</h3>
            <p class="muted small" style="margin:0 0 14px;">
              Click <strong>All Classes</strong> or tap <strong>as many specific classes as you want</strong> at once.
            </p>
            <form id="admin-notice-form" class="form-stack">
              <div class="field">
                <label for="adm-notice-title">Notice Headline</label>
                <input id="adm-notice-title" type="text" placeholder="e.g. Science Fair Submissions Due Friday" value="${editing ? escapeHtml(editing.title) : ""}" required />
              </div>
              <div class="field">
                <label for="adm-notice-body">Announcement Message</label>
                <textarea id="adm-notice-body" rows="3" placeholder="Write the details students need to know..." required>${editing ? escapeHtml(editing.body) : ""}</textarea>
              </div>
              <div class="field">
                <label>Send To Classes (Multi-Select)</label>
                <div class="multi-class-picker" id="adm-class-picker">${chipsHtml}</div>
              </div>
              <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;">
                <div class="field" style="flex:1;min-width:150px;">
                  <label for="adm-notice-priority">Priority</label>
                  <select id="adm-notice-priority" class="select-input" style="width:100%;">
                    <option value="info"${!editing || editing.priority === "info" ? " selected" : ""}>Normal Notice</option>
                    <option value="important"${editing && editing.priority === "important" ? " selected" : ""}>Important</option>
                    <option value="urgent"${editing && editing.priority === "urgent" ? " selected" : ""}>Urgent</option>
                  </select>
                </div>
                <label style="display:inline-flex;align-items:center;gap:8px;font-size:0.86rem;font-weight:600;margin-top:18px;cursor:pointer;">
                  <input id="adm-notice-pinned" type="checkbox" ${!editing || editing.pinned ? "checked" : ""} />
                  Pin to top
                </label>
              </div>
              <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button type="submit" class="btn btn-primary btn-sm">${editing ? "Save Changes" : "Publish Notice"}</button>
                ${editing ? `<button type="button" class="btn btn-ghost btn-sm" id="cancel-edit-notice-btn">Cancel Edit</button>` : ""}
              </div>
            </form>
          </div>

          <h3 style="margin:12px 0 4px;">Published Notices (${notices.length})</h3>
          ${listHtml}
        </div>
      `;

      const picker = $("adm-class-picker");
      if (picker) {
        picker.addEventListener("click", (e) => {
          const chip = e.target.closest("[data-cls-chip]");
          if (!chip) return;
          const val = chip.dataset.clsChip;
          const allChip = picker.querySelector('[data-cls-chip="__ALL__"]');
          const classChips = Array.from(picker.querySelectorAll('[data-cls-chip]:not([data-cls-chip="__ALL__"])'));
          if (val === "__ALL__") {
            allChip.classList.add("selected");
            classChips.forEach((c) => c.classList.remove("selected"));
          } else {
            chip.classList.toggle("selected");
            const anySelected = classChips.some((c) => c.classList.contains("selected"));
            allChip.classList.toggle("selected", !anySelected);
          }
        });
      }

      const form = $("admin-notice-form");
      if (form) {
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const chosenClasses = Array.from(
            $("adm-class-picker").querySelectorAll('[data-cls-chip]:not([data-cls-chip="__ALL__"]).selected')
          ).map((c) => c.dataset.clsChip);

          const payload = {
            title: $("adm-notice-title").value,
            body: $("adm-notice-body").value,
            priority: $("adm-notice-priority").value,
            pinned: $("adm-notice-pinned").checked,
            target_classes: chosenClasses,
          };
          try {
            if (state.editingNoticeId) {
              await api(`/api/admin/notices/${state.editingNoticeId}`, {
                method: "PUT",
                auth: "admin",
                json: payload,
              });
              toast("Notice updated!", "success");
              state.editingNoticeId = null;
            } else {
              await api("/api/admin/notices", {
                method: "POST",
                auth: "admin",
                json: payload,
              });
              toast(
                chosenClasses.length
                  ? `Notice sent to ${chosenClasses.join(", ")}!`
                  : "Notice published to All Classes!",
                "success"
              );
              state.prefillNoticeClass = "";
            }
            refreshAdminData(true);
          } catch (err) {
            toast(err.message, "error");
          }
        });
      }

      const cancelBtn = $("cancel-edit-notice-btn");
      if (cancelBtn) {
        cancelBtn.addEventListener("click", () => {
          state.editingNoticeId = null;
          state.prefillNoticeClass = "";
          renderAdminOverview();
        });
      }
    } else if (state.adminTab === "poll") {
      const polls = state.adminData.polls || [];
      const editing = polls.find((p) => p.id === state.editingPollId) || null;
      const opts = editing ? editing.options : ["", "", "", ""];

      const pollsHtml = polls.length
        ? polls
            .map((p, idx) => {
              const total = Math.max(1, p.total_votes);
              const breakdown = p.options
                .map((o, i) => {
                  const cnt = p.counts[i] || 0;
                  const pct = p.total_votes > 0 ? Math.round((cnt / total) * 100) : 0;
                  return `${escapeHtml(o)} (${cnt} • ${pct}%)`;
                })
                .join("  |  ");
              return `
                <div class="admin-row-card ${idx === 0 ? "pending-highlight" : ""}">
                  <div class="admin-row-main">
                    <div class="admin-row-title">
                      <span>${escapeHtml(p.question)}</span>
                      ${idx === 0 ? `<span class="status-pill approved">LIVE ON HOMEPAGE</span>` : ""}
                    </div>
                    <div class="admin-row-sub" style="margin-top:4px;color:#374151;">${breakdown}</div>
                    <div class="admin-row-sub">${p.total_votes} total vote${p.total_votes === 1 ? "" : "s"} &bull; ${timeAgo(p.created_at)}</div>
                  </div>
                  <div class="admin-row-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-adm-edit-poll="${p.id}">Edit</button>
                    <button type="button" class="btn btn-danger btn-sm" data-adm-del-poll="${p.id}">Delete</button>
                  </div>
                </div>
              `;
            })
            .join("")
        : `<div class="empty-state"><h3>No polls yet</h3><p>Create a poll above and it will go live in the Primus Poll box on every student's homepage!</p></div>`;

      container.innerHTML = `
        <div class="admin-list">
          <div class="admin-row-card" style="display:block;">
            <h3 style="margin:0 0 6px;">${editing ? "✏️ Edit Primus Poll" : "🗳️ Create a New Live Primus Poll"}</h3>
            <p class="muted small" style="margin:0 0 14px;">
              The newest poll is shown live in the <strong>🗳️ Primus Poll</strong> box on the homepage.
            </p>
            <form id="admin-poll-form" class="form-stack">
              <div class="field">
                <label for="adm-poll-q">Poll Question</label>
                <input id="adm-poll-q" type="text" placeholder="e.g. What should our Friday spirit day theme be?" value="${editing ? escapeHtml(editing.question) : ""}" required />
              </div>
              <div class="field">
                <label>Choices (2 to 4 options)</label>
                <input class="adm-poll-opt" type="text" placeholder="Option 1 (required)" value="${escapeHtml(opts[0] || "")}" required />
                <input class="adm-poll-opt" type="text" placeholder="Option 2 (required)" value="${escapeHtml(opts[1] || "")}" required />
                <input class="adm-poll-opt" type="text" placeholder="Option 3 (optional)" value="${escapeHtml(opts[2] || "")}" />
                <input class="adm-poll-opt" type="text" placeholder="Option 4 (optional)" value="${escapeHtml(opts[3] || "")}" />
              </div>
              <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button type="submit" class="btn btn-primary btn-sm">${editing ? "Save Poll Changes" : "Publish Live Poll"}</button>
                ${editing ? `<button type="button" class="btn btn-ghost btn-sm" id="cancel-edit-poll-btn">Cancel Edit</button>` : ""}
              </div>
            </form>
          </div>

          <h3 style="margin:12px 0 4px;">All Polls (${polls.length})</h3>
          ${pollsHtml}
        </div>
      `;

      const pForm = $("admin-poll-form");
      if (pForm) {
        pForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const question = $("adm-poll-q").value.trim();
          const options = Array.from(document.querySelectorAll(".adm-poll-opt"))
            .map((i) => i.value.trim())
            .filter(Boolean);
          try {
            if (state.editingPollId) {
              await api(`/api/admin/polls/${state.editingPollId}`, {
                method: "PUT",
                auth: "admin",
                json: { question, options },
              });
              toast("Primus Poll updated!", "success");
              state.editingPollId = null;
            } else {
              await api("/api/admin/polls", {
                method: "POST",
                auth: "admin",
                json: { question, options },
              });
              toast("New Primus Poll is now LIVE!", "success");
            }
            refreshAdminData(true);
          } catch (err) {
            toast(err.message, "error");
          }
        });
      }

      const cancelPollBtn = $("cancel-edit-poll-btn");
      if (cancelPollBtn) {
        cancelPollBtn.addEventListener("click", () => {
          state.editingPollId = null;
          renderAdminOverview();
        });
      }
    } else if (state.adminTab === "sessions") {
      if (!sessions.length) {
        container.innerHTML = `<div class="empty-state"><h3>No sign-in history yet</h3></div>`;
        return;
      }
      container.innerHTML = `<div class="admin-list">${sessions
        .map(
          (s) => `
          <div class="admin-row-card ${s.status === "pending" ? "pending-highlight" : ""}">
            <div class="admin-row-main">
              <div class="admin-row-title">
                <span>${escapeHtml(s.name)}</span>
                <span class="status-pill ${s.status}">${s.status.replace("_", " ")}</span>
              </div>
              <div class="admin-row-sub">
                ${escapeHtml(s.reg_number)} &bull; ${escapeHtml(s.class_name)} &bull; ${timeAgo(s.created_at)}
              </div>
            </div>
            <div class="admin-row-actions">
              ${s.status === "pending" ? `<button type="button" class="btn btn-success btn-sm" data-adm-approve="${s.id}">Allow</button>` : ""}
              ${s.status === "pending" ? `<button type="button" class="btn btn-danger btn-sm" data-adm-deny="${s.id}">Deny</button>` : ""}
              ${s.status === "approved" ? `<button type="button" class="btn btn-danger btn-sm" data-adm-revoke="${s.id}">Revoke Access</button>` : ""}
            </div>
          </div>
        `
        )
        .join("")}</div>`;
    } else if (state.adminTab === "users") {
      if (!users.length) {
        container.innerHTML = `<div class="empty-state"><h3>No students have signed in yet</h3></div>`;
        return;
      }
      // Group students by class_name
      const byClass = new Map();
      users.forEach((u) => {
        const cls = (u.class_name || "Unassigned").trim();
        if (!byClass.has(cls)) byClass.set(cls, []);
        byClass.get(cls).push(u);
      });
      const sortedClasses = Array.from(byClass.keys()).sort((a, b) => a.localeCompare(b));

      container.innerHTML = `<div class="admin-list">${sortedClasses
        .map((cls) => {
          const members = byClass.get(cls);
          const rowsHtml = members
            .map(
              (u) => `
              <div class="admin-row-card" style="box-shadow:none;">
                <div class="admin-row-main">
                  <div class="admin-row-title">
                    <span>${escapeHtml(u.name)}</span>
                    ${u.is_banned ? `<span class="status-pill banned">Banned</span>` : `<span class="status-pill approved">Active</span>`}
                  </div>
                  <div class="admin-row-sub">
                    Reg No: <strong>${escapeHtml(u.reg_number)}</strong> &bull;
                    ${u.post_count} post(s) &bull; ${u.active_sessions} active session(s)
                  </div>
                </div>
                <div class="admin-row-actions">
                  ${
                    u.is_banned
                      ? `<button type="button" class="btn btn-success btn-sm" data-adm-ban="${u.id}" data-ban-val="false">Unban</button>`
                      : `<button type="button" class="btn btn-danger btn-sm" data-adm-ban="${u.id}" data-ban-val="true">Ban Student</button>`
                  }
                </div>
              </div>
            `
            )
            .join("");

          return `
            <div class="class-group-box">
              <div class="class-group-header">
                <div class="class-group-title">
                  <span>🏫 ${escapeHtml(cls)}</span>
                  <span class="hub-badge">${members.length} student${members.length === 1 ? "" : "s"}</span>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" data-adm-notice-class="${escapeHtml(cls)}">
                  📌 Send Notice to ${escapeHtml(cls)}
                </button>
              </div>
              <div class="class-group-body">${rowsHtml}</div>
            </div>
          `;
        })
        .join("")}</div>`;
    } else if (state.adminTab === "posts") {
      if (!posts.length) {
        container.innerHTML = `<div class="empty-state"><h3>No posts published yet</h3></div>`;
        return;
      }
      container.innerHTML = `<div class="admin-list">${posts
        .map(
          (p) => `
          <div class="admin-row-card">
            <div class="admin-row-main">
              <div class="admin-row-title">
                <span class="type-badge ${p.post_type}">${p.post_type}</span>
                <span>${escapeHtml(p.title || "(Untitled post)")}</span>
              </div>
              <div class="admin-row-sub">
                By <strong>${escapeHtml(p.author_name)}</strong> (${escapeHtml(p.author_reg_number)} &bull; ${escapeHtml(p.author_class)}) &bull;
                ${timeAgo(p.created_at)} &bull; ♥ ${p.like_count} &bull; 💬 ${p.comment_count}
              </div>
              ${p.content ? `<div class="admin-row-sub" style="color:#cbd5e1;margin-top:4px">${escapeHtml(p.content.slice(0, 160))}${p.content.length > 160 ? "…" : ""}</div>` : ""}
            </div>
            <div class="admin-row-actions">
              <button type="button" class="btn btn-danger btn-sm" data-adm-del-post="${p.id}">Delete Post</button>
            </div>
          </div>
        `
        )
        .join("")}</div>`;
    } else if (state.adminTab === "email") {
      const cfg = state.adminSettings || {
        email_mode: "mailpit",
        smtp_host: "127.0.0.1",
        smtp_port: 1025,
        admin_email: "",
        gmail_user: "",
        gmail_app_password_set: false,
        app_base_url: "http://127.0.0.1:8000",
        local_inbox: [],
      };
      const isMailpit = (cfg.email_mode || "mailpit") === "mailpit";
      const inboxHtml = cfg.local_inbox && cfg.local_inbox.length
        ? cfg.local_inbox
            .map(
              (m) => `
              <div class="admin-row-card">
                <div class="admin-row-main">
                  <div class="admin-row-title">
                    <span>${escapeHtml(m.subject)}</span>
                    <span class="status-pill ${m.error ? "denied" : "approved"}">${escapeHtml(m.delivery)}</span>
                  </div>
                  <div class="admin-row-sub">
                    Reg No: <strong>${escapeHtml(m.reg_number)}</strong> &bull;
                    Class: <strong>${escapeHtml(m.class_name)}</strong> &bull;
                    ${timeAgo(m.created_at)}
                    ${m.error ? `<div style="color:#dc2626;margin-top:4px">Error: ${escapeHtml(m.error)}</div>` : ""}
                  </div>
                </div>
                <div class="admin-row-actions">
                  <a class="btn btn-success btn-sm" href="${escapeHtml(m.allow_url)}" target="_blank" rel="noopener">Email Allow Link</a>
                  <a class="btn btn-danger btn-sm" href="${escapeHtml(m.deny_url)}" target="_blank" rel="noopener">Email Deny Link</a>
                </div>
              </div>
            `
            )
            .join("")
        : `<div class="empty-state"><h3>No approval emails generated yet</h3><p>When a new student signs in, their approval email will be delivered to Mailpit (<code>http://127.0.0.1:8025</code>) and logged here.</p></div>`;

      container.innerHTML = `
        <div class="admin-list">
          <div class="admin-row-card" style="display:block;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
              <h3 style="margin:0;">📬 Email Delivery (Mailpit / Gmail)</h3>
              <a href="http://127.0.0.1:8025" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">Open Mailpit Inbox (8025) ↗</a>
            </div>
            <p class="muted small" style="margin:0 0 14px;">
              Use <strong>Mailpit</strong> (<code>127.0.0.1:1025</code>) for instant local email testing, or switch to <strong>Gmail SMTP</strong> for live emails.
            </p>
            <form id="gmail-settings-form" class="form-stack">
              <div class="field">
                <label for="cfg-email-mode">Email Provider Mode</label>
                <select id="cfg-email-mode" class="select-input" style="width:100%;">
                  <option value="mailpit"${isMailpit ? " selected" : ""}>📬 Mailpit (Local Testing — 127.0.0.1:1025)</option>
                  <option value="gmail"${!isMailpit ? " selected" : ""}>📧 Gmail SMTP (Live Production)</option>
                </select>
              </div>
              <div style="display:flex;gap:12px;flex-wrap:wrap;">
                <div class="field" style="flex:2;min-width:160px;">
                  <label for="cfg-smtp-host">Mailpit SMTP Host</label>
                  <input id="cfg-smtp-host" type="text" value="${escapeHtml(cfg.smtp_host || "127.0.0.1")}" placeholder="127.0.0.1" />
                </div>
                <div class="field" style="flex:1;min-width:110px;">
                  <label for="cfg-smtp-port">Mailpit SMTP Port</label>
                  <input id="cfg-smtp-port" type="number" value="${escapeHtml(cfg.smtp_port || 1025)}" placeholder="1025" />
                </div>
              </div>
              <div class="field">
                <label for="cfg-admin-email">Recipient Admin Email</label>
                <input id="cfg-admin-email" type="email" value="${escapeHtml(cfg.admin_email)}" placeholder="kinza.surya@gmail.com" />
              </div>
              <div class="field">
                <label for="cfg-gmail-user">Gmail Address (only needed for Gmail mode)</label>
                <input id="cfg-gmail-user" type="email" value="${escapeHtml(cfg.gmail_user)}" placeholder="you@gmail.com" />
              </div>
              <div class="field">
                <label for="cfg-gmail-pass">Google App Password ${cfg.gmail_app_password_set ? "(Saved — leave blank to keep current)" : "(only needed for Gmail mode)"}</label>
                <input id="cfg-gmail-pass" type="password" placeholder="${cfg.gmail_app_password_set ? "••••••••••••••••" : "xxxx xxxx xxxx xxxx"}" />
              </div>
              <div class="field">
                <label for="cfg-base-url">App Base URL (used inside email Allow/Deny buttons)</label>
                <input id="cfg-base-url" type="url" value="${escapeHtml(cfg.app_base_url)}" placeholder="http://127.0.0.1:8000" />
              </div>
              <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button type="submit" class="btn btn-primary btn-sm">Save Email Settings</button>
                <button type="button" class="btn btn-secondary btn-sm" id="send-test-gmail-btn">Send Test Email</button>
              </div>
            </form>
          </div>

          <h3 style="margin:14px 0 4px;">Recent Approval Emails (Log)</h3>
          ${inboxHtml}
        </div>
      `;

      const form = $("gmail-settings-form");
      if (form) {
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            await api("/api/admin/settings", {
              method: "POST",
              auth: "admin",
              json: {
                email_mode: $("cfg-email-mode").value,
                smtp_host: $("cfg-smtp-host").value,
                smtp_port: Number($("cfg-smtp-port").value) || 1025,
                gmail_user: $("cfg-gmail-user").value,
                gmail_app_password: $("cfg-gmail-pass").value,
                admin_email: $("cfg-admin-email").value,
                app_base_url: $("cfg-base-url").value,
              },
            });
            toast("Email settings saved!", "success");
            refreshAdminData(true);
          } catch (err) {
            toast(err.message, "error");
          }
        });
      }

      const testBtn = $("send-test-gmail-btn");
      if (testBtn) {
        testBtn.addEventListener("click", async () => {
          testBtn.disabled = true;
          try {
            const res = await api("/api/admin/settings/test-email", { method: "POST", auth: "admin" });
            toast(res.message, "success");
          } catch (err) {
            toast(err.message, "error");
          } finally {
            testBtn.disabled = false;
          }
        });
      }
    }
  }

  // ---------- Event Listeners ----------

  // Student Sign-In Form
  $("student-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("login-submit-btn");
    btn.disabled = true;
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        json: {
          reg_number: $("login-reg").value,
          name: $("login-name").value,
          class_name: $("login-class").value,
        },
      });
      state.sessionToken = data.token;
      state.currentUser = data.user;
      state.sessionStatus = data.status;
      localStorage.setItem(LS_SESSION, data.token);
      if (data.status === "approved") {
        toast("Welcome back to Primus Pix!", "success");
        enterStudentApp();
      } else {
        toast("Sign-in request submitted! Waiting for admin approval.", "success");
        enterPendingView("pending");
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });

  // Pending View Actions
  $("check-status-btn").addEventListener("click", () => pollPendingStatus(true));
  $("cancel-pending-btn").addEventListener("click", async () => {
    if (state.sessionToken) {
      try {
        await api("/api/auth/logout", { method: "POST", auth: "student" });
      } catch {
        // ignore
      }
    }
    clearStudentSession();
    stopTimers();
    showOnly("view-login");
  });

  // Student Logout
  $("student-logout-btn").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST", auth: "student" });
    } catch {
      // ignore
    }
    clearStudentSession();
    stopTimers();
    toast("Signed out. You can sign right back in anytime.");
    showOnly("view-login");
  });

  // Admin Email Magic-Link Modal Triggers
  function triggerAdminAccess() {
    if (state.adminToken) {
      enterAdminDashboard();
    } else {
      const statusEl = $("admin-link-status");
      if (statusEl) {
        statusEl.textContent = "";
        statusEl.classList.add("hidden");
      }
      const btn = $("admin-request-link-btn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Send Admin Access Link to Email";
      }
      $("modal-admin-login").classList.remove("hidden");
    }
  }

  $("open-admin-login-btn").addEventListener("click", triggerAdminAccess);
  $("pending-admin-btn").addEventListener("click", triggerAdminAccess);
  $("app-admin-btn").addEventListener("click", triggerAdminAccess);
  $("close-admin-login").addEventListener("click", () => $("modal-admin-login").classList.add("hidden"));

  $("admin-request-link-btn").addEventListener("click", async () => {
    const btn = $("admin-request-link-btn");
    const statusEl = $("admin-link-status");
    btn.disabled = true;
    btn.textContent = "Sending email link...";
    try {
      const data = await api("/api/admin/request-link", { method: "POST" });
      statusEl.textContent = data.message || "One-time Admin Access Link sent! Check your email and click the link within 10 minutes.";
      statusEl.classList.remove("hidden");
      btn.textContent = "Resend Admin Access Link";
      btn.disabled = false;
      toast("Admin access link emailed!", "success");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Send Admin Access Link to Email";
      toast(err.message, "error");
    }
  });

  $("admin-refresh-btn").addEventListener("click", () => {
    refreshAdminData(true);
    toast("Refreshed.");
  });

  $("admin-back-student-btn").addEventListener("click", () => {
    state.inAdminView = false;
    boot();
  });

  $("admin-logout-btn").addEventListener("click", async () => {
    try {
      await api("/api/admin/logout", { method: "POST", auth: "admin" });
    } catch {
      // ignore
    }
    state.adminToken = null;
    state.inAdminView = false;
    localStorage.removeItem(LS_ADMIN);
    toast("Signed out of Admin Panel.");
    boot();
  });

  // Admin Tabs & Actions Delegation
  document.querySelectorAll("[data-admtab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.adminTab = btn.dataset.admtab;
      if (state.adminTab === "email" || state.adminTab === "notices" || state.adminTab === "poll") {
        refreshAdminData(true);
      } else {
        renderAdminOverview();
      }
    });
  });

  $("admin-tab-content").addEventListener("click", async (e) => {
    const approveBtn = e.target.closest("[data-adm-approve]");
    const denyBtn = e.target.closest("[data-adm-deny]");
    const revokeBtn = e.target.closest("[data-adm-revoke]");
    const banBtn = e.target.closest("[data-adm-ban]");
    const delPostBtn = e.target.closest("[data-adm-del-post]");
    const editNoticeBtn = e.target.closest("[data-adm-edit-notice]");
    const delNoticeBtn = e.target.closest("[data-adm-del-notice]");
    const noticeClassBtn = e.target.closest("[data-adm-notice-class]");
    const editPollBtn = e.target.closest("[data-adm-edit-poll]");
    const delPollBtn = e.target.closest("[data-adm-del-poll]");

    try {
      if (noticeClassBtn) {
        state.editingNoticeId = null;
        state.prefillNoticeClass = noticeClassBtn.dataset.admNoticeClass;
        state.adminTab = "notices";
        renderAdminOverview();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (editPollBtn) {
        state.editingPollId = Number(editPollBtn.dataset.admEditPoll);
        renderAdminOverview();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (delPollBtn) {
        const pid = Number(delPollBtn.dataset.admDelPoll);
        await api(`/api/admin/polls/${pid}`, { method: "DELETE", auth: "admin" });
        if (state.editingPollId === pid) state.editingPollId = null;
        toast("Poll deleted.");
        refreshAdminData(true);
      } else if (approveBtn) {
        await api(`/api/admin/sessions/${approveBtn.dataset.admApprove}/approve`, { method: "POST", auth: "admin" });
        toast("Sign-in allowed!", "success");
        refreshAdminData();
      } else if (denyBtn) {
        await api(`/api/admin/sessions/${denyBtn.dataset.admDeny}/deny`, { method: "POST", auth: "admin" });
        toast("Sign-in denied.", "error");
        refreshAdminData();
      } else if (revokeBtn) {
        await api(`/api/admin/sessions/${revokeBtn.dataset.admRevoke}/revoke`, { method: "POST", auth: "admin" });
        toast("Session revoked.");
        refreshAdminData();
      } else if (banBtn) {
        const isBanned = banBtn.dataset.banVal === "true";
        await api(`/api/admin/users/${banBtn.dataset.admBan}/ban`, {
          method: "POST",
          auth: "admin",
          json: { is_banned: isBanned },
        });
        toast(isBanned ? "Student banned and sessions revoked." : "Student unbanned.", isBanned ? "error" : "success");
        refreshAdminData();
      } else if (delPostBtn) {
        await api(`/api/admin/posts/${delPostBtn.dataset.admDelPost}`, { method: "DELETE", auth: "admin" });
        toast("Post deleted.");
        refreshAdminData();
      } else if (editNoticeBtn) {
        state.editingNoticeId = Number(editNoticeBtn.dataset.admEditNotice);
        renderAdminOverview();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (delNoticeBtn) {
        const nid = Number(delNoticeBtn.dataset.admDelNotice);
        await api(`/api/admin/notices/${nid}`, { method: "DELETE", auth: "admin" });
        if (state.editingNoticeId === nid) state.editingNoticeId = null;
        toast("Notice deleted.");
        refreshAdminData(true);
      }
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // Navigation & Feed Filtering
  $("nav-home-btn").addEventListener("click", showFeedMode);
  $("back-to-feed-btn").addEventListener("click", showFeedMode);
  $("nav-my-profile-btn").addEventListener("click", () => {
    if (state.currentUser) loadUserProfile(state.currentUser.id);
  });

  document.querySelectorAll("#feed-controls .tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#feed-controls .tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.filterType = btn.dataset.type;
      loadFeed();
    });
  });

  $("class-filter").addEventListener("change", (e) => {
    state.filterClass = e.target.value;
    loadFeed();
  });

  $("search-input").addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      if (state.viewingProfileId) {
        showFeedMode();
      } else {
        loadFeed();
      }
    }, 260);
  });

  // Composer Events
  if ($("open-composer-btn")) $("open-composer-btn").addEventListener("click", () => openComposer("vlog"));
  if ($("fb-tab-home")) $("fb-tab-home").addEventListener("click", showFeedMode);
  if ($("qp-open-any")) $("qp-open-any").addEventListener("click", () => openComposer("pic"));
  if ($("qp-open-story")) $("qp-open-story").addEventListener("click", openStoryComposer);
  if ($("qp-take-photo-btn")) {
    $("qp-take-photo-btn").addEventListener("click", () => {
      openComposer("pic");
      openCameraFor("post");
    });
  }
  document.querySelectorAll("[data-quick-post]").forEach((btn) => {
    btn.addEventListener("click", () => openComposer(btn.dataset.quickPost));
  });
  $("close-composer").addEventListener("click", closeComposer);
  $("cancel-composer").addEventListener("click", closeComposer);

  document.querySelectorAll(".type-pill").forEach((btn) => {
    btn.addEventListener("click", () => setComposerType(btn.dataset.ctype));
  });

  $("post-media").addEventListener("change", (e) => {
    const file = e.target.files[0];
    const preview = $("media-preview");
    if (!file) {
      preview.classList.add("hidden");
      preview.innerHTML = "";
      return;
    }
    $("file-drop-text").textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`;
    const url = URL.createObjectURL(file);
    preview.classList.remove("hidden");
    if (file.type.startsWith("video/")) {
      preview.innerHTML = `<video src="${url}" controls muted></video>`;
    } else {
      preview.innerHTML = `<img src="${url}" alt="Preview" />`;
    }
  });

  $("composer-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("submit-post-btn");
    btn.disabled = true;
    btn.textContent = "Uploading...";

    try {
      const formData = new FormData();
      formData.append("post_type", state.composerType);
      formData.append("audience", state.postAudience);
      formData.append("title", $("post-title").value);
      formData.append("content", $("post-content").value);
      const file = $("post-media").files[0] || state.capturedPostFile;
      if (file) formData.append("media", file);

      await api("/api/posts", {
        method: "POST",
        auth: "student",
        body: formData,
      });

      state.capturedPostFile = null;
      closeComposer();
      celebrateXP(50, state.postAudience === "close_friends" ? "⭐ Close Friends post published!" : "Post published!");
      if ($("section-close-friends") && !$("section-close-friends").classList.contains("hidden")) {
        loadCloseFriendsFeed();
      } else if (state.viewingProfileId) {
        loadUserProfile(state.viewingProfileId);
      } else {
        loadFeed();
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Publish Post";
    }
  });

  // Feed Event Delegation (Likes, Comments, Profiles, Delete, Lightbox)
  $("feed-list").addEventListener("click", async (e) => {
    const profileTrigger = e.target.closest("[data-profile-id]");
    if (profileTrigger) {
      loadUserProfile(Number(profileTrigger.dataset.profileId));
      return;
    }

    const lightboxImg = e.target.closest("[data-lightbox]");
    if (lightboxImg) {
      $("lightbox-img").src = lightboxImg.dataset.lightbox;
      $("modal-lightbox").classList.remove("hidden");
      return;
    }

    const rxBtn = e.target.closest("[data-react-post]");
    if (rxBtn) {
      const postId = Number(rxBtn.dataset.reactPost);
      const emoji = rxBtn.dataset.reactEmoji;
      try {
        const res = await api(`/api/posts/${postId}/react`, {
          method: "POST",
          auth: "student",
          json: { emoji },
        });
        const bar = $(`rx-bar-${postId}`);
        if (bar) {
          const mySet = new Set(res.my_reactions || []);
          bar.innerHTML = ["🔥", "💖", "😂", "🤯", "👏"]
            .map((em) => {
              const cnt = (res.reactions && res.reactions[em]) || 0;
              return `<button type="button" class="rx-btn ${mySet.has(em) ? "active" : ""}" data-react-post="${postId}" data-react-emoji="${em}">${em}<span>${cnt > 0 ? cnt : ""}</span></button>`;
            })
            .join("");
        }
        if (res.xp_earned > 0) celebrateXP(res.xp_earned, `Reacted ${emoji}`);
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }

    const likeBtn = e.target.closest("[data-like-post]");
    if (likeBtn) {
      const postId = Number(likeBtn.dataset.likePost);
      try {
        const res = await api(`/api/posts/${postId}/like`, { method: "POST", auth: "student" });
        likeBtn.classList.toggle("liked", res.liked);
        likeBtn.querySelector("span:first-child").textContent = res.liked ? "♥" : "♡";
        likeBtn.querySelector(`[data-like-count="${postId}"]`).textContent = res.like_count;
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }

    const toggleCommentsBtn = e.target.closest("[data-toggle-comments]");
    if (toggleCommentsBtn) {
      const postId = Number(toggleCommentsBtn.dataset.toggleComments);
      const box = $(`comments-box-${postId}`);
      if (state.openComments.has(postId)) {
        state.openComments.delete(postId);
        box.classList.add("hidden");
      } else {
        state.openComments.add(postId);
        box.classList.remove("hidden");
        loadComments(postId);
      }
      return;
    }

    const delPostBtn = e.target.closest("[data-delete-post]");
    if (delPostBtn) {
      const postId = Number(delPostBtn.dataset.deletePost);
      try {
        await api(`/api/posts/${postId}`, { method: "DELETE", auth: "student" });
        toast("Post deleted.");
        if (state.viewingProfileId) loadUserProfile(state.viewingProfileId);
        else loadFeed();
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }

    const delCommentBtn = e.target.closest("[data-delete-comment]");
    if (delCommentBtn) {
      const commentId = Number(delCommentBtn.dataset.deleteComment);
      const postId = Number(delCommentBtn.dataset.parentPost);
      try {
        await api(`/api/comments/${commentId}`, { method: "DELETE", auth: "student" });
        loadComments(postId);
        const countEl = document.querySelector(`[data-comment-count="${postId}"]`);
        if (countEl) countEl.textContent = Math.max(0, Number(countEl.textContent) - 1);
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });

  $("feed-list").addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-comment-form]");
    if (!form) return;
    e.preventDefault();
    const postId = Number(form.dataset.commentForm);
    const input = form.querySelector("input");
    const body = input.value.trim();
    if (!body) return;
    try {
      await api(`/api/posts/${postId}/comments`, {
        method: "POST",
        auth: "student",
        json: { body },
      });
      input.value = "";
      loadComments(postId);
      const countEl = document.querySelector(`[data-comment-count="${postId}"]`);
      if (countEl) countEl.textContent = Number(countEl.textContent) + 1;
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // Stories Events
  $("stories-bar").addEventListener("click", (e) => {
    const item = e.target.closest("[data-view-story]");
    if (item) openStoryViewer(Number(item.dataset.viewStory));
  });

  $("close-story-composer").addEventListener("click", closeStoryComposer);
  $("cancel-story-composer").addEventListener("click", closeStoryComposer);
  $("close-story-viewer").addEventListener("click", closeStoryViewer);
  $("modal-story-viewer").addEventListener("click", (e) => {
    if (e.target === $("modal-story-viewer")) closeStoryViewer();
  });

  document.querySelectorAll("[data-stype]").forEach((btn) => {
    btn.addEventListener("click", () => setStoryType(btn.dataset.stype));
  });

  $("story-swatches").addEventListener("click", (e) => {
    const sw = e.target.closest(".swatch");
    if (!sw) return;
    document.querySelectorAll("#story-swatches .swatch").forEach((s) => s.classList.remove("active"));
    sw.classList.add("active");
    state.storyBgColor = sw.dataset.color;
  });

  $("story-media").addEventListener("change", (e) => {
    const file = e.target.files[0];
    const preview = $("story-preview");
    if (!file) {
      preview.classList.add("hidden");
      preview.innerHTML = "";
      return;
    }
    $("story-drop-text").textContent = file.name;
    const url = URL.createObjectURL(file);
    preview.classList.remove("hidden");
    if (file.type.startsWith("video/")) {
      preview.innerHTML = `<video src="${url}" controls muted></video>`;
    } else {
      preview.innerHTML = `<img src="${url}" alt="Story preview" />`;
    }
  });

  $("story-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("submit-story-btn");
    btn.disabled = true;
    btn.textContent = "Sharing...";
    try {
      const fd = new FormData();
      fd.append("story_type", state.storyType);
      fd.append("caption", $("story-caption").value);
      fd.append("bg_color", state.storyBgColor);
      fd.append("audience", state.storyAudience);
      const file = $("story-media").files[0] || state.capturedStoryFile;
      if (file) fd.append("media", file);
      await api("/api/stories", { method: "POST", auth: "student", body: fd });
      state.capturedStoryFile = null;
      closeStoryComposer();
      celebrateXP(30, state.storyAudience === "close_friends" ? "Close Friends Story shared!" : "24h Story live!");
      loadStories();
      if ($("section-close-friends") && !$("section-close-friends").classList.contains("hidden")) {
        loadCloseFriendsFeed();
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Share Story";
    }
  });

  $("sv-delete-btn").addEventListener("click", async () => {
    if (!state.activeStory) return;
    try {
      await api(`/api/stories/${state.activeStory.id}`, { method: "DELETE", auth: "student" });
      closeStoryViewer();
      toast("Story deleted.");
      loadStories();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // Texting removed per user request

  // Gamification: Polls, Quests & Leaderboard Events
  if ($("qp-open-poll")) $("qp-open-poll").addEventListener("click", openPollModal);
  if ($("close-poll-modal")) $("close-poll-modal").addEventListener("click", closePollModal);
  if ($("cancel-poll-modal")) $("cancel-poll-modal").addEventListener("click", closePollModal);

  if ($("poll-form")) {
    $("poll-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const question = $("poll-question").value.trim();
      const options = Array.from(document.querySelectorAll(".poll-opt-input"))
        .map((i) => i.value.trim())
        .filter(Boolean);
      try {
        await api("/api/polls", {
          method: "POST",
          auth: "student",
          json: { question, options },
        });
        closePollModal();
        celebrateXP(35, "Campus Poll launched!");
        loadPolls();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  if ($("poll-stage")) {
    $("poll-stage").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-vote-poll]");
      if (!btn) return;
      const pollId = Number(btn.dataset.votePoll);
      const optIdx = Number(btn.dataset.voteOpt);
      try {
        const res = await api(`/api/polls/${pollId}/vote`, {
          method: "POST",
          auth: "student",
          json: { option_index: optIdx },
        });
        if (res.xp_earned > 0) celebrateXP(res.xp_earned, "Voted in Campus Poll!");
        loadPolls();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  if ($("daily-quest-list")) {
    $("daily-quest-list").addEventListener("click", (e) => {
      const item = e.target.closest("[data-quest-action]");
      if (!item || item.classList.contains("done")) return;
      const act = item.dataset.questAction;
      if (act === "post") openComposer("pic");
      else if (act === "story") openStoryComposer();
      else if (act === "chat") openChatMode();
      else if (act === "poll" && $("poll-stage")) $("poll-stage").scrollIntoView({ behavior: "smooth" });
      else if (act === "react" && $("feed-list")) $("feed-list").scrollIntoView({ behavior: "smooth" });
    });
  }

  if ($("leaderboard-list")) {
    $("leaderboard-list").addEventListener("click", (e) => {
      const row = e.target.closest("[data-lb-profile]");
      if (row) loadUserProfile(Number(row.dataset.lbProfile));
    });
  }

  // Edit Profile Modal (Avatar, Bio & 14-Day Display Name)
  function openEditProfileModal() {
    if (!state.currentUser) return;
    const u = state.currentUser;
    $("edit-profile-form").reset();
    $("edit-avatar-preview").innerHTML = renderAvatar(u.avatar_url, u.name);
    $("edit-display-name").value = u.name || "";
    $("edit-bio").value = u.bio || "";

    const nameInput = $("edit-display-name");
    const hint = $("edit-name-cooldown-hint");
    if (u.can_change_name === false) {
      nameInput.disabled = true;
      const d = u.days_remaining || 14;
      hint.textContent = `Display name locked — next change available in ${d} day${d === 1 ? "" : "s"}.`;
      hint.classList.add("locked");
    } else {
      nameInput.disabled = false;
      hint.textContent = "Available now. Once changed, you'll wait 14 days before changing it again.";
      hint.classList.remove("locked");
    }
    $("modal-edit-profile").classList.remove("hidden");
  }

  function closeEditProfileModal() {
    $("modal-edit-profile").classList.add("hidden");
  }

  if ($("open-edit-profile-btn")) $("open-edit-profile-btn").addEventListener("click", openEditProfileModal);
  if ($("close-edit-profile")) $("close-edit-profile").addEventListener("click", closeEditProfileModal);
  if ($("cancel-edit-profile")) $("cancel-edit-profile").addEventListener("click", closeEditProfileModal);

  if ($("edit-avatar-input")) {
    $("edit-avatar-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      $("edit-avatar-preview").innerHTML = `<img src="${url}" alt="Avatar preview" />`;
    });
  }

  if ($("edit-profile-form")) {
    $("edit-profile-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("save-profile-btn");
      btn.disabled = true;
      btn.textContent = "Saving...";
      try {
        const fd = new FormData();
        if (!$("edit-display-name").disabled) {
          fd.append("display_name", $("edit-display-name").value);
        }
        fd.append("bio", $("edit-bio").value);
        const file = $("edit-avatar-input").files[0];
        if (file) fd.append("avatar", file);

        const res = await api("/api/profile/me", {
          method: "POST",
          auth: "student",
          body: fd,
        });
        state.currentUser = res.user;
        syncMyNavIdentity();
        closeEditProfileModal();
        toast("Profile updated!", "success");
        if (state.viewingProfileId) {
          loadUserProfile(state.viewingProfileId);
        } else {
          loadFeed();
        }
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Save Profile";
      }
    });
  }

  // ---------- Story Audience Toggle ----------
  document.querySelectorAll("[data-story-aud]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.storyAudience = btn.dataset.storyAud;
      document.querySelectorAll("[data-story-aud]").forEach((b) => {
        b.classList.toggle("active", b.dataset.storyAud === state.storyAudience);
      });
    });
  });

  // ---------- Dedicated Close Friends Page ----------
  let cfAllFriends = [];

  async function openCloseFriendsPage() {
    state.inChatView = false;
    state.viewingProfileId = null;
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
    showOnlyStudentSection("section-close-friends");
    setActiveNavTab("nav-close-friends-btn");
    await Promise.all([loadCloseFriendsList(), loadCloseFriendsFeed()]);
  }

  async function loadCloseFriendsList() {
    const list = $("cf-page-friends-list");
    if (!list) return;
    list.innerHTML = `<p class="muted small">Loading classmates...</p>`;
    try {
      const data = await api("/api/close-friends", { auth: "student" });
      cfAllFriends = data.friends || [];
      renderCloseFriendsList();
    } catch (err) {
      list.innerHTML = `<p class="muted small">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderCloseFriendsList() {
    const list = $("cf-page-friends-list");
    if (!list) return;
    const q = ($("cf-search-input") ? $("cf-search-input").value : "").trim().toLowerCase();
    const selectedCount = cfAllFriends.filter((f) => f.is_close_friend).length;
    if ($("cf-count-pill")) $("cf-count-pill").textContent = `${selectedCount} selected`;

    const filtered = cfAllFriends.filter(
      (f) => !q || f.name.toLowerCase().includes(q) || (f.class_name || "").toLowerCase().includes(q) || (f.reg_number || "").toLowerCase().includes(q)
    );

    if (!filtered.length) {
      list.innerHTML = `<p class="muted small">No classmates found.</p>`;
      return;
    }

    list.innerHTML = filtered
      .map(
        (f) => `
        <div class="cf-row">
          <div style="display:flex;align-items:center;gap:10px;min-width:0;cursor:pointer;" data-cf-profile="${f.id}">
            <div class="post-avatar" style="width:36px;height:36px;font-size:0.84rem;">${renderAvatar(f.avatar_url, f.name)}</div>
            <div style="min-width:0;">
              <div style="font-weight:700;font-size:0.86rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(f.name)}</div>
              <div class="muted" style="font-size:0.74rem;">${escapeHtml(f.class_name)}</div>
            </div>
          </div>
          <button type="button" class="btn btn-sm ${f.is_close_friend ? "btn-success" : "btn-ghost"}" data-toggle-cf="${f.id}">
            ${f.is_close_friend ? "⭐ Added" : "+ Add"}
          </button>
        </div>
      `
      )
      .join("");
  }

  async function loadCloseFriendsFeed() {
    const stBar = $("cf-page-stories-bar");
    const flBar = $("cf-page-flashes-bar");
    const postsEl = $("cf-page-posts-list");
    try {
      const [stData, flData, pData] = await Promise.all([
        api("/api/stories", { auth: "student" }),
        api("/api/flashes", { auth: "student" }),
        api("/api/posts?audience=close_friends", { auth: "student" }),
      ]);
      state.stories = stData.stories || [];
      state.flashes = flData.flashes || [];
      const cfPosts = pData.posts || [];

      if (postsEl) {
        if (!cfPosts.length) {
          postsEl.innerHTML = `
            <div class="empty-state">
              <h3>No Close Friends posts yet ⭐</h3>
              <p>Click <strong>+ Close Friends Post</strong> above to share a private video or blog just with your inner circle!</p>
            </div>
          `;
        } else {
          postsEl.innerHTML = cfPosts.map((p) => renderPostCard(p)).join("");
        }
      }

      const cfStories = state.stories.filter((s) => s.audience === "close_friends");
      const cfFlashes = state.flashes.filter((f) => f.audience === "close_friends");

      if (stBar) {
        const addBtn = `
          <button type="button" class="fb-story-card create-card" id="cf-add-story-card" style="border-color:#22c55e;">
            <div class="fb-story-create-top" style="background:linear-gradient(135deg,#dcfce7,#bbf7d0);color:#15803d;">+</div>
            <div class="fb-story-create-bottom">New CF Story</div>
          </button>
        `;
        const cards = cfStories
          .map((st) => {
            const bgHtml =
              st.story_type === "image" && st.media_url
                ? `<img class="fb-story-bg" src="${escapeHtml(st.media_url)}" alt="Story" />`
                : st.story_type === "video"
                ? `<div class="fb-story-text-preview" style="background:#111827;color:#fff;font-size:1.8rem;">▶</div>`
                : `<div class="fb-story-text-preview" style="background:${escapeHtml(st.bg_color || "#dcfce7")};">${escapeHtml(st.caption.slice(0, 48))}</div>`;
            return `
              <button type="button" class="fb-story-card close-friends" data-view-story="${st.id}">
                ${bgHtml}
                <div class="fb-story-avatar-ring">${renderAvatar(st.author_avatar, st.author_name)}</div>
                <span class="fb-story-cf-star">⭐ CF</span>
                <div class="fb-story-name">${escapeHtml(st.author_name)}</div>
              </button>
            `;
          })
          .join("");
        stBar.innerHTML = addBtn + cards;
        const addCard = $("cf-add-story-card");
        if (addCard) addCard.addEventListener("click", openCfStoryComposer);
      }

      if (flBar) {
        if (!cfFlashes.length) {
          flBar.innerHTML = `<p class="muted small" style="margin:4px 0;">No Close Friends Flashes yet — hit <strong>⚡ Close Friends Flash</strong> above to share one privately!</p>`;
        } else {
          flBar.innerHTML = cfFlashes
            .map((f) => {
              const isMine = state.currentUser && f.user_id === state.currentUser.id;
              return `
                <div class="flash-chip close-friends">
                  <div class="flash-chip-head">
                    <div class="avatar-chip" style="width:24px;height:24px;font-size:0.7rem;">${renderAvatar(f.author_avatar, f.author_name)}</div>
                    <div style="min-width:0;flex:1;">
                      <div class="flash-chip-name">${escapeHtml(f.author_name)}</div>
                      <div class="muted" style="font-size:0.68rem;">⭐ Close Friends &bull; ${timeAgo(f.created_at)}</div>
                    </div>
                    ${isMine ? `<button type="button" class="icon-btn" style="width:22px;height:22px;font-size:0.9rem;" data-del-flash="${f.id}">&times;</button>` : ""}
                  </div>
                  ${f.media_url ? `<img class="flash-chip-img" src="${escapeHtml(f.media_url)}" alt="Flash" data-lightbox="${escapeHtml(f.media_url)}" />` : ""}
                  ${f.text ? `<div class="flash-chip-text">${escapeHtml(f.text)}</div>` : ""}
                </div>
              `;
            })
            .join("");
        }
      }
    } catch {
      // ignore
    }
  }

  function openCfStoryComposer() {
    openStoryComposer();
    state.storyAudience = "close_friends";
    document.querySelectorAll("[data-story-aud]").forEach((b) => {
      b.classList.toggle("active", b.dataset.storyAud === "close_friends");
    });
  }

  function openCfFlashComposer() {
    openFlashModal();
    state.flashAudience = "close_friends";
    document.querySelectorAll("[data-flash-aud]").forEach((b) => {
      b.classList.toggle("active", b.dataset.flashAud === "close_friends");
    });
  }

  document.querySelectorAll("[data-post-aud]").forEach((btn) => {
    btn.addEventListener("click", () => setPostAudience(btn.dataset.postAud));
  });

  if ($("nav-close-friends-btn")) $("nav-close-friends-btn").addEventListener("click", openCloseFriendsPage);
  if ($("stories-manage-cf-btn")) $("stories-manage-cf-btn").addEventListener("click", openCloseFriendsPage);
  if ($("cf-back-home-btn")) $("cf-back-home-btn").addEventListener("click", showFeedMode);
  if ($("cf-page-new-post-btn")) $("cf-page-new-post-btn").addEventListener("click", () => openComposer("vlog", "close_friends"));
  if ($("cf-page-new-story-btn")) $("cf-page-new-story-btn").addEventListener("click", openCfStoryComposer);
  if ($("cf-page-new-flash-btn")) $("cf-page-new-flash-btn").addEventListener("click", openCfFlashComposer);
  if ($("cf-search-input")) $("cf-search-input").addEventListener("input", renderCloseFriendsList);

  if ($("cf-page-posts-list")) {
    $("cf-page-posts-list").addEventListener("click", async (e) => {
      const profileTrigger = e.target.closest("[data-profile-id]");
      if (profileTrigger) {
        loadUserProfile(Number(profileTrigger.dataset.profileId));
        return;
      }
      const likeBtn = e.target.closest("[data-like-post]");
      if (likeBtn) {
        const postId = Number(likeBtn.dataset.likePost);
        try {
          const res = await api(`/api/posts/${postId}/like`, { method: "POST", auth: "student" });
          likeBtn.classList.toggle("liked", res.liked);
          likeBtn.querySelector("span:first-child").textContent = res.liked ? "♥" : "♡";
          likeBtn.querySelector(`[data-like-count="${postId}"]`).textContent = res.like_count;
        } catch (err) {
          toast(err.message, "error");
        }
        return;
      }
      const toggleCommentsBtn = e.target.closest("[data-toggle-comments]");
      if (toggleCommentsBtn) {
        const postId = Number(toggleCommentsBtn.dataset.toggleComments);
        const box = $(`comments-box-${postId}`);
        if (state.openComments.has(postId)) {
          state.openComments.delete(postId);
          if (box) box.classList.add("hidden");
        } else {
          state.openComments.add(postId);
          if (box) box.classList.remove("hidden");
          loadComments(postId);
        }
        return;
      }
      const delPostBtn = e.target.closest("[data-delete-post]");
      if (delPostBtn) {
        try {
          await api(`/api/posts/${delPostBtn.dataset.deletePost}`, { method: "DELETE", auth: "student" });
          toast("Post deleted.");
          loadCloseFriendsFeed();
        } catch (err) {
          toast(err.message, "error");
        }
        return;
      }
      const delCommentBtn = e.target.closest("[data-delete-comment]");
      if (delCommentBtn) {
        const commentId = Number(delCommentBtn.dataset.deleteComment);
        const postId = Number(delCommentBtn.dataset.parentPost);
        try {
          await api(`/api/comments/${commentId}`, { method: "DELETE", auth: "student" });
          loadComments(postId);
        } catch (err) {
          toast(err.message, "error");
        }
      }
    });

    $("cf-page-posts-list").addEventListener("submit", async (e) => {
      const form = e.target.closest("[data-comment-form]");
      if (!form) return;
      e.preventDefault();
      const postId = Number(form.dataset.commentForm);
      const input = form.querySelector("input");
      const body = input.value.trim();
      if (!body) return;
      try {
        await api(`/api/posts/${postId}/comments`, {
          method: "POST",
          auth: "student",
          json: { body },
        });
        input.value = "";
        loadComments(postId);
        const countEl = $("cf-page-posts-list").querySelector(`[data-comment-count="${postId}"]`);
        if (countEl) countEl.textContent = Number(countEl.textContent) + 1;
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  if ($("cf-page-stories-bar")) {
    $("cf-page-stories-bar").addEventListener("click", (e) => {
      const item = e.target.closest("[data-view-story]");
      if (item) openStoryViewer(Number(item.dataset.viewStory));
    });
  }

  if ($("cf-page-flashes-bar")) {
    $("cf-page-flashes-bar").addEventListener("click", async (e) => {
      const delBtn = e.target.closest("[data-del-flash]");
      if (delBtn) {
        try {
          await api(`/api/flashes/${delBtn.dataset.delFlash}`, { method: "DELETE", auth: "student" });
          toast("Flash deleted.");
          loadCloseFriendsFeed();
        } catch (err) {
          toast(err.message, "error");
        }
        return;
      }
      const img = e.target.closest("[data-lightbox]");
      if (img) {
        $("lightbox-img").src = img.dataset.lightbox;
        $("modal-lightbox").classList.remove("hidden");
      }
    });
  }

  if ($("cf-page-friends-list")) {
    $("cf-page-friends-list").addEventListener("click", async (e) => {
      const prof = e.target.closest("[data-cf-profile]");
      if (prof && !e.target.closest("[data-toggle-cf]")) {
        loadUserProfile(Number(prof.dataset.cfProfile));
        return;
      }
      const btn = e.target.closest("[data-toggle-cf]");
      if (!btn) return;
      const fid = Number(btn.dataset.toggleCf);
      try {
        const res = await api(`/api/close-friends/${fid}`, { method: "POST", auth: "student" });
        const target = cfAllFriends.find((f) => f.id === fid);
        if (target) target.is_close_friend = res.is_close_friend ? 1 : 0;
        renderCloseFriendsList();
        toast(res.is_close_friend ? "Added to Close Friends!" : "Removed from Close Friends.");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  // ---------- Flashes (Instant Snaps & Quick Vibes) ----------
  function openFlashModal() {
    $("flash-form").reset();
    state.capturedFlashFile = null;
    state.flashAudience = "all";
    document.querySelectorAll("[data-flash-aud]").forEach((b) => {
      b.classList.toggle("active", b.dataset.flashAud === "all");
    });
    $("flash-drop-text").textContent = "Tap to pick a quick photo, or hit Snap Live above";
    $("flash-preview").innerHTML = "";
    $("flash-preview").classList.add("hidden");
    $("modal-flash").classList.remove("hidden");
  }

  function closeFlashModal() {
    $("modal-flash").classList.add("hidden");
  }

  if ($("open-flash-composer-btn")) $("open-flash-composer-btn").addEventListener("click", openFlashModal);
  if ($("nav-flash-btn")) $("nav-flash-btn").addEventListener("click", openFlashModal);
  if ($("close-flash-modal")) $("close-flash-modal").addEventListener("click", closeFlashModal);
  if ($("cancel-flash-modal")) $("cancel-flash-modal").addEventListener("click", closeFlashModal);

  document.querySelectorAll("[data-flash-aud]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.flashAudience = btn.dataset.flashAud;
      document.querySelectorAll("[data-flash-aud]").forEach((b) => {
        b.classList.toggle("active", b.dataset.flashAud === state.flashAudience);
      });
    });
  });

  if ($("flash-media")) {
    $("flash-media").addEventListener("change", (e) => {
      const file = e.target.files[0];
      const preview = $("flash-preview");
      if (!file) {
        preview.classList.add("hidden");
        preview.innerHTML = "";
        return;
      }
      state.capturedFlashFile = null;
      $("flash-drop-text").textContent = file.name;
      const url = URL.createObjectURL(file);
      preview.classList.remove("hidden");
      preview.innerHTML = `<img src="${url}" alt="Flash preview" />`;
    });
  }

  if ($("flash-form")) {
    $("flash-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("submit-flash-btn");
      btn.disabled = true;
      btn.textContent = "Posting...";
      try {
        const fd = new FormData();
        fd.append("text", $("flash-text").value);
        fd.append("audience", state.flashAudience);
        const file = $("flash-media").files[0] || state.capturedFlashFile;
        if (file) fd.append("media", file);
        await api("/api/flashes", { method: "POST", auth: "student", body: fd });
        state.capturedFlashFile = null;
        closeFlashModal();
        toast("⚡ Flash dropped for 24h!", "success");
        loadFlashes();
        if ($("section-close-friends") && !$("section-close-friends").classList.contains("hidden")) {
          loadCloseFriendsFeed();
        }
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "⚡ Post Flash";
      }
    });
  }

  if ($("flashes-bar")) {
    $("flashes-bar").addEventListener("click", async (e) => {
      const delBtn = e.target.closest("[data-del-flash]");
      if (delBtn) {
        try {
          await api(`/api/flashes/${delBtn.dataset.delFlash}`, { method: "DELETE", auth: "student" });
          toast("Flash deleted.");
          loadFlashes();
        } catch (err) {
          toast(err.message, "error");
        }
        return;
      }
      const img = e.target.closest("[data-lightbox]");
      if (img) {
        $("lightbox-img").src = img.dataset.lightbox;
        $("modal-lightbox").classList.remove("hidden");
      }
    });
  }

  // ---------- Live In-App Camera ----------
  let activeCameraStream = null;
  let pendingCameraBlob = null;

  function stopCameraStream() {
    if (activeCameraStream) {
      activeCameraStream.getTracks().forEach((t) => t.stop());
      activeCameraStream = null;
    }
  }

  async function openCameraFor(target) {
    state.cameraTarget = target;
    pendingCameraBlob = null;
    $("camera-error").classList.add("hidden");
    $("camera-video").classList.remove("hidden");
    $("camera-captured-img").classList.add("hidden");
    $("camera-capture-btn").classList.remove("hidden");
    $("camera-retake-btn").classList.add("hidden");
    $("camera-use-btn").classList.add("hidden");
    $("modal-camera").classList.remove("hidden");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $("camera-error").textContent = "Camera access is not supported in this browser. You can still upload a photo directly.";
      $("camera-error").classList.remove("hidden");
      $("camera-capture-btn").classList.add("hidden");
      return;
    }

    try {
      activeCameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      $("camera-video").srcObject = activeCameraStream;
    } catch (err) {
      $("camera-error").textContent = "Camera permission denied or no camera found. Allow camera access in your browser settings to snap live photos.";
      $("camera-error").classList.remove("hidden");
      $("camera-capture-btn").classList.add("hidden");
    }
  }

  function closeCameraModal() {
    stopCameraStream();
    pendingCameraBlob = null;
    $("modal-camera").classList.add("hidden");
  }

  if ($("composer-camera-btn")) $("composer-camera-btn").addEventListener("click", () => openCameraFor("post"));
  if ($("story-camera-btn")) $("story-camera-btn").addEventListener("click", () => openCameraFor("story"));
  if ($("flash-camera-btn")) $("flash-camera-btn").addEventListener("click", () => openCameraFor("flash"));
  if ($("close-camera-modal")) $("close-camera-modal").addEventListener("click", closeCameraModal);

  if ($("camera-capture-btn")) {
    $("camera-capture-btn").addEventListener("click", () => {
      const video = $("camera-video");
      const canvas = $("camera-canvas");
      if (!video.videoWidth) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          pendingCameraBlob = blob;
          const url = URL.createObjectURL(blob);
          $("camera-captured-img").src = url;
          $("camera-video").classList.add("hidden");
          $("camera-captured-img").classList.remove("hidden");
          $("camera-capture-btn").classList.add("hidden");
          $("camera-retake-btn").classList.remove("hidden");
          $("camera-use-btn").classList.remove("hidden");
        },
        "image/jpeg",
        0.92
      );
    });
  }

  if ($("camera-retake-btn")) {
    $("camera-retake-btn").addEventListener("click", () => {
      pendingCameraBlob = null;
      $("camera-captured-img").classList.add("hidden");
      $("camera-video").classList.remove("hidden");
      $("camera-capture-btn").classList.remove("hidden");
      $("camera-retake-btn").classList.add("hidden");
      $("camera-use-btn").classList.add("hidden");
    });
  }

  if ($("camera-use-btn")) {
    $("camera-use-btn").addEventListener("click", () => {
      if (!pendingCameraBlob) return;
      const file = new File([pendingCameraBlob], `camera_${Date.now()}.jpg`, { type: "image/jpeg" });
      const url = URL.createObjectURL(file);

      if (state.cameraTarget === "post") {
        state.capturedPostFile = file;
        $("post-media").value = "";
        $("file-drop-text").textContent = "📷 Camera photo captured!";
        $("media-preview").innerHTML = `<img src="${url}" alt="Captured photo" />`;
        $("media-preview").classList.remove("hidden");
      } else if (state.cameraTarget === "story") {
        state.capturedStoryFile = file;
        $("story-media").value = "";
        $("story-drop-text").textContent = "📷 Camera photo captured!";
        $("story-preview").innerHTML = `<img src="${url}" alt="Captured story" />`;
        $("story-preview").classList.remove("hidden");
      } else if (state.cameraTarget === "flash") {
        state.capturedFlashFile = file;
        $("flash-media").value = "";
        $("flash-drop-text").textContent = "📷 Camera photo captured!";
        $("flash-preview").innerHTML = `<img src="${url}" alt="Captured flash" />`;
        $("flash-preview").classList.remove("hidden");
      }
      closeCameraModal();
      toast("Photo ready to share!", "success");
    });
  }

  // ---------- Chat Silent Edit & Delete Handlers ----------
  if ($("chat-messages")) {
    $("chat-messages").addEventListener("click", async (e) => {
      const editBtn = e.target.closest("[data-edit-msg]");
      if (editBtn) {
        state.editingMessageId = Number(editBtn.dataset.editMsg);
        await loadChatMessages(true);
        const inp = $("chat-messages").querySelector(".msg-edit-form input");
        if (inp) {
          inp.focus();
          inp.select();
        }
        return;
      }

      const cancelBtn = e.target.closest("[data-cancel-edit-msg]");
      if (cancelBtn) {
        state.editingMessageId = null;
        loadChatMessages(true);
        return;
      }

      const delBtn = e.target.closest("[data-del-msg]");
      if (delBtn) {
        const mid = Number(delBtn.dataset.delMsg);
        try {
          await api(`/api/chat/messages/${mid}`, { method: "DELETE", auth: "student" });
          if (state.editingMessageId === mid) state.editingMessageId = null;
          await loadChatMessages(true);
          loadChatPeers();
        } catch (err) {
          toast(err.message, "error");
        }
      }
    });

    $("chat-messages").addEventListener("submit", async (e) => {
      const form = e.target.closest("[data-save-edit-msg]");
      if (!form) return;
      e.preventDefault();
      const mid = Number(form.dataset.saveEditMsg);
      const body = form.querySelector("input").value.trim();
      if (!body) return;
      try {
        await api(`/api/chat/messages/${mid}`, {
          method: "PUT",
          auth: "student",
          json: { body },
        });
        state.editingMessageId = null;
        await loadChatMessages(true);
        loadChatPeers();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  // ---------- Story Interactive Actions (Seen By, Like, Comment, Repost) ----------
  if ($("sv-viewers-btn")) {
    $("sv-viewers-btn").addEventListener("click", () => {
      $("sv-comments-drawer").classList.add("hidden");
      $("sv-viewers-drawer").classList.toggle("hidden");
    });
  }
  if ($("close-sv-viewers")) {
    $("close-sv-viewers").addEventListener("click", () => $("sv-viewers-drawer").classList.add("hidden"));
  }

  if ($("sv-comments-btn")) {
    $("sv-comments-btn").addEventListener("click", () => {
      $("sv-viewers-drawer").classList.add("hidden");
      $("sv-comments-drawer").classList.toggle("hidden");
      if (!$("sv-comments-drawer").classList.contains("hidden")) {
        $("sv-comment-input").focus();
      }
    });
  }
  if ($("close-sv-comments")) {
    $("close-sv-comments").addEventListener("click", () => $("sv-comments-drawer").classList.add("hidden"));
  }

  if ($("sv-like-btn")) {
    $("sv-like-btn").addEventListener("click", async () => {
      if (!state.activeStory) return;
      try {
        const res = await api(`/api/stories/${state.activeStory.id}/like`, {
          method: "POST",
          auth: "student",
        });
        $("sv-like-count").textContent = res.like_count;
        $("sv-like-heart").textContent = res.liked ? "♥" : "♡";
        $("sv-like-btn").classList.toggle("liked", !!res.liked);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  if ($("sv-comment-form")) {
    $("sv-comment-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!state.activeStory) return;
      const input = $("sv-comment-input");
      const body = input.value.trim();
      if (!body) return;
      try {
        await api(`/api/stories/${state.activeStory.id}/comments`, {
          method: "POST",
          auth: "student",
          json: { body },
        });
        input.value = "";
        await refreshActiveStoryMeta();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  if ($("sv-repost-btn")) {
    $("sv-repost-btn").addEventListener("click", async () => {
      if (!state.activeStory) return;
      try {
        await api(`/api/stories/${state.activeStory.id}/repost`, {
          method: "POST",
          auth: "student",
        });
        toast("🔁 Story reposted to your 24h Stories!", "success");
        loadStories();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  // ---------- iSnaps Vertical Scroll Feed ----------
  async function openInstaMode() {
    state.inChatView = false;
    state.viewingProfileId = null;
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
    showOnlyStudentSection("section-insta");
    setActiveNavTab("nav-insta-btn");
    await loadInstaFeed();
  }

  async function loadInstaFeed() {
    const feed = $("insta-feed");
    if (!feed) return;
    feed.innerHTML = `<div class="empty-state"><h3>Loading iSnaps...</h3></div>`;
    try {
      const data = await api("/api/posts", { auth: "student" });
      const posts = data.posts || [];
      if (!posts.length) {
        feed.innerHTML = `
          <div class="empty-state">
            <h3>No videos or blogs yet ✨</h3>
            <p>Tap <strong>+ Upload Video</strong> above to drop the first post in iSnaps!</p>
          </div>
        `;
        return;
      }
      feed.innerHTML = posts
        .map((p) => {
          const mediaHtml =
            p.post_type === "vlog" && p.media_url
              ? `<div class="insta-media-wrap" data-insta-dbl="${p.id}" style="aspect-ratio:16/10;background:#000;">
                   <video src="${escapeHtml(p.media_url)}" controls playsinline preload="metadata" style="width:100%;height:100%;object-fit:contain;"></video>
                 </div>`
              : `<div class="insta-media-wrap" data-insta-dbl="${p.id}" style="aspect-ratio:auto;min-height:140px;padding:24px 20px;background:linear-gradient(135deg,#fdf2f8,#eff6ff);color:#111827;flex-direction:column;text-align:left;align-items:flex-start;">
                   ${p.title ? `<h3 style="margin:0 0 8px;font-size:1.15rem;">${escapeHtml(p.title)}</h3>` : ""}
                   <p style="margin:0;line-height:1.6;color:#374151;white-space:pre-wrap;">${escapeHtml(p.content)}</p>
                 </div>`;
          return `
            <article class="insta-card">
              <div class="insta-head">
                <div class="post-author" data-insta-profile="${p.user_id}">
                  <div class="post-avatar" style="width:36px;height:36px;font-size:0.84rem;">${renderAvatar(p.author_avatar, p.author_name)}</div>
                  <div>
                    <div class="post-author-name" style="font-size:0.88rem;">${escapeHtml(p.author_name)}</div>
                    <div class="post-meta">${escapeHtml(p.author_class)} &bull; ${timeAgo(p.created_at)}</div>
                  </div>
                </div>
                <span class="type-badge ${p.post_type}">${p.post_type === "vlog" ? "Video" : "Blog"}</span>
              </div>
              ${mediaHtml}
              <div class="insta-actions">
                <button type="button" class="action-btn ${p.liked_by_me ? "liked" : ""}" data-insta-like="${p.id}">
                  <span>${p.liked_by_me ? "♥" : "♡"}</span>
                  <span data-insta-like-cnt="${p.id}">${p.like_count}</span>
                </button>
              </div>
              ${
                p.post_type === "vlog"
                  ? `<div class="insta-caption-box">
                       <strong>${escapeHtml(p.author_name)}</strong>
                       ${p.title ? `<span>${escapeHtml(p.title)}${p.content ? " — " : ""}</span>` : ""}
                       ${p.content ? `<span>${escapeHtml(p.content)}</span>` : ""}
                     </div>`
                  : ""
              }
            </article>
          `;
        })
        .join("");
    } catch (err) {
      feed.innerHTML = `<div class="empty-state"><h3>Couldn't load feed</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  async function triggerInstaLike(postId, forceLikeOnly = false) {
    const btn = document.querySelector(`[data-insta-like="${postId}"]`);
    if (forceLikeOnly && btn && btn.classList.contains("liked")) return;
    try {
      const res = await api(`/api/posts/${postId}/like`, { method: "POST", auth: "student" });
      if (btn) {
        btn.classList.toggle("liked", res.liked);
        btn.querySelector("span:first-child").textContent = res.liked ? "♥" : "♡";
        const cnt = btn.querySelector(`[data-insta-like-cnt="${postId}"]`);
        if (cnt) cnt.textContent = res.like_count;
      }
    } catch (err) {
      toast(err.message, "error");
    }
  }

  if ($("nav-insta-btn")) $("nav-insta-btn").addEventListener("click", openInstaMode);
  if ($("insta-back-home-btn")) $("insta-back-home-btn").addEventListener("click", showFeedMode);
  if ($("insta-upload-pic-btn")) $("insta-upload-pic-btn").addEventListener("click", () => openComposer("vlog"));

  if ($("insta-feed")) {
    $("insta-feed").addEventListener("click", (e) => {
      const prof = e.target.closest("[data-insta-profile]");
      if (prof) {
        loadUserProfile(Number(prof.dataset.instaProfile));
        return;
      }
      const likeBtn = e.target.closest("[data-insta-like]");
      if (likeBtn) {
        triggerInstaLike(Number(likeBtn.dataset.instaLike), false);
      }
    });

    $("insta-feed").addEventListener("dblclick", (e) => {
      const media = e.target.closest("[data-insta-dbl]");
      if (!media) return;
      const postId = Number(media.dataset.instaDbl);
      const burst = document.createElement("div");
      burst.className = "insta-heart-burst";
      burst.textContent = "♥";
      media.appendChild(burst);
      setTimeout(() => burst.remove(), 680);
      triggerInstaLike(postId, true);
    });
  }

  // ---------- Primus Tube (YouTube Cinema Videos Feed) ----------
  async function openTubeMode() {
    state.inChatView = false;
    state.viewingProfileId = null;
    if (chatPollTimer) { clearInterval(chatPollTimer); chatPollTimer = null; }
    showOnlyStudentSection("section-tube");
    setActiveNavTab("nav-tube-btn");
    await loadTubeVlogs();
  }

  async function loadTubeVlogs() {
    const grid = $("tube-feed");
    if (!grid) return;
    try {
      const data = await api("/api/posts?post_type=vlog", { auth: "student" });
      const vlogs = data.posts || [];
      if (!vlogs.length) {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column:1/-1;">
            <h3>No videos uploaded yet ▶️</h3>
            <p>Tap <strong>+ Upload Video</strong> above to publish the first video on Primus Tube!</p>
          </div>
        `;
        return;
      }

      grid.innerHTML = vlogs
        .map(
          (v) => `
          <article class="tube-card">
            <div class="tube-player-wrap">
              <video src="${escapeHtml(v.media_url)}" controls playsinline preload="metadata"></video>
            </div>
            <div class="tube-info">
              <div class="post-avatar" style="width:38px;height:38px;font-size:0.84rem;cursor:pointer;" data-tube-profile="${v.user_id}">
                ${renderAvatar(v.author_avatar, v.author_name)}
              </div>
              <div style="min-width:0;flex:1;">
                <h4 class="tube-title">${escapeHtml(v.title || "Untitled Video")}</h4>
                <div class="tube-meta">${escapeHtml(v.author_name)} &bull; ${escapeHtml(v.author_class)} &bull; ${timeAgo(v.created_at)}</div>
                ${v.content ? `<div class="tube-meta" style="margin-top:4px;color:#374151;">${escapeHtml(v.content)}</div>` : ""}
              </div>
            </div>
            <div class="tube-actions">
              <button type="button" class="action-btn ${v.liked_by_me ? "liked" : ""}" data-tube-like="${v.id}">
                <span>${v.liked_by_me ? "♥" : "♡"}</span>
                <span data-tube-like-cnt="${v.id}">${v.like_count}</span>
              </button>
            </div>
          </article>
        `
        )
        .join("");
    } catch (err) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><h3>Couldn't load videos</h3><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  async function handleTubeClick(e) {
    const prof = e.target.closest("[data-tube-profile]");
    if (prof) {
      loadUserProfile(Number(prof.dataset.tubeProfile));
      return;
    }
    const likeBtn = e.target.closest("[data-tube-like]");
    if (likeBtn) {
      const postId = Number(likeBtn.dataset.tubeLike);
      try {
        const res = await api(`/api/posts/${postId}/like`, { method: "POST", auth: "student" });
        document.querySelectorAll(`[data-tube-like="${postId}"]`).forEach((b) => {
          b.classList.toggle("liked", res.liked);
          b.querySelector("span:first-child").textContent = res.liked ? "♥" : "♡";
          const c = b.querySelector(`[data-tube-like-cnt="${postId}"]`);
          if (c) c.textContent = res.like_count;
        });
      } catch (err) {
        toast(err.message, "error");
      }
    }
  }

  if ($("nav-tube-btn")) $("nav-tube-btn").addEventListener("click", () => openTubeMode());
  if ($("tube-back-home-btn")) $("tube-back-home-btn").addEventListener("click", showFeedMode);
  if ($("tube-upload-vlog-btn")) $("tube-upload-vlog-btn").addEventListener("click", () => openComposer("vlog"));
  if ($("tube-feed")) $("tube-feed").addEventListener("click", handleTubeClick);

  // ---------- Campus TV Showcase (iCarly-Style Featured Screen) ----------
  let tvIndex = 0;

  function getTvMediaPosts() {
    return (state.posts || []).filter((p) => p.media_url && (p.post_type === "vlog" || p.post_type === "pic"));
  }

  function renderCampusTV() {
    const screen = $("campus-tv-screen");
    if (!screen) return;
    const items = getTvMediaPosts();
    if (!items.length) {
      screen.innerHTML = `
        <div class="tv-empty-state">
          <div style="font-size:2.2rem;margin-bottom:6px;">📺</div>
          <strong>PrimusPix Campus TV</strong>
          <p style="margin:4px 0 0;font-size:0.8rem;opacity:0.85;">Upload a Vlog or Pic to feature it live on the Campus TV!</p>
        </div>
      `;
      return;
    }
    tvIndex = ((tvIndex % items.length) + items.length) % items.length;
    const item = items[tvIndex];
    const mediaTag =
      item.post_type === "vlog"
        ? `<video src="${escapeHtml(item.media_url)}" controls playsinline preload="metadata"></video>`
        : `<img src="${escapeHtml(item.media_url)}" alt="${escapeHtml(item.title || "Featured")}" style="cursor:zoom-in;" data-tv-lb="${escapeHtml(item.media_url)}" />`;
    screen.innerHTML = `
      ${mediaTag}
      <div class="tv-overlay-title">${escapeHtml(item.title || item.content || "Featured Drop")} &bull; by ${escapeHtml(item.author_name)}</div>
    `;
  }

  if ($("tv-prev-btn")) {
    $("tv-prev-btn").addEventListener("click", () => {
      tvIndex -= 1;
      renderCampusTV();
    });
  }
  if ($("tv-next-btn")) {
    $("tv-next-btn").addEventListener("click", () => {
      tvIndex += 1;
      renderCampusTV();
    });
  }
  if ($("tv-open-tube-btn")) $("tv-open-tube-btn").addEventListener("click", () => openTubeMode("feed"));
  if ($("campus-tv-screen")) {
    $("campus-tv-screen").addEventListener("click", (e) => {
      const img = e.target.closest("[data-tv-lb]");
      if (img) {
        $("lightbox-img").src = img.dataset.tvLb;
        $("modal-lightbox").classList.remove("hidden");
      }
    });
  }

  // Signpost quick links
  if ($("sp-make-avatar")) $("sp-make-avatar").addEventListener("click", openAvatarMaker);
  if ($("sp-open-insta")) $("sp-open-insta").addEventListener("click", openInstaMode);
  if ($("sp-open-tube")) $("sp-open-tube").addEventListener("click", () => openTubeMode("feed"));

  // ---------- iVOTE Campus Poll Widget ----------
  async function loadIVote() {
    const body = $("ivote-body");
    if (!body) return;
    try {
      const data = await api("/api/polls", { auth: "student" });
      const polls = data.polls || [];
      if (!polls.length) {
        body.innerHTML = `<p class="muted small" style="margin:0;">No active campus poll right now.</p>`;
        return;
      }
      const p = polls[0];
      const total = Math.max(1, p.total_votes);
      body.innerHTML = `
        <p class="ivote-q">${escapeHtml(p.question)}</p>
        <div class="ivote-opts">
          ${p.options
            .map((opt, idx) => {
              const cnt = p.counts[idx] || 0;
              const pct = p.total_votes > 0 ? Math.round((cnt / total) * 100) : 0;
              const voted = p.my_vote === idx;
              return `
                <button type="button" class="ivote-opt-btn" data-ivote-poll="${p.id}" data-ivote-opt="${idx}">
                  <div class="ivote-opt-fill" style="width:${p.my_vote !== null ? pct : 0}%"></div>
                  <span style="position:relative;z-index:1;">${voted ? "✓ " : ""}${escapeHtml(opt)}</span>
                  <span style="position:relative;z-index:1;color:#be185d;font-weight:800;">${p.my_vote !== null ? `${pct}%` : "Vote"}</span>
                </button>
              `;
            })
            .join("")}
        </div>
        <div class="muted" style="font-size:0.72rem;margin-top:8px;text-align:right;">${p.total_votes} vote${p.total_votes === 1 ? "" : "s"}</div>
      `;
    } catch {
      // ignore
    }
  }

  if ($("ivote-body")) {
    $("ivote-body").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-ivote-poll]");
      if (!btn) return;
      try {
        await api(`/api/polls/${btn.dataset.ivotePoll}/vote`, {
          method: "POST",
          auth: "student",
          json: { option_index: Number(btn.dataset.ivoteOpt) },
        });
        toast("Vote recorded!", "success");
        loadIVote();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  // ---------- Custom Avatar Studio (14 Hairstyles, Pretty Eyes/Faces, Draw Outfit + AI Readjust) ----------
  const avatarCfg = {
    skin: "#fde4cf",
    hairStyle: "long",
    hairColor: "#1e1820",
    eyes: "dreamy",
    eyeColor: "#3b261d",
    mouth: "smile",
    accessory: "none",
    outfitStyle: "tshirt",
    shirt: "#f472b6",
    bg: "#fce7f3",
  };

  let outfitBrushColor = "#ffffff";
  let outfitBrushSize = 9;
  let outfitStrokes = []; // Array of { color, size, points: [{x, y}] }
  let outfitAiTailored = false;
  let isDrawingOutfit = false;

  function buildEyesSvg(style, eyeColor, hairColor) {
    const brow = `<path d="M68 89 Q80 83 91 88" stroke="${hairColor}" stroke-width="2.6" fill="none" stroke-linecap="round"/>
                  <path d="M109 88 Q120 83 132 89" stroke="${hairColor}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;

    const prettyEye = (cx, winged = false, starry = false, halfLid = false) => {
      const wing = winged
        ? cx < 100
          ? `<path d="M66 99 L61 95" stroke="#1f1722" stroke-width="2.8" stroke-linecap="round"/>`
          : `<path d="M134 99 L139 95" stroke="#1f1722" stroke-width="2.8" stroke-linecap="round"/>`
        : "";
      const extraStar = starry
        ? `<circle cx="${cx + 3}" cy="107" r="1.7" fill="#fef08a"/><circle cx="${cx - 4}" cy="106" r="1.2" fill="#ffffff"/>`
        : "";
      const lid = halfLid
        ? `<rect x="${cx - 12}" y="92" width="24" height="9" rx="4" fill="${avatarCfg.skin}"/><line x1="${cx - 11}" y1="100" x2="${cx + 11}" y2="100" stroke="#1f1722" stroke-width="2.5" stroke-linecap="round"/>`
        : "";
      return `
        <ellipse cx="${cx}" cy="103" rx="10.5" ry="9.5" fill="#ffffff"/>
        <circle cx="${cx}" cy="103.5" r="7.2" fill="${eyeColor}"/>
        <circle cx="${cx}" cy="104" r="4.1" fill="#17111a"/>
        <circle cx="${cx - 2.6}" cy="100" r="2.6" fill="#ffffff"/>
        <circle cx="${cx + 2.8}" cy="106.2" r="1.3" fill="#ffffff"/>
        ${extraStar}
        <path d="M${cx - 11} 100 Q${cx} 90 ${cx + 11} 100" stroke="#1f1722" stroke-width="3.2" fill="none" stroke-linecap="round"/>
        ${wing}
        ${lid}
      `;
    };

    if (style === "happy") {
      return `${brow}
        <path d="M70 105 Q80 94 91 105" stroke="#1f1722" stroke-width="3.4" fill="none" stroke-linecap="round"/>
        <path d="M109 105 Q120 94 130 105" stroke="#1f1722" stroke-width="3.4" fill="none" stroke-linecap="round"/>`;
    }
    if (style === "wink") {
      return `${brow}
        ${prettyEye(80, true, false, false)}
        <path d="M109 104 Q120 95 131 104" stroke="#1f1722" stroke-width="3.4" fill="none" stroke-linecap="round"/>`;
    }
    if (style === "hearts") {
      const heart = (cx) => `
        <path d="M${cx} 111 C${cx - 11} 103, ${cx - 12} 93, ${cx - 5} 93 C${cx - 2} 93, ${cx} 96, ${cx} 97 C${cx} 96, ${cx + 2} 93, ${cx + 5} 93 C${cx + 12} 93, ${cx + 11} 103, ${cx} 111 Z" fill="#ec4899"/>
        <circle cx="${cx - 3}" cy="98" r="1.8" fill="rgba(255,255,255,0.75)"/>`;
      return `${brow}${heart(80)}${heart(120)}`;
    }
    if (style === "cat") return `${brow}${prettyEye(80, true, false, false)}${prettyEye(120, true, false, false)}`;
    if (style === "sparkle") return `${brow}${prettyEye(80, true, true, false)}${prettyEye(120, true, true, false)}`;
    if (style === "chill") return `${brow}${prettyEye(80, false, false, true)}${prettyEye(120, false, false, true)}`;
    if (style === "focused") {
      return `
        <path d="M69 87 L91 91" stroke="${hairColor}" stroke-width="2.8" stroke-linecap="round"/>
        <path d="M131 87 L109 91" stroke="${hairColor}" stroke-width="2.8" stroke-linecap="round"/>
        ${prettyEye(80, false, false, false)}${prettyEye(120, false, false, false)}`;
    }
    // dreamy default
    return `${brow}${prettyEye(80, false, true, false)}${prettyEye(120, false, true, false)}`;
  }

  function buildMouthSvg(mouth) {
    if (mouth === "grin") {
      return `<path d="M87 121 Q100 136 113 121 Z" fill="#ffffff" stroke="#be185d" stroke-width="2.5" stroke-linejoin="round"/>`;
    }
    if (mouth === "cat") {
      return `<path d="M88 123 Q94 129 100 123 Q106 129 112 123" stroke="#9f1239" stroke-width="2.8" fill="none" stroke-linecap="round"/>`;
    }
    if (mouth === "smirk") {
      return `<path d="M90 125 Q103 127 113 120" stroke="#9f1239" stroke-width="2.8" fill="none" stroke-linecap="round"/>`;
    }
    if (mouth === "soft") {
      return `<path d="M93 124 Q100 127 107 124" stroke="#9f1239" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
    }
    if (mouth === "wow") {
      return `<ellipse cx="100" cy="125" rx="5.5" ry="7" fill="#f43f5e" stroke="#9f1239" stroke-width="2.2"/>`;
    }
    return `<path d="M89 122 Q100 132 111 122" stroke="#9f1239" stroke-width="2.9" fill="none" stroke-linecap="round"/>`;
  }

  function buildHairLayers(style, col) {
    let back = "";
    let front = "";
    if (style === "long") {
      back = `<path d="M44 76 C44 36, 156 36, 156 76 L160 184 C140 190, 60 190, 40 184 Z" fill="${col}"/>`;
      front = `<path d="M50 86 C52 40, 148 40, 150 86 C134 68, 114 64, 100 72 C86 64, 66 68, 50 86 Z" fill="${col}"/>`;
    } else if (style === "wavy") {
      back = `<path d="M42 82 C36 42, 164 42, 158 82 C164 114, 154 146, 162 178 C134 190, 66 190, 38 178 C46 146, 36 114, 42 82 Z" fill="${col}"/>`;
      front = `<path d="M48 92 C50 40, 150 40, 152 92 C136 74, 114 60, 100 66 C86 60, 64 74, 48 92 Z" fill="${col}"/>`;
    } else if (style === "bob") {
      back = `<path d="M45 80 C45 38, 155 38, 155 80 C157 122, 148 144, 134 146 L66 146 C52 144, 43 122, 45 80 Z" fill="${col}"/>`;
      front = `<path d="M50 82 C54 42, 146 42, 150 82 L138 74 L120 77 L100 72 L80 77 L62 74 Z" fill="${col}"/>`;
    } else if (style === "wolf") {
      back = `<path d="M40 84 C42 36, 158 36, 160 84 L166 148 L146 138 L154 170 L124 154 L76 154 L46 170 L54 138 L34 148 Z" fill="${col}"/>`;
      front = `<path d="M48 88 C52 38, 148 38, 152 88 L134 70 L118 82 L100 66 L82 82 L66 70 Z" fill="${col}"/>`;
    } else if (style === "ponytail") {
      back = `<path d="M116 44 C156 36, 174 86, 162 148 C150 156, 138 140, 142 104 C144 80, 130 64, 114 58 Z" fill="${col}"/>
              <circle cx="122" cy="48" r="7" fill="#ec4899"/>`;
      front = `<path d="M52 84 C54 40, 146 40, 148 84 C132 66, 68 66, 52 84 Z" fill="${col}"/>`;
    } else if (style === "pigtails") {
      back = `<ellipse cx="42" cy="112" rx="18" ry="44" transform="rotate(14 42 112)" fill="${col}"/>
              <ellipse cx="158" cy="112" rx="18" ry="44" transform="rotate(-14 158 112)" fill="${col}"/>
              <circle cx="52" cy="76" r="6" fill="#f472b6"/><circle cx="148" cy="76" r="6" fill="#f472b6"/>`;
      front = `<path d="M52 84 C54 40, 146 40, 148 84 C130 68, 70 68, 52 84 Z" fill="${col}"/>`;
    } else if (style === "spacebuns") {
      back = `<circle cx="58" cy="44" r="20" fill="${col}"/><circle cx="142" cy="44" r="20" fill="${col}"/>`;
      front = `<path d="M52 86 C54 42, 146 42, 148 86 C130 68, 70 68, 52 86 Z" fill="${col}"/>`;
    } else if (style === "bun") {
      back = `<circle cx="100" cy="34" r="22" fill="${col}"/>`;
      front = `<path d="M52 84 C54 42, 146 42, 148 84 C130 68, 70 68, 52 84 Z" fill="${col}"/>
               <path d="M58 76 Q52 102 58 116" stroke="${col}" stroke-width="5" fill="none" stroke-linecap="round"/>
               <path d="M142 76 Q148 102 142 116" stroke="${col}" stroke-width="5" fill="none" stroke-linecap="round"/>`;
    } else if (style === "curly") {
      back = `<circle cx="54" cy="84" r="24" fill="${col}"/><circle cx="146" cy="84" r="24" fill="${col}"/>
              <circle cx="58" cy="118" r="22" fill="${col}"/><circle cx="142" cy="118" r="22" fill="${col}"/>`;
      front = `<circle cx="72" cy="56" r="22" fill="${col}"/><circle cx="100" cy="48" r="25" fill="${col}"/><circle cx="128" cy="56" r="22" fill="${col}"/>`;
    } else if (style === "braids") {
      const braid = (x) => `
        <circle cx="${x}" cy="112" r="11" fill="${col}"/>
        <circle cx="${x}" cy="128" r="10" fill="${col}"/>
        <circle cx="${x}" cy="144" r="9" fill="${col}"/>
        <circle cx="${x}" cy="158" r="8" fill="${col}"/>
        <rect x="${x - 6}" y="162" width="12" height="5" rx="2.5" fill="#ec4899"/>`;
      back = `${braid(52)}${braid(148)}`;
      front = `<path d="M50 86 C52 40, 148 40, 150 86 C130 68, 70 68, 50 86 Z" fill="${col}"/>`;
    } else if (style === "fluffy") {
      front = `<path d="M48 90 C44 46, 78 34, 100 38 C122 34, 156 46, 152 90 C138 72, 122 66, 108 76 C96 64, 82 68, 70 78 C62 72, 54 78, 48 90 Z" fill="${col}"/>`;
    } else if (style === "middle") {
      front = `<path d="M50 92 C48 42, 96 38, 100 58 C104 38, 152 42, 150 92 C136 74, 114 66, 100 72 C86 66, 64 74, 50 92 Z" fill="${col}"/>`;
    } else if (style === "spiky") {
      front = `<path d="M50 86 L54 46 L74 60 L92 32 L108 58 L128 36 L142 60 L150 86 C130 68, 70 68, 50 86 Z" fill="${col}"/>`;
    } else if (style === "hijab") {
      back = `<path d="M42 96 C42 36, 158 36, 158 96 L164 188 C134 198, 66 198, 36 188 Z" fill="${col}"/>`;
      front = `<path d="M48 98 C48 44, 152 44, 152 98 C142 66, 124 58, 100 58 C76 58, 58 66, 48 98 Z" fill="${col}"/>
               <path d="M52 134 Q100 162 148 134 L156 172 Q100 186 44 172 Z" fill="${col}" opacity="0.92"/>`;
    }
    return { back, front };
  }

  function buildOutfitSvg(style, shirt) {
    const base = `<path d="M42 202 C46 156, 72 146, 100 146 C128 146, 154 156, 158 202 Z" fill="${shirt}"/>`;
    if (style === "hoodie") {
      return `${base}
        <path d="M74 146 Q100 164 126 146" fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="5" stroke-linecap="round"/>
        <line x1="91" y1="156" x2="91" y2="180" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>
        <line x1="109" y1="156" x2="109" y2="180" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round"/>`;
    }
    if (style === "jacket") {
      return `${base}
        <path d="M42 202 C46 160, 62 152, 74 150 L70 202 Z" fill="rgba(255,255,255,0.28)"/>
        <path d="M158 202 C154 160, 138 152, 126 150 L130 202 Z" fill="rgba(255,255,255,0.28)"/>
        <line x1="100" y1="152" x2="100" y2="202" stroke="rgba(255,255,255,0.65)" stroke-width="3"/>
        <circle cx="100" cy="168" r="2.5" fill="#ffffff"/><circle cx="100" cy="184" r="2.5" fill="#ffffff"/>`;
    }
    if (style === "sweater") {
      return `${base}
        <path d="M78 146 Q100 162 122 146" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="6" stroke-linecap="round"/>`;
    }
    return `${base}
      <path d="M82 146 Q100 160 118 146" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="3.5" stroke-linecap="round"/>`;
  }

  function buildAvatarSvg(c) {
    const hair = buildHairLayers(c.hairStyle, c.hairColor);
    const eyesSvg = buildEyesSvg(c.eyes, c.eyeColor, c.hairColor);
    const mouthSvg = buildMouthSvg(c.mouth);
    const outfitSvg = buildOutfitSvg(c.outfitStyle, c.shirt);

    let accSvg = "";
    if (c.accessory === "glasses") {
      accSvg = `
        <circle cx="80" cy="103" r="14" fill="rgba(255,255,255,0.22)" stroke="#374151" stroke-width="2.8"/>
        <circle cx="120" cy="103" r="14" fill="rgba(255,255,255,0.22)" stroke="#374151" stroke-width="2.8"/>
        <line x1="94" y1="103" x2="106" y2="103" stroke="#374151" stroke-width="2.8"/>`;
    } else if (c.accessory === "shades") {
      accSvg = `
        <rect x="64" y="93" width="32" height="19" rx="7" fill="#111827"/>
        <rect x="104" y="93" width="32" height="19" rx="7" fill="#111827"/>
        <line x1="96" y1="101" x2="104" y2="101" stroke="#111827" stroke-width="3.2"/>
        <line x1="70" y1="98" x2="80" y2="98" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round"/>
        <line x1="110" y1="98" x2="120" y2="98" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round"/>`;
    } else if (c.accessory === "crown") {
      accSvg = `<path d="M72 52 L78 28 L91 42 L100 22 L109 42 L122 28 L128 52 Z" fill="#fbbf24" stroke="#d97706" stroke-width="2.4" stroke-linejoin="round"/>`;
    } else if (c.accessory === "bow") {
      accSvg = `
        <ellipse cx="128" cy="54" rx="14" ry="9" transform="rotate(-18 128 54)" fill="#ec4899"/>
        <ellipse cx="144" cy="62" rx="14" ry="9" transform="rotate(24 144 62)" fill="#f472b6"/>
        <circle cx="136" cy="58" r="6" fill="#be185d"/>`;
    } else if (c.accessory === "headphones") {
      accSvg = `
        <path d="M48 104 C48 40, 152 40, 152 104" stroke="#38bdf8" stroke-width="8" fill="none" stroke-linecap="round"/>
        <rect x="40" y="92" width="14" height="28" rx="7" fill="#0284c7"/>
        <rect x="146" y="92" width="14" height="28" rx="7" fill="#0284c7"/>`;
    } else if (c.accessory === "blush_hearts") {
      accSvg = `<text x="64" y="121" font-size="11">💖</text><text x="125" y="121" font-size="11">💖</text>`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="400" height="400">
      <rect width="200" height="200" fill="${c.bg}"/>
      <circle cx="30" cy="34" r="14" fill="rgba(255,255,255,0.45)"/>
      <circle cx="170" cy="40" r="10" fill="rgba(255,255,255,0.4)"/>
      ${hair.back}
      ${outfitSvg}
      <rect x="88" y="132" width="24" height="22" rx="10" fill="${c.skin}"/>
      <circle cx="56" cy="106" r="8.5" fill="${c.skin}"/>
      <circle cx="144" cy="106" r="8.5" fill="${c.skin}"/>
      <rect x="58" y="54" width="84" height="90" rx="42" fill="${c.skin}"/>
      <ellipse cx="70" cy="116" rx="8" ry="5" fill="rgba(244,114,182,0.34)"/>
      <ellipse cx="130" cy="116" rx="8" ry="5" fill="rgba(244,114,182,0.34)"/>
      <path d="M98 112 Q100 115 102 112" stroke="rgba(150,90,70,0.45)" stroke-width="2" fill="none" stroke-linecap="round"/>
      ${eyesSvg}
      ${mouthSvg}
      ${hair.front}
      ${accSvg}
    </svg>`;
  }

  // ---------- Outfit Freehand Drawing + AI Readjust Engine ----------
  function clipTorsoPath(ctx) {
    // Matches the exact avatar torso silhouette scaled to 400x400 canvas
    ctx.beginPath();
    ctx.moveTo(84, 404);
    ctx.bezierCurveTo(92, 312, 144, 292, 200, 292);
    ctx.bezierCurveTo(256, 292, 308, 312, 316, 404);
    ctx.closePath();
  }

  function redrawOutfitCanvas() {
    const canvas = $("outfit-draw-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!outfitStrokes.length && !outfitAiTailored) return;

    ctx.save();
    if (outfitAiTailored) {
      // AI Readjust: clip strictly inside the avatar's tailored torso silhouette!
      clipTorsoPath(ctx);
      ctx.clip();
    }

    outfitStrokes.forEach((stroke) => {
      const pts = stroke.points;
      if (!pts.length) return;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size * 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();

      if (pts.length === 1) {
        ctx.arc(pts[0].x, pts[0].y, stroke.size, 0, Math.PI * 2);
        ctx.fillStyle = stroke.color;
        ctx.fill();
        return;
      }

      if (outfitAiTailored && pts.length >= 3) {
        // AI Readjust: smooth jagged hand-drawn strokes into clean quadratic Bezier curves
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const midX = (pts[i].x + pts[i + 1].x) / 2;
          const midY = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x, last.y);
      } else {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
    });

    if (outfitAiTailored) {
      // AI Readjust: add studio fabric shading, soft top highlight & clean neckline shadow
      const grad = ctx.createLinearGradient(84, 292, 316, 400);
      grad.addColorStop(0, "rgba(255,255,255,0.22)");
      grad.addColorStop(0.5, "rgba(255,255,255,0)");
      grad.addColorStop(1, "rgba(15,23,42,0.18)");
      ctx.fillStyle = grad;
      ctx.fillRect(80, 290, 240, 120);

      // Clean collar trim
      ctx.beginPath();
      ctx.moveTo(164, 292);
      ctx.quadraticCurveTo(200, 322, 236, 292);
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.stroke();

      // Subtle shoulder seam contour
      clipTorsoPath(ctx);
      ctx.strokeStyle = "rgba(15,23,42,0.14)";
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    ctx.restore();
  }

  function aiReadjustOutfit() {
    if (!outfitStrokes.length) {
      toast("Sketch something on the avatar's outfit first, then click AI Readjust!", "info");
      return;
    }
    // Smooth raw points via 2-pass averaging so wobbly lines become clean curves
    outfitStrokes = outfitStrokes.map((st) => {
      if (st.points.length < 4) return st;
      let pts = st.points;
      for (let pass = 0; pass < 2; pass++) {
        const next = [pts[0]];
        for (let i = 1; i < pts.length - 1; i++) {
          next.push({
            x: (pts[i - 1].x + pts[i].x * 2 + pts[i + 1].x) / 4,
            y: (pts[i - 1].y + pts[i].y * 2 + pts[i + 1].y) / 4,
          });
        }
        next.push(pts[pts.length - 1]);
        pts = next;
      }
      return { ...st, points: pts };
    });
    outfitAiTailored = true;
    redrawOutfitCanvas();
    toast("✨ AI tailored, smoothed & shaded your custom outfit!", "success");
  }

  function getCanvasCoords(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  const drawCanvas = $("outfit-draw-canvas");
  if (drawCanvas) {
    const startDraw = (e) => {
      e.preventDefault();
      isDrawingOutfit = true;
      outfitAiTailored = false;
      const pt = getCanvasCoords(e, drawCanvas);
      outfitStrokes.push({ color: outfitBrushColor, size: outfitBrushSize, points: [pt] });
      redrawOutfitCanvas();
    };
    const moveDraw = (e) => {
      if (!isDrawingOutfit) return;
      e.preventDefault();
      const pt = getCanvasCoords(e, drawCanvas);
      outfitStrokes[outfitStrokes.length - 1].points.push(pt);
      redrawOutfitCanvas();
    };
    const endDraw = () => {
      isDrawingOutfit = false;
    };

    drawCanvas.addEventListener("mousedown", startDraw);
    drawCanvas.addEventListener("mousemove", moveDraw);
    window.addEventListener("mouseup", endDraw);
    drawCanvas.addEventListener("touchstart", startDraw, { passive: false });
    drawCanvas.addEventListener("touchmove", moveDraw, { passive: false });
    window.addEventListener("touchend", endDraw);
  }

  // Studio tab switching
  document.querySelectorAll("[data-av-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.avTab;
      document.querySelectorAll("[data-av-tab]").forEach((t) => t.classList.toggle("active", t.dataset.avTab === target));
      document.querySelectorAll("[data-av-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.avPanel !== target));
    });
  });

  if ($("outfit-brush-colors")) {
    $("outfit-brush-colors").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-bcolor]");
      if (!btn) return;
      outfitBrushColor = btn.dataset.bcolor;
      $("outfit-brush-colors").querySelectorAll("[data-bcolor]").forEach((b) => b.classList.toggle("active", b === btn));
    });
  }
  if ($("outfit-brush-size")) {
    $("outfit-brush-size").addEventListener("input", (e) => {
      outfitBrushSize = Number(e.target.value) || 9;
    });
  }
  if ($("outfit-undo-btn")) {
    $("outfit-undo-btn").addEventListener("click", () => {
      outfitStrokes.pop();
      redrawOutfitCanvas();
    });
  }
  if ($("outfit-clear-btn")) {
    $("outfit-clear-btn").addEventListener("click", () => {
      outfitStrokes = [];
      outfitAiTailored = false;
      redrawOutfitCanvas();
    });
  }
  if ($("ai-readjust-outfit-btn")) {
    $("ai-readjust-outfit-btn").addEventListener("click", aiReadjustOutfit);
  }

  function renderAvatarPreview() {
    const stage = $("avatar-svg-stage");
    if (stage) stage.innerHTML = buildAvatarSvg(avatarCfg);
    document.querySelectorAll("[data-av-part]").forEach((group) => {
      const part = group.dataset.avPart;
      group.querySelectorAll("[data-val]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.val === avatarCfg[part]);
      });
    });
  }

  function openAvatarMaker() {
    renderAvatarPreview();
    redrawOutfitCanvas();
    $("modal-avatar-maker").classList.remove("hidden");
  }

  function closeAvatarMaker() {
    $("modal-avatar-maker").classList.add("hidden");
  }

  if ($("nav-avatar-maker-btn")) $("nav-avatar-maker-btn").addEventListener("click", openAvatarMaker);
  if ($("profile-make-avatar-btn")) $("profile-make-avatar-btn").addEventListener("click", openAvatarMaker);
  if ($("close-avatar-maker")) $("close-avatar-maker").addEventListener("click", closeAvatarMaker);
  if ($("cancel-avatar-maker")) $("cancel-avatar-maker").addEventListener("click", closeAvatarMaker);

  document.querySelectorAll("[data-av-part]").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-val]");
      if (!btn) return;
      avatarCfg[group.dataset.avPart] = btn.dataset.val;
      renderAvatarPreview();
    });
  });

  if ($("avatar-randomize-btn")) {
    $("avatar-randomize-btn").addEventListener("click", () => {
      const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
      avatarCfg.skin = pick(["#fde4cf", "#f5cba7", "#e0ac7e", "#c68652", "#965d38", "#633b22"]);
      avatarCfg.hairStyle = pick(["long", "wavy", "bob", "wolf", "ponytail", "pigtails", "spacebuns", "bun", "curly", "braids", "fluffy", "middle", "spiky", "hijab"]);
      avatarCfg.hairColor = pick(["#1e1820", "#4a2e1f", "#7c4a27", "#d9a441", "#b9432f", "#ec4899", "#a855f7", "#38bdf8", "#e5e7eb", "#0f766e"]);
      avatarCfg.eyes = pick(["dreamy", "sparkle", "cat", "chill", "happy", "wink", "hearts", "focused"]);
      avatarCfg.eyeColor = pick(["#3b261d", "#2563eb", "#059669", "#7c3aed", "#db2777", "#b45309", "#475569"]);
      avatarCfg.mouth = pick(["smile", "grin", "cat", "smirk", "soft", "wow"]);
      avatarCfg.accessory = pick(["none", "glasses", "shades", "crown", "bow", "headphones", "blush_hearts"]);
      avatarCfg.outfitStyle = pick(["tshirt", "hoodie", "jacket", "sweater"]);
      avatarCfg.shirt = pick(["#f472b6", "#38bdf8", "#ffffff", "#6366f1", "#fbbf24", "#10b981", "#1f2937"]);
      avatarCfg.bg = pick(["#fce7f3", "#e0f2fe", "#fef9c3", "#f3e8ff", "#dcfce7", "#ffedd5"]);
      renderAvatarPreview();
    });
  }

  if ($("save-custom-avatar-btn")) {
    $("save-custom-avatar-btn").addEventListener("click", async () => {
      const btn = $("save-custom-avatar-btn");
      btn.disabled = true;
      btn.textContent = "Saving Avatar...";
      try {
        const svgStr = buildAvatarSvg(avatarCfg);
        const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(svgBlob);
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 400;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 400, 400);
        URL.revokeObjectURL(url);

        // Composite the user's drawn / AI-readjusted outfit right onto the saved avatar!
        const outfitCanvas = $("outfit-draw-canvas");
        if (outfitCanvas) {
          ctx.drawImage(outfitCanvas, 0, 0, 400, 400);
        }

        const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        const file = new File([pngBlob], `avatar_${Date.now()}.png`, { type: "image/png" });
        const fd = new FormData();
        fd.append("avatar", file);
        const res = await api("/api/profile/me", { method: "POST", auth: "student", body: fd });
        state.currentUser = res.user;
        syncMyNavIdentity();
        closeAvatarMaker();
        toast("🎨 Custom Avatar saved as your profile pic!", "success");
        if (state.viewingProfileId) loadUserProfile(state.viewingProfileId);
        else loadFeed();
      } catch (err) {
        toast(err.message || "Could not save avatar.", "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Save as My Profile Pic";
      }
    });
  }

  // Lightbox Close
  $("close-lightbox").addEventListener("click", () => $("modal-lightbox").classList.add("hidden"));
  $("modal-lightbox").addEventListener("click", (e) => {
    if (e.target === $("modal-lightbox")) $("modal-lightbox").classList.add("hidden");
  });

  // ---------- PWA Service Worker & Install App Prompt ----------
  let deferredInstallPrompt = null;
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if ($("pwa-install-btn") && !isStandalone) {
      $("pwa-install-btn").classList.remove("hidden");
    }
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    if ($("pwa-install-btn")) $("pwa-install-btn").classList.add("hidden");
    toast("📲 Primus Pix installed on your device!", "success");
  });

  // On iOS Safari (no beforeinstallprompt), show Install button if not standalone
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIos && !isStandalone && $("pwa-install-btn")) {
    $("pwa-install-btn").classList.remove("hidden");
  }

  if ($("pwa-install-btn")) {
    $("pwa-install-btn").addEventListener("click", async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === "accepted") {
          $("pwa-install-btn").classList.add("hidden");
        }
        deferredInstallPrompt = null;
      } else if (isIos) {
        toast("On iPhone/iPad: tap Share (↑) → 'Add to Home Screen' to install Primus Pix!");
      } else {
        toast("Use your browser's address bar install icon to install Primus Pix!");
      }
    });
  }

  // Start!
  boot();
})();
