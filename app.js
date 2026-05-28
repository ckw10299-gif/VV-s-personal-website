(function () {
  const DB_NAME = "personal-manager-mvp";
  const STORE = "files";
  const LOCAL_BACKUP_KEY = "pm.localBackupSnapshot";
  const LAST_EMAIL_KEY = "pm.lastLoginEmail";
  const PENDING_CLOUD_KEYS = "pm.pendingCloudKeys";
  const TODO_TYPES = {
    business: "业务",
    pm: "PM",
    growth: "个人成长",
    onboarding: "新人课程"
  };
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
    statsYear: new Date().getFullYear(),
    statsMonth: new Date().getMonth() + 1,
    goals: loadArray("pm.goals"),
    todos: loadArray("pm.todos"),
    materials: loadArray("pm.materials"),
    ideas: loadArray("pm.ideas"),
    docs: loadArray("pm.docs"),
    memory: load("pm.materialMemory", {
      projects: [],
      vendors: [],
      tagOne: [],
      tagTwo: [],
      tagThree: []
    }),
    materialFilters: {
      week: "",
      scriptType: "",
      scriptStatus: "",
      progress: "",
      tagOne: "",
      tagTwo: "",
      tagThree: ""
    }
  };

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
    const config = window.PM_SUPABASE;
    if (!config?.url || !config?.anonKey || !window.supabase?.createClient) {
      updateCloudUI();
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
      if (state.user) state.cloudPausedUntil = 0;
      updateCloudUI(state.user ? "登录状态已恢复，正在后台同步云端数据。" : "未登录，当前使用本地缓存。");
      if (state.user && state.user.id !== previousUserId) syncPendingThenLoadCloud({ background: true, passive: true });
    });
  }

  async function refreshSessionInBackground() {
    try {
      const { data } = await withTimeout(state.supabase.auth.getSession(), 22000, "刷新登录状态");
      if (data.session?.user) {
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
    state.cloudPausedUntil = 0;
    if (email) localStorage.setItem(LAST_EMAIL_KEY, email);
    $("#authPassword").value = "";
    alert(data.session ? "注册成功，已登录。" : "注册成功，请按 Supabase 邮件设置完成验证后再登录。");
    if (data.session) await migrateLocalDataToCloud();
    updateCloudUI();
  }

  async function signOut() {
    if (!state.supabase) return;
    if (state.user && hasPendingCloudChanges()) {
      updateCloudUI("正在退出前保存未同步数据到云端...");
      try {
        await flushPendingCloudChanges({ force: true });
      } catch (error) {
        console.warn(error.message);
        const keepWorking = !confirm("云端保存暂时失败。建议先不要退出，等网络恢复后再退出。是否仍然退出登录？");
        if (keepWorking) {
          updateCloudUI("已取消退出；本地数据仍然安全保存。");
          return;
        }
      }
    }
    await withTimeout(state.supabase.auth.signOut(), 10000, "退出登录").catch((error) => console.warn(error.message));
    state.user = null;
    state.goals = loadArray("pm.goals");
    state.todos = loadArray("pm.todos");
    state.materials = loadArray("pm.materials");
    state.ideas = loadArray("pm.ideas");
    state.docs = loadArray("pm.docs");
    state.memory = load("pm.materialMemory", state.memory);
    $("#authPassword").value = "";
    updateCloudUI();
    renderAll();
  }

  function updateCloudUI(message = "") {
    const signedIn = Boolean(state.user);
    const checkingSession = state.cloudReady && !state.cloudSessionChecked && !signedIn;
    const cloudPaused = signedIn && Date.now() < state.cloudPausedUntil;
    $("#authForm").classList.toggle("hidden", signedIn || checkingSession);
    $("#cloudActions").classList.toggle("hidden", !signedIn);
    $("#cloudTitle").textContent = signedIn
      ? `已登录：${state.user.email || "个人账号"}`
      : checkingSession
        ? "正在恢复上次登录"
        : "登录后同步你的个人数据";
    $("#cloudStatus").textContent = message || (signedIn
      ? cloudPaused
        ? "云端连接暂时较慢，当前使用本地优先模式；本地修改已保存，稍后可点“刷新云端数据”重试。"
        : "当前数据会同步到 Supabase；换电脑打开同一个网址并登录，也能看到同一份内容。"
      : checkingSession
        ? "正在读取浏览器保存的登录状态；如果之前登录过，会自动进入账号。"
        : state.cloudReady
          ? "未登录时仍可本地使用；登录后数据会保存到 Supabase。"
          : "Supabase 还未配置完成，当前使用本地存储。");
    $("#storageMode").textContent = signedIn ? (cloudPaused ? "本地优先存储" : "云端同步存储") : "本地演示存储";
    $("#storageDetail").textContent = signedIn ? (cloudPaused ? "localStorage + 云端稍后重试" : "Supabase Database + Storage") : "localStorage + IndexedDB";
  }

  function ensureCloudReady() {
    if (state.supabase) return true;
    alert("Supabase 还没有配置完成，请先检查 supabase-config.js。");
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
    return ["projects", "vendors", "tagOne", "tagTwo", "tagThree"].reduce((memory, key) => {
      memory[key] = [...new Set([...(cloudMemory?.[key] || []), ...(localMemory?.[key] || [])])];
      return memory;
    }, {});
  }

  function readLocalSnapshot() {
    const snapshot = {
      todos: loadArray("pm.todos"),
      goals: loadArray("pm.goals"),
      materials: loadArray("pm.materials"),
      ideas: loadArray("pm.ideas"),
      docs: loadArray("pm.docs"),
      memory: load("pm.materialMemory", { projects: [], vendors: [], tagOne: [], tagTwo: [], tagThree: [] })
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
      memory: load("pm.materialMemory", { projects: [], vendors: [], tagOne: [], tagTwo: [], tagThree: [] })
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
      memory: backup.data.memory || { projects: [], vendors: [], tagOne: [], tagTwo: [], tagThree: [] }
    };
  }

  function hasAnyLocalData(snapshot) {
    return snapshot.todos.length
      || snapshot.goals.length
      || snapshot.materials.length
      || snapshot.ideas.length
      || snapshot.docs.length;
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
    if (!items.length) return;
    const rows = items.map((item) => ({
      id: item.id,
      user_id: state.user.id,
      kind,
      data: item,
      updated_at: new Date(item.updatedAt || item.createdAt || Date.now()).toISOString()
    }));
    const { error } = await withTimeout(state.supabase.from("app_items").insert(rows), 20000, `保存${kind}`);
    if (error) throw new Error(error.message);
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
  }

  function clearCloudPending(key) {
    const keys = getPendingCloudKeys().filter((entry) => entry !== key);
    localStorage.setItem(PENDING_CLOUD_KEYS, JSON.stringify(keys));
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
      if (item.videoKey) await copyLocalFileToCloud(item.videoKey);
      if (item.metricKey) await copyLocalFileToCloud(item.metricKey);
    }
    for (const doc of localData.docs) {
      if (doc.attachmentKey) await copyLocalFileToCloud(doc.attachmentKey);
    }
    state.todos = localData.todos;
    state.goals = localData.goals;
    state.materials = localData.materials;
    state.ideas = localData.ideas;
    state.docs = localData.docs;
    state.memory = localData.memory;
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
      ...backup.materials.flatMap((item) => [item.videoKey, item.metricKey]),
      ...backup.docs.map((doc) => doc.attachmentKey)
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
        memory: backup.memory || { projects: [], vendors: [], tagOne: [], tagTwo: [], tagThree: [] }
      };
      state.todos = snapshot.todos;
      state.goals = snapshot.goals;
      state.materials = snapshot.materials;
      state.ideas = snapshot.ideas;
      state.docs = snapshot.docs;
      state.memory = snapshot.memory;
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
      const goal = {
        id: editing?.id || crypto.randomUUID(),
        type: $("#goalType").value,
        title: $("#goalTitle").value.trim(),
        detail: $("#goalDetail").value.trim(),
        ddl: $("#goalDDL").value,
        done: editing?.done || false,
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
      $("#materialDialog").showModal();
    });
    $("#cancelMaterial").addEventListener("click", closeMaterialDialog);
    $("#closeMaterialDialog").addEventListener("click", closeMaterialDialog);
    $("#closeVideo").addEventListener("click", closeVideo);
    $("#videoDialog").addEventListener("close", closeVideo);
    $("#exportMaterials").addEventListener("click", exportMaterials);
    initMaterialStatsControls();
    $("#materialForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = event.submitter;
      submit.disabled = true;
      submit.textContent = "处理中...";
      try {
        const editing = state.materials.find((item) => item.id === state.editingMaterialId);
        const videoFile = $("#materialVideo").files[0];
        const metricFile = $("#materialMetric").files[0];
        const id = editing?.id || crypto.randomUUID();
        const videoKey = videoFile ? `video-${id}-${Date.now()}` : editing?.videoKey || "";
        const metricKey = metricFile ? `metric-${id}-${Date.now()}` : editing?.metricKey || "";
        const cover = videoFile ? await captureVideoCover(videoFile) : editing?.cover || createPlaceholderCover($("#materialTitle").value.trim());
        if (videoFile) await putFile(videoKey, videoFile);
        if (metricFile) await putFile(metricKey, metricFile);
        const payload = {
          id,
          title: $("#materialTitle").value.trim(),
          project: $("#projectName").value.trim(),
          scriptType: new FormData(event.currentTarget).get("scriptType") || "AE脚本",
          scriptLink: $("#scriptLink").value.trim(),
          scriptStatus: new FormData(event.currentTarget).get("scriptStatus") || "",
          progress: {
            passed: $("#progressPassed").checked,
            pushed: $("#progressPushed").checked,
            feedback: $("#progressFeedback").checked,
            recovered: $("#progressRecovered").checked,
            reviewSheet: $("#progressReviewSheet").checked
          },
          vendor: $("#vendorName").value.trim(),
          tags: [$("#tagOne").value.trim(), $("#tagTwo").value.trim(), $("#tagThree").value.trim()],
          date: $("#materialDate").value,
          videoKey,
          videoName: videoFile?.name || editing?.videoName || "",
          metricKey,
          metricName: metricFile?.name || editing?.metricName || "",
          rating: Number($("#materialRating").value),
          cover,
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
    $("#statsYear").value = state.statsYear;
    $("#statsMonth").innerHTML = Array.from({ length: 12 }, (_, index) => {
      const month = index + 1;
      return `<option value="${month}" ${month === state.statsMonth ? "selected" : ""}>${month}月</option>`;
    }).join("");
    $("#statsYear").addEventListener("input", (event) => {
      state.statsYear = Number(event.target.value) || new Date().getFullYear();
      renderMaterialStats();
    });
    $("#statsMonth").addEventListener("change", (event) => {
      state.statsMonth = Number(event.target.value);
      renderMaterialStats();
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
    $("#clearMaterialFilters").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.materialFilters = { week: "", scriptType: "", scriptStatus: "", progress: "", tagOne: "", tagTwo: "", tagThree: "" };
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
      input.addEventListener("focus", () => renderMemoryMenu(id));
      input.addEventListener("input", () => renderMemoryMenu(id));
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".memory-field")) hideMemoryMenus();
    });
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
      return;
    }
    menu.innerHTML = values.map((value) => `
      <div class="memory-option">
        <button type="button" data-pick="${escapeAttr(value)}">${escapeHtml(value)}</button>
        <button type="button" class="memory-delete" data-delete="${escapeAttr(value)}">删除</button>
      </div>
    `).join("");
    menu.classList.add("open");
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
    document.querySelectorAll(".memory-menu").forEach((menu) => {
      menu.classList.remove("open");
      menu.innerHTML = "";
    });
  }

  function bindBrain() {
    $("#ideaForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const text = $("#ideaInput").value.trim();
      if (!text) return;
      state.ideas.unshift({ id: crypto.randomUUID(), text, createdAt: Date.now() });
      save("pm.ideas", state.ideas);
      $("#ideaInput").value = "";
      renderIdeas();
    });
    $("#openDocModal").addEventListener("click", () => $("#docDialog").showModal());
    $("#cancelDoc").addEventListener("click", () => $("#docDialog").close());
    $("#closeDocDialog").addEventListener("click", () => $("#docDialog").close());
    $("#docForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = $("#docBody").value.trim();
      const link = $("#docLink").value.trim();
      const file = $("#docAttachment").files[0];
      if (!body && !link && !file) {
        $("#docBody").setCustomValidity("请至少填写正文、链接或上传附件中的一项");
        $("#docBody").reportValidity();
        return;
      }
      $("#docBody").setCustomValidity("");
      const id = crypto.randomUUID();
      const attachmentKey = file ? `doc-${id}` : "";
      if (file) await putFile(attachmentKey, file);
      state.docs.unshift({
        id,
        title: $("#docTitle").value.trim(),
        body,
        link,
        attachmentKey,
        attachmentName: file?.name || "",
        createdAt: Date.now()
      });
      save("pm.docs", state.docs);
      $("#docForm").reset();
      $("#docDialog").close();
      renderDocs();
    });
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
    const done = state.goals.filter((goal) => goal.done).length;
    $("#goalsSummary").textContent = `${done}/${total} 已达成`;
    const groups = ["业务产出", "其他维度"].map((type) => [
      type,
      state.goals.filter((goal) => goal.type === type)
    ]);
    $("#goalGroups").innerHTML = groups.map(([type, goals]) => `
      <details class="goal-group" open>
        <summary class="goal-group-title">
          <span class="goal-group-caret">▾</span>
          <h3>${escapeHtml(type)}</h3>
          <span>${goals.length} 个目标 · ${goals.filter((goal) => goal.done).length} 已达成</span>
        </summary>
        <div class="goal-list">
          ${goals.length ? goals.map((goal) => `
            <article class="goal-item ${goal.done ? "done" : ""} ${state.editingGoalId === goal.id ? "editing" : ""}" data-id="${goal.id}">
              <button class="goal-achieve ${goal.done ? "is-done" : ""}" data-action="toggle" type="button" title="${goal.done ? "标记为未达成" : "标记为已达成"}">
                <span class="goal-checkmark">✓</span>
                <span>${goal.done ? "已达成" : "达成"}</span>
              </button>
              <div class="goal-content">
                <div class="goal-row">
                  <span class="goal-type-tag ${type === "业务产出" ? "business" : "other"}">${escapeHtml(goal.type)}</span>
                  <strong>${escapeHtml(goal.title)}</strong>
                  <span class="goal-ddl">${goal.ddl ? `DDL：${escapeHtml(goal.ddl)}` : "阶段目标"}</span>
                </div>
                ${goal.detail ? `<p>${escapeHtml(goal.detail)}</p>` : `<p class="muted-note">暂无详情</p>`}
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
          state.goals = state.goals.map((goal) => goal.id === id ? { ...goal, done: !goal.done } : goal);
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
    $("#goalSubmitBtn").textContent = "保存修改";
    $("#cancelGoalEdit").hidden = false;
    renderGoals();
    $("#goalTitle").focus();
  }

  function resetGoalForm() {
    state.editingGoalId = null;
    $("#goalForm").reset();
    $("#goalSubmitBtn").textContent = "新增目标";
    $("#cancelGoalEdit").hidden = true;
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
    $("#selectedTaskEyebrow").textContent = isToday ? "Today" : "Selected Day";
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
    renderMaterialStats();
    renderMaterialFilterOptions();
    renderMaterialOptions();
    const filtered = getFilteredMaterials();
    $("#materialEmpty").style.display = filtered.length ? "none" : "block";
    $("#materialEmpty").textContent = state.materials.length ? "没有符合筛选条件的素材。" : "还没有素材，先上传一条视频素材。";
    const projectGroups = groupMaterials(filtered);
    grid.innerHTML = projectGroups.map(([project, weekGroups]) => `
      <details class="project-group" open>
        <summary class="project-group-head">
          <h3><span class="level-badge project-badge">项目</span>${escapeHtml(project)}</h3>
          <span>${countNestedMaterials(weekGroups)} 条素材</span>
        </summary>
        ${weekGroups.map(([week, tagGroups]) => `
          <details class="week-group" open>
            <summary class="week-group-head">
              <h3><span class="level-badge week-badge">周时间</span>${escapeHtml(week)}</h3>
              <span>${tagGroups.reduce((sum, [, items]) => sum + items.length, 0)} 条素材</span>
            </summary>
            ${tagGroups.map(([tag, items]) => `
          <details class="material-group" open>
            <summary class="material-group-head">
              <h3><span class="level-badge tag-badge">第一标签</span>${escapeHtml(tag)}</h3>
              <span>${items.length} 条素材</span>
            </summary>
            <div class="material-group-grid">
              ${items.map((item) => `
            <article class="material-card ${scriptCardClass(item.scriptStatus)}" data-id="${item.id}">
              ${renderScriptStatusBadge(item.scriptStatus)}
              <button class="cover-btn" data-action="play" title="${item.videoKey ? "播放完整视频" : "未上传视频"}">
                <img alt="${escapeHtml(item.title)} 封面" src="${item.cover}" />
                ${renderScriptTypeBadge(item)}
                <span class="cover-tags">${normalizedTags(item).map((tagValue, index) => `<span class="cover-tag ${index === 0 ? "primary" : ""}">${escapeHtml(tagValue)}</span>`).join("")}</span>
              </button>
              <div class="material-body">
                <label class="material-select-wrap"><input class="material-select" type="checkbox" data-id="${item.id}" />选择该素材</label>
                <h3>${escapeHtml(item.title)}</h3>
                <div class="material-date">记录时间：${item.date}</div>
                <div class="material-meta-line">脚本类型：${escapeHtml(normalizedScriptType(item))}</div>
                <div class="material-meta-line">所属项目：${escapeHtml(item.project || "未归属项目")}</div>
                <div class="material-meta-line">供应商：${escapeHtml(item.vendor || "未填写")}</div>
                <div class="script-status ${scriptStatusClass(item.scriptStatus)}">
                  脚本状态：${escapeHtml(item.scriptStatus || "未填写")}
                </div>
                ${item.scriptLink ? `<a class="link-btn script-link ${scriptStatusClass(item.scriptStatus)}" href="${escapeAttr(item.scriptLink)}" target="_blank" rel="noreferrer">打开脚本链接</a>` : ""}
                <div class="progress-row">${renderProgress(item.progress)}</div>
                <div class="rating-row">${renderStars(item.rating || 0)}</div>
                <div class="metric-slot" id="metric-${item.id}"></div>
                <div class="card-actions">
                  <label class="ghost-btn">更新数据截图<input data-action="metric" type="file" accept="image/*" hidden /></label>
                  <button class="link-btn" data-action="edit">编辑</button>
                  <button class="link-btn" data-action="delete">删除</button>
                </div>
              </div>
            </article>
              `).join("")}
            </div>
          </details>
            `).join("")}
          </details>
        `).join("")}
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
    grid.querySelectorAll("[data-action='edit']").forEach((button) => {
      button.addEventListener("click", () => openMaterialEditor(button.closest(".material-card").dataset.id));
    });
    grid.querySelectorAll("[data-progress]").forEach((button) => {
      button.addEventListener("click", () => toggleMaterialProgress(button.closest(".material-card").dataset.id, button.dataset.progress));
    });
    grid.querySelectorAll("[data-action='delete']").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.closest(".material-card").dataset.id;
        const item = state.materials.find((entry) => entry.id === id);
        if (item) {
          await deleteFile(item.videoKey);
          if (item.metricKey) await deleteFile(item.metricKey);
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
        state.materials = state.materials.map((item) => item.id === id ? { ...item, metricKey: key, metricName: file.name } : item);
        save("pm.materials", state.materials);
        renderMaterials();
      });
    });
    grid.querySelectorAll(".material-select").forEach((input) => {
      input.addEventListener("change", updateSelectedMaterialCount);
    });
    updateSelectedMaterialCount();
  }

  function renderMaterialStats() {
    const allApproved = state.materials.filter((item) => isScriptApproved(item.scriptStatus)).length;
    const allRejected = state.materials.filter((item) => isScriptRejected(item.scriptStatus)).length;
    $("#allScriptCount").textContent = state.materials.length;
    $("#allApprovedScriptCount").textContent = allApproved;
    $("#allRejectedScriptCount").textContent = allRejected;

    const monthly = state.materials.filter((item) => {
      const date = parseISODate(item.date || toISODate(new Date()));
      return date.getFullYear() === state.statsYear && date.getMonth() + 1 === state.statsMonth;
    });
    const approved = monthly.filter((item) => isScriptApproved(item.scriptStatus)).length;
    const rejected = monthly.filter((item) => isScriptRejected(item.scriptStatus)).length;
    $("#approvedScriptCount").textContent = approved;
    $("#totalScriptCount").textContent = monthly.length;
    $("#rejectedScriptCount").textContent = rejected;
  }

  function uniqueValues(values) {
    return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  function renderMaterialFilterOptions() {
    fillSelect("#filterWeek", [["", "全部周维度"], ...uniqueValues(state.materials.map((item) => getWeekRangeLabel(item.date))).map((value) => [value, value])], state.materialFilters.week);
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
      ["feedback", "反馈"],
      ["recovered", "回收"]
    ], state.materialFilters.progress);
    fillSelect("#filterTagOne", [["", "全部第一标签"], ...uniqueValues(state.materials.map((item) => normalizedTags(item)[0])).map((value) => [value, value])], state.materialFilters.tagOne);
    fillSelect("#filterTagTwo", [["", "全部第二标签"], ...uniqueValues(state.materials.map((item) => normalizedTags(item)[1])).map((value) => [value, value])], state.materialFilters.tagTwo);
    fillSelect("#filterTagThree", [["", "全部第三标签"], ...uniqueValues(state.materials.map((item) => normalizedTags(item)[2])).map((value) => [value, value])], state.materialFilters.tagThree);
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
      const progressMatch = !filters.progress || Boolean(item.progress?.[filters.progress]);
      const weekMatch = !filters.week || getWeekRangeLabel(item.date) === filters.week;
      const scriptTypeMatch = !filters.scriptType || normalizedScriptType(item) === filters.scriptType;
      const scriptStatusMatch = !filters.scriptStatus
        || (filters.scriptStatus === "approved" && isScriptApproved(item.scriptStatus))
        || (filters.scriptStatus === "rejected" && isScriptRejected(item.scriptStatus))
        || (filters.scriptStatus === "unset" && !isScriptApproved(item.scriptStatus) && !isScriptRejected(item.scriptStatus));
      return progressMatch
        && weekMatch
        && scriptTypeMatch
        && scriptStatusMatch
        && (!filters.tagOne || tags[0] === filters.tagOne)
        && (!filters.tagTwo || tags[1] === filters.tagTwo)
        && (!filters.tagThree || tags[2] === filters.tagThree);
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
      const progress = item.progress || {};
      return {
        "所属项目": item.project || "未归属项目",
        "周时间": getWeekRangeLabel(item.date),
        "素材标题": item.title || "",
        "脚本类型": normalizedScriptType(item),
        "脚本状态": item.scriptStatus || "",
        "脚本链接": item.scriptLink || "",
        "第一标签": tags[0] || "",
        "第二标签": tags[1] || "",
        "第三标签": tags[2] || "",
        "上传时间": item.date || "",
        "供应商": item.vendor || "",
        "审核表格": progress.reviewSheet ? "是" : "否",
        "通过": progress.passed ? "是" : "否",
        "推进": progress.pushed ? "是" : "否",
        "反馈": progress.feedback ? "是" : "否",
        "回收": progress.recovered ? "是" : "否",
        "数据评分": item.rating ? `${item.rating}星` : "未评分",
        "视频文件": item.videoKey ? (item.videoName || "已上传视频") : "无",
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

  function groupMaterials(materials) {
    const projects = materials.reduce((projectMap, item) => {
      const project = item.project?.trim() || "未归属项目";
      const week = getWeekRangeLabel(item.date);
      const firstTag = normalizedTags(item)[0]?.trim() || "未分类";
      if (!projectMap.has(project)) projectMap.set(project, new Map());
      const weekMap = projectMap.get(project);
      if (!weekMap.has(week)) weekMap.set(week, new Map());
      const tagMap = weekMap.get(week);
      if (!tagMap.has(firstTag)) tagMap.set(firstTag, []);
      tagMap.get(firstTag).push(item);
      return projectMap;
    }, new Map());
    return [...projects.entries()]
      .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
      .map(([project, weekMap]) => [
        project,
        [...weekMap.entries()]
          .sort(([, tagMapA], [, tagMapB]) => getNewestDateFromTagMap(tagMapB) - getNewestDateFromTagMap(tagMapA))
          .map(([week, tagMap]) => [
            week,
            [...tagMap.entries()].sort(([, itemsA], [, itemsB]) => itemsB.length - itemsA.length)
          ])
      ]);
  }

  function countNestedMaterials(weekGroups) {
    return weekGroups.reduce((sum, [, tagGroups]) => (
      sum + tagGroups.reduce((inner, [, items]) => inner + items.length, 0)
    ), 0);
  }

  function getNewestDateFromTagMap(tagMap) {
    const times = [...tagMap.values()].flat().map((item) => parseISODate(item.date || toISODate(new Date())).getTime());
    return Math.max(...times);
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

  async function playMaterial(id) {
    const item = state.materials.find((entry) => entry.id === id);
    if (!item || !item.videoKey) return;
    const file = await getFile(item.videoKey);
    if (!file) return;
    $("#videoTitle").textContent = item.title;
    $("#videoPlayer").src = URL.createObjectURL(file);
    $("#videoDialog").showModal();
  }

  function normalizedTags(item) {
    return item.tags || [item.tagOne, item.tagTwo, item.tagThree].filter(Boolean);
  }

  function renderProgress(progress = {}) {
    const items = [
      ["reviewSheet", "审核表格"],
      ["passed", "通过"],
      ["pushed", "推进"],
      ["feedback", "反馈"],
      ["recovered", "回收"]
    ];
    return items.map(([key, label]) => `<button class="progress-pill ${progress[key] ? "on" : ""}" data-progress="${key}" type="button">${label}</button>`).join("");
  }

  function openMaterialEditor(id) {
    const item = state.materials.find((entry) => entry.id === id);
    if (!item) return;
    state.editingMaterialId = id;
    $("#materialDialog .modal-head h2").textContent = "编辑素材";
    $("#materialTitle").value = item.title || "";
    $("#projectName").value = item.project || "";
    setScriptTypeRadio(normalizedScriptType(item));
    $("#scriptLink").value = item.scriptLink || "";
    setScriptStatusRadio(item.scriptStatus || "");
    $("#progressPassed").checked = Boolean(item.progress?.passed);
    $("#progressPushed").checked = Boolean(item.progress?.pushed);
    $("#progressFeedback").checked = Boolean(item.progress?.feedback);
    $("#progressRecovered").checked = Boolean(item.progress?.recovered);
    $("#progressReviewSheet").checked = Boolean(item.progress?.reviewSheet);
    $("#vendorName").value = item.vendor || "";
    const tags = normalizedTags(item);
    $("#tagOne").value = tags[0] || "";
    $("#tagTwo").value = tags[1] || "";
    $("#tagThree").value = tags[2] || "";
    $("#materialDate").value = item.date || toISODate(new Date());
    $("#materialRating").value = String(item.rating || 0);
    $("#materialVideo").value = "";
    $("#materialMetric").value = "";
    $("#materialDialog").showModal();
  }

  function resetMaterialForm() {
    state.editingMaterialId = null;
    $("#materialDialog .modal-head h2").textContent = "上传素材";
    $("#materialForm").reset();
    $("#materialRating").value = "0";
    setScriptTypeRadio("AE脚本");
    setScriptStatusRadio("");
    $("#progressPassed").checked = false;
    $("#progressPushed").checked = false;
    $("#progressFeedback").checked = false;
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
      const progress = { ...(item.progress || {}) };
      progress[key] = !progress[key];
      return { ...item, progress, updatedAt: Date.now() };
    });
    save("pm.materials", state.materials);
    renderMaterials();
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
    $("#bulkTextValue").classList.toggle("hidden", field === "scriptType");
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
    const value = field === "scriptType" ? $("#bulkScriptType").value : $("#bulkTextValue").value.trim();
    if (!value) {
      alert("请输入要批量修改的值。");
      return;
    }
    state.materials = state.materials.map((item) => {
      if (!ids.includes(item.id)) return item;
      if (field === "scriptType") return { ...item, scriptType: value, updatedAt: Date.now() };
      if (field === "vendor") return { ...item, vendor: value, updatedAt: Date.now() };
      const tags = normalizedTags(item);
      const indexMap = { tagOne: 0, tagTwo: 1, tagThree: 2 };
      tags[indexMap[field]] = value;
      return { ...item, tags, updatedAt: Date.now() };
    });
    save("pm.materials", state.materials);
    $("#bulkTextValue").value = "";
    renderMaterials();
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
    return `<span class="stars">${Array.from({ length: 5 }, (_, index) => index < score ? "★" : "☆").join("")}</span>`;
  }

  function createPlaceholderCover(title) {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createLinearGradient(0, 0, 1280, 720);
    gradient.addColorStop(0, "#172033");
    gradient.addColorStop(1, "#2563eb");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = "rgba(255,255,255,.14)";
    ctx.fillRect(80, 80, 1120, 560);
    ctx.fillStyle = "#ffffff";
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
    $("#ideaBoard").innerHTML = state.ideas.map((idea) => `
      <article class="note" data-id="${idea.id}">
        <p>${escapeHtml(idea.text)}</p>
        <div class="note-meta">${formatTime(idea.createdAt)} · <button class="link-btn" data-action="delete">删除</button></div>
      </article>
    `).join("") || `<div class="empty-state">随手写一条灵感，它会以便签形式留在这里。</div>`;
    $("#ideaBoard").querySelectorAll("[data-action='delete']").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.closest(".note").dataset.id;
        state.ideas = state.ideas.filter((idea) => idea.id !== id);
        save("pm.ideas", state.ideas);
        renderIdeas();
      });
    });
  }

  function renderDocs() {
    $("#docList").innerHTML = state.docs.map((doc) => `
      <article class="doc-item" data-id="${doc.id}">
        <h3>${escapeHtml(doc.title)}</h3>
        <div class="doc-meta">${formatTime(doc.createdAt)}</div>
        ${doc.body ? `<p class="doc-body">${escapeHtml(doc.body)}</p>` : ""}
        <div class="card-actions">
          ${doc.link ? `<a class="link-btn doc-link" href="${escapeAttr(doc.link)}" target="_blank" rel="noreferrer">打开链接</a>` : ""}
          ${doc.attachmentKey ? `<button class="link-btn" data-action="download">查看附件：${escapeHtml(doc.attachmentName)}</button>` : ""}
          <button class="link-btn" data-action="delete">删除</button>
        </div>
      </article>
    `).join("") || `<div class="empty-state">还没有深度文档，可以新建一条长文本、链接或附件沉淀。</div>`;
    $("#docList").querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.closest(".doc-item").dataset.id;
        const doc = state.docs.find((entry) => entry.id === id);
        if (button.dataset.action === "download" && doc) {
          const file = await getFile(doc.attachmentKey);
          if (!file) return;
          window.open(URL.createObjectURL(file), "_blank");
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

  async function putCloudFile(key, file) {
    const { error } = await withTimeout(state.supabase.storage
      .from("personal-assets")
      .upload(cloudFilePath(key), file, {
        cacheControl: "3600",
        upsert: true,
        contentType: file.type || "application/octet-stream"
      }), 30000, "上传附件");
    if (error) throw error;
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
