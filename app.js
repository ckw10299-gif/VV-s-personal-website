(function () {
  const DB_NAME = "personal-manager-mvp";
  const STORE = "files";
  const LOCAL_BACKUP_KEY = "pm.localBackupSnapshot";
  const LAST_EMAIL_KEY = "pm.lastLoginEmail";
  const PENDING_CLOUD_KEYS = "pm.pendingCloudKeys";
  const LAST_CLOUD_SYNC_KEY = "pm.lastCloudSyncAt";
  const LOCAL_DATA_LOCK_KEY = "pm.localDataLocked";
  const TUS_CLIENT_URL = "tus.min.js?v=20260615-tus-all";
  const TUS_CHUNK_SIZE = 6 * 1024 * 1024;
  const SUPABASE_FREE_FILE_LIMIT = 50 * 1000 * 1000;
  const FALLBACK_SUPABASE_CONFIG = {
    url: "https://mcqmltqlqvljpteqvpje.supabase.co",
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jcW1sdHFscXZsanB0ZXF2cGplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MDg5MDUsImV4cCI6MjA5NTQ4NDkwNX0.Bu_W_KzNIH0uMd7IgA3NTX1wN9B0LPDbkJrSgK1hSIs"
  };
  const TODO_TYPES = {
    business: "业务",
    pm: "PM",
    growth: "个人成长",
    onboarding: "新人课程"
  };

  const DOC_CATEGORIES = ["个人深度文档", "工作相关文档", "专业文档", "其他"];
  const TYPE_CLASS = {
    business: "business",
    pm: "pm",
    growth: "growth",
    onboarding: "onboarding"
  };

  const state = {
    view: "todo",
    month: new Date(),
    selectedDate: toISODate(new Date()),
    editingTodoId: null,
    editingMaterialId: null,
    editingGoalId: null,
    editingDocId: null,
    supabase: null,
    user: null,
    cloudReady: false,
    cloudLoading: false,
    cloudSavePromise: Promise.resolve(),
    cloudSessionChecked: false,
    cloudAuthSubscribed: false,
    cloudPausedUntil: 0,
    cloudRetryTimer: null,
    supabaseAuthKey: "",
    openMemoryInputId: null,
    pendingIdeaImages: [],
    ideaImageUrls: [],
    activeIdeaImageUrl: "",
    statsWeek: getWeekRangeLabel(toISODate(new Date())),
    statsMonth: getMonthLabel(toISODate(new Date())),
    reviewDimension: "project",
    reviewWeek: "",
    assetDrafts: [],
    materialOpenKeys: new Set(),
    materialOpenStateReady: false,
    goals: loadPrivateArray("pm.goals"),
    todos: loadPrivateArray("pm.todos"),
    materials: loadPrivateArray("pm.materials"),
    ideas: loadPrivateArray("pm.ideas"),
    docs: loadPrivateArray("pm.docs"),
    memory: normalizeMemory(isLocalDataLocked() ? {} : load("pm.materialMemory", {
      projects: [],
      vendors: [],
      tagOne: [],
      tagTwo: [],
      tagThree: []
    })),
    materialFilters: {
      week: "",
      scriptType: "",
      scriptStatus: "",
      progress: "",
      tagOne: "",
      tagTwo: "",
      tagThree: ""
    },
    materialFilterModes: defaultMaterialFilterModes()
  };

  function defaultMaterialFilterModes() {
    return {
      week: "include",
      scriptType: "include",
      scriptStatus: "include",
      progress: "include",
      tagOne: "include",
      tagTwo: "include",
      tagThree: "include"
    };
  }

  function updateMaterialFilterModeControls() {
    document.querySelectorAll("[data-filter-mode]").forEach((select) => {
      const key = select.dataset.filterMode;
      select.value = state.materialFilterModes?.[key] || "include";
    });
  }

  function filterByMode(activeValue, matched, key) {
    if (!activeValue) return true;
    const mode = state.materialFilterModes?.[key] || "include";
    return mode === "exclude" ? !matched : matched;
  }

  const $ = (selector) => document.querySelector(selector);

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    $("#todayPill").textContent = new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long"
    }).format(new Date());

    initSupabase();
    bindNavigation();
    bindCloudAuth();
    bindTodo();
    bindGoals();
    bindMaterials();
    bindBrain();
    bindMemoryInputs();
    seedMaterialMemory();
    seedOnboardingGoals();
    renderAll();
    updateCloudUI("已加载本地缓存，正在恢复登录状态。");
    restoreCloudSession();
  }

  function initSupabase() {
    const config = window.PM_SUPABASE || FALLBACK_SUPABASE_CONFIG;
    if (!config?.url || !config?.anonKey) {
      updateCloudUI("Supabase 配置没有加载成功，当前先使用本地存储。");
      return;
    }
    if (!window.supabase?.createClient) {
      updateCloudUI("云端登录组件加载失败，当前先使用本地存储。请刷新页面或检查网络。");
      return;
    }
    state.supabaseAuthKey = config.authStorageKey || deriveSupabaseAuthKey(config.url);
    state.supabase = window.supabase.createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage,
        storageKey: state.supabaseAuthKey
      }
    });
    state.cloudReady = true;
  }

  function deriveSupabaseAuthKey(url) {
    try {
      const ref = new URL(url).hostname.split(".")[0];
      return `sb-${ref}-auth-token`;
    } catch {
      return "pm.supabase.auth-token";
    }
  }

  function bindCloudAuth() {
    $("#authEmail").value = localStorage.getItem(LAST_EMAIL_KEY) || "";
    $("#authForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      await signIn();
    });
    $("#signUpBtn").addEventListener("click", signUp);
    $("#signOutBtn").addEventListener("click", signOut);
    $("#refreshCloudData").addEventListener("click", loadCloudData);
    $("#migrateLocalData").addEventListener("click", migrateLocalDataToCloud);
    $("#exportLocalData").addEventListener("click", exportBackupData);
    $("#downloadLocalBackup").addEventListener("click", exportBackupData);
    $("#importLocalData").addEventListener("click", () => $("#importDataFile").click());
    $("#importDataFile").addEventListener("change", importBackupData);
    $("#avatarInput").addEventListener("change", updateAvatar);
  }

  async function restoreCloudSession() {
    if (!state.supabase) {
      state.cloudSessionChecked = true;
      updateCloudUI();
      return;
    }
    subscribeAuthChanges();
    const cachedUser = readCachedSupabaseUser();
    if (cachedUser) {
      unlockLocalData();
      state.user = cachedUser;
      state.cloudSessionChecked = true;
      updateCloudUI("已从本机恢复登录；云端连接慢也不会影响本地使用。");
      window.setTimeout(() => refreshSessionInBackground(), 300);
      window.setTimeout(() => syncPendingThenLoadCloud({ background: true, passive: true }), 800);
      return;
    }
    try {
      const { data } = await withTimeout(state.supabase.auth.getSession(), 18000, "恢复登录状态");
      state.user = data.session?.user || null;
      if (state.user) unlockLocalData();
      state.cloudSessionChecked = true;
      updateCloudUI(state.user ? "已恢复登录，正在后台同步云端数据。" : "未登录，当前使用本地缓存。");
      if (state.user) syncPendingThenLoadCloud({ background: true, passive: true });
    } catch (error) {
      state.cloudSessionChecked = true;
      console.warn(error.message);
      updateCloudUI("云端登录检查较慢，已继续使用本地缓存；你可以稍后再登录或刷新云端数据。");
    }
  }

  function subscribeAuthChanges() {
    if (state.cloudAuthSubscribed || !state.supabase) return;
    state.cloudAuthSubscribed = true;
    state.supabase.auth.onAuthStateChange(async (_event, session) => {
      if (_event === "INITIAL_SESSION" && state.cloudSessionChecked) return;
      const previousUserId = state.user?.id || "";
      state.user = session?.user || null;
      if (state.user) unlockLocalData();
      if (state.user) state.cloudPausedUntil = 0;
      updateCloudUI(state.user ? "登录状态已恢复，正在后台同步云端数据。" : "未登录，当前使用本地缓存。");
      if (state.user && state.user.id !== previousUserId) syncPendingThenLoadCloud({ background: true, passive: true });
    });
  }

  async function refreshSessionInBackground() {
    try {
      const { data } = await withTimeout(state.supabase.auth.getSession(), 22000, "刷新登录状态");
      if (data.session?.user) {
        unlockLocalData();
        state.user = data.session.user;
        updateCloudUI("登录状态已确认，云端同步会在后台进行。");
      }
    } catch (error) {
      console.warn(error.message);
      updateCloudUI("已使用本机登录缓存；云端连接较慢，本地修改仍会正常保存。");
    }
  }

  function readCachedSupabaseUser() {
    if (!state.supabaseAuthKey) return null;
    try {
      const raw = localStorage.getItem(state.supabaseAuthKey);
      if (!raw) return null;
      const auth = JSON.parse(raw);
      return auth?.user || auth?.currentSession?.user || auth?.session?.user || null;
    } catch {
      return null;
    }
  }

  async function signIn() {
    if (!ensureCloudReady()) return;
    const email = $("#authEmail").value.trim();
    const password = $("#authPassword").value;
    if (!email || !password) {
      alert("请填写邮箱和密码");
      return;
    }
    updateCloudUI("正在登录...");
    const { data, error } = await withTimeout(
      state.supabase.auth.signInWithPassword({ email, password }),
      30000,
      "登录"
    );
    if (error) {
      updateCloudUI();
      alert(error.message);
      return;
    }
    state.user = data.user;
    unlockLocalData();
    state.cloudPausedUntil = 0;
    if (email) localStorage.setItem(LAST_EMAIL_KEY, email);
    $("#authPassword").value = "";
    updateCloudUI("登录成功，正在后台同步云端数据。");
    syncPendingThenLoadCloud({ background: true });
  }

  async function signUp() {
    if (!ensureCloudReady()) return;
    const email = $("#authEmail").value.trim();
    const password = $("#authPassword").value;
    if (!email || password.length < 6) {
      alert("请填写邮箱，并设置至少 6 位密码");
      return;
    }
    updateCloudUI("正在注册...");
    const { data, error } = await withTimeout(
      state.supabase.auth.signUp({ email, password }),
      30000,
      "注册"
    );
    if (error) {
      updateCloudUI();
      alert(error.message);
      return;
    }
    state.user = data.user;
    unlockLocalData();
    state.cloudPausedUntil = 0;
    if (email) localStorage.setItem(LAST_EMAIL_KEY, email);
    $("#authPassword").value = "";
    alert(data.session ? "注册成功，已登录。" : "注册成功，请按 Supabase 邮件设置完成验证后再登录。");
    if (data.session) await migrateLocalDataToCloud();
    updateCloudUI();
  }

  async function signOut() {
    if (!state.supabase) return;
    let shouldClearPending = false;
    if (state.user && hasPendingCloudChanges()) {
      updateCloudUI("正在退出前保存未同步数据到云端...");
      try {
        await flushPendingCloudChanges({ force: true });
      } catch (error) {
        console.warn(error.message);
        const keepWorking = !confirm("云端保存暂时失败。建议先不要退出，等网络恢复后再退出。若仍然退出，本机会隐藏页面数据并保留本地备份，之后可通过备份恢复。是否仍然退出登录？");
        if (keepWorking) {
          updateCloudUI("已取消退出；本地数据仍然安全保存。");
          return;
        }
        shouldClearPending = true;
      }
    }
    writeLocalBackupSnapshot(readPrimaryLocalSnapshot(), "sign-out");
    await withTimeout(state.supabase.auth.signOut(), 10000, "退出登录").catch((error) => console.warn(error.message));
    state.user = null;
    lockLocalData();
    clearPrivateLocalCache({ clearPending: shouldClearPending || !hasPendingCloudChanges() });
    setEmptyPrivateState();
    $("#authPassword").value = "";
    updateCloudUI("已退出登录，页面已隐藏账号数据；本地备份仍保留。");
    renderAll();
  }

  function lockLocalData() {
    localStorage.setItem(LOCAL_DATA_LOCK_KEY, "1");
  }

  function unlockLocalData() {
    localStorage.removeItem(LOCAL_DATA_LOCK_KEY);
  }

  function isLocalDataLocked() {
    return localStorage.getItem(LOCAL_DATA_LOCK_KEY) === "1";
  }

  function clearPrivateLocalCache(options = {}) {
    ["pm.todos", "pm.goals", "pm.materials", "pm.ideas", "pm.docs", "pm.materialMemory"].forEach((key) => {
      localStorage.removeItem(key);
    });
    if (options.clearPending) {
      localStorage.setItem(PENDING_CLOUD_KEYS, JSON.stringify([]));
    }
  }

  function setEmptyPrivateState() {
    state.goals = [];
    state.todos = [];
    state.materials = [];
    state.ideas = [];
    state.docs = [];
    state.memory = normalizeMemory({});
    state.materialFilters = { week: "", scriptType: "", scriptStatus: "", progress: "", tagOne: "", tagTwo: "", tagThree: "" };
    state.materialFilterModes = defaultMaterialFilterModes();
    state.reviewWeek = "";
    state.statsMonth = getMonthLabel(toISODate(new Date()));
    state.assetDrafts = [];
  }

  function updateCloudUI(message = "") {
    const signedIn = Boolean(state.user);
    const checkingSession = state.cloudReady && !state.cloudSessionChecked && !signedIn;
    const cloudPaused = signedIn && Date.now() < state.cloudPausedUntil;
    const localLocked = !signedIn && isLocalDataLocked();
    $("#authForm").classList.toggle("hidden", signedIn || checkingSession);
    $("#cloudActions").classList.toggle("hidden", !signedIn);
    $("#cloudTitle").textContent = signedIn
      ? state.user.email || "个人账号"
      : checkingSession
        ? "正在恢复上次登录"
        : "登录后同步数据";
    $("#cloudStatus").textContent = message || (signedIn
      ? cloudPaused
        ? "本地优先，稍后可刷新云端。"
        : "云端同步中，换设备登录也能用。"
      : checkingSession
        ? "正在读取浏览器保存的登录状态。"
        : state.cloudReady
          ? localLocked ? "已退出，账号数据已隐藏。" : "未登录时仍可本地使用。"
          : "云端未就绪，先用本地存储。");
    $("#storageMode").textContent = signedIn ? (cloudPaused ? "本地优先存储" : "云端同步存储") : localLocked ? "已退出登录" : "本地演示存储";
    $("#storageDetail").textContent = signedIn ? (cloudPaused ? "本地保存 + 云端稍后重试" : "云端数据库 + 文件存储") : localLocked ? "账号数据已隐藏，本地备份保留" : "浏览器本地存储";
    renderAvatar();
    updateSafetyUI();
  }

  async function updateAvatar(event) {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (!state.user) {
      alert("请先登录账号，再上传头像。");
      return;
    }
    if (!file.type.startsWith("image/")) {
      alert("请选择图片文件。");
      return;
    }
    try {
      const avatarData = await imageFileToAvatarDataUrl(file);
      state.memory = normalizeMemory(state.memory);
      state.memory.profile = {
        ...(state.memory.profile || {}),
        email: state.user.email || "",
        avatarData,
        updatedAt: Date.now()
      };
      save("pm.materialMemory", state.memory);
      updateCloudUI("头像已保存，会跟随账号同步。");
    } catch (error) {
      console.warn(error.message);
      alert("头像保存失败，请换一张图片再试。");
    }
  }

  function renderAvatar() {
    const img = $("#userAvatar");
    const initial = $("#avatarInitial");
    if (!img || !initial) return;
    const avatarData = normalizeMemory(state.memory).profile?.avatarData || "";
    if (avatarData) {
      img.src = avatarData;
      img.classList.remove("hidden");
      initial.classList.add("hidden");
      return;
    }
    img.removeAttribute("src");
    img.classList.add("hidden");
    initial.classList.remove("hidden");
    initial.textContent = (state.user?.email || "薇").trim().slice(0, 1).toUpperCase();
  }

  function updateSafetyUI() {
    const backup = load(LOCAL_BACKUP_KEY, null);
    const lastLocal = backup?.savedAt || "";
    const lastCloud = localStorage.getItem(LAST_CLOUD_SYNC_KEY) || "";
    const pendingKeys = getPendingCloudKeys();
    if ($("#lastLocalBackupTime")) $("#lastLocalBackupTime").textContent = formatDateTime(lastLocal);
    if ($("#lastCloudSyncTime")) $("#lastCloudSyncTime").textContent = formatDateTime(lastCloud);
    if ($("#pendingCloudState")) {
      $("#pendingCloudState").textContent = pendingKeys.length ? `${pendingKeys.length} 项待同步` : "无";
    }
  }

  function formatDateTime(value) {
    if (!value) return "暂无";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "暂无";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  async function imageFileToAvatarDataUrl(file) {
    const dataUrl = await fileToDataUrl(file);
    const image = await loadImage(dataUrl);
    const size = 180;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    const scale = Math.max(size / image.width, size / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
    return canvas.toDataURL("image/png");
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function ensureCloudReady() {
    if (state.supabase) return true;
    if (!window.supabase?.createClient) {
      alert("云端登录组件还没有加载成功，请刷新页面或换个网络再试。本地数据不会丢。");
      return false;
    }
    alert("Supabase 配置没有加载成功，当前会继续使用本地存储。");
    return false;
  }

  async function loadCloudData(options = {}) {
    if (!state.supabase || !state.user || state.cloudLoading) return;
    if (hasPendingCloudChanges() && !options.skipPendingFlush) {
      try {
        await flushPendingCloudChanges({ force: !options.passive });
      } catch (error) {
        console.warn(error.message);
        pauseCloudSync("本地仍有未同步修改，已暂停读取云端，避免旧云端数据覆盖本地。");
        return;
      }
      if (hasPendingCloudChanges()) return;
    }
    if (!options.passive) state.cloudPausedUntil = 0;
    const localSnapshot = readLocalSnapshot();
    state.cloudLoading = true;
    updateCloudUI(options.background ? "正在后台读取云端数据，本地缓存会先保留。" : "正在读取云端数据...");
    let response;
    try {
      response = await retryCloud(
        () => withTimeout(
          state.supabase
            .from("app_items")
            .select("kind,id,data,updated_at")
            .order("updated_at", { ascending: false }),
          options.passive ? 18000 : 35000,
          "读取云端数据"
        ),
        options.passive ? 0 : 1
      );
    } catch (error) {
      state.cloudLoading = false;
      console.warn(error.message);
      state.todos = localSnapshot.todos;
      state.goals = localSnapshot.goals;
      state.materials = localSnapshot.materials;
      state.ideas = localSnapshot.ideas;
      state.docs = localSnapshot.docs;
      state.memory = localSnapshot.memory;
      renderAll();
      pauseCloudSync("云端读取较慢，已切到本地优先模式；本地数据不会被清空。");
      return;
    }
    state.cloudLoading = false;
    const { data, error } = response;
    if (error) {
      console.warn(error.message);
      state.todos = localSnapshot.todos;
      state.goals = localSnapshot.goals;
      state.materials = localSnapshot.materials;
      state.ideas = localSnapshot.ideas;
      state.docs = localSnapshot.docs;
      state.memory = localSnapshot.memory;
      renderAll();
      pauseCloudSync(`云端读取失败，已保留本地缓存：${error.message}`);
      return;
    }
    markCloudSynced();
    const grouped = {
      todos: [],
      goals: [],
      materials: [],
      ideas: [],
      docs: [],
      memory: null
    };
    (data || []).forEach((row) => {
      if (row.kind === "memory") {
        grouped.memory = row.data;
      } else if (Array.isArray(grouped[row.kind])) {
        grouped[row.kind].push(row.data);
      }
    });
    const hasCloudData = Boolean((data || []).length);
    if (!hasCloudData && hasAnyLocalData(localSnapshot)) {
      state.todos = localSnapshot.todos;
      state.goals = localSnapshot.goals;
      state.materials = localSnapshot.materials;
      state.ideas = localSnapshot.ideas;
      state.docs = localSnapshot.docs;
      state.memory = localSnapshot.memory;
      updateCloudUI("云端还是空的，已保留当前浏览器本地数据。请点“迁移本地数据到云端”。");
      renderAll();
      return;
    }
    const hasKind = (kind) => (data || []).some((row) => row.kind === kind);
    state.todos = hasKind("todos") ? mergeCloudAndLocalItems(localSnapshot.todos, grouped.todos) : localSnapshot.todos;
    state.goals = hasKind("goals") ? mergeCloudAndLocalItems(localSnapshot.goals, grouped.goals) : localSnapshot.goals;
    state.materials = hasKind("materials") ? mergeCloudAndLocalItems(localSnapshot.materials, grouped.materials) : localSnapshot.materials;
    state.ideas = hasKind("ideas") ? mergeCloudAndLocalItems(localSnapshot.ideas, grouped.ideas) : localSnapshot.ideas;
    state.docs = hasKind("docs") ? mergeCloudAndLocalItems(localSnapshot.docs, grouped.docs) : localSnapshot.docs;
    state.memory = hasKind("memory") ? mergeMemory(localSnapshot.memory, grouped.memory) : localSnapshot.memory;
    saveLocalSnapshot();
    updateCloudUI("云端数据已同步。");
    renderAll();
  }

  function mergeCloudAndLocalItems(localItems = [], cloudItems = []) {
    const items = new Map();
    [...cloudItems, ...localItems].forEach((item) => {
      if (!item?.id) return;
      const existing = items.get(item.id);
      if (!existing || itemTimestamp(item) >= itemTimestamp(existing)) {
        items.set(item.id, item);
      }
    });
    return [...items.values()];
  }

  function itemTimestamp(item = {}) {
    return Number(item.updatedAt || item.createdAt || 0);
  }

  function mergeMemory(localMemory = {}, cloudMemory = {}) {
    const local = normalizeMemory(localMemory);
    const cloud = normalizeMemory(cloudMemory);
    const memory = ["projects", "vendors", "tagOne", "tagTwo", "tagThree"].reduce((result, key) => {
      result[key] = [...new Set([...(cloud[key] || []), ...(local[key] || [])])];
      return result;
    }, {});
    memory.profile = newerProfile(local.profile, cloud.profile);
    return memory;
  }

  function normalizeMemory(memory = {}) {
    return ["projects", "vendors", "tagOne", "tagTwo", "tagThree"].reduce((result, key) => {
      result[key] = Array.isArray(memory?.[key]) ? memory[key] : [];
      return result;
    }, {
      profile: memory?.profile || {}
    });
  }

  function newerProfile(localProfile = {}, cloudProfile = {}) {
    const localTime = Number(localProfile?.updatedAt || 0);
    const cloudTime = Number(cloudProfile?.updatedAt || 0);
    return cloudTime > localTime ? cloudProfile : localProfile;
  }

  function readLocalSnapshot() {
    const snapshot = {
      todos: loadArray("pm.todos"),
      goals: loadArray("pm.goals"),
      materials: loadArray("pm.materials"),
      ideas: loadArray("pm.ideas"),
      docs: loadArray("pm.docs"),
      memory: normalizeMemory(load("pm.materialMemory", { projects: [], vendors: [], tagOne: [], tagTwo: [], tagThree: [] }))
    };
    if (hasAnyLocalData(snapshot)) return snapshot;
    return readLocalBackupSnapshot() || snapshot;
  }

  function readPrimaryLocalSnapshot() {
    return {
      todos: loadArray("pm.todos"),
      goals: loadArray("pm.goals"),
      materials: loadArray("pm.materials"),
      ideas: loadArray("pm.ideas"),
      docs: loadArray("pm.docs"),
      memory: normalizeMemory(load("pm.materialMemory", { projects: [], vendors: [], tagOne: [], tagTwo: [], tagThree: [] }))
    };
  }

  function readLocalBackupSnapshot() {
    const backup = load(LOCAL_BACKUP_KEY, null);
    if (!backup?.data) return null;
    return {
      todos: Array.isArray(backup.data.todos) ? backup.data.todos : [],
      goals: Array.isArray(backup.data.goals) ? backup.data.goals : [],
      materials: Array.isArray(backup.data.materials) ? backup.data.materials : [],
      ideas: Array.isArray(backup.data.ideas) ? backup.data.ideas : [],
      docs: Array.isArray(backup.data.docs) ? backup.data.docs : [],
      memory: normalizeMemory(backup.data.memory || { projects: [], vendors: [], tagOne: [], tagTwo: [], tagThree: [] })
    };
  }

  function hasAnyLocalData(snapshot) {
    const memory = normalizeMemory(snapshot.memory);
    return snapshot.todos.length
      || snapshot.goals.length
      || snapshot.materials.length
      || snapshot.ideas.length
      || snapshot.docs.length
      || memory.projects.length
      || memory.vendors.length
      || memory.tagOne.length
      || memory.tagTwo.length
      || memory.tagThree.length
      || Boolean(memory.profile?.avatarData);
  }

  function persistCloud(key, value) {
    if (!state.supabase || !state.user) return Promise.resolve();
    markCloudPending(key);
    if (Date.now() < state.cloudPausedUntil) return Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(value));
    state.cloudSavePromise = state.cloudSavePromise
      .then(() => persistCloudNow(key, snapshot))
      .then(() => clearCloudPending(key))
      .catch((error) => {
        console.warn(error.message);
        pauseCloudSync(`云端保存失败：${error.message}`);
      });
    return state.cloudSavePromise;
  }

  async function persistCloudNow(key, value) {
    const kind = cloudKindFromKey(key);
    if (!kind) return;
    if (kind === "memory") {
      const { error } = await withTimeout(state.supabase.from("app_items").upsert({
        id: "memory",
        user_id: state.user.id,
        kind,
        data: value,
        updated_at: new Date().toISOString()
      }), 15000, "保存标签记忆");
      if (error) throw new Error(error.message);
      markCloudSynced();
      return;
    }
    const items = Array.isArray(value) ? value : [];
    const deleted = await withTimeout(
      state.supabase.from("app_items").delete().eq("kind", kind).eq("user_id", state.user.id),
      15000,
      `清理${kind}`
    );
    if (deleted.error) {
      throw new Error(deleted.error.message);
    }
    if (!items.length) {
      markCloudSynced();
      return;
    }
    const rows = items.map((item) => ({
      id: item.id,
      user_id: state.user.id,
      kind,
      data: item,
      updated_at: new Date(item.updatedAt || item.createdAt || Date.now()).toISOString()
    }));
    const { error } = await withTimeout(state.supabase.from("app_items").insert(rows), 20000, `保存${kind}`);
    if (error) throw new Error(error.message);
    markCloudSynced();
  }

  function markCloudSynced() {
    localStorage.setItem(LAST_CLOUD_SYNC_KEY, new Date().toISOString());
    updateSafetyUI();
  }

  async function replaceCloudSnapshot(snapshot) {
    if (!state.supabase || !state.user) return;
    await state.cloudSavePromise;
    state.cloudSavePromise = Promise.resolve();
    await persistCloudNow("pm.todos", snapshot.todos);
    await persistCloudNow("pm.goals", snapshot.goals);
    await persistCloudNow("pm.materials", snapshot.materials);
    await persistCloudNow("pm.ideas", snapshot.ideas);
    await persistCloudNow("pm.docs", snapshot.docs);
    await persistCloudNow("pm.materialMemory", snapshot.memory);
    localStorage.setItem(PENDING_CLOUD_KEYS, JSON.stringify([]));
  }

  async function syncPendingThenLoadCloud(options = {}) {
    try {
      await flushPendingCloudChanges({ force: !options.passive });
    } catch (error) {
      console.warn(error.message);
      if (options.passive) return;
    }
    loadCloudData(options);
  }

  async function flushPendingCloudChanges(options = {}) {
    if (!state.supabase || !state.user) return;
    if (!options.force && Date.now() < state.cloudPausedUntil) return;
    const pendingKeys = getPendingCloudKeys();
    if (!pendingKeys.length) return;
    state.cloudPausedUntil = 0;
    updateCloudUI("正在把本地未同步修改保存到云端...");
    await state.cloudSavePromise;
    state.cloudSavePromise = Promise.resolve();
    for (const key of pendingKeys) {
      await retryCloud(
        () => persistCloudNow(key, valueForCloudKey(key)),
        options.force ? 1 : 0
      );
      clearCloudPending(key);
    }
    updateCloudUI("本地未同步修改已保存到云端。");
  }

  function valueForCloudKey(key) {
    return {
      "pm.todos": loadArray("pm.todos"),
      "pm.goals": loadArray("pm.goals"),
      "pm.materials": loadArray("pm.materials"),
      "pm.ideas": loadArray("pm.ideas"),
      "pm.docs": loadArray("pm.docs"),
      "pm.materialMemory": load("pm.materialMemory", { projects: [], vendors: [], tagOne: [], tagTwo: [], tagThree: [] })
    }[key] || [];
  }

  function getPendingCloudKeys() {
    return loadArray(PENDING_CLOUD_KEYS).filter((key) => cloudKindFromKey(key));
  }

  function hasPendingCloudChanges() {
    return getPendingCloudKeys().length > 0;
  }

  function markCloudPending(key) {
    if (!cloudKindFromKey(key)) return;
    const keys = new Set(getPendingCloudKeys());
    keys.add(key);
    localStorage.setItem(PENDING_CLOUD_KEYS, JSON.stringify([...keys]));
    updateSafetyUI();
  }

  function clearCloudPending(key) {
    const keys = getPendingCloudKeys().filter((entry) => entry !== key);
    localStorage.setItem(PENDING_CLOUD_KEYS, JSON.stringify(keys));
    updateSafetyUI();
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error(`${label}超时，请检查网络或 Supabase 设置`)), ms);
      })
    ]);
  }

  async function retryCloud(task, retries = 0) {
    let lastError;
    for (let index = 0; index <= retries; index += 1) {
      try {
        return await task();
      } catch (error) {
        lastError = error;
        if (index < retries) await wait(1200 * (index + 1));
      }
    }
    throw lastError;
  }

  function pauseCloudSync(message) {
    state.cloudPausedUntil = Date.now() + 5 * 60 * 1000;
    scheduleCloudRetry();
    updateCloudUI(`${message} 本地修改已保存，5 分钟后会自动恢复尝试；也可以手动点“刷新云端数据”。`);
  }

  function scheduleCloudRetry() {
    if (state.cloudRetryTimer) window.clearTimeout(state.cloudRetryTimer);
    state.cloudRetryTimer = window.setTimeout(() => {
      state.cloudRetryTimer = null;
      syncPendingThenLoadCloud({ background: true, passive: true });
    }, Math.max(1000, state.cloudPausedUntil - Date.now() + 500));
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function cloudKindFromKey(key) {
    return {
      "pm.todos": "todos",
      "pm.goals": "goals",
      "pm.materials": "materials",
      "pm.ideas": "ideas",
      "pm.docs": "docs",
      "pm.materialMemory": "memory"
    }[key] || "";
  }

  async function migrateLocalDataToCloud() {
    if (!state.supabase || !state.user) {
      alert("请先登录账号，再迁移本地数据。");
      return;
    }
    if (!confirm("会把当前浏览器里的本地数据覆盖到你的云端账号中，确认继续吗？")) return;
    updateCloudUI("正在迁移本地数据和附件...");
    const localData = readLocalSnapshot();
    if (!hasAnyLocalData(localData)) {
      alert("当前这个网页域名下没有可迁移的本地数据。如果旧数据在 localhost，请先在 localhost 页面导出备份，再到线上导入。");
      updateCloudUI();
      return;
    }
    for (const item of localData.materials) {
      for (const key of materialVideoKeys(item)) await copyLocalFileToCloud(key);
      if (item.metricKey) await copyLocalFileToCloud(item.metricKey);
    }
    for (const doc of localData.docs) {
      if (doc.attachmentKey) await copyLocalFileToCloud(doc.attachmentKey);
    }
    for (const idea of localData.ideas) {
      for (const image of ideaImageEntries(idea)) {
        await copyLocalFileToCloud(image.key);
      }
    }
    state.todos = localData.todos;
    state.goals = localData.goals;
    state.materials = localData.materials;
    state.ideas = localData.ideas;
    state.docs = localData.docs;
    state.memory = normalizeMemory(localData.memory);
    save("pm.todos", state.todos);
    save("pm.goals", state.goals);
    save("pm.materials", state.materials);
    save("pm.ideas", state.ideas);
    save("pm.docs", state.docs);
    save("pm.materialMemory", state.memory);
    await state.cloudSavePromise;
    updateCloudUI("本地数据已迁移到云端。");
    renderAll();
  }

  async function exportBackupData() {
    updateCloudUI("正在打包本地数据...");
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      ...readLocalSnapshot(),
      files: {}
    };
    const fileKeys = [
      ...backup.materials.flatMap((item) => [...materialVideoKeys(item), item.metricKey]),
      ...backup.docs.map((doc) => doc.attachmentKey),
      ...backup.ideas.flatMap((idea) => ideaImageEntries(idea).map((image) => image.key))
    ].filter(Boolean);
    for (const key of [...new Set(fileKeys)]) {
      const file = await getLocalFile(key);
      if (file) {
        backup.files[key] = {
          name: file.name || key,
          type: file.type || "application/octet-stream",
          dataUrl: await fileToDataUrl(file)
        };
      }
    }
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `personal-manager-backup-${toISODate(new Date())}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    updateCloudUI("本地数据备份已导出。");
  }

  async function importBackupData(event) {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (!state.user) {
      alert("请先登录账号，再导入数据。");
      return;
    }
    if (!confirm("导入后会覆盖当前账号的云端数据，确认继续吗？")) return;
    try {
      updateCloudUI("正在读取备份文件...");
      const backup = JSON.parse(await file.text());
      const files = backup.files || {};
      for (const [key, meta] of Object.entries(files)) {
        const blob = dataUrlToBlob(meta.dataUrl, meta.type);
        const restoredFile = new File([blob], meta.name || key, { type: meta.type || blob.type });
        await putCloudFile(key, restoredFile);
        await putLocalFile(key, restoredFile);
      }
      const snapshot = {
        todos: Array.isArray(backup.todos) ? backup.todos : [],
        goals: Array.isArray(backup.goals) ? backup.goals : [],
        materials: Array.isArray(backup.materials) ? backup.materials : [],
        ideas: Array.isArray(backup.ideas) ? backup.ideas : [],
        docs: Array.isArray(backup.docs) ? backup.docs : [],
        memory: normalizeMemory(backup.memory || { projects: [], vendors: [], tagOne: [], tagTwo: [], tagThree: [] })
      };
      state.todos = snapshot.todos;
      state.goals = snapshot.goals;
      state.materials = snapshot.materials;
      state.ideas = snapshot.ideas;
      state.docs = snapshot.docs;
      state.memory = normalizeMemory(snapshot.memory);
      saveLocalSnapshot();
      renderAll();
      updateCloudUI("本地已恢复，正在同步云端...");
      await replaceCloudSnapshot(snapshot);
      updateCloudUI("数据已导入并同步到云端。");
    } catch (error) {
      console.error(error);
      updateCloudUI("导入没有完成，请查看提示后重试。");
      alert(error.message || "导入失败，请刷新页面后重试。");
    }
  }

  async function copyLocalFileToCloud(key) {
    const file = await getLocalFile(key);
    if (file) await putCloudFile(key, file);
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function dataUrlToBlob(dataUrl, fallbackType = "application/octet-stream") {
    const [header, base64] = String(dataUrl).split(",");
    const type = header.match(/data:(.*?);base64/)?.[1] || fallbackType;
    const binary = atob(base64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type });
  }

  function saveLocalSnapshot() {
    localStorage.setItem("pm.todos", JSON.stringify(state.todos));
    localStorage.setItem("pm.goals", JSON.stringify(state.goals));
    localStorage.setItem("pm.materials", JSON.stringify(state.materials));
    localStorage.setItem("pm.ideas", JSON.stringify(state.ideas));
    localStorage.setItem("pm.docs", JSON.stringify(state.docs));
    localStorage.setItem("pm.materialMemory", JSON.stringify(state.memory));
    writeLocalBackupSnapshot({
      todos: state.todos,
      goals: state.goals,
      materials: state.materials,
      ideas: state.ideas,
      docs: state.docs,
      memory: state.memory
    }, "snapshot");
  }

  function writeLocalBackupSnapshot(snapshot, reason = "auto") {
    if (!hasAnyLocalData(snapshot)) return;
    localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify({
      version: 1,
      reason,
      savedAt: new Date().toISOString(),
      data: snapshot
    }));
    updateSafetyUI();
  }

  function bindNavigation() {
    document.querySelectorAll(".nav-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.view = tab.dataset.view;
        document.querySelectorAll(".nav-tab").forEach((item) => item.classList.toggle("active", item === tab));
        document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
        $(`#${state.view}View`).classList.add("active");
        $("#pageTitle").textContent = tab.textContent;
      });
    });
  }

  function bindTodo() {
    $("#prevMonth").addEventListener("click", () => {
      state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
      renderCalendar();
    });
    $("#nextMonth").addEventListener("click", () => {
      state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
      renderCalendar();
    });
    $("#openSelectedTodo").addEventListener("click", () => openTodoDialog(state.selectedDate));
    $("#jumpToday").addEventListener("click", () => selectTodoDate(toISODate(new Date()), true));
    $("#closeTodoDialog").addEventListener("click", () => $("#todoDialog").close());
    $("#clearTodoEdit").addEventListener("click", () => {
      resetTodoForm();
      renderTodoDialog();
    });
    $("#todoForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const payload = {
        id: state.editingTodoId || crypto.randomUUID(),
        date: state.selectedDate,
        title: $("#todoTitle").value.trim(),
        desc: $("#todoDesc").value.trim(),
        type: new FormData(event.currentTarget).get("todoType"),
        done: state.editingTodoId ? state.todos.find((item) => item.id === state.editingTodoId)?.done || false : false,
        updatedAt: Date.now()
      };
      state.todos = state.todos.filter((item) => item.id !== payload.id).concat(payload);
      save("pm.todos", state.todos);
      resetTodoForm();
      renderCalendar();
      renderTodayTasks();
      renderTodoDialog();
    });
  }

  function bindGoals() {
    $("#goalForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const editing = state.goals.find((goal) => goal.id === state.editingGoalId);
      const progress = clampPercent($("#goalProgress").value);
      const completedAt = progress >= 100 ? ($("#goalCompletedAt").value || editing?.completedAt || toISODate(new Date())) : "";
      const goal = {
        id: editing?.id || crypto.randomUUID(),
        type: $("#goalType").value,
        title: $("#goalTitle").value.trim(),
        detail: $("#goalDetail").value.trim(),
        ddl: $("#goalDDL").value,
        progress,
        progressNote: $("#goalProgressNote").value.trim(),
        completedAt,
        done: progress >= 100 && Boolean(completedAt),
        createdAt: editing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      state.goals = editing
        ? state.goals.map((item) => item.id === goal.id ? goal : item)
        : [goal, ...state.goals];
      save("pm.goals", state.goals);
      resetGoalForm();
      renderGoals();
    });
    $("#cancelGoalEdit").addEventListener("click", resetGoalForm);
  }

  function seedOnboardingGoals() {
    const seedGoals = [
      {
        type: "业务产出",
        title: "入职第1个月：通过并进入生产的精品脚本 >= 20条",
        detail: "阶段性产出目标。入职日期：2026-05-14；第1个月周期约为 2026-05-14 至 2026-06-13。",
        ddl: "2026-06-13"
      },
      {
        type: "业务产出",
        title: "入职第2个月起：每月稳定通过的精品脚本 >= 30条",
        detail: "阶段性/长期月度目标，从入职第2个月起持续追踪，不设置单一 DDL。",
        ddl: ""
      },
      {
        type: "业务产出",
        title: "7月前：交付小程序买量素材 >= 15条，并产出1份阶段性沉淀总结文档",
        detail: "业务素材条数与复盘沉淀目标。",
        ddl: "2026-06-30"
      },
      {
        type: "业务产出",
        title: "国内OB公测前：交付小程序素材 >= 120条",
        detail: "国内 OB 公测前，即九月底之前完成。",
        ddl: "2026-09-30"
      },
      {
        type: "业务产出",
        title: "最终总交付：APP + 小程序买量素材总数 >= 240条",
        detail: "最终总交付目标，11月13日之前完成。",
        ddl: "2026-11-13"
      },
      {
        type: "业务产出",
        title: "国内消耗占比 >= 30%",
        detail: "消耗与线上数据指标，看后台数据追踪。",
        ddl: ""
      },
      {
        type: "业务产出",
        title: "全球消耗占比 >= 15%",
        detail: "消耗与线上数据指标，看后台数据追踪。",
        ddl: ""
      },
      {
        type: "其他维度",
        title: "《闪耀吧！噜咪》冒险等级达到60级（不开GM）",
        detail: "游戏体验指标，入职1个月内完成。",
        ddl: "2026-06-13"
      },
      {
        type: "其他维度",
        title: "《Monopoly Go》等级达到500级",
        detail: "游戏体验指标，入职1个月内完成。",
        ddl: "2026-06-13"
      },
      {
        type: "其他维度",
        title: "SOP沉淀：完成1份《国内UA素材AI生产SOP》的梳理与优化",
        detail: "AI生产指标，沉淀可复用方法论与流程。",
        ddl: ""
      },
      {
        type: "其他维度",
        title: "AI物料占比：AI类生产物料在整体物料中占比 >= 20%",
        detail: "AI生产指标，包含平面/视频等AI类生产物料。",
        ddl: ""
      }
    ];
    const existingTitles = new Set(state.goals.map((goal) => goal.title));
    const newGoals = seedGoals
      .filter((goal) => !existingTitles.has(goal.title))
      .map((goal, index) => ({
        id: crypto.randomUUID(),
        type: goal.type,
        title: goal.title,
        detail: goal.detail,
        ddl: goal.ddl,
        done: false,
        createdAt: Date.now() - index
      }));
    if (!newGoals.length) return;
    state.goals = [...newGoals, ...state.goals];
    save("pm.goals", state.goals);
  }

  function bindMaterials() {
    $("#openMaterialModal").addEventListener("click", () => {
      resetMaterialForm();
      $("#materialDate").value = toISODate(new Date());
      $("#materialBelongDate").value = toISODate(new Date());
      $("#materialDialog").showModal();
    });
    $("#cancelMaterial").addEventListener("click", closeMaterialDialog);
    $("#closeMaterialDialog").addEventListener("click", closeMaterialDialog);
    $("#closeVideo").addEventListener("click", closeVideo);
    $("#videoDialog").addEventListener("close", closeVideo);
    $("#exportMaterials").addEventListener("click", exportMaterials);
    $("#syncFeishuMaterials").addEventListener("click", () => {
      if (!state.materials.length) {
        alert("当前还没有素材可以同步。");
        return;
      }
      syncMaterialsToFeishu(state.materials.map((item) => item.id), { manual: true, batch: true });
    });
    $("#progressPassed").addEventListener("change", (event) => {
      if (event.target.checked) setScriptStatusRadio("通过");
      if (!event.target.checked) {
        const status = document.querySelector('input[name="scriptStatus"]:checked')?.value || "";
        if (isScriptApproved(status)) setScriptStatusRadio("");
      }
    });
    document.querySelectorAll('input[name="scriptStatus"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        if (input.value === "通过") $("#progressPassed").checked = true;
        if (input.value !== "通过") $("#progressPassed").checked = false;
      });
    });
    document.querySelectorAll('input[name="assetMode"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        if (input.value === "single" && state.assetDrafts.length > 1) {
          state.assetDrafts = [state.assetDrafts[0]];
        }
        ensureAssetDrafts();
        renderAssetRows();
      });
    });
    $("#addAssetRow").addEventListener("click", () => {
      setAssetMode("multiple");
      readAssetDraftInputs();
      state.assetDrafts.push(createAssetDraft());
      renderAssetRows();
    });
    initMaterialStatsControls();
    $("#materialForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = event.submitter;
      submit.disabled = true;
      submit.textContent = "处理中...";
      try {
        const editing = state.materials.find((item) => item.id === state.editingMaterialId);
        const metricFile = $("#materialMetric").files[0];
        if (metricFile) assertCloudUploadable(metricFile);
        const id = editing?.id || crypto.randomUUID();
        const metricKey = metricFile ? `metric-${id}-${Date.now()}` : editing?.metricKey || "";
        const assets = await saveAssetDrafts(id, editing);
        const primaryAsset = assets[0] || null;
        if (metricFile) await putFile(metricKey, metricFile);
        const formData = new FormData(form);
        const progress = {
          passed: $("#progressPassed").checked,
          pushed: $("#progressPushed").checked,
          flat: $("#progressFlat").checked,
          video: $("#progressVideo").checked,
          recovered: $("#progressRecovered").checked,
          reviewSheet: $("#progressReviewSheet").checked
        };
        const rawScriptStatus = formData.get("scriptStatus") || "";
        const scriptStatus = progress.passed ? "通过" : isScriptApproved(rawScriptStatus) ? "" : rawScriptStatus;
        const payload = {
          id,
          title: $("#materialTitle").value.trim(),
          finalName: $("#materialFinalName").value.trim(),
          project: $("#projectName").value.trim(),
          scriptType: formData.get("scriptType") || "AE脚本",
          scriptLink: $("#scriptLink").value.trim(),
          storageUrl: $("#materialStorageUrl").value.trim(),
          scriptStatus,
          progress,
          vendor: $("#vendorName").value.trim(),
          tags: [$("#tagOne").value.trim(), $("#tagTwo").value.trim(), $("#tagThree").value.trim()],
          date: $("#materialDate").value,
          belongDate: $("#materialBelongDate").value || $("#materialDate").value,
          assetMode: assets.length > 1 ? "multiple" : "single",
          assets,
          videoKey: primaryAsset?.videoKey || "",
          videoName: primaryAsset?.videoName || "",
          metricKey,
          metricName: metricFile?.name || editing?.metricName || "",
          rating: Number($("#materialRating").value),
          cover: primaryAsset?.cover || editing?.cover || createPlaceholderCover($("#materialTitle").value.trim()),
          feishuRecordId: editing?.feishuRecordId || "",
          feishuSyncStatus: editing?.feishuSyncStatus || "",
          feishuSyncedAt: editing?.feishuSyncedAt || 0,
          createdAt: editing?.createdAt || Date.now(),
          updatedAt: Date.now()
        };
        state.materials = editing
          ? state.materials.map((item) => item.id === id ? payload : item)
          : [payload, ...state.materials];
        rememberMaterialFields(payload);
        save("pm.materials", state.materials);
        resetMaterialForm();
        $("#materialDialog").close();
        renderMaterials();
        syncMaterialsToFeishu([id]);
      } catch (error) {
        alert(error.message);
      } finally {
        submit.disabled = false;
        submit.textContent = "保存素材";
      }
    });
    bindMaterialFilters();
  }

  function initMaterialStatsControls() {
    $("#statsMonth").addEventListener("change", (event) => {
      state.statsMonth = event.target.value;
      renderMaterialStats();
    });
    $("#statsWeek").addEventListener("change", (event) => {
      state.statsWeek = event.target.value;
      renderMaterialStats();
    });
    $("#reviewDimension").addEventListener("change", (event) => {
      state.reviewDimension = event.target.value;
      renderMaterialReview();
    });
    $("#reviewWeek").addEventListener("change", (event) => {
      state.reviewWeek = event.target.value;
      renderMaterialReview();
    });
  }

  function bindMaterialFilters() {
    [
      ["filterWeek", "week"],
      ["filterScriptType", "scriptType"],
      ["filterScriptStatus", "scriptStatus"],
      ["filterProgress", "progress"],
      ["filterTagOne", "tagOne"],
      ["filterTagTwo", "tagTwo"],
      ["filterTagThree", "tagThree"]
    ].forEach(([id, key]) => {
      $(`#${id}`).addEventListener("change", (event) => {
        state.materialFilters[key] = event.target.value;
        renderMaterials();
      });
    });
    document.querySelectorAll("[data-filter-mode]").forEach((select) => {
      select.addEventListener("change", (event) => {
        state.materialFilterModes[event.target.dataset.filterMode] = event.target.value;
        renderMaterials();
      });
    });
    $("#clearMaterialFilters").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.materialFilters = { week: "", scriptType: "", scriptStatus: "", progress: "", tagOne: "", tagTwo: "", tagThree: "" };
      state.materialFilterModes = defaultMaterialFilterModes();
      updateMaterialFilterModeControls();
      renderMaterials();
    });
    $("#bulkField").addEventListener("change", updateBulkControl);
    $("#applyBulkEdit").addEventListener("click", applyBulkEdit);
    $("#selectAllMaterials").addEventListener("change", (event) => {
      document.querySelectorAll(".material-select").forEach((input) => {
        input.checked = event.target.checked;
      });
      updateSelectedMaterialCount();
    });
    updateBulkControl();
  }

  function bindMemoryInputs() {
    const fields = ["projectName", "vendorName", "tagOne", "tagTwo", "tagThree"];
    fields.forEach((id) => {
      const input = $(`#${id}`);
      if (!input) return;
      input.addEventListener("mousedown", (event) => {
        const menu = document.querySelector(`[data-menu-for="${id}"]`);
        if (document.activeElement === input && state.openMemoryInputId === id && menu?.classList.contains("open")) {
          event.preventDefault();
          hideMemoryMenus();
        }
      });
      input.addEventListener("focus", () => renderMemoryMenu(id));
      input.addEventListener("input", () => renderMemoryMenu(id));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hideMemoryMenus();
      });
      input.addEventListener("blur", () => {
        window.setTimeout(() => {
          if (!input.closest(".memory-field")?.contains(document.activeElement)) hideMemoryMenus();
        }, 0);
      });
    });
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".memory-field")) hideMemoryMenus();
    }, true);
  }

  function seedMaterialMemory() {
    if (load("pm.materialMemorySeeded", false)) return;
    state.materials.forEach(rememberMaterialFields);
    save("pm.materialMemorySeeded", true);
  }

  function rememberMaterialFields(item) {
    const tags = normalizedTags(item);
    addMemoryValue("projects", item.project);
    addMemoryValue("vendors", item.vendor);
    addMemoryValue("tagOne", tags[0]);
    addMemoryValue("tagTwo", tags[1]);
    addMemoryValue("tagThree", tags[2]);
    save("pm.materialMemory", state.memory);
  }

  function addMemoryValue(key, value) {
    const clean = String(value || "").trim();
    if (!clean) return;
    state.memory[key] = uniqueValues([...(state.memory[key] || []), clean]);
  }

  function memoryKeyForInput(id) {
    return {
      projectName: "projects",
      vendorName: "vendors",
      tagOne: "tagOne",
      tagTwo: "tagTwo",
      tagThree: "tagThree"
    }[id];
  }

  function renderMaterialOptions() {
    const activeId = document.activeElement?.id;
    if (memoryKeyForInput(activeId)) renderMemoryMenu(activeId);
  }

  function renderMemoryMenu(inputId) {
    const input = $(`#${inputId}`);
    const menu = document.querySelector(`[data-menu-for="${inputId}"]`);
    const key = memoryKeyForInput(inputId);
    if (!input || !menu || !key) return;
    const query = input.value.trim().toLowerCase();
    const values = (state.memory[key] || []).filter((value) => value.toLowerCase().includes(query));
    if (!values.length) {
      menu.classList.remove("open");
      menu.innerHTML = "";
      if (state.openMemoryInputId === inputId) state.openMemoryInputId = null;
      return;
    }
    menu.innerHTML = values.map((value) => `
      <div class="memory-option">
        <button type="button" data-pick="${escapeAttr(value)}">${escapeHtml(value)}</button>
        <button type="button" class="memory-delete" data-delete="${escapeAttr(value)}">删除</button>
      </div>
    `).join("");
    menu.classList.add("open");
    state.openMemoryInputId = inputId;
    menu.querySelectorAll("[data-pick]").forEach((button) => {
      button.addEventListener("click", () => {
        input.value = button.dataset.pick;
        hideMemoryMenus();
      });
    });
    menu.querySelectorAll("[data-delete]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        state.memory[key] = (state.memory[key] || []).filter((value) => value !== button.dataset.delete);
        save("pm.materialMemory", state.memory);
        renderMemoryMenu(inputId);
      });
    });
  }

  function hideMemoryMenus() {
    state.openMemoryInputId = null;
    document.querySelectorAll(".memory-menu").forEach((menu) => {
      menu.classList.remove("open");
      menu.innerHTML = "";
    });
  }

  function bindBrain() {
    $("#ideaInput").addEventListener("paste", handleIdeaPaste);
    $("#closeIdeaImage").addEventListener("click", closeIdeaImagePreview);
    $("#ideaImageDialog").addEventListener("close", closeIdeaImagePreview);
    $("#ideaImageDialog").addEventListener("click", (event) => {
      if (event.target.id === "ideaImageDialog") closeIdeaImagePreview();
    });
    $("#ideaForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = $("#ideaInput").value.trim();
      if (!text && !state.pendingIdeaImages.length) return;
      const id = crypto.randomUUID();
      const imageKeys = [];
      for (const [index, item] of state.pendingIdeaImages.entries()) {
        const key = `idea-${id}-${index}-${Date.now()}`;
        await putFile(key, item.file);
        imageKeys.push({ key, name: item.file.name || `脑暴图片-${index + 1}.png`, type: item.file.type || "image/png" });
      }
      state.ideas.unshift({ id, text, imageKeys, createdAt: Date.now() });
      save("pm.ideas", state.ideas);
      $("#ideaInput").value = "";
      clearPendingIdeaImages();
      renderIdeas();
    });
    $("#openDocModal").addEventListener("click", () => {
      resetDocForm();
      $("#docDialog").showModal();
    });
    $("#cancelDoc").addEventListener("click", closeDocDialog);
    $("#closeDocDialog").addEventListener("click", closeDocDialog);
    $("#docDialog").addEventListener("close", resetDocForm);
    $("#docForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = $("#docBody").value.trim();
      const link = $("#docLink").value.trim();
      const title = $("#docTitle").value.trim();
      const editing = state.docs.find((doc) => doc.id === state.editingDocId);
      if (!link && !editing?.attachmentKey) {
        $("#docLink").setCustomValidity("请填写文档 URL");
        $("#docLink").reportValidity();
        return;
      }
      $("#docLink").setCustomValidity("");
      const doc = {
        id: editing?.id || crypto.randomUUID(),
        category: $("#docCategory").value || "其他",
        title,
        body,
        link,
        attachmentKey: editing?.attachmentKey || "",
        attachmentName: editing?.attachmentName || "",
        createdAt: editing?.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      if (editing) {
        state.docs = state.docs.map((entry) => entry.id === editing.id ? doc : entry);
      } else {
        state.docs.unshift(doc);
      }
      save("pm.docs", state.docs);
      closeDocDialog();
      renderDocs();
    });
  }

  function openDocEditor(id) {
    const doc = state.docs.find((entry) => entry.id === id);
    if (!doc) return;
    state.editingDocId = doc.id;
    $("#docDialogTitle").textContent = "编辑深度记录";
    $("#docSubmitBtn").textContent = "保存修改";
    $("#docCategory").value = normalizedDocCategory(doc);
    $("#docTitle").value = doc.title || "";
    $("#docLink").value = doc.link || "";
    $("#docLink").required = !doc.attachmentKey;
    $("#docLink").setCustomValidity("");
    $("#docBody").value = doc.body || "";
    $("#docDialog").showModal();
    $("#docTitle").focus();
  }

  function resetDocForm() {
    state.editingDocId = null;
    $("#docForm").reset();
    $("#docCategory").value = DOC_CATEGORIES[0];
    $("#docLink").required = true;
    $("#docLink").setCustomValidity("");
    $("#docDialogTitle").textContent = "新建深度记录";
    $("#docSubmitBtn").textContent = "保存文档";
  }

  function closeDocDialog() {
    resetDocForm();
    if ($("#docDialog").open) $("#docDialog").close();
  }

  function handleIdeaPaste(event) {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") || "";
    if (text) insertTextAtCursor($("#ideaInput"), text);
    files.forEach((file) => {
      state.pendingIdeaImages.push({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file)
      });
    });
    renderIdeaPastePreview();
  }

  function insertTextAtCursor(input, text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
    const next = start + text.length;
    input.setSelectionRange(next, next);
  }

  function renderIdeaPastePreview() {
    const preview = $("#ideaPastePreview");
    if (!state.pendingIdeaImages.length) {
      preview.hidden = true;
      preview.innerHTML = "";
      return;
    }
    preview.hidden = false;
    preview.innerHTML = state.pendingIdeaImages.map((item, index) => `
      <div class="idea-image-preview" data-id="${item.id}">
        <img src="${escapeAttr(item.previewUrl)}" alt="待加入脑暴图片 ${index + 1}" />
        <button class="idea-image-remove" type="button" title="移除图片">×</button>
      </div>
    `).join("");
    preview.querySelectorAll(".idea-image-remove").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.closest(".idea-image-preview").dataset.id;
        const item = state.pendingIdeaImages.find((entry) => entry.id === id);
        if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
        state.pendingIdeaImages = state.pendingIdeaImages.filter((entry) => entry.id !== id);
        renderIdeaPastePreview();
      });
    });
  }

  function clearPendingIdeaImages() {
    state.pendingIdeaImages.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    state.pendingIdeaImages = [];
    renderIdeaPastePreview();
  }

  function renderAll() {
    renderGoals();
    renderCalendar();
    renderTodayTasks();
    renderMaterials();
    renderIdeas();
    renderDocs();
  }

  function renderGoals() {
    const total = state.goals.length;
    const done = state.goals.filter((goal) => isGoalDone(goal)).length;
    const averageProgress = total ? Math.round(state.goals.reduce((sum, goal) => sum + goalProgress(goal), 0) / total) : 0;
    $("#goalsSummary").textContent = `已完成 ${done}/${total} · 总进度 ${averageProgress}%`;
    const groups = ["业务产出", "其他维度"].map((type) => [
      type,
      state.goals.filter((goal) => goal.type === type)
    ]);
    $("#goalGroups").innerHTML = groups.map(([type, goals]) => `
      <details class="goal-group" open>
        <summary class="goal-group-title">
          <span class="goal-group-caret">▾</span>
          <h3>${escapeHtml(type)}</h3>
          <span>${goals.length} 个目标 · ${goals.filter((goal) => isGoalDone(goal)).length} 已达成</span>
        </summary>
        <div class="goal-list">
          ${goals.length ? goals.map((goal) => `
            <article class="goal-item ${isGoalDone(goal) ? "done" : ""} ${state.editingGoalId === goal.id ? "editing" : ""}" data-id="${goal.id}">
              <button class="goal-achieve ${isGoalDone(goal) ? "is-done" : ""}" data-action="toggle" type="button" title="${isGoalDone(goal) ? "标记为未达成" : "标记为已达成"}">
                <span class="goal-checkmark">✓</span>
                <span>${isGoalDone(goal) ? "已达成" : "达成"}</span>
              </button>
              <div class="goal-content">
                <div class="goal-row">
                  <span class="goal-type-tag ${type === "业务产出" ? "business" : "other"}">${escapeHtml(goal.type)}</span>
                  <strong>${escapeHtml(goal.title)}</strong>
                  <span class="goal-ddl">${goal.ddl ? `DDL：${escapeHtml(goal.ddl)}` : "阶段目标"}</span>
                  ${goal.completedAt ? `<span class="goal-ddl completed">完成：${escapeHtml(goal.completedAt)}</span>` : ""}
                </div>
                ${goal.detail ? `<p>${escapeHtml(goal.detail)}</p>` : `<p class="muted-note">暂无详情</p>`}
                <div class="goal-progress-line">
                  <span>完成进度 ${goalProgress(goal)}%</span>
                  <div class="goal-progress-bar"><i style="width:${goalProgress(goal)}%"></i></div>
                </div>
                ${goal.progressNote ? `<p class="goal-progress-note">${escapeHtml(goal.progressNote)}</p>` : ""}
              </div>
              <div class="goal-item-actions">
                <button class="link-btn" data-action="edit" type="button">编辑</button>
                <button class="link-btn danger" data-action="delete" type="button">删除</button>
              </div>
            </article>
          `).join("") : `<div class="inline-empty">还没有${escapeHtml(type)}目标。</div>`}
        </div>
      </details>
    `).join("");
    $("#goalGroups").querySelectorAll("[data-action]").forEach((node) => {
      node.addEventListener("click", (event) => {
        const item = event.target.closest(".goal-item");
        if (!item) return;
        const id = item.dataset.id;
        if (node.dataset.action === "toggle") {
          const goal = state.goals.find((entry) => entry.id === id);
          if (!goal) return;
          if (isGoalDone(goal)) {
            state.goals = state.goals.map((entry) => entry.id === id ? {
              ...entry,
              done: false,
              completedAt: "",
              progress: Math.min(goalProgress(entry), 99),
              updatedAt: Date.now()
            } : entry);
          } else {
            const completedAt = prompt("请输入完成目标的日期（格式：YYYY-MM-DD）", toISODate(new Date()));
            if (completedAt === null) return;
            const cleanDate = completedAt.trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
              alert("日期格式请填写为 YYYY-MM-DD，例如 2026-06-08。");
              return;
            }
            state.goals = state.goals.map((entry) => entry.id === id ? {
              ...entry,
              done: true,
              progress: 100,
              completedAt: cleanDate,
              updatedAt: Date.now()
            } : entry);
          }
        }
        if (node.dataset.action === "edit") {
          const goal = state.goals.find((item) => item.id === id);
          if (goal) fillGoalForm(goal);
          return;
        }
        if (node.dataset.action === "delete") {
          state.goals = state.goals.filter((goal) => goal.id !== id);
          if (state.editingGoalId === id) resetGoalForm();
        }
        save("pm.goals", state.goals);
        renderGoals();
      });
    });
  }

  function fillGoalForm(goal) {
    state.editingGoalId = goal.id;
    $("#goalType").value = goal.type;
    $("#goalTitle").value = goal.title;
    $("#goalDetail").value = goal.detail || "";
    $("#goalDDL").value = goal.ddl || "";
    $("#goalProgress").value = String(goalProgress(goal));
    $("#goalCompletedAt").value = goal.completedAt || "";
    $("#goalProgressNote").value = goal.progressNote || "";
    $("#goalSubmitBtn").textContent = "保存修改";
    $("#cancelGoalEdit").hidden = false;
    renderGoals();
    $("#goalTitle").focus();
  }

  function resetGoalForm() {
    state.editingGoalId = null;
    $("#goalForm").reset();
    $("#goalProgress").value = "0";
    $("#goalCompletedAt").value = "";
    $("#goalProgressNote").value = "";
    $("#goalSubmitBtn").textContent = "新增目标";
    $("#cancelGoalEdit").hidden = true;
  }

  function goalProgress(goal) {
    if (Number.isFinite(Number(goal?.progress))) return clampPercent(goal.progress);
    return goal?.done ? 100 : 0;
  }

  function isGoalDone(goal) {
    return Boolean(goal?.done) || goalProgress(goal) >= 100;
  }

  function clampPercent(value) {
    return Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
  }

  function renderCalendar() {
    const year = state.month.getFullYear();
    const month = state.month.getMonth();
    $("#monthTitle").textContent = `${year}年${month + 1}月`;
    const grid = $("#calendarGrid");
    const first = new Date(year, month, 1);
    const firstWeekday = (first.getDay() + 6) % 7;
    const start = new Date(year, month, 1 - firstWeekday);
    const cells = [];

    for (let i = 0; i < 42; i += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const iso = toISODate(date);
      const dayTodos = state.todos.filter((item) => item.date === iso);
      const doneCount = dayTodos.filter((item) => item.done).length;
      const classes = [
        "day-cell",
        date.getMonth() !== month ? "is-muted" : "",
        iso === toISODate(new Date()) ? "is-today" : "",
        iso === state.selectedDate ? "is-selected" : ""
      ].filter(Boolean).join(" ");
      cells.push(`
        <button class="${classes}" type="button" data-date="${iso}">
        <div class="day-number">${date.getDate()}</div>
        <div class="day-badges">${dayTodos.slice(0, 6).map((item) => `<span class="mini-badge ${TYPE_CLASS[item.type]}"></span>`).join("")}</div>
        ${dayTodos.length ? `<div class="done-count">${doneCount}/${dayTodos.length} 已完成</div>` : ""}
        </button>
      `);
    }
    grid.innerHTML = cells.join("");
    grid.querySelectorAll(".day-cell").forEach((cell) => {
      cell.addEventListener("click", () => selectTodoDate(cell.dataset.date));
      cell.addEventListener("dblclick", () => openTodoDialog(cell.dataset.date));
    });
  }

  function renderTodayTasks() {
    const list = $("#todayTaskList");
    const selected = parseISODate(state.selectedDate);
    const selectedTodos = state.todos
      .filter((item) => item.date === state.selectedDate)
      .sort((a, b) => Number(a.done) - Number(b.done) || b.updatedAt - a.updatedAt);
    const isToday = state.selectedDate === toISODate(new Date());
    $("#selectedTaskEyebrow").textContent = isToday ? "今天" : "选中日期";
    $("#selectedTaskTitle").textContent = `${isToday ? "今日" : formatDateLabel(selected)}任务`;
    if (!selectedTodos.length) {
      list.innerHTML = `<div class="inline-empty">${isToday ? "今天" : formatDateLabel(selected)}还没有任务安排。点击“新增/查看”添加。</div>`;
      return;
    }
    list.innerHTML = selectedTodos.map((item) => `
      <article class="today-task ${item.done ? "done" : ""}" data-id="${item.id}">
        <span class="todo-type ${TYPE_CLASS[item.type]}"></span>
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <small>${TODO_TYPES[item.type]}${item.desc ? ` · ${escapeHtml(item.desc)}` : ""}</small>
        </div>
        <button class="status-pill" data-action="toggle">${item.done ? "已完成" : "待完成"}</button>
      </article>
    `).join("");
    list.querySelectorAll("[data-action='toggle']").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.closest(".today-task").dataset.id;
        toggleTodo(id);
      });
    });
  }

  function openTodoDialog(date) {
    state.selectedDate = date;
    resetTodoForm();
    renderCalendar();
    renderTodayTasks();
    renderTodoDialog();
    $("#todoDialog").showModal();
  }

  function selectTodoDate(date, syncMonth = false) {
    state.selectedDate = date;
    if (syncMonth) {
      const parsed = parseISODate(date);
      state.month = new Date(parsed.getFullYear(), parsed.getMonth(), 1);
    }
    renderCalendar();
    renderTodayTasks();
  }

  function renderTodoDialog() {
    const list = $("#todoList");
    const dayTodos = state.todos
      .filter((item) => item.date === state.selectedDate)
      .sort((a, b) => Number(a.done) - Number(b.done) || b.updatedAt - a.updatedAt);
    $("#todoDialogTitle").textContent = `${state.selectedDate} 日程详情`;
    $("#daySummary").textContent = dayTodos.length ? `共 ${dayTodos.length} 条，已完成 ${dayTodos.filter((item) => item.done).length} 条` : "这一天还没有安排。";
    list.innerHTML = dayTodos.map((item) => `
      <article class="todo-item ${item.done ? "done" : ""} ${state.editingTodoId === item.id ? "editing" : ""}" data-id="${item.id}">
        <span class="todo-type ${TYPE_CLASS[item.type]}"></span>
        <div>
          <strong class="todo-title">${escapeHtml(item.title)}</strong>
          <div class="todo-desc">${escapeHtml(item.desc || TODO_TYPES[item.type])}</div>
        </div>
        <div class="todo-actions">
          <button class="link-btn" data-action="toggle">${item.done ? "恢复" : "完成"}</button>
          <button class="link-btn" data-action="edit">编辑</button>
          <button class="link-btn" data-action="delete">删除</button>
        </div>
      </article>
    `).join("");
    list.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const id = button.closest(".todo-item").dataset.id;
        const action = button.dataset.action;
        if (action === "toggle") toggleTodo(id);
        if (action === "delete") deleteTodo(id);
        if (action === "edit") {
          fillTodoForm(state.todos.find((item) => item.id === id));
          renderTodoDialog();
        }
      });
    });
  }

  function toggleTodo(id) {
    state.todos = state.todos.map((item) => item.id === id ? { ...item, done: !item.done, updatedAt: Date.now() } : item);
    save("pm.todos", state.todos);
    renderCalendar();
    renderTodayTasks();
    if ($("#todoDialog").open) renderTodoDialog();
  }

  function deleteTodo(id) {
    state.todos = state.todos.filter((item) => item.id !== id);
    save("pm.todos", state.todos);
    renderCalendar();
    renderTodayTasks();
    renderTodoDialog();
  }

  function fillTodoForm(todo) {
    if (!todo) return;
    state.editingTodoId = todo.id;
    $("#todoTitle").value = todo.title;
    $("#todoDesc").value = todo.desc;
    document.querySelector(`input[name="todoType"][value="${todo.type}"]`).checked = true;
    $("#todoSubmitBtn").textContent = "更新日程";
    $("#clearTodoEdit").textContent = "取消编辑";
    $("#todoTitle").focus();
  }

  function resetTodoForm() {
    state.editingTodoId = null;
    $("#todoTitle").value = "";
    $("#todoDesc").value = "";
    document.querySelector('input[name="todoType"][value="business"]').checked = true;
    $("#todoSubmitBtn").textContent = "保存日程";
    $("#clearTodoEdit").textContent = "清空";
  }

  async function renderMaterials() {
    const grid = $("#materialGrid");
    rememberMaterialOpenState(grid);
    normalizeMaterialStatuses();
    renderMaterialFilterOptions();
    renderMaterialStats();
    renderMaterialOptions();
    const filtered = getFilteredMaterials();
    $("#materialEmpty").style.display = filtered.length ? "none" : "block";
    $("#materialEmpty").textContent = state.materials.length ? "没有符合筛选条件的素材。" : "还没有素材，先上传一条视频素材。";
    const weekGroups = groupMaterialsByWeek(filtered);
    grid.innerHTML = weekGroups.map(({ week, items, projectGroups }) => `
      <details class="week-overview" data-open-key="${escapeAttr(materialOpenKey("week", week))}" ${detailOpenAttr(materialOpenKey("week", week), false)}>
        <summary class="week-overview-head">
          <div class="week-title-block">
            <span class="level-badge week-badge">周维度</span>
            <h3>${escapeHtml(week)}</h3>
            <span class="week-date-hint">${escapeHtml(getWeekDateHint(items))}</span>
          </div>
          <div class="week-summary-metrics">${renderWeekSummaryChips(items)}</div>
        </summary>
        <div class="week-overview-body">
          <div class="week-vendor-strip">${renderWeekVendorPreview(items)}</div>
          ${projectGroups.map(([project, scriptTypeGroups]) => `
            <details class="project-slice" data-open-key="${escapeAttr(materialOpenKey("project", week, project))}" ${detailOpenAttr(materialOpenKey("project", week, project), true)}>
              <summary class="project-slice-head">
                <h4><span class="level-badge project-badge">项目</span>${escapeHtml(project)}</h4>
                <span>${countScriptTypeGroups(scriptTypeGroups)} 条素材</span>
              </summary>
              ${scriptTypeGroups.map(([scriptType, tagGroups]) => `
                <details class="script-type-group" data-open-key="${escapeAttr(materialOpenKey("scriptType", week, project, scriptType))}" ${detailOpenAttr(materialOpenKey("scriptType", week, project, scriptType), true)}>
                  <summary class="script-type-head">
                    <h4><span class="script-type-pill">${escapeHtml(scriptType)}</span></h4>
                    <span>${countTagGroups(tagGroups)} 条素材</span>
                  </summary>
                  ${tagGroups.map(([tag, tagItems]) => `
                    <details class="material-group" data-open-key="${escapeAttr(materialOpenKey("tag", week, project, scriptType, tag))}" ${detailOpenAttr(materialOpenKey("tag", week, project, scriptType, tag), true)}>
                      <summary class="material-group-head">
                        <h3><span class="level-badge tag-badge">第一标签</span>${escapeHtml(tag)}</h3>
                        <span>${tagItems.length} 条素材</span>
                      </summary>
                      <div class="material-group-grid">
                        ${tagItems.map(renderMaterialCard).join("")}
                      </div>
                    </details>
                  `).join("")}
                </details>
              `).join("")}
            </details>
          `).join("")}
        </div>
      </details>
    `).join("");

    state.materials.forEach(async (item) => {
      if (!item.metricKey) return;
      const file = await getFile(item.metricKey);
      const slot = $(`#metric-${CSS.escape(item.id)}`);
      if (file && slot) slot.innerHTML = `<img class="metric-thumb" src="${URL.createObjectURL(file)}" alt="数据截图" />`;
    });

    grid.querySelectorAll("[data-action='play']").forEach((button) => {
      button.addEventListener("click", () => playMaterial(button.closest(".material-card").dataset.id));
    });
    grid.querySelectorAll("[data-action='play-asset']").forEach((button) => {
      button.addEventListener("click", () => playMaterial(button.closest(".material-card").dataset.id, button.dataset.assetId));
    });
    grid.querySelectorAll("[data-action='delete-video']").forEach((button) => {
      button.addEventListener("click", () => deleteMaterialVideos(button.closest(".material-card").dataset.id));
    });
    grid.querySelectorAll("[data-action='edit']").forEach((button) => {
      button.addEventListener("click", () => openMaterialEditor(button.closest(".material-card").dataset.id));
    });
    grid.querySelectorAll("[data-progress]").forEach((button) => {
      button.addEventListener("click", () => toggleMaterialProgress(button.closest(".material-card").dataset.id, button.dataset.progress));
    });
    grid.querySelectorAll("[data-rating]").forEach((button) => {
      button.addEventListener("click", () => updateMaterialRating(button.closest(".material-card").dataset.id, Number(button.dataset.rating)));
    });
    grid.querySelectorAll("[data-action='delete']").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.closest(".material-card").dataset.id;
        const item = state.materials.find((entry) => entry.id === id);
        if (item) {
          const keys = [...new Set([item.videoKey, ...normalizedAssets(item).map((asset) => asset.videoKey)].filter(Boolean))];
          for (const key of keys) await deleteFile(key);
          if (item.metricKey) await deleteFile(item.metricKey);
          deleteMaterialFromFeishu(item);
        }
        state.materials = state.materials.filter((entry) => entry.id !== id);
        save("pm.materials", state.materials);
        renderMaterials();
      });
    });
    grid.querySelectorAll("[data-action='metric']").forEach((input) => {
      input.addEventListener("change", async () => {
        const file = input.files[0];
        if (!file) return;
        const id = input.closest(".material-card").dataset.id;
        const key = `metric-${id}`;
        await putFile(key, file);
        state.materials = state.materials.map((item) => item.id === id ? { ...item, metricKey: key, metricName: file.name, updatedAt: Date.now() } : item);
        save("pm.materials", state.materials);
        renderMaterials();
        syncMaterialsToFeishu([id]);
      });
    });
    grid.querySelectorAll(".material-select").forEach((input) => {
      input.addEventListener("change", updateSelectedMaterialCount);
    });
    updateSelectedMaterialCount();
  }

  function rememberMaterialOpenState(grid) {
    if (!grid) return;
    const details = [...grid.querySelectorAll("[data-open-key]")];
    if (!details.length) return;
    state.materialOpenKeys = new Set(details.filter((node) => node.open).map((node) => node.dataset.openKey));
    state.materialOpenStateReady = true;
  }

  function detailOpenAttr(key, defaultOpen = false) {
    const shouldOpen = state.materialOpenStateReady ? state.materialOpenKeys.has(key) : defaultOpen;
    return shouldOpen ? "open" : "";
  }

  function materialOpenKey(...parts) {
    return parts.map((part) => String(part || "").replaceAll("|", "/")).join("|");
  }

  function renderMaterialCard(item) {
    const assets = normalizedAssets(item);
    const primaryAsset = assets[0] || {};
    const cover = primaryAsset.cover || item.cover || createPlaceholderCover(item.title);
    const hasPrimaryVideo = Boolean(primaryAsset.videoKey || item.videoKey);
    return `
      <article class="material-card ${scriptCardClass(item.scriptStatus)}" data-id="${item.id}">
        ${renderScriptStatusBadge(item.scriptStatus)}
        <button class="cover-btn" data-action="play" title="${hasPrimaryVideo ? "播放完整视频" : "未上传视频"}">
          <img alt="${escapeAttr(item.title)} 封面" src="${escapeAttr(cover)}" />
          ${renderScriptTypeBadge(item)}
          <span class="cover-tags">${normalizedTags(item).map((tagValue, index) => `<span class="cover-tag ${index === 0 ? "primary" : ""}">${escapeHtml(tagValue)}</span>`).join("")}</span>
        </button>
        <div class="material-body">
          <label class="material-select-wrap"><input class="material-select" type="checkbox" data-id="${item.id}" />选择该素材</label>
          <h3>${escapeHtml(item.title)}</h3>
          <div class="material-date">记录时间：${escapeHtml(item.date || "")}</div>
          <div class="material-date">归属周：${escapeHtml(getMaterialWeekLabel(item))}</div>
          <div class="material-meta-line"><span>脚本类型</span>${escapeHtml(normalizedScriptType(item))}</div>
          <div class="material-meta-line"><span>所属项目</span>${escapeHtml(item.project || "未归属项目")}</div>
          <div class="material-meta-line"><span>供应商</span>${escapeHtml(item.vendor || "未填写")}</div>
          ${item.finalName ? `<div class="material-meta-line"><span>最终命名</span>${escapeHtml(item.finalName)}</div>` : ""}
          ${item.storageUrl ? `<div class="material-meta-line"><span>素材存放</span>${renderStorageAddress(item.storageUrl)}</div>` : ""}
          <div class="script-status ${scriptStatusClass(item.scriptStatus)}">
            脚本状态：${escapeHtml(item.scriptStatus || "未填写")}
          </div>
          ${renderFeishuSyncStatus(item)}
          ${item.scriptLink ? `<a class="link-btn script-link ${scriptStatusClass(item.scriptStatus)}" href="${escapeAttr(item.scriptLink)}" target="_blank" rel="noreferrer">打开脚本链接</a>` : ""}
          ${renderMaterialAssets(item)}
          <div class="progress-row">${renderProgress(item.progress)}</div>
          <div class="rating-row">${renderStars(item.rating || 0)}</div>
          <div class="metric-slot" id="metric-${item.id}"></div>
          <div class="card-actions">
            <label class="ghost-btn">更新数据截图<input data-action="metric" type="file" accept="image/*" hidden /></label>
            ${hasPrimaryVideo ? `<button class="link-btn danger" data-action="delete-video">删除视频</button>` : ""}
            <button class="link-btn" data-action="edit">编辑</button>
            <button class="link-btn" data-action="delete">删除</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderWeekSummaryChips(items) {
    const approved = items.filter((item) => isScriptApproved(item.scriptStatus)).length;
    const rejected = items.filter((item) => isScriptRejected(item.scriptStatus)).length;
    const done = items.filter((item) => normalizeProgress(item.progress).recovered).length;
    const rate = items.length ? Math.round((approved / items.length) * 100) : 0;
    return `
      <span class="week-chip total">总 ${items.length}</span>
      <span class="week-chip approved">通过 ${approved}</span>
      <span class="week-chip rejected">未通过 ${rejected}</span>
      <span class="week-chip done">验收 ${done}</span>
      <span class="week-chip rate">通过率 ${rate}%</span>
    `;
  }

  function renderWeekVendorPreview(items) {
    const rows = vendorRows(items);
    if (!rows.length) return `<span class="vendor-pill muted">暂无供应商</span>`;
    return rows.slice(0, 6).map((row) => `<span class="vendor-pill">${escapeHtml(row.name)} <b>${row.count}</b></span>`).join("");
  }

  function getWeekDateHint(items) {
    const dates = items.map((item) => getMaterialBelongDate(item)).sort();
    const start = dates[0] || "";
    const end = dates[dates.length - 1] || "";
    return start && end && start !== end ? `${start} 至 ${end}` : (start || "暂无日期");
  }

  function renderMaterialStats() {
    const allApproved = state.materials.filter((item) => isScriptApproved(item.scriptStatus)).length;
    const allRejected = state.materials.filter((item) => isScriptRejected(item.scriptStatus)).length;
    const allAccepted = state.materials.filter((item) => normalizeProgress(item.progress).recovered).length;
    $("#allScriptCount").textContent = state.materials.length;
    $("#allApprovedScriptCount").textContent = allApproved;
    $("#allRejectedScriptCount").textContent = allRejected;
    $("#allAcceptedMaterialCount").textContent = allAccepted;
    renderVendorList("#allVendorList", state.materials);
    $("#allVendorSummaryCount").textContent = `${vendorRows(state.materials).length} 个供应商`;

    const monthly = state.materials.filter((item) => getMaterialMonthLabel(item) === state.statsMonth);
    const monthlyApproved = monthly.filter((item) => isScriptApproved(item.scriptStatus)).length;
    const monthlyRejected = monthly.filter((item) => isScriptRejected(item.scriptStatus)).length;
    const monthlyAccepted = monthly.filter((item) => normalizeProgress(item.progress).recovered).length;
    $("#monthlyScriptCount").textContent = monthly.length;
    $("#monthlyApprovedScriptCount").textContent = monthlyApproved;
    $("#monthlyRejectedScriptCount").textContent = monthlyRejected;
    $("#monthlyAcceptedMaterialCount").textContent = monthlyAccepted;
    $("#monthlyPassRate").textContent = `${monthly.length ? Math.round((monthlyApproved / monthly.length) * 100) : 0}%`;
    renderVendorList("#monthlyVendorList", monthly);

    const weekly = state.materials.filter((item) => getMaterialWeekLabel(item) === state.statsWeek);
    const approved = weekly.filter((item) => isScriptApproved(item.scriptStatus)).length;
    const rejected = weekly.filter((item) => isScriptRejected(item.scriptStatus)).length;
    const weeklyAccepted = weekly.filter((item) => normalizeProgress(item.progress).recovered).length;
    $("#approvedScriptCount").textContent = approved;
    $("#totalScriptCount").textContent = weekly.length;
    $("#rejectedScriptCount").textContent = rejected;
    $("#weeklyAcceptedMaterialCount").textContent = weeklyAccepted;
    $("#weeklyPassRate").textContent = `${weekly.length ? Math.round((approved / weekly.length) * 100) : 0}%`;
    renderVendorList("#weeklyVendorList", weekly);
    renderMaterialReview();
  }

  function vendorRows(materials) {
    const groups = new Map();
    materials.forEach((item) => {
      const key = item.vendor || "未填写供应商";
      groups.set(key, (groups.get(key) || 0) + 1);
    });
    return [...groups.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  }

  function renderVendorList(selector, materials) {
    const rows = vendorRows(materials);
    const node = $(selector);
    if (!node) return;
    node.innerHTML = rows.length ? rows.map((row) => `
      <div class="vendor-row">
        <span>${escapeHtml(row.name)}</span>
        <strong>${row.count} 条</strong>
      </div>
    `).join("") : `<div class="inline-empty">暂无供应商数据。</div>`;
  }

  function renderMaterialReview() {
    const list = $("#reviewList");
    if (!list) return;
    const materials = getReviewMaterials();
    if (!materials.length) {
      list.innerHTML = `<div class="empty-state compact-empty">当前周维度下暂无可复盘素材。</div>`;
      return;
    }
    const groups = new Map();
    materials.forEach((item) => {
      const key = reviewGroupName(item);
      const group = groups.get(key) || { name: key, total: 0, approved: 0, rejected: 0 };
      group.total += 1;
      if (isScriptApproved(item.scriptStatus)) group.approved += 1;
      if (isScriptRejected(item.scriptStatus)) group.rejected += 1;
      groups.set(key, group);
    });
    const rows = [...groups.values()]
      .map((group) => ({
        ...group,
        rate: group.total ? Math.round((group.approved / group.total) * 100) : 0
      }))
      .sort((a, b) => b.total - a.total || b.rate - a.rate || a.name.localeCompare(b.name, "zh-CN"))
      .slice(0, 8);
    list.innerHTML = rows.map((row) => `
      <div class="review-row">
        <div class="review-name" title="${escapeAttr(row.name)}">${escapeHtml(row.name)}</div>
        <div>
          <div class="review-bar"><span style="width:${row.rate}%"></span></div>
          <div class="review-meta">
            <span>总数 ${row.total}</span>
            <span>通过 ${row.approved}</span>
            <span>未通过 ${row.rejected}</span>
          </div>
        </div>
        <strong class="review-rate">${row.rate}%</strong>
      </div>
    `).join("");
  }

  function reviewGroupName(item) {
    const tags = normalizedTags(item);
    return {
      project: item.project || "未归属项目",
      scriptType: normalizedScriptType(item),
      tagOne: tags[0] || "未填写第一标签",
      tagTwo: tags[1] || "未填写第二标签",
      tagThree: tags[2] || "未填写第三标签",
      vendor: item.vendor || "未填写供应商"
    }[state.reviewDimension] || "未分类";
  }

  function getReviewMaterials() {
    return state.materials.filter((item) => !state.reviewWeek || getMaterialWeekLabel(item) === state.reviewWeek);
  }

  function uniqueValues(values) {
    return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  function sortedWeekOptions() {
    const weekMap = new Map();
    const addWeek = (dateValue) => {
      const label = getWeekRangeLabel(dateValue);
      const startTime = getWeekStartTime(dateValue);
      weekMap.set(label, Math.max(weekMap.get(label) || 0, startTime));
    };
    addWeek(toISODate(new Date()));
    state.materials.forEach((item) => addWeek(getMaterialBelongDate(item)));
    return [...weekMap.entries()]
      .sort(([, timeA], [, timeB]) => timeB - timeA)
      .map(([label]) => [label, label]);
  }

  function renderMaterialFilterOptions() {
    const monthOptions = uniqueValues([
      getMonthLabel(toISODate(new Date())),
      ...state.materials.map(getMaterialMonthLabel)
    ]).map((value) => [value, value]);
    const weekOptions = sortedWeekOptions();
    if (!state.statsMonth || !monthOptions.some(([value]) => value === state.statsMonth)) {
      state.statsMonth = monthOptions[0]?.[0] || getMonthLabel(toISODate(new Date()));
    }
    if (!state.statsWeek || !weekOptions.some(([value]) => value === state.statsWeek)) {
      state.statsWeek = weekOptions[0]?.[0] || getWeekRangeLabel(toISODate(new Date()));
    }
    fillSelect("#statsMonth", monthOptions, state.statsMonth);
    fillSelect("#statsWeek", weekOptions, state.statsWeek);
    fillSelect("#filterWeek", [["", "全部周维度"], ...weekOptions], state.materialFilters.week);
    fillSelect("#reviewWeek", [["", "全部周维度"], ...weekOptions], state.reviewWeek);
    fillSelect("#filterScriptType", [
      ["", "全部脚本类型"],
      ["AE脚本", "AE脚本"],
      ["UE脚本", "UE脚本"],
      ["真人脚本", "真人脚本"]
    ], state.materialFilters.scriptType);
    fillSelect("#filterScriptStatus", [
      ["", "全部脚本状态"],
      ["approved", "通过"],
      ["rejected", "不通过"],
      ["unset", "未设置"]
    ], state.materialFilters.scriptStatus);
    fillSelect("#filterProgress", [
      ["", "全部进度"],
      ["reviewSheet", "审核表格"],
      ["passed", "通过"],
      ["pushed", "推进"],
      ["flat", "平面"],
      ["video", "视频"],
      ["recovered", "回收"]
    ], state.materialFilters.progress);
    fillSelect("#filterTagOne", [["", "全部第一标签"], ...uniqueValues(state.materials.map((item) => normalizedTags(item)[0])).map((value) => [value, value])], state.materialFilters.tagOne);
    fillSelect("#filterTagTwo", [["", "全部第二标签"], ...uniqueValues(state.materials.map((item) => normalizedTags(item)[1])).map((value) => [value, value])], state.materialFilters.tagTwo);
    fillSelect("#filterTagThree", [["", "全部第三标签"], ...uniqueValues(state.materials.map((item) => normalizedTags(item)[2])).map((value) => [value, value])], state.materialFilters.tagThree);
    updateMaterialFilterModeControls();
  }

  function fillSelect(selector, options, selected) {
    const node = $(selector);
    if (!node) return;
    node.innerHTML = options.map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
  }

  function getFilteredMaterials() {
    return state.materials.filter((item) => {
      const tags = normalizedTags(item);
      const filters = state.materialFilters;
      const progress = normalizeProgress(item.progress);
      const progressMatch = progress[filters.progress] === true;
      const weekMatch = getMaterialWeekLabel(item) === filters.week;
      const scriptTypeMatch = normalizedScriptType(item) === filters.scriptType;
      const scriptStatusMatch = (filters.scriptStatus === "approved" && isScriptApproved(item.scriptStatus))
        || (filters.scriptStatus === "rejected" && isScriptRejected(item.scriptStatus))
        || (filters.scriptStatus === "unset" && !isScriptApproved(item.scriptStatus) && !isScriptRejected(item.scriptStatus));
      return filterByMode(filters.progress, progressMatch, "progress")
        && filterByMode(filters.week, weekMatch, "week")
        && filterByMode(filters.scriptType, scriptTypeMatch, "scriptType")
        && filterByMode(filters.scriptStatus, scriptStatusMatch, "scriptStatus")
        && filterByMode(filters.tagOne, tags[0] === filters.tagOne, "tagOne")
        && filterByMode(filters.tagTwo, tags[1] === filters.tagTwo, "tagTwo")
        && filterByMode(filters.tagThree, tags[2] === filters.tagThree, "tagThree");
    });
  }

  function exportMaterials() {
    const materials = getFilteredMaterials();
    if (!materials.length) {
      alert("当前没有可导出的素材。");
      return;
    }
    const rows = materials.map((item) => {
      const tags = normalizedTags(item);
      const progress = normalizeProgress(item.progress);
      return {
        "所属项目": item.project || "未归属项目",
        "周时间": getMaterialWeekLabel(item),
        "素材归属日期": getMaterialBelongDate(item),
        "素材标题": item.title || "",
        "最终命名": item.finalName || "",
        "素材存放地址": item.storageUrl || "",
        "脚本类型": normalizedScriptType(item),
        "脚本状态": item.scriptStatus || "未设置",
        "脚本链接": item.scriptLink || "",
        "第一标签": tags[0] || "",
        "第二标签": tags[1] || "",
        "第三标签": tags[2] || "",
        "上传时间": item.date || "",
        "供应商": item.vendor || "",
        "审核表格": progress.reviewSheet ? "是" : "否",
        "通过": progress.passed ? "是" : "否",
        "推进": progress.pushed ? "是" : "否",
        "平面": progress.flat ? "是" : "否",
        "视频": progress.video ? "是" : "否",
        "回收": progress.recovered ? "是" : "否",
        "验收状态": progress.recovered ? "已结束" : "进行中",
        "数据评分": item.rating ? `${item.rating}星` : "未评分",
        "视频文件": materialAssetNames(item) || "无",
        "数据截图": item.metricKey ? (item.metricName || "已上传截图") : "无"
      };
    });
    const headers = Object.keys(rows[0]);
    const table = `
      <html>
        <head>
          <meta charset="UTF-8" />
          <style>
            table { border-collapse: collapse; font-family: Arial, "Microsoft YaHei", sans-serif; }
            th { background: #dbeafe; color: #10233f; font-weight: 700; }
            th, td { border: 1px solid #9fb7d8; padding: 8px; mso-number-format:"\\@"; }
          </style>
        </head>
        <body>
          <table>
            <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
            <tbody>
              ${rows.map((row) => `<tr>${headers.map((header) => `<td>${escapeHtml(row[header])}</td>`).join("")}</tr>`).join("")}
            </tbody>
          </table>
        </body>
      </html>
    `;
    const blob = new Blob([table], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `素材库-${toISODate(new Date())}.xls`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function getMaterialBelongDate(item) {
    return item?.belongDate || item?.date || toISODate(new Date());
  }

  function getMaterialWeekLabel(item) {
    return getWeekRangeLabel(getMaterialBelongDate(item));
  }

  function getMaterialMonthLabel(item) {
    return getMonthLabel(getMaterialBelongDate(item));
  }

  function groupMaterialsByWeek(materials) {
    const weekMap = materials.reduce((map, item) => {
      const week = getMaterialWeekLabel(item);
      if (!map.has(week)) map.set(week, []);
      map.get(week).push(item);
      return map;
    }, new Map());

    return [...weekMap.entries()]
      .map(([week, items]) => ({
        week,
        items,
        sortTime: getNewestMaterialTime(items),
        projectGroups: groupWeekProjects(items)
      }))
      .sort((a, b) => b.sortTime - a.sortTime || a.week.localeCompare(b.week, "zh-CN"));
  }

  function groupWeekProjects(items) {
    const projects = new Map();
    items.forEach((item) => {
      const project = item.project?.trim() || "未归属项目";
      const scriptType = normalizedScriptType(item);
      const firstTag = normalizedTags(item)[0]?.trim() || "未分类";
      if (!projects.has(project)) projects.set(project, new Map());
      const typeMap = projects.get(project);
      if (!typeMap.has(scriptType)) typeMap.set(scriptType, new Map());
      const tagMap = typeMap.get(scriptType);
      if (!tagMap.has(firstTag)) tagMap.set(firstTag, []);
      tagMap.get(firstTag).push(item);
    });

    return [...projects.entries()]
      .sort(([, a], [, b]) => countScriptTypeGroups(b) - countScriptTypeGroups(a))
      .map(([project, typeMap]) => [
        project,
        [...typeMap.entries()]
          .sort(([aType, aTags], [bType, bTags]) => (
            scriptTypeOrder(aType) - scriptTypeOrder(bType)
            || countTagGroups(bTags) - countTagGroups(aTags)
            || aType.localeCompare(bType, "zh-CN")
          ))
          .map(([scriptType, tagMap]) => [
            scriptType,
            [...tagMap.entries()]
              .map(([tag, tagItems]) => [
                tag,
                [...tagItems].sort((a, b) => parseISODate(getMaterialBelongDate(b)).getTime() - parseISODate(getMaterialBelongDate(a)).getTime())
              ])
              .sort(([, itemsA], [, itemsB]) => itemsB.length - itemsA.length)
          ])
      ]);
  }

  function countScriptTypeGroups(scriptTypeGroups) {
    return [...scriptTypeGroups.values ? scriptTypeGroups.values() : scriptTypeGroups].reduce((sum, group) => {
      const tagGroups = Array.isArray(group) && Array.isArray(group[1]) ? group[1] : group;
      return sum + countTagGroups(tagGroups);
    }, 0);
  }

  function countTagGroups(tagGroups) {
    return [...tagGroups.values ? tagGroups.values() : tagGroups].reduce((sum, group) => {
      const items = Array.isArray(group) && Array.isArray(group[1]) ? group[1] : group;
      return sum + items.length;
    }, 0);
  }

  function getNewestMaterialTime(items) {
    const times = items.map((item) => parseISODate(getMaterialBelongDate(item)).getTime());
    return times.length ? Math.max(...times) : 0;
  }

  function scriptTypeOrder(type) {
    return ["AE脚本", "UE脚本", "真人脚本"].indexOf(type) >= 0
      ? ["AE脚本", "UE脚本", "真人脚本"].indexOf(type)
      : 99;
  }

  function getWeekStartTime(dateValue) {
    const date = parseISODate(dateValue || toISODate(new Date()));
    const day = (date.getDay() + 6) % 7;
    const start = new Date(date);
    start.setDate(date.getDate() - day);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }

  function getWeekRangeLabel(dateValue) {
    const date = parseISODate(dateValue || toISODate(new Date()));
    const day = (date.getDay() + 6) % 7;
    const start = new Date(date);
    start.setDate(date.getDate() - day);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return `${start.getMonth() + 1}.${start.getDate()}-${end.getMonth() + 1}.${end.getDate()}`;
  }

  function getMonthLabel(dateValue) {
    const date = parseISODate(dateValue || toISODate(new Date()));
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  async function playMaterial(id, assetId = "") {
    const item = state.materials.find((entry) => entry.id === id);
    if (!item) return;
    const asset = assetId ? normalizedAssets(item).find((entry) => entry.id === assetId) : normalizedAssets(item)[0];
    let videoKey = asset?.videoKey || item.videoKey;
    if (!videoKey) {
      alert("这条素材还没有上传视频。");
      return;
    }
    let file = await getFile(videoKey);
    if (!file) {
      const repairedKey = await findCloudVideoKeyForMaterial(item.id);
      if (repairedKey && repairedKey !== videoKey) {
        videoKey = repairedKey;
        file = await getFile(videoKey);
        if (file) repairMaterialVideoKey(item.id, asset?.id, videoKey, file);
      }
    }
    if (!file) {
      alert("没有找到这个视频文件，可能是之前上传失败或云端文件已失效。请重新编辑这条素材并上传视频。");
      return;
    }
    const player = $("#videoPlayer");
    $("#videoTitle").textContent = asset?.name || item.title;
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(file);
    player.load();
    $("#videoDialog").showModal();
    player.play().catch(() => {
      // Some browsers block autoplay after async cloud downloads; controls remain visible.
    });
  }

  async function findCloudVideoKeyForMaterial(materialId) {
    if (!state.supabase || !state.user || !materialId) return "";
    const prefix = `asset-${materialId}-`;
    const { data, error } = await state.supabase.storage
      .from("personal-assets")
      .list(state.user.id, {
        limit: 100,
        search: prefix,
        sortBy: { column: "updated_at", order: "desc" }
      });
    if (error || !Array.isArray(data)) return "";
    const match = data.find((entry) => {
      const type = entry?.metadata?.mimetype || entry?.metadata?.contentType || "";
      return entry?.name?.startsWith(prefix) && (!type || String(type).startsWith("video/"));
    });
    return match?.name || "";
  }

  function repairMaterialVideoKey(id, assetId, videoKey, file) {
    const item = state.materials.find((entry) => entry.id === id);
    if (!item || !videoKey) return;
    const fileName = file?.name || item.videoName || "";
    const assets = normalizedAssets(item);
    const targetAssetId = assetId || assets[0]?.id || "primary";
    const nextAssets = assets.length
      ? assets.map((asset, index) => {
          const shouldRepair = asset.id === targetAssetId || (!assetId && index === 0);
          return shouldRepair ? { ...asset, videoKey, videoName: asset.videoName || fileName } : asset;
        })
      : [{ id: "primary", name: item.title || "成品素材", videoKey, videoName: fileName, cover: item.cover || "", createdAt: item.createdAt || Date.now() }];
    state.materials = state.materials.map((entry) => entry.id === id ? {
      ...entry,
      assets: nextAssets,
      videoKey: nextAssets[0]?.videoKey || videoKey,
      videoName: nextAssets[0]?.videoName || fileName,
      updatedAt: Date.now()
    } : entry);
    save("pm.materials", state.materials);
  }

  function normalizedTags(item) {
    return item.tags || [item.tagOne, item.tagTwo, item.tagThree].filter(Boolean);
  }

  function renderFeishuSyncStatus(item) {
    const status = item.feishuSyncStatus || (item.feishuRecordId ? "synced" : "");
    const text = {
      syncing: "飞书：同步中",
      synced: "飞书：已同步",
      failed: "飞书：同步失败",
      pending: "飞书：待同步"
    }[status] || "飞书：未同步";
    const title = item.feishuSyncMessage ? ` title="${escapeAttr(item.feishuSyncMessage)}"` : "";
    return `<div class="feishu-sync-status ${escapeAttr(status || "idle")}"${title}>${escapeHtml(text)}</div>`;
  }

  function renderStorageAddress(value) {
    const text = String(value || "").trim();
    if (/^https?:\/\//i.test(text)) {
      return `<a class="inline-link" href="${escapeAttr(text)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
    }
    return escapeHtml(text);
  }

  function normalizedAssets(item) {
    const assets = Array.isArray(item?.assets) ? item.assets : [];
    const normalized = assets
      .filter((asset) => asset && (asset.videoKey || asset.videoName || asset.name))
      .map((asset, index) => ({
        id: asset.id || `asset-${index + 1}`,
        name: asset.name || asset.videoName || `${item?.title || "成品素材"} ${index + 1}`,
        videoKey: asset.videoKey || "",
        videoName: asset.videoName || "",
        cover: asset.cover || "",
        createdAt: asset.createdAt || item?.createdAt || Date.now()
      }));
    if (!normalized.length && (item?.videoKey || item?.videoName)) {
      normalized.push({
        id: "primary",
        name: item.videoName || item.title || "成品素材",
        videoKey: item.videoKey || "",
        videoName: item.videoName || "",
        cover: item.cover || "",
        createdAt: item.createdAt || Date.now()
      });
    }
    return normalized;
  }

  function materialVideoKeys(item) {
    return [...new Set([item?.videoKey, ...normalizedAssets(item).map((asset) => asset.videoKey)].filter(Boolean))];
  }

  function materialAssetNames(item) {
    const names = normalizedAssets(item).map((asset, index) => asset.name || asset.videoName || `成品 ${index + 1}`);
    return names.length ? names.join("\n") : (item?.videoName || "");
  }

  async function deleteMaterialVideos(id) {
    const item = state.materials.find((entry) => entry.id === id);
    if (!item) return;
    const keys = materialVideoKeys(item);
    if (!keys.length) {
      alert("这条素材没有可删除的视频。");
      return;
    }
    if (!confirm("确定删除这条素材已上传的视频吗？素材标题、标签、脚本链接等信息都会保留。")) return;
    for (const key of keys) await deleteFile(key);
    state.materials = state.materials.map((entry) => {
      if (entry.id !== id) return entry;
      const assets = normalizedAssets(entry).map((asset) => ({
        ...asset,
        videoKey: "",
        videoName: "",
        cover: ""
      }));
      return {
        ...entry,
        assets,
        videoKey: "",
        videoName: "",
        cover: createPlaceholderCover(entry.title),
        updatedAt: Date.now()
      };
    });
    save("pm.materials", state.materials);
    renderMaterials();
    syncMaterialsToFeishu([id]);
  }

  function createAssetDraft(asset = {}) {
    return {
      id: asset.id || crypto.randomUUID(),
      name: asset.name || asset.videoName || "",
      videoKey: asset.videoKey || "",
      videoName: asset.videoName || "",
      cover: asset.cover || "",
      file: null
    };
  }

  function ensureAssetDrafts() {
    if (!state.assetDrafts.length) state.assetDrafts = [createAssetDraft()];
  }

  function currentAssetMode() {
    return document.querySelector('input[name="assetMode"]:checked')?.value || "single";
  }

  function setAssetMode(mode) {
    const radio = document.querySelector(`input[name="assetMode"][value="${mode}"]`);
    if (radio) radio.checked = true;
  }

  function readAssetDraftInputs() {
    state.assetDrafts = state.assetDrafts.map((draft) => {
      const name = document.querySelector(`[data-asset-name="${draft.id}"]`)?.value.trim();
      return { ...draft, name: name ?? draft.name };
    });
  }

  function renderAssetRows() {
    const rows = $("#assetRows");
    if (!rows) return;
    ensureAssetDrafts();
    const multiple = currentAssetMode() === "multiple";
    if (!multiple && state.assetDrafts.length > 1) state.assetDrafts = [state.assetDrafts[0]];
    $("#addAssetRow").classList.toggle("hidden", !multiple);
    rows.innerHTML = state.assetDrafts.map((draft, index) => `
      <div class="asset-row" data-asset-row="${escapeAttr(draft.id)}">
        <label>成品名称
          <input data-asset-name="${escapeAttr(draft.id)}" maxlength="120" autocomplete="off" value="${escapeAttr(draft.name || "")}" placeholder="${escapeAttr(index === 0 ? "默认使用素材标题" : `成品素材 ${index + 1}`)}" />
        </label>
        <div class="asset-drop-zone" data-asset-drop="${escapeAttr(draft.id)}" role="button" tabindex="0">
          <input data-asset-file="${escapeAttr(draft.id)}" type="file" accept="video/*" multiple hidden />
          <strong>${escapeHtml(draft.file?.name || draft.videoName || "拖入一个或多个视频，或点击选择")}</strong>
          <span>${draft.file ? "已选择新视频" : draft.videoKey ? "保留已上传视频，可重新选择替换" : "支持一次选择多个 MP4 / MOV 等视频文件"}</span>
        </div>
        ${multiple ? `<button class="icon-btn asset-remove" type="button" data-asset-remove="${escapeAttr(draft.id)}" title="删除这一条">×</button>` : ""}
      </div>
    `).join("");
    rows.querySelectorAll("[data-asset-file]").forEach((input) => {
      input.addEventListener("change", () => {
        const files = [...input.files].filter(isVideoFile);
        if (files.length) setAssetDraftFiles(input.dataset.assetFile, files);
      });
    });
    rows.querySelectorAll("[data-asset-drop]").forEach((zone) => {
      zone.addEventListener("click", () => zone.querySelector("input")?.click());
      zone.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        zone.querySelector("input")?.click();
      });
      zone.addEventListener("dragover", (event) => {
        event.preventDefault();
        zone.classList.add("is-dragging");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("is-dragging"));
      zone.addEventListener("drop", (event) => {
        event.preventDefault();
        zone.classList.remove("is-dragging");
        const files = [...event.dataTransfer.files].filter(isVideoFile);
        if (!files.length) {
          alert("请拖入视频文件。");
          return;
        }
        setAssetDraftFiles(zone.dataset.assetDrop, files);
      });
    });
    rows.querySelectorAll("[data-asset-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        readAssetDraftInputs();
        state.assetDrafts = state.assetDrafts.filter((draft) => draft.id !== button.dataset.assetRemove);
        ensureAssetDrafts();
        renderAssetRows();
      });
    });
  }

  function isVideoFile(file) {
    return file?.type?.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file?.name || "");
  }

  function assetNameFromFile(file) {
    return (file?.name || "").replace(/\.[^.]+$/, "").trim() || file?.name || "";
  }

  function setAssetDraftFiles(id, files) {
    const videos = [...files].filter(isVideoFile);
    if (!videos.length) return;
    readAssetDraftInputs();
    const targetIndex = Math.max(state.assetDrafts.findIndex((draft) => draft.id === id), 0);
    const targetDraft = state.assetDrafts[targetIndex] || createAssetDraft();
    const replacements = videos.map((file, index) => {
      const existing = index === 0 ? targetDraft : createAssetDraft();
      return {
        ...existing,
        id: existing.id || crypto.randomUUID(),
        file,
        videoName: file.name,
        name: assetNameFromFile(file),
        videoKey: index === 0 ? existing.videoKey : "",
        cover: index === 0 ? existing.cover : ""
      };
    });
    if (videos.length > 1) setAssetMode("multiple");
    state.assetDrafts = [
      ...state.assetDrafts.slice(0, targetIndex),
      ...replacements,
      ...state.assetDrafts.slice(targetIndex + 1)
    ];
    ensureAssetDrafts();
    renderAssetRows();
  }

  async function saveAssetDrafts(materialId, editing) {
    readAssetDraftInputs();
    const baseTitle = $("#materialTitle").value.trim() || "成品素材";
    const drafts = currentAssetMode() === "single" ? state.assetDrafts.slice(0, 1) : state.assetDrafts;
    const saved = [];
    for (const [index, draft] of drafts.entries()) {
      if (!draft.file && !draft.videoKey && !draft.videoName && !draft.name) continue;
      const file = draft.file;
      const videoKey = file ? `asset-${materialId}-${draft.id}-${Date.now()}` : draft.videoKey;
      const videoName = file?.name || draft.videoName || "";
      const cover = file ? await captureVideoCover(file) : draft.cover;
      const uploadFile = file ? await prepareVideoUploadFile(file) : null;
      if (uploadFile) await putFile(videoKey, uploadFile);
      saved.push({
        id: draft.id || crypto.randomUUID(),
        name: draft.name || videoName || (drafts.length > 1 ? `${baseTitle}-${index + 1}` : baseTitle),
        videoKey: videoKey || "",
        videoName,
        cover: cover || "",
        createdAt: draft.createdAt || editing?.createdAt || Date.now()
      });
    }
    if (!saved.length && editing) return normalizedAssets(editing);
    return saved;
  }

  function renderMaterialAssets(item) {
    const assets = normalizedAssets(item);
    const videoAssets = assets.filter((asset) => asset.videoKey);
    if (!videoAssets.length) return `<div class="asset-summary muted">暂无成品视频</div>`;
    return `
      <button class="asset-summary asset-summary-button" type="button" data-action="play">成品素材 ${videoAssets.length} 条</button>
      <div class="asset-chip-list">
        ${videoAssets.map((asset, index) => `
          <button class="asset-chip" type="button" data-action="play-asset" data-asset-id="${escapeAttr(asset.id)}" title="${asset.videoKey ? "播放该成品" : "未上传视频"}">
            ${escapeHtml(asset.name || asset.videoName || `成品 ${index + 1}`)}
          </button>
        `).join("")}
      </div>
    `;
  }

  async function syncMaterialsToFeishu(ids, options = {}) {
    const uniqueIds = [...new Set(ids)].filter(Boolean);
    if (!uniqueIds.length) return;
    if (!state.supabase || !state.user) {
      if (options.manual) alert("请先登录账号，登录后才能同步到飞书。");
      return;
    }
    if (options.batch && uniqueIds.length > 1) {
      return syncMaterialBatchToFeishu(uniqueIds, options);
    }
    let success = 0;
    let failed = 0;
    setFeishuSyncState(uniqueIds, { feishuSyncStatus: "syncing", feishuSyncMessage: "" });
    for (const id of uniqueIds) {
      const item = state.materials.find((entry) => entry.id === id);
      if (!item) continue;
      try {
        const { data, error } = await state.supabase.functions.invoke("sync-feishu-material", {
          body: {
            action: "upsert",
            localId: item.id,
            recordId: item.feishuRecordId || "",
            fields: buildFeishuMaterialFields(item)
          }
        });
        if (error) throw new Error(await readFunctionError(error, "飞书同步失败"));
        if (!data?.ok) throw new Error(data?.message || "飞书同步失败");
        setFeishuSyncState([id], {
          feishuRecordId: data.recordId || item.feishuRecordId || "",
          feishuSyncStatus: "synced",
          feishuSyncMessage: "",
          feishuSyncedAt: Date.now()
        }, { render: false });
        success += 1;
      } catch (error) {
        failed += 1;
        setFeishuSyncState([id], {
          feishuSyncStatus: "failed",
          feishuSyncMessage: error.message || "飞书同步失败"
        }, { render: false });
        console.warn(error);
      }
    }
    save("pm.materials", state.materials);
    renderMaterials();
    if (options.manual) {
      alert(failed ? `飞书同步完成：成功 ${success} 条，失败 ${failed} 条。` : `飞书同步完成：成功 ${success} 条。`);
    }
  }

  async function syncMaterialBatchToFeishu(ids, options = {}) {
    const uniqueIds = [...new Set(ids)].filter(Boolean);
    const items = uniqueIds
      .map((id) => state.materials.find((entry) => entry.id === id))
      .filter(Boolean);
    if (!items.length) return;
    setFeishuSyncState(items.map((item) => item.id), { feishuSyncStatus: "syncing", feishuSyncMessage: "" });
    try {
      const { data, error } = await state.supabase.functions.invoke("sync-feishu-material", {
        body: {
          action: "batchUpsert",
          records: items.map((item) => ({
            localId: item.id,
            recordId: item.feishuRecordId || "",
            fields: buildFeishuMaterialFields(item)
          }))
        }
      });
      if (error) throw new Error(await readFunctionError(error, "飞书批量同步失败"));
      if (!data?.ok) throw new Error(data?.message || "飞书批量同步失败");
      const results = Array.isArray(data.results) ? data.results : [];
      const resultMap = new Map(results.map((result) => [result.localId, result]));
      state.materials = state.materials.map((item) => {
        if (!uniqueIds.includes(item.id)) return item;
        const result = resultMap.get(item.id);
        if (result?.ok) {
          return {
            ...item,
            feishuRecordId: result.recordId || item.feishuRecordId || "",
            feishuSyncStatus: "synced",
            feishuSyncMessage: "",
            feishuSyncedAt: Date.now()
          };
        }
        return {
          ...item,
          feishuSyncStatus: "failed",
          feishuSyncMessage: result?.message || "飞书同步失败"
        };
      });
      save("pm.materials", state.materials);
      renderMaterials();
      if (options.manual) {
        alert(data.failed ? `飞书同步完成：成功 ${data.success || 0} 条，失败 ${data.failed} 条。失败原因可在素材卡片“飞书：同步失败”处悬停查看。` : `飞书同步完成：成功 ${data.success || items.length} 条。`);
      }
    } catch (error) {
      setFeishuSyncState(items.map((item) => item.id), {
        feishuSyncStatus: "failed",
        feishuSyncMessage: error.message || "飞书批量同步失败"
      });
      if (options.manual) alert(error.message || "飞书批量同步失败");
      console.warn(error);
    }
  }

  function setFeishuSyncState(ids, patch, options = {}) {
    state.materials = state.materials.map((item) => ids.includes(item.id) ? { ...item, ...patch } : item);
    save("pm.materials", state.materials);
    if (options.render !== false) renderMaterials();
  }

  async function readFunctionError(error, fallback) {
    let message = error?.message || fallback;
    const response = error?.context;
    if (!response) return message;
    try {
      const payload = await (typeof response.clone === "function" ? response.clone() : response).json();
      message = payload?.message || payload?.error || message;
    } catch (_) {
      // Keep the SDK message when the Edge Function response has no JSON body.
    }
    return message;
  }

  function deleteMaterialFromFeishu(item) {
    if (!state.supabase || !state.user || !item?.feishuRecordId) return;
    state.supabase.functions.invoke("sync-feishu-material", {
      body: {
        action: "delete",
        recordId: item.feishuRecordId
      }
    }).catch((error) => console.warn(error));
  }

  function buildFeishuMaterialFields(item) {
    const tags = normalizedTags(item);
    const progress = normalizeProgress(item.progress);
    return {
      "素材ID": item.id || "",
      "所属项目": item.project || "未归属项目",
      "周时间": getMaterialWeekLabel(item),
      "素材归属日期": getMaterialBelongDate(item),
      "上传时间": item.date || "",
      "素材标题": item.title || "",
      "最终命名": item.finalName || "",
      "素材存放地址": item.storageUrl || "",
      "脚本类型": normalizedScriptType(item),
      "脚本状态": item.scriptStatus || "未设置",
      "脚本链接": item.scriptLink || "",
      "第一标签": tags[0] || "",
      "第二标签": tags[1] || "",
      "第三标签": tags[2] || "",
      "供应商": item.vendor || "",
      "审核": progress.reviewSheet ? "是" : "否",
      "通过": progress.passed ? "是" : "否",
      "推进": progress.pushed ? "是" : "否",
      "平面": progress.flat ? "是" : "否",
      "视频": progress.video ? "是" : "否",
      "回收": progress.recovered ? "是" : "否",
      "验收": progress.recovered ? "已结束" : "进行中",
      "数据评分": item.rating ? `${item.rating}星` : "未评分",
      "视频文件": materialAssetNames(item) || "无",
      "数据截图": item.metricKey ? (item.metricName || "已上传截图") : "无",
      "更新时间": formatTime(item.updatedAt || Date.now())
    };
  }

  function renderProgress(progress = {}) {
    const items = [
      ["reviewSheet", "审核表格"],
      ["passed", "通过"],
      ["pushed", "推进"],
      ["flat", "平面"],
      ["video", "视频"],
      ["recovered", "回收"]
    ];
    const normalizedProgress = normalizeProgress(progress);
    return items.map(([key, label]) => `<button class="progress-pill ${normalizedProgress[key] ? "on" : ""}" data-progress="${key}" type="button">${label}</button>`).join("");
  }

  function openMaterialEditor(id) {
    const item = state.materials.find((entry) => entry.id === id);
    if (!item) return;
    state.editingMaterialId = id;
    $("#materialDialog .modal-head h2").textContent = "编辑素材";
    $("#materialTitle").value = item.title || "";
    $("#materialFinalName").value = item.finalName || "";
    $("#projectName").value = item.project || "";
    setScriptTypeRadio(normalizedScriptType(item));
    $("#scriptLink").value = item.scriptLink || "";
    $("#materialStorageUrl").value = item.storageUrl || "";
    setScriptStatusRadio(item.scriptStatus || "");
    const progress = normalizeProgress(item.progress);
    $("#progressPassed").checked = progress.passed;
    $("#progressPushed").checked = progress.pushed;
    $("#progressFlat").checked = progress.flat;
    $("#progressVideo").checked = progress.video;
    $("#progressRecovered").checked = progress.recovered;
    $("#progressReviewSheet").checked = progress.reviewSheet;
    $("#vendorName").value = item.vendor || "";
    const tags = normalizedTags(item);
    $("#tagOne").value = tags[0] || "";
    $("#tagTwo").value = tags[1] || "";
    $("#tagThree").value = tags[2] || "";
    $("#materialDate").value = item.date || toISODate(new Date());
    $("#materialBelongDate").value = getMaterialBelongDate(item);
    $("#materialRating").value = String(item.rating || 0);
    state.assetDrafts = normalizedAssets(item).map(createAssetDraft);
    setAssetMode(state.assetDrafts.length > 1 ? "multiple" : "single");
    renderAssetRows();
    $("#materialMetric").value = "";
    $("#materialDialog").showModal();
  }

  function resetMaterialForm() {
    state.editingMaterialId = null;
    $("#materialDialog .modal-head h2").textContent = "上传素材";
    $("#materialForm").reset();
    $("#materialRating").value = "0";
    $("#materialBelongDate").value = toISODate(new Date());
    state.assetDrafts = [createAssetDraft()];
    setAssetMode("single");
    renderAssetRows();
    setScriptTypeRadio("AE脚本");
    setScriptStatusRadio("");
    $("#progressPassed").checked = false;
    $("#progressPushed").checked = false;
    $("#progressFlat").checked = false;
    $("#progressVideo").checked = false;
    $("#progressRecovered").checked = false;
    $("#progressReviewSheet").checked = false;
  }

  function closeMaterialDialog() {
    resetMaterialForm();
    $("#materialDialog").close();
  }

  function toggleMaterialProgress(id, key) {
    state.materials = state.materials.map((item) => {
      if (item.id !== id) return item;
      const progress = normalizeProgress(item.progress);
      progress[key] = !progress[key];
      return normalizeMaterialStatus({ ...item, progress, updatedAt: Date.now() });
    });
    save("pm.materials", state.materials);
    renderMaterials();
    syncMaterialsToFeishu([id]);
  }

  function updateMaterialRating(id, rating) {
    state.materials = state.materials.map((item) => (
      item.id === id ? { ...item, rating, updatedAt: Date.now() } : item
    ));
    save("pm.materials", state.materials);
    renderMaterials();
    syncMaterialsToFeishu([id]);
  }

  function normalizeMaterialStatuses() {
    let changed = false;
    state.materials = state.materials.map((item) => {
      const normalized = normalizeMaterialStatus(item);
      if (normalized !== item) changed = true;
      return normalized;
    });
    if (changed) save("pm.materials", state.materials);
  }

  function normalizeMaterialStatus(item) {
    const progress = normalizeProgress(item.progress);
    const scriptStatus = progress.passed
      ? "通过"
      : isScriptApproved(item.scriptStatus)
        ? ""
        : item.scriptStatus || "";
    const sameProgress = ["reviewSheet", "passed", "pushed", "flat", "video", "recovered"].every((key) => Boolean(item.progress?.[key]) === progress[key]);
    if (sameProgress && (item.scriptStatus || "") === scriptStatus) return item;
    return { ...item, progress, scriptStatus, updatedAt: Date.now() };
  }

  function normalizeProgress(progress = {}) {
    return {
      reviewSheet: progress.reviewSheet === true,
      passed: progress.passed === true,
      pushed: progress.pushed === true,
      flat: progress.flat === true || progress.feedback === true,
      video: progress.video === true,
      recovered: progress.recovered === true
    };
  }

  function isScriptRejected(status) {
    const value = String(status || "").trim().toLowerCase();
    return value.includes("不通过")
      || value.includes("未通过")
      || value.includes("驳回")
      || value.includes("fail")
      || value.includes("reject");
  }

  function setScriptStatusRadio(value) {
    const normalized = isScriptRejected(value) ? "不通过" : isScriptApproved(value) ? "通过" : "";
    const radio = document.querySelector(`input[name="scriptStatus"][value="${normalized}"]`);
    if (radio) radio.checked = true;
  }

  function setScriptTypeRadio(value) {
    const normalized = ["AE脚本", "UE脚本", "真人脚本"].includes(value) ? value : "AE脚本";
    const radio = document.querySelector(`input[name="scriptType"][value="${normalized}"]`);
    if (radio) radio.checked = true;
  }

  function normalizedScriptType(item) {
    return ["AE脚本", "UE脚本", "真人脚本"].includes(item?.scriptType) ? item.scriptType : "AE脚本";
  }

  function selectedMaterialIds() {
    return [...document.querySelectorAll(".material-select:checked")].map((input) => input.dataset.id);
  }

  function updateSelectedMaterialCount() {
    const count = selectedMaterialIds().length;
    $("#selectedMaterialCount").textContent = `已选择 ${count} 条`;
    const visible = document.querySelectorAll(".material-select").length;
    $("#selectAllMaterials").checked = visible > 0 && count === visible;
    $("#bulkPanel").classList.toggle("is-visible", count > 0);
  }

  function updateBulkControl() {
    const field = $("#bulkField").value;
    $("#bulkScriptType").classList.toggle("hidden", field !== "scriptType");
    $("#bulkScriptStatus").classList.toggle("hidden", field !== "scriptStatus");
    $("#bulkTextValue").classList.toggle("hidden", ["scriptType", "scriptStatus"].includes(field));
    $("#bulkTextValue").placeholder = {
      tagOne: "输入新的第一标签",
      tagTwo: "输入新的第二标签",
      tagThree: "输入新的第三标签",
      vendor: "输入新的供应商"
    }[field] || "输入批量修改值";
  }

  function applyBulkEdit() {
    const ids = selectedMaterialIds();
    if (!ids.length) {
      alert("请先选择要批量修改的素材。");
      return;
    }
    const field = $("#bulkField").value;
    const value = field === "scriptType"
      ? $("#bulkScriptType").value
      : field === "scriptStatus"
        ? $("#bulkScriptStatus").value
        : $("#bulkTextValue").value.trim();
    if (!value) {
      alert("请输入要批量修改的值。");
      return;
    }
    state.materials = state.materials.map((item) => {
      if (!ids.includes(item.id)) return item;
      if (field === "scriptType") return { ...item, scriptType: value, updatedAt: Date.now() };
      if (field === "scriptStatus") {
        const progress = normalizeProgress(item.progress);
        if (isScriptApproved(value)) progress.passed = true;
        if (isScriptRejected(value)) progress.passed = false;
        return normalizeMaterialStatus({ ...item, scriptStatus: value, progress, updatedAt: Date.now() });
      }
      if (field === "vendor") return { ...item, vendor: value, updatedAt: Date.now() };
      const tags = [...normalizedTags(item)];
      const indexMap = { tagOne: 0, tagTwo: 1, tagThree: 2 };
      tags[indexMap[field]] = value;
      return { ...item, tags, updatedAt: Date.now() };
    });
    save("pm.materials", state.materials);
    $("#bulkTextValue").value = "";
    renderMaterials();
    syncMaterialsToFeishu(ids);
  }

  function renderScriptTypeBadge(item) {
    const type = normalizedScriptType(item);
    const className = {
      "AE脚本": "ae",
      "UE脚本": "ue",
      "真人脚本": "live"
    }[type] || "ae";
    return `<span class="cover-type-badge ${className}">${escapeHtml(type)}</span>`;
  }

  function isScriptApproved(status) {
    const value = String(status || "").trim().toLowerCase();
    return !isScriptRejected(status) && (
      value === "通过"
      || value.includes("已通过")
      || value.includes("pass")
      || value.includes("approved")
    );
  }

  function scriptStatusClass(status) {
    if (isScriptRejected(status)) return "rejected";
    if (isScriptApproved(status)) return "approved";
    return "";
  }

  function scriptCardClass(status) {
    const statusClass = scriptStatusClass(status);
    return statusClass ? `script-${statusClass}` : "";
  }

  function renderScriptStatusBadge(status) {
    if (isScriptRejected(status)) return `<span class="script-card-badge rejected">不通过</span>`;
    if (isScriptApproved(status)) return `<span class="script-card-badge approved">通过</span>`;
    return "";
  }

  function renderStars(rating) {
    const score = Number(rating) || 0;
    return `
      <div class="star-editor" aria-label="数据评分">
        ${Array.from({ length: 5 }, (_, index) => {
          const value = index + 1;
          return `<button class="star-btn ${value <= score ? "active" : ""}" data-rating="${value}" type="button" title="${value}星">${value <= score ? "★" : "☆"}</button>`;
        }).join("")}
      </div>
    `;
  }

  function createPlaceholderCover(title) {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 1280, 720);
    gradient.addColorStop(0, "#ffe176");
    gradient.addColorStop(1, "#ff9f77");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = "rgba(255,255,255,.24)";
    ctx.fillRect(80, 80, 1120, 560);
    ctx.fillStyle = "#4b2a07";
    ctx.font = "700 64px Microsoft YaHei, sans-serif";
    ctx.fillText(title || "未上传视频", 120, 360, 1040);
    ctx.font = "400 32px Microsoft YaHei, sans-serif";
    ctx.fillText("素材占位封面", 120, 430);
    return canvas.toDataURL("image/jpeg", 0.78);
  }

  function closeVideo() {
    const player = $("#videoPlayer");
    player.pause();
    if (player.src) URL.revokeObjectURL(player.src);
    player.removeAttribute("src");
    if ($("#videoDialog").open) $("#videoDialog").close();
  }

  function renderIdeas() {
    state.ideaImageUrls.forEach((url) => URL.revokeObjectURL(url));
    state.ideaImageUrls = [];
    $("#ideaBoard").innerHTML = state.ideas.map((idea) => `
      <article class="note" data-id="${idea.id}">
        ${idea.text ? `<p>${escapeHtml(idea.text)}</p>` : ""}
        ${renderIdeaImages(idea)}
        <div class="note-meta">${formatTime(idea.createdAt)} · <button class="link-btn" data-action="delete">删除</button></div>
      </article>
    `).join("") || `<div class="empty-state">随手写一条灵感，它会以便签形式留在这里。</div>`;
    $("#ideaBoard").querySelectorAll("[data-idea-image]").forEach(async (slot) => {
      const file = await getFile(slot.dataset.ideaImage);
      if (!file) {
        slot.innerHTML = `<span>图片暂时无法读取</span>`;
        return;
      }
      const url = URL.createObjectURL(file);
      state.ideaImageUrls.push(url);
      slot.innerHTML = `<img src="${escapeAttr(url)}" alt="脑暴图片" />`;
    });
    $("#ideaBoard").querySelectorAll("[data-idea-image]").forEach((slot) => {
      slot.addEventListener("click", async () => {
        await openIdeaImagePreview(slot.dataset.ideaImage);
      });
    });
    $("#ideaBoard").querySelectorAll("[data-action='delete']").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.closest(".note").dataset.id;
        const idea = state.ideas.find((idea) => idea.id === id);
        for (const image of ideaImageEntries(idea)) {
          await deleteFile(image.key);
        }
        state.ideas = state.ideas.filter((idea) => idea.id !== id);
        save("pm.ideas", state.ideas);
        renderIdeas();
      });
    });
  }

  function renderIdeaImages(idea) {
    const images = ideaImageEntries(idea);
    if (!images.length) return "";
    return `
      <div class="idea-image-grid">
        ${images.map((image) => `<button class="idea-image-slot" data-idea-image="${escapeAttr(image.key)}" type="button"><span>读取图片中...</span></button>`).join("")}
      </div>
    `;
  }

  function ideaImageEntries(idea) {
    if (!idea) return [];
    if (Array.isArray(idea.imageKeys)) {
      return idea.imageKeys
        .map((entry) => typeof entry === "string" ? { key: entry } : entry)
        .filter((entry) => entry?.key);
    }
    return idea.imageKey ? [{ key: idea.imageKey, name: idea.imageName || "" }] : [];
  }

  async function openIdeaImagePreview(key) {
    const file = await getFile(key);
    if (!file) return;
    closeIdeaImagePreview({ keepDialogOpen: true });
    state.activeIdeaImageUrl = URL.createObjectURL(file);
    $("#ideaImagePreview").src = state.activeIdeaImageUrl;
    $("#ideaImageDialog").showModal();
  }

  function closeIdeaImagePreview(options = {}) {
    if (state.activeIdeaImageUrl) {
      URL.revokeObjectURL(state.activeIdeaImageUrl);
      state.activeIdeaImageUrl = "";
    }
    $("#ideaImagePreview").removeAttribute("src");
    if (!options.keepDialogOpen && $("#ideaImageDialog").open) $("#ideaImageDialog").close();
  }

  function renderDocs() {
    renderDocCategorySummary();
    const groups = DOC_CATEGORIES.map((category) => [
      category,
      state.docs.filter((doc) => normalizedDocCategory(doc) === category)
    ]);
    $("#docList").innerHTML = groups.map(([category, docs]) => `
      <details class="doc-category-group" open>
        <summary>
          <strong>${escapeHtml(category)}</strong>
          <span>${docs.length} 份</span>
        </summary>
        <div class="doc-category-list">
          ${docs.length ? docs.map((doc) => `
            <article class="doc-item" data-id="${doc.id}">
              <h3>${escapeHtml(doc.title)}</h3>
              <div class="doc-meta">${formatTime(doc.createdAt)} · ${escapeHtml(normalizedDocCategory(doc))}</div>
              ${doc.body ? `<p class="doc-body">${escapeHtml(doc.body)}</p>` : ""}
              <div class="card-actions">
                ${doc.link ? `<a class="link-btn doc-link" href="${escapeAttr(doc.link)}" target="_blank" rel="noreferrer">打开链接</a>` : ""}
                ${doc.attachmentKey ? `<button class="link-btn" data-action="download">查看旧附件：${escapeHtml(doc.attachmentName)}</button>` : ""}
                <button class="link-btn" data-action="edit">编辑</button>
                <button class="link-btn" data-action="delete">删除</button>
              </div>
            </article>
          `).join("") : `<div class="inline-empty">这个分类还没有文档。</div>`}
        </div>
      </details>
    `).join("") || `<div class="empty-state">还没有深度文档，可以新建一条 URL 沉淀。</div>`;
    $("#docList").querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.closest(".doc-item").dataset.id;
        const doc = state.docs.find((entry) => entry.id === id);
        if (button.dataset.action === "edit") {
          openDocEditor(id);
          return;
        }
        if (button.dataset.action === "download" && doc) {
          const file = await getFile(doc.attachmentKey);
          if (!file) return;
          window.open(URL.createObjectURL(file), "_blank");
          return;
        }
        if (button.dataset.action === "delete") {
          if (doc?.attachmentKey) await deleteFile(doc.attachmentKey);
          state.docs = state.docs.filter((entry) => entry.id !== id);
          save("pm.docs", state.docs);
          renderDocs();
        }
      });
    });
  }

  function renderDocCategorySummary() {
    const total = state.docs.length;
    $("#docCategorySummary").innerHTML = DOC_CATEGORIES.map((category) => {
      const count = state.docs.filter((doc) => normalizedDocCategory(doc) === category).length;
      const rate = total ? Math.round((count / total) * 100) : 0;
      return `
        <article class="doc-category-stat">
          <span>${escapeHtml(category)}</span>
          <strong>${count}</strong>
          <small>${rate}%</small>
        </article>
      `;
    }).join("");
  }

  function normalizedDocCategory(doc) {
    return DOC_CATEGORIES.includes(doc?.category) ? doc.category : "其他";
  }

  async function captureVideoCover(file) {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = url;
    await waitFor(video, "loadedmetadata");
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    video.currentTime = Math.min(duration - 0.1, Math.max(0, Math.random() * duration));
    await waitFor(video, "seeked");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    return canvas.toDataURL("image/jpeg", 0.72);
  }

  function waitFor(target, eventName) {
    return new Promise((resolve, reject) => {
      target.addEventListener(eventName, resolve, { once: true });
      target.addEventListener("error", () => reject(new Error("无法读取文件")), { once: true });
    });
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withStore(mode, callback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const result = callback(store);
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error);
    });
  }

  const putLocalFile = (key, file) => withStore("readwrite", (store) => store.put(file, key));
  const getLocalFile = (key) => withStore("readonly", (store) => store.get(key));
  const deleteLocalFile = (key) => withStore("readwrite", (store) => store.delete(key));

  async function putFile(key, file) {
    if (state.supabase && state.user) return putCloudFile(key, file);
    return putLocalFile(key, file);
  }

  async function getFile(key) {
    if (state.supabase && state.user) return getCloudFile(key);
    return getLocalFile(key);
  }

  async function deleteFile(key) {
    if (!key) return;
    if (state.supabase && state.user) return deleteCloudFile(key);
    return deleteLocalFile(key);
  }

  function cloudFilePath(key) {
    return `${state.user.id}/${key}`;
  }

  function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size >= 1000 * 1000) return `${(size / (1000 * 1000)).toFixed(1)}MB`;
    if (size >= 1000) return `${(size / 1000).toFixed(1)}KB`;
    return `${size}B`;
  }

  function assertCloudUploadable(file) {
    if (!state.supabase || !state.user || !file) return;
    if (file.size <= SUPABASE_FREE_FILE_LIMIT) return;
    throw new Error(`文件「${file.name}」大小为 ${formatFileSize(file.size)}，超过 Supabase 免费版单文件 50MB 上限。请先压缩视频，或把视频放到网盘/飞书后在“素材存放地址”里粘贴链接。`);
  }

  async function prepareVideoUploadFile(file) {
    if (!file || !state.supabase || !state.user || !isVideoFile(file)) return file;
    assertCloudUploadable(file);
    return file;
  }

  async function putCloudFile(key, file) {
    assertCloudUploadable(file);
    return putCloudFileResumable(key, file);
  }

  async function getCloudFile(key) {
    const { data, error } = await state.supabase.storage
      .from("personal-assets")
      .download(cloudFilePath(key));
    if (error) {
      console.warn(error.message);
      return null;
    }
    return data;
  }

  async function ensureTusClient() {
    if (window.tus?.Upload) return window.tus;
    await new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${TUS_CLIENT_URL}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", () => reject(new Error("云端上传组件加载失败，请刷新页面后重试。")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = TUS_CLIENT_URL;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("云端上传组件加载失败，请刷新页面后重试。"));
      document.head.appendChild(script);
    });
    if (!window.tus?.Upload) throw new Error("云端上传组件没有正确加载，请刷新页面后重试。");
    return window.tus;
  }

  function storageResumableEndpoint() {
    const config = window.PM_SUPABASE || FALLBACK_SUPABASE_CONFIG;
    try {
      const ref = new URL(config.url).hostname.split(".")[0];
      return `https://${ref}.storage.supabase.co/storage/v1/upload/resumable`;
    } catch {
      return `${String(config.url || "").replace(/\/$/, "")}/storage/v1/upload/resumable`;
    }
  }

  async function putCloudFileResumable(key, file) {
    const tus = await ensureTusClient();
    const { data, error } = await withTimeout(state.supabase.auth.getSession(), 20000, "获取上传登录状态");
    const accessToken = data?.session?.access_token;
    if (error || !accessToken) throw new Error("登录状态已过期，请重新登录后再上传附件。");
    const config = window.PM_SUPABASE || FALLBACK_SUPABASE_CONFIG;
    const objectName = cloudFilePath(key);
    await withTimeout(new Promise((resolve, reject) => {
      const upload = new tus.Upload(file, {
        endpoint: storageResumableEndpoint(),
        chunkSize: TUS_CHUNK_SIZE,
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        retryDelays: [0, 1000, 3000, 5000, 10000],
        headers: {
          authorization: `Bearer ${accessToken}`,
          apikey: config.anonKey,
          "x-upsert": "true"
        },
        metadata: {
          bucketName: "personal-assets",
          objectName,
          contentType: file.type || "application/octet-stream",
          cacheControl: "3600"
        },
        onError: (uploadError) => {
          const message = uploadError?.originalResponse?.getBody?.() || uploadError?.message || "未知错误";
          reject(new Error(`Supabase 云端上传失败：${message}`));
        },
        onSuccess: resolve
      });
      upload.findPreviousUploads().then((previousUploads) => {
        if (previousUploads.length) upload.resumeFromPreviousUpload(previousUploads[0]);
        upload.start();
      }).catch(() => upload.start());
    }), 20 * 60 * 1000, "上传附件到云端");
  }

  async function deleteCloudFile(key) {
    const { error } = await state.supabase.storage
      .from("personal-assets")
      .remove([cloudFilePath(key)]);
    if (error) console.warn(error.message);
  }

  function toISODate(date) {
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
  }

  function parseISODate(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function formatDateLabel(date) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "short"
    }).format(date);
  }

  function formatTime(time) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(time));
  }

  function load(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function loadArray(key) {
    const value = load(key, []);
    return Array.isArray(value) ? value : [];
  }

  function loadPrivateArray(key) {
    return isLocalDataLocked() ? [] : loadArray(key);
  }

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    writeLocalBackupSnapshot(readPrimaryLocalSnapshot(), key);
    persistCloud(key, value);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }
})();


